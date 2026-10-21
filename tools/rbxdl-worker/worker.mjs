// Proxies Roblox asset delivery for /toys/rbxdl/.
// Roblox sends no CORS headers, so the browser cannot read these responses
// directly. This worker fetches server-side and hands the bytes back with CORS.

const UA = "rbxdl-toy/1.0 (+https://jitterdev.github.io/toys/rbxdl/)";
const MAX_BYTES = 32 * 1024 * 1024;
const META_TTL = 600;

const TYPES = new Map([
  [1, ["Image", "png"]],
  [2, ["TShirt", "png"]],
  [3, ["Audio", "ogg"]],
  [4, ["Mesh", "mesh"]],
  [5, ["Script", "lua"]],
  [7, ["Text", "txt"]],
  [8, ["Hat", "rbxm"]],
  [9, ["Place", "rbxl"]],
  [10, ["Model", "rbxm"]],
  [11, ["Shirt", "png"]],
  [12, ["Pants", "png"]],
  [13, ["Decal", "png"]],
  [17, ["Head", "rbxm"]],
  [18, ["Face", "png"]],
  [19, ["Gear", "rbxm"]],
  [24, ["Animation", "rbxm"]],
  [25, ["Torso", "rbxm"]],
  [26, ["RightArm", "rbxm"]],
  [27, ["LeftArm", "rbxm"]],
  [28, ["RightLeg", "rbxm"]],
  [29, ["LeftLeg", "rbxm"]],
  [30, ["Package", "rbxm"]],
  [38, ["Plugin", "rbxm"]],
  [40, ["MeshPart", "rbxm"]],
  [41, ["HairAccessory", "rbxm"]],
  [42, ["FaceAccessory", "rbxm"]],
  [43, ["NeckAccessory", "rbxm"]],
  [44, ["ShoulderAccessory", "rbxm"]],
  [45, ["FrontAccessory", "rbxm"]],
  [46, ["BackAccessory", "rbxm"]],
  [47, ["WaistAccessory", "rbxm"]],
  [48, ["EarAccessory", "rbxm"]],
  [49, ["EyeAccessory", "rbxm"]],
  [77, ["EmoteAnimation", "rbxm"]],
  [78, ["Video", "mp4"]],
]);

// Roblox will not deliver a place as an asset file.
const BLOCKED = new Set([9]);

export default {
  async fetch(request, env) {
    const origin = corsFor(request, env);
    if (!origin) return json({ error: "origin not allowed" }, 403);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: preflight(origin) });
    }
    if (request.method !== "GET") {
      return json({ error: "method not allowed" }, 405, origin);
    }

    const url = new URL(request.url);
    if (url.pathname === "/") {
      return json(
        {
          ok: true,
          routes: ["/api/meta/:id", "/api/file/:id?name=..."],
          note: "public Roblox assets only. places are refused.",
        },
        200,
        origin,
      );
    }

    const match = url.pathname.match(/^\/api\/(meta|file)\/(\d{1,20})$/);
    if (!match) return json({ error: "not found" }, 404, origin);

    const [, route, id] = match;
    try {
      if (route === "meta") return await handleMeta(id, origin);
      return await handleFile(id, url.searchParams.get("name"), origin);
    } catch (error) {
      return json(
        { error: "proxy failed: " + (error?.message || "unknown error") },
        502,
        origin,
      );
    }
  },
};

async function handleMeta(id, origin) {
  const response = await fetch(
    `https://economy.roblox.com/v2/assets/${id}/details`,
    {
      headers: { "user-agent": UA, accept: "application/json" },
      cf: { cacheTtl: META_TTL, cacheEverything: true },
    },
  );

  if (response.status === 404) {
    return json({ error: "no asset with that id, or it was deleted." }, 404, origin);
  }
  if (!response.ok) {
    return json(
      { error: `roblox metadata returned ${response.status}.` },
      502,
      origin,
    );
  }

  const data = await response.json();
  if (!data?.Name) {
    return json(
      { error: "that asset has no public name. it is probably deleted or moderated." },
      404,
      origin,
    );
  }

  const [type, extension] = TYPES.get(data.AssetTypeId) ?? ["Asset", "bin"];
  return json(
    {
      id,
      name: data.Name,
      type,
      typeId: data.AssetTypeId,
      creator: data.Creator?.Name ?? null,
      extension,
      blocked: BLOCKED.has(data.AssetTypeId),
      reason: BLOCKED.has(data.AssetTypeId)
        ? "roblox does not deliver place files. use a model, image, audio, or accessory id."
        : null,
    },
    200,
    origin,
  );
}

async function handleFile(id, rawName, origin) {
  const upstream = await fetch(
    `https://assetdelivery.roblox.com/v1/asset/?id=${id}`,
    {
      redirect: "follow",
      headers: { "user-agent": UA, accept: "*/*" },
    },
  );

  if (upstream.status === 401 || upstream.status === 403) {
    return json(
      {
        error:
          "roblox would not hand this file over. it is private, moderated, or the creator disabled downloads.",
      },
      403,
      origin,
    );
  }
  if (upstream.status === 404) {
    return json({ error: "no asset with that id, or it was deleted." }, 404, origin);
  }
  if (upstream.status === 429) {
    return json(
      { error: "roblox is rate limiting this proxy. try again in a minute." },
      429,
      origin,
    );
  }
  if (!upstream.ok) {
    return json({ error: `roblox returned ${upstream.status}.` }, 502, origin);
  }

  const declared = Number(upstream.headers.get("content-length") || 0);
  if (declared > MAX_BYTES) {
    return json({ error: "that file is too big for this toy." }, 413, origin);
  }

  const buffer = await readCapped(upstream, MAX_BYTES);
  if (!buffer) {
    return json({ error: "that file is too big for this toy." }, 413, origin);
  }

  const guess = sniff(buffer) ?? { ext: "bin", mime: "application/octet-stream" };
  const name = sanitizeName(rawName) || `asset-${id}`;
  const filename = `${name}.${guess.ext}`;

  const headers = new Headers({
    ...corsHeaders(origin),
    "content-type": guess.mime,
    "content-disposition": disposition(filename),
    "content-length": String(buffer.byteLength),
    "cache-control": "no-store",
    "x-asset-id": id,
  });

  return new Response(buffer, { status: 200, headers });
}

// Buffering is unavoidable if we want to sniff the type, but a chunked
// response with no content-length would otherwise sail past MAX_BYTES.
async function readCapped(response, max) {
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}

function sniff(buffer) {
  const head = new Uint8Array(buffer.slice(0, 16));
  const at = (offset, ...bytes) =>
    bytes.every((byte, index) => head[offset + index] === byte);

  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return { ext: "png", mime: "image/png" };
  if (at(0, 0xff, 0xd8, 0xff)) return { ext: "jpg", mime: "image/jpeg" };
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return { ext: "gif", mime: "image/gif" };
  if (at(0, 0x4f, 0x67, 0x67, 0x53)) return { ext: "ogg", mime: "audio/ogg" };
  if (at(4, 0x66, 0x74, 0x79, 0x70)) return { ext: "mp4", mime: "video/mp4" };
  if (at(0, 0x50, 0x4b, 0x03, 0x04)) return { ext: "zip", mime: "application/zip" };
  if (at(0, 0x52, 0x49, 0x46, 0x46)) {
    if (at(8, 0x57, 0x45, 0x42, 0x50)) return { ext: "webp", mime: "image/webp" };
    return { ext: "wav", mime: "audio/wav" };
  }

  const text = new TextDecoder().decode(head);
  if (text.startsWith("<roblox!")) {
    return { ext: "rbxm", mime: "application/octet-stream" };
  }
  if (text.includes("<roblox")) return { ext: "rbxmx", mime: "application/xml" };

  return null;
}

function sanitizeName(value) {
  if (!value) return "";
  return value
    .normalize("NFKD")
    .replace(/[^\w .-]+/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 80);
}

function disposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function allowedOrigins(env) {
  const configured = env?.ALLOWED_ORIGINS?.trim();
  if (!configured) return "*";
  return configured
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function corsFor(request, env) {
  const allowed = allowedOrigins(env);
  if (allowed === "*") return "*";
  const origin = request.headers.get("origin");
  return allowed.includes(origin) ? origin : null;
}

function corsHeaders(origin) {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    vary: "origin",
  };
}

function preflight(origin) {
  return corsHeaders(origin);
}

function json(body, status, origin) {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  };
  if (origin) Object.assign(headers, corsHeaders(origin));
  return new Response(JSON.stringify(body), { status, headers });
}

#!/usr/bin/env node
// Bulk wrapper around the mesh2fbx toy.
//
// Reads a dwt_harvest directory (data.json + manifest.json + models/*.container),
// filters to non-weapon, non-voi_only equipment, and writes one FBX per mesh
// that belongs to the equipment itself (not the reference body parts used to
// position it), plus a model.json describing the container node tree.
//
// usage:
//   node bulk.mjs --harvest /path/to/dwt_harvest --out /path/to/out [--only slug]
//                 [--force] [--jobs 4]
//
// Node has no DOM, so the Draco wrapper is shimmed: window/self/document/fetch
// point at the local files, and the wrapper is evaluated as a classic script.

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { pathToFileURL } from "node:url";

const TOY_DIR = path.dirname(new URL(import.meta.url).pathname);

globalThis.window = globalThis;
globalThis.self = globalThis;
globalThis.location = { href: new URL("./", import.meta.url).href };
globalThis.document = {
  currentScript: { src: new URL("./draco_wasm_wrapper.js", import.meta.url).href },
  head: {
    append(script) {
      const src = fs.readFileSync(new URL(script.src), "utf8");
      new Function(src + "\n;globalThis.DracoDecoderModule = DracoDecoderModule;")();
      script.onload?.();
    },
  },
  createElement() {
    return {};
  },
};
globalThis.fetch = async (url) => {
  const p = url instanceof URL ? url : new URL(String(url));
  const buf = fs.readFileSync(p);
  return {
    ok: true,
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  };
};

const { parseFileMesh, meshToFBX } = await import("./filemesh.js");

function parseArgs(argv) {
  const opts = { harvest: null, out: null, only: null, force: false, jobs: 4 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--harvest") opts.harvest = argv[++i];
    else if (a === "--out") opts.out = argv[++i];
    else if (a === "--only") opts.only = argv[++i];
    else if (a === "--force") opts.force = true;
    else if (a === "--jobs") opts.jobs = Number(argv[++i]) || 4;
    else if (a === "-h" || a === "--help") {
      console.log("usage: node bulk.mjs --harvest <dir> --out <dir> [--only slug] [--force] [--jobs n]");
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  if (!opts.harvest || !opts.out) throw new Error("--harvest and --out are required");
  return opts;
}

const SLOT_FOLDER = {
  Head: "Head",
  Face: "Face",
  Earrings: "Ears",
  Arms: "Arms",
  Torso: "Torso",
  Legs: "Legs",
  Rings: "Ring",
};

const BODY_PARTS = new Set(["Head", "Torso", "Left Arm", "Right Arm", "Left Leg", "Right Leg", "HumanoidRootPart"]);

// Names the user explicitly does not want brought over.
const bigintReplacer = (_key, value) => (typeof value === "bigint" ? value.toString() : value);

function isExcluded(data) {
  const name = String(data.name || "").toLowerCase();
  if (name.includes("scarf") && !name.includes("trickster")) return true;
  if (name === "threadwork kilt") return true;
  if (name === "imperator's fury" || name === "imperators fury") return true;
  return false;
}

function isEligible(slug, data) {
  if (!data || data.voi_only) return false;
  if (isExcluded(data)) return false;
  return true;
}

function findNodeIndex(nodes, name, parent) {
  return nodes.findIndex((n) => n.name === name && n.parent === parent);
}

// The container is: Model (Group) -> Folder (Group) -> the item's own meshes,
// with the body-part reference meshes sitting directly under Model.
function equipmentNodeIndices(nodes) {
  const root = nodes.findIndex((n) => n.parent === undefined);
  if (root < 0) return null;
  // Rings and some small items are a bare Mesh at the root.
  if (nodes[root].kind === "Mesh") return [root];
  if (nodes[root].kind !== "Group") return null;
  let folder = nodes.findIndex((n) => n.kind === "Group" && n.parent === root && n.name === "Folder");
  if (folder < 0) {
    // Some items put the meshes straight under the root.
    folder = root;
  }

  const inSubtree = (i) => {
    let cur = i;
    while (cur !== undefined && cur >= 0) {
      if (cur === folder) return true;
      cur = nodes[cur].parent;
    }
    return false;
  };

  return nodes
    .map((n, i) => ({ n, i }))
    .filter(({ n, i }) => n.kind === "Mesh" && inSubtree(i))
    .map(({ i }) => i);
}

function anchorFor(nodes, meshIndex) {
  const weld = nodes.find((n) => n.kind === "Weld" && n.parent === meshIndex);
  if (!weld) return { weld: null, anchorName: null };
  const part0 = typeof weld.data.part0 === "number" ? weld.data.part0 : null;
  const part1 = typeof weld.data.part1 === "number" ? weld.data.part1 : null;
  const anchorIndex = part1 === meshIndex ? part0 : part1;
  const anchor = anchorIndex !== null ? nodes[anchorIndex] : null;
  return { weld: weld.data, anchorName: anchor ? anchor.name : null };
}

// c0 * c1^-1 turns the source weld into the C1 offset our runtime weld uses.
function cframeMul(a, b) {
  const m = (cf) => cf.rotation;
  const am = m(a), bm = m(b);
  const out = new Array(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] = am[r * 3] * bm[c] + am[r * 3 + 1] * bm[3 + c] + am[r * 3 + 2] * bm[6 + c];
    }
  }
  const tx = am[0] * b.position.x + am[1] * b.position.y + am[2] * b.position.z + a.position.x;
  const ty = am[3] * b.position.x + am[4] * b.position.y + am[5] * b.position.z + a.position.y;
  const tz = am[6] * b.position.x + am[7] * b.position.y + am[8] * b.position.z + a.position.z;
  return { position: { x: tx, y: ty, z: tz }, rotation: out };
}

function cframeInverse(cf) {
  const r = cf.rotation;
  const inv = [r[0], r[3], r[6], r[1], r[4], r[7], r[2], r[5], r[8]];
  const p = cf.position;
  const pos = {
    x: -(inv[0] * p.x + inv[1] * p.y + inv[2] * p.z),
    y: -(inv[3] * p.x + inv[4] * p.y + inv[5] * p.z),
    z: -(inv[6] * p.x + inv[7] * p.y + inv[8] * p.z),
  };
  return { position: pos, rotation: inv };
}

async function convertItem(item, container, outDir) {
  const nodes = container.nodes;
  const idx = equipmentNodeIndices(nodes);
  if (!idx || idx.length === 0) return { meshes: [], error: "no equipment meshes under Folder" };

  const meshById = new Map(container.meshes.map((m) => [String(m.id), m]));
  const usedNames = new Map();
  const meshes = [];

  for (const i of idx) {
    const node = nodes[i];
    const asset = node.data.geometry?.Mesh?.Asset;
    const payload = asset !== undefined ? meshById.get(String(asset)) : null;
    if (!payload) return { meshes: [], error: `mesh node ${node.name} has no matching payload` };

    const { weld, anchorName } = anchorFor(nodes, i);
    let offset = null;
    if (weld) {
      const c0 = weld.c0;
      const c1 = weld.c1;
      offset = cframeMul(c0, cframeInverse(c1));
    }

    // Sleeve/pauldron containers often have several nodes all called "MeshPart".
    const baseName = node.name.replace(/[^A-Za-z0-9]+/g, "_");
    const seen = usedNames.get(baseName) || 0;
    usedNames.set(baseName, seen + 1);
    const partName = seen === 0 ? node.name : `${node.name} ${seen + 1}`;
    const partFile = (seen === 0 ? baseName : `${baseName}_${seen + 1}`) + ".fbx";
    const fbxPath = path.join(outDir, partFile);
    const mesh = await parseFileMesh(
      payload.bytes.buffer.slice(payload.bytes.byteOffset, payload.bytes.byteOffset + payload.bytes.byteLength)
    );
    const fbx = meshToFBX(mesh, { name: `${item.slug}_${node.name}` });
    fs.writeFileSync(fbxPath, Buffer.from(fbx));

    meshes.push({
      part: partName,
      fbx: partFile,
      asset: String(asset),
      anchor: anchorName,
      offset,
      size: node.data.size,
      cframe: node.data.cframe,
      color: node.data.color,
      shading: node.data.shading,
      transparency: node.data.transparency,
      doubleSided: node.data.double_sided,
      vertexColors: node.data.vertex_colors,
      castShadow: node.data.cast_shadow,
      vertices: mesh.positions.length / 3,
      faces: mesh.faces.length / 3,
      hasColors: !!mesh.colors,
      hasTangents: !!mesh.tangents,
      textures: container.textures.map((t) => String(t.id)),
      nodes: nodes
        .filter((n) => n.kind !== "Group" && n.kind !== "Mesh" && n.kind !== "Weld")
        .map((n) => ({ kind: n.kind, name: n.name, data: n.data, parent: n.parent })),
    });
  }

  const textures = [];
  for (const t of container.textures) {
    const file = `${t.id}.png`;
    fs.writeFileSync(path.join(outDir, file), Buffer.from(t.bytes));
    textures.push({ id: String(t.id), file });
  }

  return { meshes, textures };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const harvest = path.resolve(opts.harvest);
  const outRoot = path.resolve(opts.out);
  const { parseContainer } = await import(pathToFileURL(path.join(harvest, "parse_container.mjs")).href);
  const data = JSON.parse(fs.readFileSync(path.join(harvest, "data.json"), "utf8"));
  const manifest = JSON.parse(fs.readFileSync(path.join(harvest, "manifest.json"), "utf8"));

  const entries = manifest.filter(
    (m) => m.category === "equipment" && isEligible(m.slug, data.equipment[m.slug])
  );
  const report = { generatedAt: new Date().toISOString(), harvest, items: [], skipped: [], errors: [] };

  let done = 0;
  for (const m of entries) {
    if (opts.only && m.slug !== opts.only) continue;
    const slot = SLOT_FOLDER[data.equipment[m.slug]?.type || m.type];
    if (!slot) {
      report.errors.push({ slug: m.slug, error: `unknown equipment type ${m.type}` });
      continue;
    }
    const itemDir = path.join(outRoot, slot, m.slug);
    const containerPath = path.join(harvest, m.file);
    if (!fs.existsSync(containerPath)) {
      report.skipped.push({ slug: m.slug, reason: "container missing" });
      continue;
    }
    const modelPath = path.join(itemDir, "model.json");
    if (!opts.force && fs.existsSync(modelPath)) {
      report.items.push(JSON.parse(fs.readFileSync(modelPath, "utf8")));
      continue;
    }

    fs.mkdirSync(itemDir, { recursive: true });
    try {
      const container = parseContainer(fs.readFileSync(containerPath), path.basename(containerPath));
      const meta = await convertItem(m, container, itemDir);
      if (meta.error) {
        report.errors.push({ slug: m.slug, error: meta.error });
        continue;
      }
      const record = {
        slug: m.slug,
        name: data.equipment[m.slug]?.name || m.name,
        type: data.equipment[m.slug]?.type || m.type,
        slot,
        rarity: data.equipment[m.slug]?.rarity || m.rarity,
        variants: data.equipment[m.slug]?.variants || [],
        meshes: meta.meshes,
        textures: meta.textures,
      };
      fs.writeFileSync(modelPath, JSON.stringify(record, bigintReplacer, 2));
      report.items.push(record);
      done++;
      process.stderr.write(`\rconverted ${done}`);
    } catch (e) {
      report.errors.push({ slug: m.slug, error: e.message });
    }
  }
  process.stderr.write("\n");

  fs.writeFileSync(path.join(outRoot, "bulk-report.json"), JSON.stringify(report, bigintReplacer, 2));
  const meshes = report.items.reduce((n, i) => n + i.meshes.length, 0);
  console.log(
    JSON.stringify(
      {
        items: report.items.length,
        meshes,
        errors: report.errors.length,
        skipped: report.skipped.length,
        out: outRoot,
      },
      null,
      2
    )
  );
  if (report.errors.length) {
    console.error(report.errors.slice(0, 10));
  }
}

await main();

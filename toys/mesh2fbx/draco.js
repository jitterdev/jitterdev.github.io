// Draco decoding for v7 COREMESH chunks.
//
// The format is Google Draco, which is not something to reimplement: the
// bitstream is rANS-coded with edgebreaker connectivity. So this shells out to
// Google's own decoder, compiled to WebAssembly.
//
// draco_decoder.wasm and draco_wasm_wrapper.js are Google's Apache-2.0 build,
// vendored unmodified; draco.README.md is their note. Same approach as the luau
// repl, which also ships a wasm blob.
//
// The wasm is fetched on first use rather than at page load, since a v7 file is
// the only thing that needs it and most meshes are older than that.

const WASM_URL = new URL('./draco_decoder.wasm', import.meta.url);
const WRAPPER_URL = new URL('./draco_wasm_wrapper.js', import.meta.url);

// Roblox labels its attributes by numeric id rather than using Draco's own
// attribute types, so ids are the only reliable way to tell them apart.
const ID_POSITION = 0;
const ID_NORMAL = 1;
const ID_TEXCOORD = 2;
const ID_TANGENT = 3;
const ID_COLOR = 4;

let decoderPromise = null;

export class DracoError extends Error {}

function loadScript(url) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url;
    s.onload = () => resolve();
    s.onerror = () => reject(new DracoError(`could not load ${url}`));
    document.head.append(s);
  });
}

async function getDecoder() {
  if (decoderPromise) return decoderPromise;

  decoderPromise = (async () => {
    if (typeof WebAssembly !== 'object') {
      throw new DracoError('this browser has no WebAssembly, so Draco meshes cannot be read');
    }

    // The emscripten wrapper is a classic script that defines a global factory.
    await loadScript(WRAPPER_URL.href);
    const factory = self.DracoDecoderModule;
    if (typeof factory !== 'function') {
      throw new DracoError('the Draco wrapper loaded but did not define DracoDecoderModule');
    }

    const res = await fetch(WASM_URL.href);
    if (!res.ok) throw new DracoError(`could not fetch the Draco decoder (${res.status})`);
    const wasmBinary = await res.arrayBuffer();

    // Wait on onModuleLoaded, not on the thenable the factory returns. The
    // wrapper installs its own onRuntimeInitialized and only reports readiness
    // through onModuleLoaded, so awaiting the module object can simply never
    // settle.
    //
    // Resolve with the module WRAPPED, never the module itself. It carries a
    // custom then(), so resolving a promise with it makes the engine treat it
    // as a thenable: it calls then(), which resolves with the same thenable
    // again, and the microtask queue never empties. That spins the main thread
    // and the tab locks up. three.js wraps for exactly this reason.
    return await new Promise((resolve, reject) => {
      let done = false;
      const finish = (fn, arg) => { if (!done) { done = true; fn(arg); } };
      factory({
        wasmBinary,
        onModuleLoaded: (mod) => finish(resolve, { module: mod }),
        onAbort: (what) =>
          finish(reject, new DracoError(`the Draco decoder aborted: ${what || 'unknown reason'}`)),
      });
    });
  })();

  // do not cache a failure, or one bad load poisons the page for good
  decoderPromise.catch(() => { decoderPromise = null; });
  return decoderPromise;
}

// Copy one attribute out of the wasm heap into a normal typed array.
//
// The decoder only ever writes into memory we hand it: allocate with _malloc,
// ask for the values, copy them out of the heap, then _free. There is a
// self-managed *Array object API too, but its signatures are easy to get wrong
// in ways that quietly pass a byte count where a pointer belongs, which writes
// attribute data straight over the decoder's own heap.
function readAttribute(module, decoder, mesh, attr, ArrayType, dracoType) {
  const comps = attr.num_components();
  const numValues = mesh.num_points() * comps;
  const view = ArrayType === Float32Array ? module.HEAPF32 : module.HEAPU8;
  const byteLength = numValues * ArrayType.BYTES_PER_ELEMENT;

  const ptr = module._malloc(byteLength);
  try {
    const ok = decoder.GetAttributeDataArrayForAllPoints(mesh, attr, dracoType, byteLength, ptr);
    if (!ok || !ptr) return null;
    // slice() copies; the heap view is only valid until the next malloc
    return new ArrayType(view.buffer, ptr, numValues).slice();
  } finally {
    module._free(ptr);
  }
}

// unique_id -> PointAttribute, built by walking the mesh's own attribute list so
// no lookup has to cope with a missing id.
function attributeIndex(decoder, mesh) {
  const byId = new Map();
  for (let i = 0; i < mesh.num_attributes(); i++) {
    const attr = decoder.GetAttribute(mesh, i);
    if (attr) byId.set(attr.unique_id(), attr);
  }
  return byId;
}

function assemble(numPoints, attrs) {
  const positions = new Float32Array(numPoints * 3);
  const normals = new Float32Array(numPoints * 3);
  const uvs = new Float32Array(numPoints * 2);
  let tangents = null;
  let colors = null;

  const pos = attrs.get(ID_POSITION);
  const nrm = attrs.get(ID_NORMAL);
  const uv = attrs.get(ID_TEXCOORD);
  const tan = attrs.get(ID_TANGENT);
  const col = attrs.get(ID_COLOR);

  if (pos) positions.set(pos.subarray(0, positions.length));
  if (nrm) normals.set(nrm.subarray(0, normals.length));
  if (uv) uvs.set(uv.subarray(0, uvs.length));

  if (tan) {
    tangents = new Float32Array(numPoints * 4);
    let missing = 0;
    for (let i = 0; i < numPoints; i++) {
      // Roblox documents this record as sbyte, and the bytes really do carry
      // the sign bit set (values above 127 show up, 255 never does), so they
      // have to go back to signed before they are scaled.
      const sx = tan[i * 4] > 127 ? tan[i * 4] - 256 : tan[i * 4];
      const sy = tan[i * 4 + 1] > 127 ? tan[i * 4 + 1] - 256 : tan[i * 4 + 1];
      const sz = tan[i * 4 + 2] > 127 ? tan[i * 4 + 2] - 256 : tan[i * 4 + 2];
      const sw = tan[i * 4 + 3] > 127 ? tan[i * 4 + 3] - 256 : tan[i * 4 + 3];
      const tx = sx / 127;
      const ty = sy / 127;
      const tz = sz / 127;
      // The fourth byte is the bitangent sign. Draco's uint8 round-trip leaves
      // it as 0 or -2 rather than the +/-127 the on-disk record uses, so it is
      // taken as a sign and normalised rather than scaled.
      const ts = sw < 0 ? -1 : 1;
      // 0,0,0 is how a pre-PBR mesh says "no tangent here"; leave those blank
      // instead of handing importers a degenerate one.
      if (tx === 0 && ty === 0 && tz === 0) {
        missing++;
      } else {
        tangents[i * 4] = tx;
        tangents[i * 4 + 1] = ty;
        tangents[i * 4 + 2] = tz;
        tangents[i * 4 + 3] = ts;
      }
    }
    if (missing === numPoints) tangents = null;
  }

  if (col) {
    // Draco writes 255,255,255,255 for "no colour set". Passing that through
    // would make every untextured mesh export as flat white.
    let tinted = false;
    for (let i = 0; i < numPoints && !tinted; i++) {
      if (col[i * 4] !== 255 || col[i * 4 + 1] !== 255 || col[i * 4 + 2] !== 255 || col[i * 4 + 3] !== 255) {
        tinted = true;
      }
    }
    if (tinted) colors = new Uint8Array(col);
  }

  return { positions, normals, uvs, tangents, colors };
}

export async function decodeDraco(stream) {
  const { module } = await getDecoder();

  const bytes = new Int8Array(stream.buffer, stream.byteOffset, stream.byteLength);
  const decoder = new module.Decoder();
  const buf = new module.DecoderBuffer();
  const mesh = new module.Mesh();

  try {
    buf.Init(bytes, stream.byteLength);

    // GetEncodedGeometryType hangs off the Decoder, not the module.
    if (decoder.GetEncodedGeometryType(buf) !== module.TRIANGULAR_MESH) {
      throw new DracoError('the Draco stream holds a point cloud, not a mesh');
    }

    const status = decoder.DecodeBufferToMesh(buf, mesh);
    if (!status.ok()) {
      throw new DracoError(`Draco could not decode this stream: ${status.error_msg() || 'unknown error'}`);
    }

    const numPoints = mesh.num_points();
    const numFaces = mesh.num_faces();

    const byId = attributeIndex(decoder, mesh);
    const attrs = new Map();
    // floats keep their precision; the byte attributes come back as raw bytes
    // and the tangent's sign is put back by hand in assemble()
    const wanted = [
      [ID_POSITION, Float32Array, module.DT_FLOAT32],
      [ID_NORMAL, Float32Array, module.DT_FLOAT32],
      [ID_TEXCOORD, Float32Array, module.DT_FLOAT32],
      [ID_TANGENT, Uint8Array, module.DT_UINT8],
      [ID_COLOR, Uint8Array, module.DT_UINT8],
    ];
    for (const [id, ArrayType, dracoType] of wanted) {
      const attr = byId.get(id);
      if (!attr) continue;
      const a = readAttribute(module, decoder, mesh, attr, ArrayType, dracoType);
      if (a) attrs.set(id, a);
      // attributes belong to the mesh; freeing them here would double-free
      // when the mesh is destroyed below
    }

    // three args, not four: (geometry, byteLength, pointer). The binding takes
    // (a, b, d) and JS silently drops the extra, so passing the triangle count
    // as a third argument reads it as the destination pointer.
    const numIndices = numFaces * 3;
    const idxPtr = module._malloc(numIndices * 4);
    let faces;
    try {
      if (!decoder.GetTrianglesUInt32Array(mesh, numIndices * 4, idxPtr)) {
        throw new DracoError('could not read triangle indices from the Draco stream');
      }
      faces = new Uint32Array(module.HEAPF32.buffer, idxPtr, numIndices).slice();
    } finally {
      module._free(idxPtr);
    }

    return { numPoints, numFaces, faces, ...assemble(numPoints, attrs) };
  } finally {
    module.destroy(mesh);
    module.destroy(buf);
    module.destroy(decoder);
  }
}
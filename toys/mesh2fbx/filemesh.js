// Roblox FileMesh -> FBX.
//
// Format spec (unofficial, reverse engineered by Maximum_ADHD):
// https://devforum.roblox.com/t/roblox-filemesh-format-specification/326114
//
// Everything is little-endian. Header is the ASCII string "version X.YY" plus \n.

import { decodeDraco } from './draco.js';

export const HEADER_BYTES = {
  v1: 0,
  v2: 12,
  v3: 16,
  v4: 24,
  v5: 32,
};

const FACE_SIZE = 12; // 3 x uint32
const SKIN_SIZE = 8; // 4 x byte indices + 4 x byte weights
const BONE_SIZE = 60; // 4 + 2 + 2 + 4 culling + 36 matrix + 12 translation
const SUBSET_SIZE = 72; // 5 x uint32 + 26 x uint16

export class MeshParseError extends Error {}

// v6 and v7 dropped the fixed header for a chunk stream, where every chunk tag
// is a full 8 bytes ("COREMESH", "LODS\0\0\0\0", ...). Reading these with a
// 4-byte tag picks up four bytes of payload as the "version", which is how you
// end up reading the literal ASCII "MESH" as a vertex count.
const CHUNK_HEADER = 16; // byte[8] tag, uint version, uint size

function readChunks(view, offset, what) {
  const chunks = new Map();
  while (offset + CHUNK_HEADER <= view.byteLength) {
    const rawTag = new TextDecoder().decode(new Uint8Array(view.buffer, view.byteOffset + offset, 8));
    const tag = rawTag.replace(/\0+$/, '');
    const version = view.getUint32(offset + 8, true);
    const size = view.getUint32(offset + 12, true);
    const start = offset + CHUNK_HEADER;

    if (start + size > view.byteLength) {
      throw new MeshParseError(
        `${what} chunk claims ${size} bytes at offset ${start} but the file is only ` +
          `${view.byteLength} bytes. the chunk stream is probably corrupt.`
      );
    }
    if (!tag || !/^[\x20-\x7e]+$/.test(tag)) {
      throw new MeshParseError(
        `expected an ascii chunk tag at offset ${offset}, found ${JSON.stringify(rawTag)}. ` +
          `the chunk stream has lost sync.`
      );
    }

    // Last one wins if a tag repeats, which matches how the chunks are additive.
    chunks.set(tag, { version, start, size, tag });
    offset = start + size;
  }
  return chunks;
}

// The header promises a size for everything in v2/v3 but drops it in v4+, so we
// sanity check against the numbers instead of trusting a byte count.
function need(view, offset, bytes, what) {
  if (offset + bytes > view.byteLength) {
    throw new MeshParseError(
      `ran out of data reading ${what}: wanted ${bytes} byte(s) at offset ${offset}, ` +
        `file is only ${view.byteLength} bytes. version string or counts are probably being misread.`
    );
  }
}

// v7 COREMESH wraps a Draco bitstream, and Draco has to run in wasm, so the
// entry point is async. Everything below it stays synchronous.
export async function parseFileMesh(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const newline = bytes.indexOf(0x0a);
  if (newline < 0) throw new MeshParseError("no newline after the version header");

  const header = new TextDecoder().decode(bytes.subarray(0, newline));
  const match = /^version\s+(\d+)\.(\d+)$/.exec(header.trim());
  if (!match) throw new MeshParseError(`unrecognised version header: ${JSON.stringify(header)}`);

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const warnings = [];

  if (major === 1) return parseV1(new TextDecoder().decode(bytes), minor, warnings);
  if (major >= 6) return await parseChunked(arrayBuffer, newline + 1, major, minor, warnings);
  if (major >= 2 && major <= 5) return parseBinary(arrayBuffer, newline + 1, major, minor, warnings);

  throw new MeshParseError(
    `version ${major}.${minor} is past this decoder (handles 1.x through 7.x). ` +
      `the format is internal to Roblox and can change without notice.`
  );
}

// version 1

// ASCII: three text lines, then numFaces * 3 * "[x,y,z]" groups. No shared
// vertex list at all, so identical corners have to be welded by hand.
function parseV1(text, minor, warnings) {
  const lines = text.split("\n");
  const numFaces = parseInt(lines[1], 10);
  if (!Number.isFinite(numFaces)) throw new MeshParseError(`bad face count on line 2: ${lines[1]}`);

  const body = lines.slice(2).join("\n");
  const triples = [];
  const re = /\[(-?[\d.eE+-]+),(-?[\d.eE+-]+),(-?[\d.eE+-]+)\]/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    triples.push([parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])]);
  }

  const expected = numFaces * 9;
  if (triples.length < expected) {
    warnings.push(`expected ${expected} vectors for ${numFaces} faces, found ${triples.length}`);
  }

  // v1.00 stores positions at twice the intended size.
  const scale = minor === 0 ? 0.5 : 1;
  if (minor === 0) warnings.push("version 1.00 positions scaled by 0.5");

  const positions = [];
  const normals = [];
  const uvs = [];
  const faces = new Uint32Array(numFaces * 3);
  const weld = new Map();

  for (let f = 0; f < numFaces; f++) {
    for (let c = 0; c < 3; c++) {
      const base = (f * 3 + c) * 3;
      const p = triples[base];
      const n = triples[base + 1];
      const t = triples[base + 2];
      if (!p || !n || !t) continue;

      const px = p[0] * scale, py = p[1] * scale, pz = p[2] * scale;
      // The v1 tex_V is stored upside down.
      const tu = t[0], tv = 1 - t[1];

      const key = `${px},${py},${pz},${n[0]},${n[1]},${n[2]},${tu},${tv}`;
      let idx = weld.get(key);
      if (idx === undefined) {
        idx = positions.length / 3;
        positions.push(px, py, pz);
        normals.push(n[0], n[1], n[2]);
        uvs.push(tu, tv);
        weld.set(key, idx);
      }
      faces[f * 3 + c] = idx;
    }
  }

  if (weld.size < faces.length) {
    warnings.push(`welded ${faces.length} corners down to ${weld.size} vertices`);
  }

  return {
    version: `1.${minor.toString().padStart(2, '0')}`,
    vertexSize: 0,
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    faces,
    colors: null,
    tangents: null,
    lodOffsets: null,
    bones: [],
    boneNames: [],
    subsets: [],
    skinning: null,
    warnings,
  };
}

// versions 6 and 7

// v6 moved to an 8-byte-tag chunk stream. v7 is the same thing with COREMESH
// bumped to chunkVersion 2, whose body is a Draco bitstream instead of raw
// vertex/face arrays.
async function parseChunked(arrayBuffer, start, major, minor, warnings) {
  const view = new DataView(arrayBuffer);
  const versionLabel = `${major}.${String(minor).padStart(2, '00')}`;
  const chunks = readChunks(view, start, `v${versionLabel}`);
  const versionMajor = major;

  const core = chunks.get('COREMESH');
  if (!core) {
    throw new MeshParseError(
      `no COREMESH chunk in this v${versionLabel} file, found: ` +
        `${[...chunks.keys()].join(', ') || 'nothing'}`
    );
  }

  let geometry;
  let lodType = null;
  let lodOffsets = null;

  if (core.version === 1) {
    geometry = readCoreMeshV1(view, core);
  } else if (core.version === 2) {
    // Draco has no pure-javascript path here; the decoder is loaded on demand.
    geometry = await decodeDracoChunk(view, core);
    warnings.push(
      `geometry was Draco-compressed (COREMESH v2), so the vertex record is not byte-aligned ` +
        `the way v2-v6 store it`
    );
  } else {
    throw new MeshParseError(
      `COREMESH chunkVersion ${core.version} is not something this decoder knows ` +
        `(handles 1 and 2). the format can change without notice.`
    );
  }

  const lods = chunks.get('LODS');
  if (lods) {
    lodType = view.getUint16(lods.start, true);
    const numLodOffsets = view.getUint32(lods.start + 3, true);
    need(view, lods.start + 7, numLodOffsets * 4, `${numLodOffsets} lod offsets`);
    lodOffsets = [];
    for (let i = 0; i < numLodOffsets; i++) {
      lodOffsets.push(view.getUint32(lods.start + 7 + i * 4, true));
    }
  }

  let bones = [];
  let boneNames = [];
  let subsets = [];
  let skinning = null;

  const skin = chunks.get('SKINNING');
  if (skin) {
    const s = readSkinningChunk(view, skin);
    bones = s.bones;
    boneNames = s.boneNames;
    subsets = s.subsets;
    skinning = s.skinning;
  }

  const unknown = [...chunks.keys()].filter((t) => !['COREMESH', 'LODS', 'SKINNING'].includes(t));
  for (const tag of unknown) {
    warnings.push(`ignored ${chunks.get(tag).size} byte(s) of ${tag} chunk data`);
  }

  return {
    version: versionLabel,
    vertexSize: 0,
    lodType,
    ...geometry,
    faces: geometry.faces,
    lodOffsets,
    bones,
    boneNames,
    subsets,
    skinning,
    warnings,
  };
}

function readCoreMeshV1(view, core) {
  let offset = core.start;
  const numVerts = view.getUint32(offset, true);
  offset += 4;
  const end = core.start + core.size;
  if (numVerts > 4000000) {
    throw new MeshParseError(`implausible vertex count ${numVerts} in the COREMESH chunk`);
  }

  // No sizeof_FileMeshVertex in this chunk either, and numFaces is stored after
  // the verts, so both are unknown. Only two strides are legal (36 or 40), and
  // exactly one of them lands the face count and its 12-byte faces flush with
  // the end of the chunk, so try each and keep the one that fits.
  let vertexSize = null;
  let numFaces = 0;
  for (const stride of [36, 40]) {
    const facesAt = offset + numVerts * stride;
    if (facesAt + 4 > end) continue;
    const count = view.getUint32(facesAt, true);
    if (count > 4000000) continue;
    if (facesAt + 4 + count * FACE_SIZE === end) {
      vertexSize = stride;
      numFaces = count;
      break;
    }
  }

  if (vertexSize === null) {
    throw new MeshParseError(
      `COREMESH chunk of ${core.size} bytes does not fit either a 36 or 40 byte vertex ` +
        `for ${numVerts} verts. the chunk layout has changed.`
    );
  }

  const verts = readVerts(view, offset, numVerts, vertexSize, []);
  let facesOffset = offset + numVerts * vertexSize + 4;

  const faces = new Uint32Array(numFaces * 3);
  for (let f = 0; f < numFaces * 3; f++) faces[f] = view.getUint32(facesOffset + f * 4, true);
  facesOffset += numFaces * FACE_SIZE;

  return { ...verts, faces, vertexSize };
}

// The Draco attribute ids Roblox uses, per the format spec's table.
async function decodeDracoChunk(view, core) {
  const streamSize = view.getUint32(core.start, true);
  need(view, core.start + 4, streamSize, `the ${streamSize} byte Draco bitstream`);
  const stream = new Uint8Array(view.buffer, view.byteOffset + core.start + 4, streamSize);

  const { numPoints, numFaces, faces, positions, normals, uvs, tangents, colors } =
    await decodeDraco(stream);

  return {
    positions,
    normals,
    uvs,
    faces,
    tangents,
    colors,
    hasColor: !!colors,
    vertexSize: 0,
  };
}

function readSkinningChunk(view, chunk) {
  let offset = chunk.start;
  const numSkinnings = view.getUint32(offset, true);
  offset += 4;
  need(view, offset, numSkinnings * SKIN_SIZE, `${numSkinnings} skinning records`);
  const skinning = readSkinning(view, offset, numSkinnings);
  offset += numSkinnings * SKIN_SIZE;

  const numBones = view.getUint32(offset, true);
  offset += 4;
  need(view, offset, numBones * BONE_SIZE, `${numBones} bones`);
  const bones = [];
  if (numBones > 0) bones.push(...readBones(view, offset, numBones));
  offset += numBones * BONE_SIZE;

  const nameTableSize = view.getUint32(offset, true);
  offset += 4;
  need(view, offset, nameTableSize, 'the bone name buffer');
  const boneNames = new TextDecoder()
    .decode(new Uint8Array(view.buffer, view.byteOffset + offset, nameTableSize))
    .split('\0')
    .filter(Boolean);
  offset += nameTableSize;

  const numSubsets = view.getUint32(offset, true);
  offset += 4;
  need(view, offset, numSubsets * SUBSET_SIZE, `${numSubsets} subsets`);
  const subsets = [];
  if (numSubsets > 0) subsets.push(...readSubsets(view, offset, numSubsets));
  offset += numSubsets * SUBSET_SIZE;

  if (offset < chunk.start + chunk.size) {
    const slack = chunk.start + chunk.size - offset;
    // an unaccounted tail here is silently wrong, so say so rather than
    // pretending the skin data lined up
    console.warn(`SKINNING chunk has ${slack} trailing byte(s)`);
  }

  return { skinning: numSkinnings > 0 ? skinning : null, bones, boneNames, subsets };
}

// versions 2 through 5

function parseBinary(arrayBuffer, start, major, minor, warnings) {
  const view = new DataView(arrayBuffer);
  const versionLabel = `${major}.${String(minor).padStart(2, '0')}`;
  let offset = start;
  let vertexSize = 36;
  let numVerts = 0;
  let numFaces = 0;
  let numLodOffsets = 0;
  let numBones = 0;
  let numSubsets = 0;
  let sizeofBoneNames = 0;
  let lodType = null;
  let facsDataSize = 0;

  if (major === 2) {
    need(view, offset, HEADER_BYTES.v2, `the v${versionLabel} header`);
    // Everything sits inside the 12 byte header, so read at absolute offsets
    // and only advance once at the end.
    vertexSize = view.getUint8(offset + 2);
    numVerts = view.getUint32(offset + 4, true);
    numFaces = view.getUint32(offset + 8, true);
    offset += HEADER_BYTES.v2;
    if (vertexSize !== 36 && vertexSize !== 40) {
      throw new MeshParseError(`unexpected vertex size ${vertexSize} (expected 36 or 40)`);
    }
  } else if (major === 3) {
    need(view, offset, HEADER_BYTES.v3, `the v${versionLabel} header`);
    vertexSize = view.getUint8(offset + 2);
    numLodOffsets = view.getUint16(offset + 6, true);
    numVerts = view.getUint32(offset + 8, true);
    numFaces = view.getUint32(offset + 12, true);
    offset += HEADER_BYTES.v3;
    if (vertexSize !== 36 && vertexSize !== 40) {
      throw new MeshParseError(`unexpected vertex size ${vertexSize} (expected 36 or 40)`);
    }
  } else {
    // v4 dropped the per-element sizes, so only the header itself is sized.
    const headerSize = major >= 5 ? HEADER_BYTES.v5 : HEADER_BYTES.v4;
    need(view, offset, headerSize, `the v${versionLabel} header`);
    lodType = view.getUint16(offset + 2, true);
    numVerts = view.getUint32(offset + 4, true);
    numFaces = view.getUint32(offset + 8, true);
    numLodOffsets = view.getUint16(offset + 12, true);
    numBones = view.getUint16(offset + 14, true);
    sizeofBoneNames = view.getUint32(offset + 16, true);
    numSubsets = view.getUint16(offset + 20, true);
    if (major >= 5) facsDataSize = view.getUint32(offset + 28, true);
    offset += headerSize;

    // No sizeof_FileMeshVertex in this header, so recover it by working backwards
    // from the file length: everything after the verts is a length we already know.
    const tail =
      numVerts * SKIN_SIZE * (numBones > 0 ? 1 : 0) +
      numFaces * FACE_SIZE +
      numLodOffsets * 4 +
      numBones * BONE_SIZE +
      sizeofBoneNames +
      numSubsets * SUBSET_SIZE +
      facsDataSize;
    const implied = numVerts > 0 ? (view.byteLength - offset - tail) / numVerts : 36;

    if (implied === 36 || implied === 40) {
      vertexSize = implied;
    } else {
      vertexSize = Math.abs(implied - 36) < Math.abs(implied - 40) ? 36 : 40;
      const slack = view.byteLength - offset - tail - numVerts * vertexSize;
      warnings.push(
        `file length implies a ${implied.toFixed(2)} byte vertex, not 36 or 40. ` +
          `assuming ${vertexSize}; ${slack} byte(s) will be off`
      );
    }
  }

  if (numVerts < 0 || numVerts > 400000) {
    throw new MeshParseError(`implausible vertex count ${numVerts}, header is likely misaligned`);
  }
  if (numFaces < 0 || numFaces > 400000) {
    throw new MeshParseError(`implausible face count ${numFaces}, header is likely misaligned`);
  }

  const verts = readVerts(view, offset, numVerts, vertexSize, warnings);
  offset += numVerts * vertexSize;

  // Only present when the mesh actually has bones.
  let skinning = null;
  if (major >= 4 && numBones > 0) {
    need(view, offset, numVerts * SKIN_SIZE, `${numVerts} skinning records`);
    skinning = readSkinning(view, offset, numVerts);
    offset += numVerts * SKIN_SIZE;
  }

  need(view, offset, numFaces * FACE_SIZE, `${numFaces} faces`);
  const faces = new Uint32Array(numFaces * 3);
  for (let f = 0; f < numFaces * 3; f++) faces[f] = view.getUint32(offset + f * 4, true);
  offset += numFaces * FACE_SIZE;

  let lodOffsets = null;
  if (numLodOffsets > 0) {
    need(view, offset, numLodOffsets * 4, `${numLodOffsets} lod offsets`);
    lodOffsets = [];
    for (let i = 0; i < numLodOffsets; i++) lodOffsets.push(view.getUint32(offset + i * 4, true));
    offset += numLodOffsets * 4;
  }

  const bones = [];
  const boneNames = [];
  const subsets = [];

  if (major >= 4) {
    need(view, offset, numBones * BONE_SIZE, `${numBones} bones`);
    bones.push(...readBones(view, offset, numBones));
    offset += numBones * BONE_SIZE;

    need(view, offset, sizeofBoneNames, 'the bone name buffer');
    const blob = new TextDecoder().decode(new Uint8Array(arrayBuffer, offset, sizeofBoneNames));
    boneNames.push(...blob.split('\0').filter(Boolean));
    offset += sizeofBoneNames;

    need(view, offset, numSubsets * SUBSET_SIZE, `${numSubsets} subsets`);
    subsets.push(...readSubsets(view, offset, numSubsets));
    offset += numSubsets * SUBSET_SIZE;
  }

  const leftover = view.byteLength - offset - facsDataSize;
  if (major >= 5 && facsDataSize > 0) {
    warnings.push(`skipped ${facsDataSize} bytes of FACS facial animation data`);
  }
  if (leftover > 0) {
    warnings.push(`${leftover} trailing byte(s) not accounted for`);
  }

  return {
    version: versionLabel,
    vertexSize,
    lodType,
    ...verts,
    faces,
    lodOffsets,
    bones,
    boneNames,
    subsets,
    skinning,
    warnings,
  };
}

function readVerts(view, offset, count, vertexSize, warnings) {
  const hasColor = vertexSize >= 40;
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  const colors = hasColor ? new Uint8Array(count * 4) : null;
  const tangents = new Float32Array(count * 4);
  let badTangents = 0;

  for (let i = 0; i < count; i++) {
    const b = offset + i * vertexSize;
    positions[i * 3] = view.getFloat32(b, true);
    positions[i * 3 + 1] = view.getFloat32(b + 4, true);
    positions[i * 3 + 2] = view.getFloat32(b + 8, true);
    normals[i * 3] = view.getFloat32(b + 12, true);
    normals[i * 3 + 1] = view.getFloat32(b + 16, true);
    normals[i * 3 + 2] = view.getFloat32(b + 20, true);
    uvs[i * 2] = view.getFloat32(b + 24, true);
    uvs[i * 2 + 1] = view.getFloat32(b + 28, true);

    // Four signed bytes that used to be an unused UV.w, now tangent + bitangent sign.
    const tx = view.getInt8(b + 32) / 127;
    const ty = view.getInt8(b + 33) / 127;
    const tz = view.getInt8(b + 34) / 127;
    const ts = view.getInt8(b + 35) / 127;
    // 00000000 means the mesh predates PBR tangents; leave those out rather
    // than feed importers a -1,-1,-1 vector.
    if (tx === 0 && ty === 0 && tz === 0) {
      badTangents++;
    } else {
      tangents[i * 4] = tx;
      tangents[i * 4 + 1] = ty;
      tangents[i * 4 + 2] = tz;
      tangents[i * 4 + 3] = ts;
    }

    if (hasColor) {
      colors[i * 4] = view.getUint8(b + 36);
      colors[i * 4 + 1] = view.getUint8(b + 37);
      colors[i * 4 + 2] = view.getUint8(b + 38);
      colors[i * 4 + 3] = view.getUint8(b + 39);
    }
  }

  if (badTangents > 0) {
    warnings.push(
      `${badTangents}/${count} vertices have no tangent (pre-PBR mesh), tangent layer omitted`
    );
  }

  return {
    positions,
    normals,
    uvs,
    colors,
    tangents: badTangents === count ? null : tangents,
    hasColor,
  };
}

function readSkinning(view, offset, count) {
  // Four subset indices + four bone weights per vertex, both unsigned bytes.
  const subsetIndices = new Uint8Array(count * 4);
  const weights = new Uint8Array(count * 4);
  for (let i = 0; i < count; i++) {
    const b = offset + i * SKIN_SIZE;
    for (let k = 0; k < 4; k++) {
      subsetIndices[i * 4 + k] = view.getUint8(b + k);
      weights[i * 4 + k] = view.getUint8(b + 4 + k);
    }
  }
  return { subsetIndices, weights };
}

function readBones(view, offset, count) {
  const bones = [];
  for (let i = 0; i < count; i++) {
    const b = offset + i * BONE_SIZE;
    const matrix = [];
    // matrix sits at +12 (right after the 4 name/parent/parent/culling fields)
    for (let k = 0; k < 9; k++) matrix.push(view.getFloat32(b + 12 + k * 4, true));
    bones.push({
      nameIndex: view.getUint32(b, true),
      parentIndex: view.getUint16(b + 4, true),
      lodParentIndex: view.getUint16(b + 6, true),
      culling: view.getFloat32(b + 8, true),
      matrix,
      translation: [
        view.getFloat32(b + 48, true),
        view.getFloat32(b + 52, true),
        view.getFloat32(b + 56, true),
      ],
    });
  }
  return bones;
}

function readSubsets(view, offset, count) {
  const subsets = [];
  for (let i = 0; i < count; i++) {
    const b = offset + i * SUBSET_SIZE;
    const boneIndices = [];
    for (let k = 0; k < 26; k++) {
      const value = view.getUint16(b + 20 + k * 2, true);
      if (value !== 0xffff) boneIndices.push(value);
    }
    subsets.push({
      facesBegin: view.getUint32(b, true),
      facesLength: view.getUint32(b + 4, true),
      vertsBegin: view.getUint32(b + 8, true),
      vertsLength: view.getUint32(b + 12, true),
      boneIndices,
    });
  }
  return subsets;
}

// FBX binary
//
// Blender dropped ASCII FBX import in 4.x and its 5.x parser is strict about the
// node layout, so this follows what Blender's own exporter emits:
//
//   * 23 byte magic (the 0x00 0x1a 0x00 tail is part of the magic), then a uint32
//     version. There is no encryption flag field.
//   * below 7500: 13 byte node headers and 13 byte end-of-block sentinels.
//   * attributes are child nodes, not properties ("FBXVersion" is a node holding
//     one int), Properties70 entries are nodes named P with five properties, and
//     connections are nodes named C. The older property form of all three is not
//     readable by the current parser.

const ENC = new TextEncoder();
const FBX_VERSION = 7400;
const FBX_MAGIC = 'Kaydara FBX Binary  ';

const P = {
  i: (v) => ({ t: 'i', v: v | 0 }),
  l: (v) => ({ t: 'l', v: BigInt(v) }),
  s: (v) => ({ t: 's', v: String(v) }),
  // scalar double: the importer asserts the value type of some Properties70
  // entries, and UnitScaleFactor has to be float64 rather than an array
  d: (v) => ({ t: 'd', v }),
  arrD: (values) => ({ t: 'ad', values }),
  arrI: (values) => ({ t: 'ai', values }),
};

const node = (name, props = [], children = []) => ({ name, props, children });

function propSize(p) {
  switch (p.t) {
    case 'i': return 5;
    case 'l': return 9;
    case 'd': return 9;
    case 's': return 1 + 4 + ENC.encode(p.v).length;
    case 'ad': return 13 + p.values.length * 8;
    case 'ai': return 13 + p.values.length * 4;
    default:
      throw new Error(`unknown fbx property ${p.t}`);
  }
}

function nodeSize(n) {
  let size = 13 + ENC.encode(n.name).length;
  for (const p of n.props) size += propSize(p);
  for (const c of n.children) size += nodeSize(c);
  n._size = size + 13; // + end-of-block sentinel
  return n._size;
}

class Blob {
  constructor(size) {
    this.bytes = new Uint8Array(size);
    this.view = new DataView(this.bytes.buffer);
    this.pos = 0;
  }
  u8(v) { this.view.setUint8(this.pos, v); this.pos += 1; }
  u32(v) { this.view.setUint32(this.pos, v, true); this.pos += 4; }
  i32(v) { this.view.setInt32(this.pos, v, true); this.pos += 4; }
  u64(v) { this.view.setBigUint64(this.pos, BigInt(v), true); this.pos += 8; }
  f64(v) { this.view.setFloat64(this.pos, v, true); this.pos += 8; }
  str(s) { const b = ENC.encode(s); this.u32(b.length); this.raw(b); }
  raw(b) { this.bytes.set(b, this.pos); this.pos += b.length; }
  sentinel() { this.u32(0); this.u32(0); this.u32(0); this.u8(0); }
}

function writeProp(blob, p) {
  switch (p.t) {
    case 'i': blob.u8(0x49); blob.i32(p.v); break;
    case 'l': blob.u8(0x4c); blob.u64(p.v); break;
    case 'd': blob.u8(0x44); blob.f64(p.v); break;
    case 's': blob.u8(0x53); blob.str(p.v); break;
    case 'ad':
      blob.u8(0x64);
      blob.u32(p.values.length);
      blob.u32(0); // 0 = uncompressed; the parser also accepts zlib
      blob.u32(p.values.length * 8);
      for (const v of p.values) blob.f64(v);
      break;
    case 'ai':
      blob.u8(0x69);
      blob.u32(p.values.length);
      blob.u32(0);
      blob.u32(p.values.length * 4);
      for (const v of p.values) blob.i32(v);
      break;
  }
}

function writeNode(blob, n) {
  const start = blob.pos;
  const endField = blob.pos;
  blob.u32(0);
  blob.u32(n.props.length);
  const propLenField = blob.pos;
  blob.u32(0);
  const name = ENC.encode(n.name);
  blob.u8(name.length);
  blob.raw(name);
  const propStart = blob.pos;
  for (const p of n.props) writeProp(blob, p);
  blob.view.setUint32(propLenField, blob.pos - propStart, true);
  for (const c of n.children) writeNode(blob, c);
  blob.sentinel();
  blob.view.setUint32(endField, blob.pos, true);

  if (n._size != null && blob.pos - start !== n._size) {
    throw new Error(`fbx node ${n.name} wrote ${blob.pos - start} bytes, sized ${n._size}`);
  }
}

// Pulls one LOD's face range out and renumbers so the FBX has no orphan vertices.
function buildGeometry(mesh, lod) {
  const totalFaces = mesh.faces.length / 3;
  let begin = 0;
  let end = totalFaces;
  if (lod != null && mesh.lodOffsets && lod + 1 < mesh.lodOffsets.length) {
    begin = mesh.lodOffsets[lod];
    end = mesh.lodOffsets[lod + 1];
  }
  begin = Math.max(0, Math.min(begin, totalFaces));
  end = Math.max(begin, Math.min(end, totalFaces));

  const remap = new Int32Array(mesh.positions.length / 3).fill(-1);
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];

  for (let f = begin; f < end; f++) {
    for (let c = 0; c < 3; c++) {
      const src = mesh.faces[f * 3 + c];
      let dst = remap[src];
      if (dst === -1) {
        dst = positions.length / 3;
        remap[src] = dst;
        positions.push(mesh.positions[src * 3], mesh.positions[src * 3 + 1], mesh.positions[src * 3 + 2]);
        normals.push(mesh.normals[src * 3], mesh.normals[src * 3 + 1], mesh.normals[src * 3 + 2]);
        uvs.push(mesh.uvs[src * 2], mesh.uvs[src * 2 + 1]);
      }
      indices.push(dst);
    }
  }

  return { positions, normals, uvs, indices, faceCount: end - begin };
}

// The parser splits the name property on \x00\x01 and expects the class after
// it, so object names have to carry that suffix.
const OBJ_NAME = (base, cls) => `${base}\x00\x01${cls}`;

const GEOMETRY_ID = 140000000;
const MODEL_ID = 220000000;

// ByPolygonVertex + Direct keeps each layer array in the same order as
// PolygonVertexIndex, so no index indirection is needed.
function layerElement(name, arrayName, values, layerName = '') {
  return node(name, [P.i(0)], [
    node('Version', [P.i(101)]),
    node('Name', [P.s(layerName)]),
    node('MappingInformationType', [P.s('ByPolygonVertex')]),
    node('ReferenceInformationType', [P.s('Direct')]),
    node(arrayName, [P.arrD(values)]),
  ]);
}

export function meshToFBX(mesh, options = {}) {
  const { name = 'mesh', lod = null, flipV = false, withTangents = true, withColor = true } = options;

  const geo = buildGeometry(mesh, lod);
  const safe = name.replace(/[^A-Za-z0-9_. -]/g, '');

  // FBX marks the last index of each polygon by bitwise-negating it.
  const polyIndices = new Array(geo.indices.length);
  for (let f = 0; f < geo.faceCount; f++) {
    polyIndices[f * 3] = geo.indices[f * 3];
    polyIndices[f * 3 + 1] = geo.indices[f * 3 + 1];
    polyIndices[f * 3 + 2] = ~geo.indices[f * 3 + 2];
  }

  // geo.normals / geo.uvs are per vertex, but ByPolygonVertex layers are per
  // polygon corner, so they have to be re-expanded through the index list.
  const normals = new Array(geo.indices.length * 3);
  const uv = new Array(geo.indices.length * 2);
  for (let i = 0; i < geo.indices.length; i++) {
    const v = geo.indices[i];
    normals[i * 3] = geo.normals[v * 3];
    normals[i * 3 + 1] = geo.normals[v * 3 + 1];
    normals[i * 3 + 2] = geo.normals[v * 3 + 2];
    uv[i * 2] = geo.uvs[v * 2];
    uv[i * 2 + 1] = flipV ? 1 - geo.uvs[v * 2 + 1] : geo.uvs[v * 2 + 1];
  }

  const geometryChildren = [
    node('Vertices', [P.arrD(geo.positions)]),
    node('PolygonVertexIndex', [P.arrI(polyIndices)]),
    node('GeometryVersion', [P.i(124)]),
    layerElement('LayerElementNormal', 'Normals', normals),
    layerElement('LayerElementUV', 'UV', uv, 'UVMap'),
  ];

  const layerRefs = ['LayerElementNormal', 'LayerElementUV'];

  if (withTangents && mesh.tangents) {
    const tangents = [];
    for (let i = 0; i < geo.indices.length; i++) {
      const src = geo.indices[i];
      tangents.push(
        mesh.tangents[src * 4],
        mesh.tangents[src * 4 + 1],
        mesh.tangents[src * 4 + 2],
        mesh.tangents[src * 4 + 3]
      );
    }
    geometryChildren.push(layerElement('LayerElementTangent', 'Tangents', tangents));
    layerRefs.push('LayerElementTangent');
  }

  if (withColor && mesh.colors) {
    const colors = [];
    for (let i = 0; i < geo.indices.length; i++) {
      const src = geo.indices[i];
      colors.push(
        mesh.colors[src * 4] / 255,
        mesh.colors[src * 4 + 1] / 255,
        mesh.colors[src * 4 + 2] / 255,
        mesh.colors[src * 4 + 3] / 255
      );
    }
    geometryChildren.push(layerElement('LayerElementColor', 'Colors', colors));
    layerRefs.push('LayerElementColor');
  }

  geometryChildren.push(
    node('Layer', [P.i(0)], [
      node('Version', [P.i(100)]),
      ...layerRefs.map((type) => node('LayerElement', [P.s(type), P.s('0')])),
    ])
  );

  const d = new Date();
  const rootChildren = [
    node('FBXHeaderExtension', [], [
      node('FBXHeaderVersion', [P.i(1003)]),
      node('FBXVersion', [P.i(FBX_VERSION)]),
      node('EncryptionType', [P.i(0)]),
      node('CreationTimeStamp', [], [
        node('Year', [P.i(d.getFullYear())]),
        node('Month', [P.i(d.getMonth() + 1)]),
        node('Day', [P.i(d.getDate())]),
        node('Hour', [P.i(d.getHours())]),
        node('Minute', [P.i(d.getMinutes())]),
        node('Second', [P.i(d.getSeconds())]),
        node('Millisecond', [P.i(d.getMilliseconds())]),
      ]),
      node('Creator', [P.s('jitterdev toys/mesh2fbx')]),
    ]),

    // The importer refuses to load without this, and reads the axis setup from
    // here. Roblox is Y up with -Z forward.
    node('GlobalSettings', [], [
      node('Version', [P.i(1000)]),
      node('Properties70', [], [
        node('P', [P.s('UpAxis'), P.s('int'), P.s('Integer'), P.s(''), P.i(1)]),
        node('P', [P.s('UpAxisSign'), P.s('int'), P.s('Integer'), P.s(''), P.i(1)]),
        node('P', [P.s('FrontAxis'), P.s('int'), P.s('Integer'), P.s(''), P.i(2)]),
        node('P', [P.s('FrontAxisSign'), P.s('int'), P.s('Integer'), P.s(''), P.i(1)]),
        node('P', [P.s('CoordAxis'), P.s('int'), P.s('Integer'), P.s(''), P.i(0)]),
        node('P', [P.s('CoordAxisSign'), P.s('int'), P.s('Integer'), P.s(''), P.i(1)]),
        node('P', [P.s('UnitScaleFactor'), P.s('double'), P.s('Number'), P.s(''), P.d(100)]),
        node('P', [P.s('OriginalUnitScaleFactor'), P.s('double'), P.s('Number'), P.s(''), P.d(100)]),
      ]),
    ]),

    node('Documents', [], [
      node('Count', [P.i(1)]),
      node('Document', [P.l(100000000), P.s(''), P.s('Scene')], [node('RootNode', [P.i(0)])]),
    ]),

    node('Definitions', [], [
      node('Version', [P.i(100)]),
      node('Count', [P.i(3)]),
      ...['GlobalSettings', 'Geometry', 'Model'].map((t) =>
        node('ObjectType', [P.s(t)], [node('Count', [P.i(1)])])
      ),
    ]),

    node('Objects', [], [
      node('Geometry', [P.l(GEOMETRY_ID), P.s(OBJ_NAME(safe, 'Geometry')), P.s('Mesh')], geometryChildren),
      node('Model', [P.l(MODEL_ID), P.s(OBJ_NAME(safe, 'Model')), P.s('Mesh')], [node('Version', [P.i(232)])]),
    ]),

    node('Connections', [], [
      // source -> destination, keyed by source: the geometry points at its model,
      // and the model points at the scene root
      node('C', [P.s('OO'), P.l(MODEL_ID), P.l(0)]),
      node('C', [P.s('OO'), P.l(GEOMETRY_ID), P.l(MODEL_ID)]),
    ]),
  ];

  const headerSize = ENC.encode(FBX_MAGIC).length + 3; // + 0x00 0x1a 0x00
  let total = headerSize + 4 + 13; // + uint32 version, + closing sentinel
  for (const n of rootChildren) total += nodeSize(n);

  const blob = new Blob(total);
  blob.raw(ENC.encode(FBX_MAGIC));
  blob.u8(0x00);
  blob.u8(0x1a);
  blob.u8(0x00);
  blob.u32(FBX_VERSION);
  for (const n of rootChildren) writeNode(blob, n);
  // the top level node loop stops when it reads a zero end offset, so the file
  // needs one trailing sentinel or the parser runs off the end
  blob.sentinel();

  return blob.bytes.subarray(0, blob.pos);
}

// mesh summary

export function describeMesh(mesh) {
  const nv = mesh.positions.length / 3;
  const nf = mesh.faces.length / 3;
  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];
  let degenerate = 0;
  let maxIndex = -1;

  for (let i = 0; i < nv; i++) {
    for (let k = 0; k < 3; k++) {
      const v = mesh.positions[i * 3 + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  for (let f = 0; f < nf; f++) {
    const a = mesh.faces[f * 3], b = mesh.faces[f * 3 + 1], c = mesh.faces[f * 3 + 2];
    if (a === b || b === c || a === c) degenerate++;
    // Spreading a typed array this size blows the stack, so walk it.
    if (a > maxIndex) maxIndex = a;
    if (b > maxIndex) maxIndex = b;
    if (c > maxIndex) maxIndex = c;
  }

  const size = [
    Number.isFinite(max[0]) ? max[0] - min[0] : 0,
    Number.isFinite(max[1]) ? max[1] - min[1] : 0,
    Number.isFinite(max[2]) ? max[2] - min[2] : 0,
  ];

  return { nv, nf, min, max, size, degenerate, maxIndex, outOfRange: maxIndex >= nv };
}

export function lodRanges(mesh) {
  if (!mesh.lodOffsets || mesh.lodOffsets.length < 2) return null;
  const ranges = [];
  for (let i = 0; i + 1 < mesh.lodOffsets.length; i++) {
    const begin = mesh.lodOffsets[i];
    const end = mesh.lodOffsets[i + 1];
    // A run of zeros means the LODS chunk is present but empty, which is what
    // Roblox writes for a mesh with no LODs at all. Keeping that range would
    // make the preview default to zero triangles and the mesh look broken.
    if (end <= begin) continue;
    ranges.push({
      index: ranges.length,
      label: i === 0 ? 'lod0 (base)' : `lod${i}`,
      begin,
      end,
      count: end - begin,
    });
  }
  return ranges.length ? ranges : null;
}
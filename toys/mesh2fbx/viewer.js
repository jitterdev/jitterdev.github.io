// Tiny software renderer so a converted mesh can be eyeballed without pulling in
// a 600kb 3d library. Z-buffered triangles into an ImageData, with perspective
// correct attributes and a mipmapped texture sampler.

const NEAR = 0.05;

// Box-filter a half-size mip level. Sampler state is per level, so this only ever
// needs the colour channels.
function downsample(src, sw, sh) {
  const dw = Math.max(1, sw >> 1);
  const dh = Math.max(1, sh >> 1);
  const out = new Uint8ClampedArray(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const sy0 = Math.min(sh - 1, y * 2);
    const sy1 = Math.min(sh - 1, y * 2 + 1);
    for (let x = 0; x < dw; x++) {
      const sx0 = Math.min(sw - 1, x * 2);
      const sx1 = Math.min(sw - 1, x * 2 + 1);
      const a = (sy0 * sw + sx0) * 4;
      const b = (sy0 * sw + sx1) * 4;
      const c = (sy1 * sw + sx0) * 4;
      const d = (sy1 * sw + sx1) * 4;
      const o = (y * dw + x) * 4;
      out[o] = (src[a] + src[b] + src[c] + src[d] + 2) >> 2;
      out[o + 1] = (src[a + 1] + src[b + 1] + src[c + 1] + src[d + 1] + 2) >> 2;
      out[o + 2] = (src[a + 2] + src[b + 2] + src[c + 2] + src[d + 2] + 2) >> 2;
      out[o + 3] = (src[a + 3] + src[b + 3] + src[c + 3] + src[d + 3] + 2) >> 2;
    }
  }
  return { data: out, width: dw, height: dh };
}

function buildMips(imageData) {
  const levels = [{
    data: imageData.data,
    width: imageData.width,
    height: imageData.height,
  }];
  let cur = levels[0];
  while (cur.width > 1 || cur.height > 1) {
    cur = downsample(cur.data, cur.width, cur.height);
    levels.push(cur);
  }
  return levels;
}

export function createViewer(canvas) {
  const ctx = canvas.getContext('2d');

  let mesh = null;
  let mips = null; // [{ data, width, height }], mips[0] is the original
  let faces = null;
  let yaw = 0.7;
  let pitch = 0.35;
  let dist = 4;
  let center = [0, 0, 0];
  let radius = 1;
  let wireframe = false;
  let textured = true;
  let flipV = false;
  let drag = null;

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    return dpr;
  }

  function fit() {
    if (!mesh) return;
    const n = mesh.positions.length / 3;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 3; k++) {
        const v = mesh.positions[i * 3 + k];
        if (v < min[k]) min[k] = v;
        if (v > max[k]) max[k] = v;
      }
    }
    center = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    radius = Math.max(0.001, Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2);
    dist = radius / Math.tan(0.4) + radius;
  }

  function basis() {
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    return {
      // screen-right is forward x up, and here forward is `back` (the camera
      // sits at centre - back*dist). Using (cy, 0, -sy) instead mirrors the
      // whole view left-to-right, which makes every mesh and every texture look
      // like it is being seen from behind.
      right: [-cy, 0, sy],
      up: [sy * sp, cp, cy * sp],
      back: [sy * cp, -sp, cy * cp],
    };
  }

  // Bilinear tap with wrapping, matching how mesh textures are meant to repeat.
  // Returns premultiplied-by-shade values straight into the target array.
  function tap(level, u, v, shade, out) {
    const L = mips[level];
    const w = L.width;
    const h = L.height;
    // texel centres, then wrap the four taps independently so the blend stays
    // correct right at the seam
    const fx = u * w - 0.5;
    const fy = v * h - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;

    const xa = ((x0 % w) + w) % w;
    const xb = ((x0 + 1) % w + w) % w;
    const ya = ((y0 % h) + h) % h;
    const yb = ((y0 + 1) % h + h) % h;

    const d = L.data;
    const p00 = (ya * w + xa) * 4;
    const p10 = (ya * w + xb) * 4;
    const p01 = (yb * w + xa) * 4;
    const p11 = (yb * w + xb) * 4;

    const w00 = (1 - tx) * (1 - ty);
    const w10 = tx * (1 - ty);
    const w01 = (1 - tx) * ty;
    const w11 = tx * ty;

    for (let c = 0; c < 3; c++) {
      out[c] =
        (d[p00 + c] * w00 + d[p10 + c] * w10 + d[p01 + c] * w01 + d[p11 + c] * w11) * shade;
    }
  }

  function render() {
    const dpr = resize();
    const W = canvas.width;
    const H = canvas.height;
    const img = ctx.createImageData(W, H);

    for (let i = 0; i < W * H; i++) {
      img.data[i * 4] = 24;
      img.data[i * 4 + 1] = 24;
      img.data[i * 4 + 2] = 38;
      img.data[i * 4 + 3] = 255;
    }

    if (!mesh || !faces || faces.length === 0) {
      ctx.putImageData(img, 0, 0);
      return { drawn: 0, culled: 0 };
    }

    const b = basis();
    const focal = H / 2 / Math.tan(0.4);
    const zbuf = new Float32Array(W * H).fill(Infinity);
    const { positions, normals, uvs } = mesh;
    const nv = positions.length / 3;

    const L = [-0.35, 0.75, 0.55];
    const ll = Math.hypot(L[0], L[1], L[2]);
    const Lx = L[0] / ll, Ly = L[1] / ll, Lz = L[2] / ll;

    const texW = mips ? mips[0].width : 1;
    const texH = mips ? mips[0].height : 1;
    const useTexture = mips && textured && texW > 0 && texH > 0;

    const sx = new Float32Array(nv);
    const sy = new Float32Array(nv);
    const sz = new Float32Array(nv);
    for (let i = 0; i < nv; i++) {
      const px = positions[i * 3] - center[0];
      const py = positions[i * 3 + 1] - center[1];
      const pz = positions[i * 3 + 2] - center[2];
      const vx = px * b.right[0] + py * b.right[1] + pz * b.right[2];
      const vy = px * b.up[0] + py * b.up[1] + pz * b.up[2];
      const vz = px * b.back[0] + py * b.back[1] + pz * b.back[2];
      const dz = Math.max(NEAR, vz + dist);
      sx[i] = W / 2 + (vx / dz) * focal;
      sy[i] = H / 2 - (vy / dz) * focal;
      sz[i] = vz + dist;
    }

    const px3 = new Float32Array(3);
    let drawn = 0;
    let culled = 0;

    for (let f = 0; f < faces.length; f += 3) {
      const i0 = faces[f], i1 = faces[f + 1], i2 = faces[f + 2];

      // Backface cull. y is projected pointing down, so a triangle whose outward
      // normal faces the camera winds clockwise here and gets negative area.
      // (Mirroring the basis flips this sign, so it is the opposite of what the
      // old mirrored projection needed.) The threshold also drops sub-pixel
      // slivers, which keeps 1/area finite for the degenerate triangles
      // collapsed meshes are full of.
      const x0 = sx[i0], y0 = sy[i0];
      const x1 = sx[i1], y1 = sy[i1];
      const x2 = sx[i2], y2 = sy[i2];
      const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
      if (area > -0.5) { culled++; continue; }

      const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
      const maxX = Math.min(W - 1, Math.ceil(Math.max(x0, x1, x2)));
      const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
      const maxY = Math.min(H - 1, Math.ceil(Math.max(y0, y1, y2)));
      if (minX > maxX || minY > maxY) { culled++; continue; }

      const invArea = 1 / area;

      // barycentric weight gradients are constant across the triangle
      const w0dx = (y1 - y2) * invArea, w0dy = (x2 - x1) * invArea;
      const w1dx = (y2 - y0) * invArea, w1dy = (x0 - x2) * invArea;
      const w2dx = -w0dx - w1dx, w2dy = -w0dy - w1dy;

      const z0 = sz[i0], z1 = sz[i1], z2 = sz[i2];
      const i0z = 1 / z0, i1z = 1 / z1, i2z = 1 / z2;
      const g0dx = w0dx * i0z, g1dx = w1dx * i1z, g2dx = w2dx * i2z;
      const g0dy = w0dy * i0z, g1dy = w1dy * i1z, g2dy = w2dy * i2z;

      const u0 = uvs[i0 * 2], v0 = uvs[i0 * 2 + 1];
      const u1 = uvs[i1 * 2], v1 = uvs[i1 * 2 + 1];
      const u2 = uvs[i2 * 2], v2 = uvs[i2 * 2 + 1];

      // geometric normal decides which side we are looking at
      const gax = positions[i1 * 3] - positions[i0 * 3];
      const gay = positions[i1 * 3 + 1] - positions[i0 * 3 + 1];
      const gaz = positions[i1 * 3 + 2] - positions[i0 * 3 + 2];
      const gbx = positions[i2 * 3] - positions[i0 * 3];
      const gby = positions[i2 * 3 + 1] - positions[i0 * 3 + 1];
      const gbz = positions[i2 * 3 + 2] - positions[i0 * 3 + 2];
      let gnx = gay * gbz - gaz * gby;
      let gny = gaz * gbx - gax * gbz;
      let gnz = gax * gby - gay * gbx;
      const gnl = Math.hypot(gnx, gny, gnz) || 1;
      gnx /= gnl; gny /= gnl; gnz /= gnl;
      const faceFlipped = gnx * b.back[0] + gny * b.back[1] + gnz * b.back[2] > 0;

      for (let y = minY; y <= maxY; y++) {
        const cy = y + 0.5;
        for (let x = minX; x <= maxX; x++) {
          const cx = x + 0.5;
          const w0 = ((x1 - cx) * (y2 - cy) - (x2 - cx) * (y1 - cy)) * invArea;
          const w1 = ((x2 - cx) * (y0 - cy) - (x0 - cx) * (y2 - cy)) * invArea;
          const w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;

          // 1/z is linear across the screen, so interpolate everything with it
          // and divide once at the end. Multiplying by the sum instead (or
          // defining the last weight as 1 - w0 - w1) rescales the result by
          // depth, which makes the texture crawl and shear per triangle.
          const q0 = w0 * i0z, q1 = w1 * i1z, q2 = w2 * i2z;
          const iz = q0 + q1 + q2;
          if (iz <= 0) continue;
          const invZ = 1 / iz;

          const idx = y * W + x;
          if (invZ >= zbuf[idx]) continue;
          zbuf[idx] = invZ;

          let nx = (q0 * normals[i0 * 3] + q1 * normals[i1 * 3] + q2 * normals[i2 * 3]) * invZ;
          let ny =
            (q0 * normals[i0 * 3 + 1] + q1 * normals[i1 * 3 + 1] + q2 * normals[i2 * 3 + 1]) * invZ;
          let nz =
            (q0 * normals[i0 * 3 + 2] + q1 * normals[i1 * 3 + 2] + q2 * normals[i2 * 3 + 2]) * invZ;
          let nl = Math.hypot(nx, ny, nz);
          if (nl > 1e-6) {
            nx /= nl; ny /= nl; nz /= nl;
          } else {
            nx = gnx; ny = gny; nz = gnz;
          }
          let d = nx * Lx + ny * Ly + nz * Lz;
          if (faceFlipped) d = -d;
          const shade = 0.25 + 0.75 * Math.abs(d);

          let r = 250 * shade, g = 179 * shade, bl = 135 * shade;

          if (useTexture) {
            let u = (q0 * u0 + q1 * u1 + q2 * u2) * invZ;
            let v = (q0 * v0 + q1 * v1 + q2 * v2) * invZ;
            if (flipV) v = 1 - v;

            // mip level from the uv footprint. N and D are both affine on screen,
            // so their gradients are the constant weight gradients above.
            const dDdx = g0dx + g1dx + g2dx;
            const dDdy = g0dy + g1dy + g2dy;
            const dNdx = g0dx * u0 + g1dx * u1 + g2dx * u2;
            const dNdy = g0dy * u0 + g1dy * u1 + g2dy * u2;
            const dMdx = g0dx * v0 + g1dx * v1 + g2dx * v2;
            const dMdy = g0dy * v0 + g1dy * v1 + g2dy * v2;

            const dudx = (dNdx * iz - (q0 * u0 + q1 * u1 + q2 * u2) * dDdx) * invZ * invZ;
            const dudy = (dNdy * iz - (q0 * u0 + q1 * u1 + q2 * u2) * dDdy) * invZ * invZ;
            const dvdx = (dMdx * iz - (q0 * v0 + q1 * v1 + q2 * v2) * dDdx) * invZ * invZ;
            const dvdy = (dMdy * iz - (q0 * v0 + q1 * v1 + q2 * v2) * dDdy) * invZ * invZ;

            const ax = dudx * texW, bx = dvdx * texH;
            const ay = dudy * texW, by = dvdy * texH;
            const rho = Math.max(Math.hypot(ax, bx), Math.hypot(ay, by));
            let lod = rho > 1 ? Math.log2(rho) : 0;
            const maxLod = mips.length - 1;
            if (lod > maxLod) lod = maxLod;
            const level = Math.min(maxLod, lod | 0);
            const frac = lod - level;

            tap(level, u, v, shade, px3);
            if (frac > 0.002 && level < maxLod) {
              const hi = new Float32Array(3);
              tap(level + 1, u, v, shade, hi);
              r = px3[0] + (hi[0] - px3[0]) * frac;
              g = px3[1] + (hi[1] - px3[1]) * frac;
              bl = px3[2] + (hi[2] - px3[2]) * frac;
            } else {
              r = px3[0]; g = px3[1]; bl = px3[2];
            }
          }

          const q = idx * 4;
          img.data[q] = r;
          img.data[q + 1] = g;
          img.data[q + 2] = bl;
          img.data[q + 3] = 255;
        }
      }
      drawn++;
    }

    ctx.putImageData(img, 0, 0);

    if (wireframe) {
      ctx.save();
      ctx.strokeStyle = 'rgba(137, 180, 250, 0.35)';
      ctx.lineWidth = Math.max(1, dpr * 0.6);
      ctx.beginPath();
      const limit = Math.min(faces.length, 30000);
      for (let f = 0; f < limit; f += 3) {
        const a = faces[f], c = faces[f + 1], d = faces[f + 2];
        ctx.moveTo(sx[a], sy[a]);
        ctx.lineTo(sx[c], sy[c]);
        ctx.lineTo(sx[d], sy[d]);
        ctx.closePath();
      }
      ctx.stroke();
      ctx.restore();
      if (faces.length > limit) {
        ctx.save();
        ctx.fillStyle = 'rgba(166, 173, 200, 0.9)';
        ctx.font = `${12 * dpr}px monospace`;
        ctx.fillText(
          `wireframe: first ${limit / 3} of ${faces.length / 3} faces`,
          10 * dpr,
          H - 10 * dpr
        );
        ctx.restore();
      }
    }

    return { drawn, culled };
  }

  canvas.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY, button: e.button, shift: e.shiftKey };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    drag.x = e.clientX;
    drag.y = e.clientY;
    if (drag.button === 2 || drag.shift) {
      const s = dist * 0.0022;
      const b = basis();
      for (let k = 0; k < 3; k++) center[k] -= (b.right[k] * dx + b.up[k] * -dy) * s;
    } else {
      yaw += dx * 0.01;
      pitch = Math.max(-1.5, Math.min(1.5, pitch + dy * 0.01));
    }
    render();
  });
  const endDrag = () => { drag = null; };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      dist *= Math.exp(e.deltaY * 0.0012);
      dist = Math.max(radius * 0.05, Math.min(dist, radius * 60));
      render();
    },
    { passive: false }
  );

  return {
    setMesh(m, faceSubset) {
      mesh = m;
      faces = faceSubset || m.faces;
      fit();
      return render();
    },
    setFaces(subset) {
      faces = subset;
      return render();
    },
    setTexture(imageData) {
      mips = buildMips(imageData);
      return render();
    },
    setWireframe(on) { wireframe = on; return render(); },
    setTextured(on) { textured = on; return render(); },
    setFlipV(on) { flipV = on; return render(); },
    resetView() {
      yaw = 0.7;
      pitch = 0.35;
      fit();
      return render();
    },
    // read-only camera state, so the drag tests can assert where the camera
    // actually went instead of inferring it from pixels
    viewState() {
      const b = basis();
      const c = [center[0] - b.back[0] * dist, center[1] - b.back[1] * dist, center[2] - b.back[2] * dist];
      return { yaw, pitch, center: center.slice(), dist, camera: c, basis: b };
    },
    render,
  };
}
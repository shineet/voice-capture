// lib/centerline.js
// Turns a raster line drawing (PNG buffer) into single-line STROKES by tracing
// the CENTRELINE of each inked line -- not its outline.
//
// Why not outline tracing (potrace): it traces the boundary of each black
// region, so every drawn line comes back as TWO parallel lines with a gap
// between them. That reads as an inked vector outline, not a hand-drawn pen
// stroke. Centrelining thins each line to its 1-pixel spine first, so one line
// in the picture becomes one pen stroke -- which is what looks hand-drawn.
//
// Pipeline: decode -> greyscale -> downscale -> binarise -> Zhang-Suen thinning
// -> walk the skeleton into polylines -> simplify -> normalise 0..1 + budget.
// Output is the app's stroke shape: [[x0,y0,x1,y1,...], ...].

const Jimp = require('jimp');

const WORK_MAX = 320;           // thinning cost is ~pixels; cap the work size
const INK_THRESHOLD = 160;      // luminance below this counts as ink (0..255)
const RDP_EPS = 1.2;            // Douglas-Peucker tolerance, in work-pixels
const MIN_STROKE_PTS = 2;
const MIN_STROKE_LEN = 3;       // drop skeleton crumbs shorter than this (px)
const MAX_STROKES = 200;
const MAX_TOTAL_POINTS = 3500;  // well inside the Motherboard's 12000 budget

// ── Decode + binarise ────────────────────────────────────────────────────────

async function toBinary(buffer) {
  const img = await Jimp.read(buffer);
  let { width, height } = img.bitmap;
  const scale = Math.min(1, WORK_MAX / Math.max(width, height));
  if (scale < 1) {
    img.resize(Math.round(width * scale), Math.round(height * scale), Jimp.RESIZE_BILINEAR);
    width = img.bitmap.width; height = img.bitmap.height;
  }
  const data = img.bitmap.data;   // RGBA
  const ink = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    // Luminance; treat transparent as white (background).
    const a = data[i + 3];
    const lum = a < 8 ? 255 : (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
    ink[p] = lum < INK_THRESHOLD ? 1 : 0;
  }
  return { ink, width, height };
}

// ── Zhang-Suen thinning ──────────────────────────────────────────────────────
// Reduces every ink region to a 1-pixel-wide skeleton, in place.

function thin(ink, w, h) {
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h) ? 0 : ink[y * w + x];
  let changed = true;
  const toClear = [];
  while (changed) {
    changed = false;
    for (let step = 0; step < 2; step++) {
      toClear.length = 0;
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          if (!ink[y * w + x]) continue;
          const p2 = at(x, y - 1), p3 = at(x + 1, y - 1), p4 = at(x + 1, y),
                p5 = at(x + 1, y + 1), p6 = at(x, y + 1), p7 = at(x - 1, y + 1),
                p8 = at(x - 1, y), p9 = at(x - 1, y - 1);
          const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (B < 2 || B > 6) continue;
          const seq = [p2, p3, p4, p5, p6, p7, p8, p9, p2];
          let A = 0;
          for (let k = 0; k < 8; k++) if (seq[k] === 0 && seq[k + 1] === 1) A++;
          if (A !== 1) continue;
          if (step === 0) {
            if (p2 * p4 * p6 !== 0) continue;
            if (p4 * p6 * p8 !== 0) continue;
          } else {
            if (p2 * p4 * p8 !== 0) continue;
            if (p2 * p6 * p8 !== 0) continue;
          }
          toClear.push(y * w + x);
        }
      }
      if (toClear.length) { changed = true; for (const idx of toClear) ink[idx] = 0; }
    }
  }
}

// ── Skeleton -> polylines ────────────────────────────────────────────────────

const N8 = [[-1,-1],[0,-1],[1,-1],[-1,0],[1,0],[-1,1],[0,1],[1,1]];

function traceSkeleton(ink, w, h) {
  const inkAt = (x, y) => (x < 0 || y < 0 || x >= w || y >= h) ? 0 : ink[y * w + x];
  const nbrs = (x, y) => {
    const out = [];
    for (const [dx, dy] of N8) if (inkAt(x + dx, y + dy)) out.push([x + dx, y + dy]);
    return out;
  };
  const visited = new Uint8Array(w * h);
  const polylines = [];

  // Follow a degree-2 chain from a start pixel, stepping first to (fx,fy), until
  // an endpoint/junction (degree != 2) or a dead end.
  const follow = (sx, sy, fx, fy) => {
    const poly = [[sx, sy]];
    let px = sx, py = sy, cx = fx, cy = fy;
    while (true) {
      poly.push([cx, cy]);
      visited[cy * w + cx] = 1;
      const nb = nbrs(cx, cy);
      if (nb.length !== 2) break;                 // endpoint or junction: stop here
      let nxt = null;
      for (const [ax, ay] of nb) {
        if (ax === px && ay === py) continue;
        if (visited[ay * w + ax]) continue;
        nxt = [ax, ay]; break;
      }
      if (!nxt) break;
      px = cx; py = cy; cx = nxt[0]; cy = nxt[1];
    }
    return poly;
  };

  // 1) Start from every endpoint/junction, one walk per unvisited branch.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!ink[y * w + x]) continue;
      const deg = nbrs(x, y).length;
      if (deg === 2) continue;                    // handled as part of a chain
      for (const [ax, ay] of nbrs(x, y)) {
        if (visited[ay * w + ax]) continue;
        polylines.push(follow(x, y, ax, ay));
      }
    }
  }
  // 2) Whatever is left is a pure loop (all degree 2): start anywhere and walk.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!ink[y * w + x] || visited[y * w + x]) continue;
      const nb = nbrs(x, y);
      if (!nb.length) continue;
      visited[y * w + x] = 1;
      polylines.push(follow(x, y, nb[0][0], nb[0][1]));
    }
  }
  return polylines;
}

// ── Simplify + normalise ─────────────────────────────────────────────────────

function rdp(points, eps) {
  if (points.length < 3) return points;
  let maxD = 0, idx = 0;
  const [ax, ay] = points[0], [bx, by] = points[points.length - 1];
  const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i];
    const d = Math.abs((px - ax) * dy - (py - ay) * dx) / len;
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD > eps) {
    const left = rdp(points.slice(0, idx + 1), eps);
    const right = rdp(points.slice(idx), eps);
    return left.slice(0, -1).concat(right);
  }
  return [points[0], points[points.length - 1]];
}

function polylineLength(pl) {
  let n = 0;
  for (let i = 1; i < pl.length; i++) n += Math.hypot(pl[i][0] - pl[i-1][0], pl[i][1] - pl[i-1][1]);
  return n;
}

function normaliseAndBudget(polylines, w, h) {
  let lines = polylines
    .filter(pl => pl.length >= MIN_STROKE_PTS && polylineLength(pl) >= MIN_STROKE_LEN)
    .map(pl => rdp(pl, RDP_EPS));

  // Uniform scale into [0.1, 0.9], preserving aspect + centring.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const pl of lines) for (const [px, py] of pl) {
    if (px < minX) minX = px; if (px > maxX) maxX = px;
    if (py < minY) minY = py; if (py > maxY) maxY = py;
  }
  if (!isFinite(minX)) return [];
  const bw = Math.max(1e-6, maxX - minX), bh = Math.max(1e-6, maxY - minY);
  const scale = 0.8 / Math.max(bw, bh);
  const offX = 0.5 - (minX + bw / 2) * scale;
  const offY = 0.5 - (minY + bh / 2) * scale;

  lines.sort((a, b) => b.length - a.length);
  if (lines.length > MAX_STROKES) lines = lines.slice(0, MAX_STROKES);

  let total = lines.reduce((n, pl) => n + pl.length, 0);
  let stride = 1;
  if (total > MAX_TOTAL_POINTS) stride = Math.ceil(total / MAX_TOTAL_POINTS);

  return lines.map(pl => {
    const flat = [];
    for (let k = 0; k < pl.length; k += stride) {
      const x = Math.min(1, Math.max(0, pl[k][0] * scale + offX));
      const y = Math.min(1, Math.max(0, pl[k][1] * scale + offY));
      flat.push(x, y);
    }
    // Always keep the last point so a stride never clips a stroke's end.
    const last = pl[pl.length - 1];
    flat.push(Math.min(1, Math.max(0, last[0] * scale + offX)),
              Math.min(1, Math.max(0, last[1] * scale + offY)));
    return flat;
  }).filter(f => f.length >= 4);
}

// ── Public API ───────────────────────────────────────────────────────────────

async function centerlineStrokes(buffer) {
  const { ink, width, height } = await toBinary(buffer);
  thin(ink, width, height);
  const polylines = traceSkeleton(ink, width, height);
  if (!polylines.length) throw new Error('Centreline produced no strokes');
  const strokes = normaliseAndBudget(polylines, width, height);
  if (!strokes.length) throw new Error('Centreline produced no usable strokes');
  return strokes;
}

module.exports = { centerlineStrokes };

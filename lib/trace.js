// lib/trace.js
// Turns a raster line drawing (PNG/JPG buffer) into line STROKES in the app's
// format: an array of strokes, each a flat [x0,y0,x1,y1,...] of coordinates
// normalised 0..1, origin top-left. Used by the high-quality AI sketch path,
// where an image model draws a clean recognisable picture and we vectorise it
// so it can print AND draw on the Motherboard (which only takes strokes).
//
// potrace traces the OUTLINE of the black regions, so a bold line drawing comes
// back as clean closed contours -- far more recognisable than an LLM plotting
// coordinates blind. Each traced subpath becomes one stroke.

const potrace = require('potrace');

// Motherboard budget is strokeCount + totalPointCount <= 12000; stay well under
// and keep it quick to draw. These are generous next to the coordinate route's
// ~500 points -- that headroom is what buys the extra detail.
const MAX_STROKES = 120;
const MAX_TOTAL_POINTS = 3000;
const CURVE_STEPS = 6;          // segments per Bezier -- smooth enough, cheap

// ── Minimal SVG path parser (the subset potrace emits: M, L, C, and Z) ───────

function tokenizePath(d) {
  // Split into command letters and numbers.
  const tokens = [];
  const re = /([MmLlHhVvCcSsQqTtAaZz])|(-?\d*\.?\d+(?:e-?\d+)?)/g;
  let m;
  while ((m = re.exec(d)) !== null) {
    tokens.push(m[1] || parseFloat(m[2]));
  }
  return tokens;
}

function bezier(p0, p1, p2, p3, steps) {
  const pts = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps, u = 1 - t;
    const x = u*u*u*p0[0] + 3*u*u*t*p1[0] + 3*u*t*t*p2[0] + t*t*t*p3[0];
    const y = u*u*u*p0[1] + 3*u*u*t*p1[1] + 3*u*t*t*p2[1] + t*t*t*p3[1];
    pts.push([x, y]);
  }
  return pts;
}

function quad(p0, p1, p2, steps) {
  const pts = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps, u = 1 - t;
    pts.push([u*u*p0[0] + 2*u*t*p1[0] + t*t*p2[0],
              u*u*p0[1] + 2*u*t*p1[1] + t*t*p2[1]]);
  }
  return pts;
}

// Parse one `d` attribute into an array of polylines (each a list of [x,y]).
// Handles absolute and relative forms of the commands potrace uses; a new
// subpath (M) starts a new polyline, Z closes it back to its start.
function pathToPolylines(d) {
  const t = tokenizePath(d);
  const lines = [];
  let cur = null;        // current polyline
  let x = 0, y = 0;      // current point
  let sx = 0, sy = 0;    // subpath start
  let i = 0, cmd = null;

  const num = () => t[i++];
  const isNum = (v) => typeof v === 'number';

  while (i < t.length) {
    if (typeof t[i] === 'string') { cmd = t[i++]; }
    const rel = cmd === cmd.toLowerCase();
    switch (cmd.toUpperCase()) {
      case 'M': {
        let nx = num(), ny = num();
        if (rel) { nx += x; ny += y; }
        x = nx; y = ny; sx = x; sy = y;
        if (cur && cur.length >= 2) lines.push(cur);
        cur = [[x, y]];
        cmd = rel ? 'l' : 'L';   // subsequent implicit coords are lineto
        break;
      }
      case 'L': {
        let nx = num(), ny = num();
        if (rel) { nx += x; ny += y; }
        x = nx; y = ny; cur.push([x, y]);
        break;
      }
      case 'H': {
        let nx = num(); if (rel) nx += x; x = nx; cur.push([x, y]); break;
      }
      case 'V': {
        let ny = num(); if (rel) ny += y; y = ny; cur.push([x, y]); break;
      }
      case 'C': {
        let x1 = num(), y1 = num(), x2 = num(), y2 = num(), nx = num(), ny = num();
        if (rel) { x1+=x; y1+=y; x2+=x; y2+=y; nx+=x; ny+=y; }
        bezier([x,y],[x1,y1],[x2,y2],[nx,ny], CURVE_STEPS).forEach(p => cur.push(p));
        x = nx; y = ny; break;
      }
      case 'Q': {
        let x1 = num(), y1 = num(), nx = num(), ny = num();
        if (rel) { x1+=x; y1+=y; nx+=x; ny+=y; }
        quad([x,y],[x1,y1],[nx,ny], CURVE_STEPS).forEach(p => cur.push(p));
        x = nx; y = ny; break;
      }
      case 'Z': {
        if (cur) { cur.push([sx, sy]); if (cur.length >= 2) lines.push(cur); cur = null; }
        x = sx; y = sy; break;
      }
      default:
        // Unknown command -- bail out of the token to avoid an infinite loop.
        if (isNum(t[i])) i++; else i++;
    }
  }
  if (cur && cur.length >= 2) lines.push(cur);
  return lines;
}

// ── Normalise + budget ───────────────────────────────────────────────────────

function normaliseAndBudget(polylines) {
  // Uniform scale into [0.1, 0.9], preserving aspect ratio and centring.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const pl of polylines) for (const [px, py] of pl) {
    if (px < minX) minX = px; if (px > maxX) maxX = px;
    if (py < minY) minY = py; if (py > maxY) maxY = py;
  }
  const w = Math.max(1e-6, maxX - minX), h = Math.max(1e-6, maxY - minY);
  const scale = 0.8 / Math.max(w, h);
  const offX = 0.5 - (minX + w / 2) * scale;
  const offY = 0.5 - (minY + h / 2) * scale;
  const map = ([px, py]) => [px * scale + offX, py * scale + offY];

  // Biggest strokes first (by point count), so if we hit the stroke cap we keep
  // the ones that carry the shape and drop tiny specks.
  let lines = polylines.map(pl => pl.map(map)).sort((a, b) => b.length - a.length);
  if (lines.length > MAX_STROKES) lines = lines.slice(0, MAX_STROKES);

  // If total points blow the budget, thin every stroke by an even stride, always
  // keeping first and last so no stroke loses its endpoints.
  let total = lines.reduce((n, pl) => n + pl.length, 0);
  if (total > MAX_TOTAL_POINTS) {
    const stride = Math.ceil(total / MAX_TOTAL_POINTS);
    lines = lines.map(pl => {
      if (pl.length <= 3) return pl;
      const out = [];
      for (let k = 0; k < pl.length; k += stride) out.push(pl[k]);
      if (out[out.length - 1] !== pl[pl.length - 1]) out.push(pl[pl.length - 1]);
      return out;
    });
  }

  // Flatten each polyline to the app's [x0,y0,x1,y1,...] and clamp to 0..1.
  return lines
    .filter(pl => pl.length >= 2)
    .map(pl => {
      const flat = [];
      for (const [px, py] of pl) {
        flat.push(Math.min(1, Math.max(0, px)), Math.min(1, Math.max(0, py)));
      }
      return flat;
    });
}

// ── Public API ───────────────────────────────────────────────────────────────

// Trace a PNG/JPG buffer to strokes. `threshold` (0..255) decides what counts
// as ink; `turdSize` drops speckles smaller than that many pixels.
function traceToStrokes(buffer, { threshold = 128, turdSize = 8 } = {}) {
  return new Promise((resolve, reject) => {
    potrace.trace(buffer, { threshold, turdSize, optCurve: true, turnPolicy: 'minority' },
      (err, svg) => {
        if (err) return reject(err);
        // Pull every path's `d` and merge their polylines.
        const ds = [...svg.matchAll(/\sd="([^"]+)"/g)].map(m => m[1]);
        let polylines = [];
        for (const d of ds) polylines = polylines.concat(pathToPolylines(d));
        if (!polylines.length) return reject(new Error('Trace produced no strokes'));
        resolve(normaliseAndBudget(polylines));
      });
  });
}

module.exports = { traceToStrokes, pathToPolylines };

// api/sketch.js
// POST { word: string } -> { strokes: [[x0,y0,x1,y1,...], ...], engine }
//
// The fallback for when the app's built-in library drawing for a word is wrong.
// Returns STROKES (flat [x,y,...] arrays, normalised 0..1, origin top-left) --
// the bundled-library shape -- so the result flows through the app's hand-drawn
// pencil renderer for the printers AND the Motherboard's path contract alike.
//
// Two engines, tried in order:
//   1. IMAGE (default): an image model draws a clean, recognisable line picture,
//      then lib/trace.js vectorises it to strokes. Slower (~10-15s) but the only
//      route that actually looks like the thing -- a text model plotting
//      coordinates blind cannot draw an organic shape (a dog came out a blob).
//      This is what makes an occasional AI redraw good enough to replace the
//      library drawing for that word.
//   2. COORDINATE (fallback): the old route -- a text model emits coordinates
//      directly. Fast, fine for simple/rigid objects, used only if the image
//      step fails so the button never dead-ends.
//
// The OpenAI key stays here, server-side, same as transcribe.js.

const { centerlineStrokes } = require('../lib/centerline.js');

const MODEL = process.env.SKETCH_MODEL || 'gpt-4o';
const IMAGE_MODEL = process.env.SKETCH_IMAGE_MODEL || 'gpt-image-1';
// Set false to force the fast coordinate route (e.g. if image billing is off).
const USE_IMAGE = process.env.SKETCH_USE_IMAGE !== 'false';

// Keep well inside the Motherboard budget (strokeCount + totalPointCount <=
// 12000) and fast to draw: a quick sketch, not an engraving.
const MAX_STROKES = 18;
const MAX_POINTS_PER_STROKE = 60;
const MAX_TOTAL_POINTS = 500;

const SYSTEM = [
  'You draw a single everyday object as a simple hand-drawn line sketch, the',
  'way someone would quickly scribble it with a pen. Output ONLY strokes -- no',
  'shading, no fill, no colour, no text or labels.',
  '',
  'Return STRICT JSON of the form {"strokes": [[x0,y0,x1,y1, ...], ...]}.',
  'Each stroke is one continuous pen line as a flat array of alternating x,y',
  'numbers. Coordinates are normalised 0.0 to 1.0, origin top-left, y increasing',
  'downward. Keep the whole drawing inside 0.12..0.88 in both axes, roughly',
  'centred. Use at most ' + MAX_STROKES + ' strokes and about ' +
    MAX_TOTAL_POINTS + ' points total.',
  '',
  // The failure this fixes: without it, the model emits one long meandering
  // contour -- each stroke starting exactly where the last ended -- which
  // reads as a shapeless blob for anything organic (animals worst of all).
  // Forcing named parts placed independently is the single biggest lever on
  // recognisability for a token-by-token generator that cannot see its output.
  'CRITICAL: compose the object from its DISTINCT PARTS, and draw each part as',
  'its own separate stroke placed at its own position. Do NOT trace one long',
  'continuous outline; do NOT start a stroke where the previous stroke ended',
  'unless those two lines truly meet on the object. Before drawing, decide the',
  'object\u{2019}s major parts and where each sits, then draw them. For an animal',
  'in side profile that means roughly: one stroke for the body, one for the',
  'head, a separate short stroke for EACH leg, one per ear, one for the tail,',
  'and a small dot/circle for the eye -- each as its own stroke in its own',
  'place, not chained together. For a person: head, body, each arm, each leg',
  'separately. Simple rigid objects (cup, box, key, house) can be a few clean',
  'lines. Aim for a clear recognisable silhouette a stranger could name at a',
  'glance. No commentary, JSON only.',
].join(' ');

function clamp01(v) {
  if (typeof v !== 'number' || !isFinite(v)) return null;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

// Pull the model's strokes into the app's exact format, dropping anything
// malformed and enforcing the budget so a runaway response can never reach the
// board or printer.
function sanitise(raw) {
  if (!raw || !Array.isArray(raw.strokes)) return null;
  const out = [];
  let total = 0;
  for (const s of raw.strokes) {
    if (out.length >= MAX_STROKES) break;
    if (!Array.isArray(s)) continue;
    const flat = [];
    for (let i = 0; i + 1 < s.length; i += 2) {
      const x = clamp01(s[i]);
      const y = clamp01(s[i + 1]);
      if (x === null || y === null) continue;
      flat.push(x, y);
      if (flat.length / 2 >= MAX_POINTS_PER_STROKE) break;
    }
    if (flat.length < 4) continue;            // need >= 2 points to be a line
    out.push(flat);
    total += flat.length / 2;
    if (total >= MAX_TOTAL_POINTS) break;
  }
  return out.length ? out : null;
}

// ── Engine 1: image model, then trace ────────────────────────────────────────

const IMAGE_PROMPT = (word) =>
  `A simple black and white line drawing of a ${word}. Bold, clean, solid black `
  + `outlines on a plain pure-white background. Minimalist coloring-book style, a `
  + `single centred object filling most of the frame. No shading, no grey, no `
  + `fill, no colour, no background scenery, no text, no border. Just clear black `
  + `outlines of the ${word} so it is instantly recognisable.`;

async function sketchByImage(word) {
  const r = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: IMAGE_MODEL,
      prompt: IMAGE_PROMPT(word),
      size: '1024x1024',
      n: 1,
    }),
  });
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    throw new Error(data.error?.message || `Image model HTTP ${r.status}`);
  }
  const data = await r.json();
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) throw new Error('Image model returned no image');
  const buffer = Buffer.from(b64, 'base64');
  // Centreline-trace the line art to strokes: each drawn line becomes ONE pen
  // stroke (outline tracing doubled every line, which looked like vector art,
  // not a hand drawing).
  const strokes = await centerlineStrokes(buffer);
  if (!strokes || !strokes.length) throw new Error('Trace produced no strokes');
  return strokes;
}

// ── Engine 2: coordinate route (fallback) ────────────────────────────────────

async function sketchByCoordinates(word) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.7,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `Draw: ${word}` },
      ],
    }),
  });
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    throw new Error(data.error?.message || `Coordinate model HTTP ${r.status}`);
  }
  const data = await r.json();
  const content = data.choices?.[0]?.message?.content || '';
  let parsed;
  try { parsed = JSON.parse(content); } catch { throw new Error('Model returned malformed drawing'); }
  const strokes = sanitise(parsed);
  if (!strokes) throw new Error('Model returned an empty drawing');
  return strokes;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  // Keep-warm ping, same idea as transcribe.js.
  if (req.method === 'GET') return res.status(200).json({ status: 'warm' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY is not configured' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
  const word = (body && typeof body.word === 'string') ? body.word.trim() : '';
  if (!word) return res.status(400).json({ error: 'Missing word' });
  if (word.length > 60) return res.status(400).json({ error: 'Word too long' });

  // Try the good engine first; fall back to the fast one so the button never
  // dead-ends. `engine` in the reply says which one drew it.
  if (USE_IMAGE) {
    try {
      const strokes = await sketchByImage(word);
      return res.status(200).json({ strokes, engine: 'image' });
    } catch (err) {
      console.error('sketch image engine failed, falling back to coordinates:', err.message);
    }
  }

  try {
    const strokes = await sketchByCoordinates(word);
    return res.status(200).json({ strokes, engine: 'vector' });
  } catch (err) {
    console.error('sketch error:', err.message);
    return res.status(502).json({ error: err.message });
  }
};

// The image model can take 10-15s; the default 10s function budget would cut it
// off. Vercel Hobby allows up to 60s when asked. (vercel.json sets this too, but
// this keeps it correct if that file changes.)
module.exports.config = { maxDuration: 60 };

// api/scene-find.js
// POST { photo, description } -> { corners: [{x,y} x4], note }
//
// Finds the surface in a photograph from a description of it -- "the licence
// plate numbers", "the house number by the door", "the cat's left eye" -- and
// returns its four corners.
//
// This replaces dragging a box by hand, and the reason it matters is that the
// box is usually TINY. The whole effect depends on the reveal being small
// enough that it is only found by zooming in, so the surface is often a number
// plate a few dozen pixels across in a photo shown on a phone. Placing four
// corners on that by thumb is fiddly at best and slightly wrong at worst, and
// slightly wrong is the difference between lettering that sits on the plate and
// lettering that hangs off it.
//
// Four corners rather than a rectangle, because a plate photographed from
// anywhere but dead-on is a trapezium, and that shape is exactly what makes the
// text later look painted on rather than stuck on. Asking for a box would throw
// away the one thing worth having.
//
// The answer is a starting point, not a verdict: the app still shows the
// corners on the photo and lets them be nudged. A model that puts them nearly
// right has done the hard part.

const MODEL = process.env.SCENE_FIND_MODEL || 'gpt-4o';

const SYSTEM = [
  'You locate a specific surface in a photograph and return its four corners.',
  '',
  'Return STRICT JSON only:',
  '{"found": true|false,',
  ' "corners": {"topLeft":{"x":0.0,"y":0.0}, "topRight":{"x":0.0,"y":0.0},',
  '             "bottomRight":{"x":0.0,"y":0.0}, "bottomLeft":{"x":0.0,"y":0.0}},',
  ' "note": "<one short sentence naming what you found and where>"}',
  '',
  'Coordinates are fractions of the image, 0.0 to 1.0, origin TOP-LEFT, x to the',
  'right and y downward. Give at least three decimal places: these surfaces are',
  'often small, and rounding to two decimals can be several percent of the',
  'image, which lands the box off the object entirely.',
  '',
  'Follow the surface corner for corner as it appears IN THE PHOTOGRAPH,',
  'including its perspective. If the object is seen at an angle the four corners',
  'form a trapezium, not a rectangle -- do not straighten it. topLeft is the',
  'corner nearest the top-left OF THE OBJECT as it sits in the picture, and the',
  'rest follow clockwise from it.',
  '',
  'Bound the WRITABLE AREA, not the whole object. Asked for the numbers on a',
  'licence plate, return the area the characters occupy, inside the plate frame',
  'and inside the state name and any border, not the outline of the plate.',
  '',
  'If the photograph does not contain what was described, set found to false and',
  'say so in the note. Do not return a guess: a box in the wrong place is worse',
  'than no box, because it looks like it worked.',
].join('\n');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: 'OPENAI_API_KEY is not configured' });
  }

  try {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
    const { photo, description } = body || {};
    if (!photo) return res.status(400).json({ error: 'No photo' });
    const want = (typeof description === 'string' ? description : '').trim();
    if (!want) return res.status(400).json({ error: 'Say what to find' });

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        response_format: { type: 'json_object' },
        max_tokens: 400,
        temperature: 0,
        messages: [
          { role: 'system', content: SYSTEM },
          {
            role: 'user',
            content: [
              { type: 'text', text: `Find: ${want}` },
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${photo}`, detail: 'high' } },
            ],
          },
        ],
      }),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      return res.status(502).json({ error: `Model refused (${r.status}): ${text.slice(0, 300)}` });
    }
    const out = JSON.parse((await r.json())?.choices?.[0]?.message?.content || '{}');

    if (out.found === false) {
      return res.status(404).json({
        error: out.note || `Could not find "${want}" in this photo`,
      });
    }

    const order = ['topLeft', 'topRight', 'bottomRight', 'bottomLeft'];
    const corners = order.map((k) => out?.corners?.[k]);
    if (corners.some((c) => !c || !Number.isFinite(Number(c.x)) || !Number.isFinite(Number(c.y)))) {
      return res.status(502).json({ error: 'The model did not return four corners' });
    }
    const clean = corners.map((c) => ({
      x: Math.min(Math.max(Number(c.x), 0), 1),
      y: Math.min(Math.max(Number(c.y), 0), 1),
    }));

    // A degenerate quad renders nothing at all and would look like the feature
    // silently failing, so it is reported as the failure it is.
    const xs = clean.map((c) => c.x), ys = clean.map((c) => c.y);
    const w = Math.max(...xs) - Math.min(...xs);
    const h = Math.max(...ys) - Math.min(...ys);
    if (w < 0.004 || h < 0.002) {
      return res.status(502).json({ error: 'The area it found is too small to write on' });
    }

    res.json({
      corners: clean,
      note: typeof out.note === 'string' ? out.note.slice(0, 300) : '',
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
};

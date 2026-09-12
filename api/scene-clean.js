// api/scene-clean.js
// POST { image, mask } (both base64 PNG, same size) -> { image: base64 PNG }
//
// Wipes the existing lettering off a surface so a value can be written there
// later.
//
// This is the half of the effect that compositing alone cannot do. A real
// photograph of a car has a real number on the plate; drawing over it leaves
// two numbers fighting, and no amount of matching the font fixes that. The
// original has to go, and putting back what was UNDER it -- the sheen of the
// plate, the shadow across it, the grain of the paint -- is an image problem,
// not a drawing one.
//
// It runs ONCE, at setup, and the cleaned photo is saved in the app. At
// performance time nothing here is called: the phone draws the value onto a
// surface that is already blank. So this being slow, or expensive, or needing
// a network, costs nothing when it matters.
//
// The app sends the pieces because it is the side with an image toolkit: a
// square crop around the surface, and a mask with a hole cut in it. This
// endpoint's whole job is to hold the key and speak multipart.

const MODEL = process.env.SCENE_CLEAN_MODEL || 'gpt-image-1';

const PROMPT = [
  'Remove every letter, number, character and marking from inside the masked',
  'area, leaving the surface completely blank and empty.',
  '',
  // The failure this line exists to stop: given a white Texas number plate with
  // the characters masked, the model returned a blank BLACK plate. Structurally
  // perfect and useless -- the car in the photograph now has a plate that is
  // the wrong colour, which anybody zooming in would notice before they noticed
  // anything else. It fills the hole convincingly and feels no obligation to
  // match what it replaced unless told to.
  'CRITICAL: the area you fill must be the SAME COLOUR, brightness and material',
  'as the surface immediately surrounding it, inside the same object. If it is a',
  'white licence plate, fill it white. If it is a painted wall, fill it that',
  'exact shade of paint. Sample the colour from the parts of that same surface',
  'that are still visible just outside the masked area and continue them. Do not',
  'darken, lighten, tint or restyle it.',
  '',
  'Continue the material exactly: its texture, grain, reflections, shadows and',
  'lighting, so the result looks like an untouched photograph of that object',
  'with nothing ever written on it. Keep the edges, borders, screws, frame and',
  'any surrounding detail exactly as they are.',
  '',
  'Do not add any text, numbers, symbols, logos, watermarks or decoration.',
  'Do not change anything outside the masked area.',
].join(' ');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: 'OPENAI_API_KEY is not configured' });
  }

  try {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
    const { image, mask } = body || {};
    if (!image) return res.status(400).json({ error: 'No image' });
    if (!mask) return res.status(400).json({ error: 'No mask' });

    const form = new FormData();
    form.append('model', MODEL);
    form.append('prompt', PROMPT);
    form.append('n', '1');
    // Square, matching what the app sends. Asking for a different shape here
    // would have the model letterbox or crop the surface, and the app composites
    // the result straight back into the original photo by position -- so a
    // shifted crop would land the clean plate slightly off the real one.
    form.append('size', '1024x1024');
    form.append('image', new Blob([Buffer.from(image, 'base64')], { type: 'image/png' }),
                'image.png');
    // Transparent where the model may paint. The app cuts the hole, because it
    // is the side that knows where the four corners are and has something to
    // draw them with.
    form.append('mask', new Blob([Buffer.from(mask, 'base64')], { type: 'image/png' }),
                'mask.png');

    const r = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
      body: form,
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      return res.status(502).json({ error: `Image edit failed (${r.status}): ${text.slice(0, 300)}` });
    }
    const json = await r.json();
    const b64 = json?.data?.[0]?.b64_json;
    if (!b64) return res.status(502).json({ error: 'No image came back' });

    res.json({ image: b64 });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
};

// api/scene-style.js
// POST { photo, crop, kind, fonts, current?, instruction? } -> a style template
//
// Looks at a photograph and works out how lettering would have to look to
// belong in it: which face, what colour, how tightly set, how soft.
//
// What comes back is a TEMPLATE -- a handful of numbers and a font name -- and
// never an image. That is the whole point of doing it this way. An image model
// could paint a value into the photo beautifully, but the value is not known
// until a spectator says it, so painting it would mean a 10-15 second round
// trip in the middle of a performance, over whatever wifi the venue has, and a
// reveal that fails when the network does. Deciding the STYLE up front and
// rendering the value on the phone means the performance is instant, offline,
// and works for any word or number that turns up.
//
// So the model is being asked the one question it is actually better at than
// code -- "what does the lettering in this picture look like" -- and nothing
// that has to be right at showtime.
//
// The OpenAI key stays here, server-side, same as transcribe.js and sketch.js.

const MODEL = process.env.SCENE_STYLE_MODEL || 'gpt-4o';

// The bounds the app's renderer actually honours. Everything the model returns
// is clamped to these: a plausible-looking number outside the range would show
// up as a control that has mysteriously stopped responding.
const LIMITS = {
  tracking: [-0.08, 0.30],
  fill: [0.4, 1.0],
  softness: [0.0, 0.08],
  opacity: [0.3, 1.0],
};

const clamp = (v, [lo, hi], fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : fallback;
};

const SYSTEM = [
  'You are matching lettering to a photograph so that a value added to it later',
  'will look like it was always part of the picture, even under close zoom.',
  '',
  'You are given the whole photo with a yellow outline marking the surface the',
  'value will sit on, and a close crop of that surface. Decide how lettering on',
  'THAT surface, in THAT photo, would actually look.',
  '',
  'Judge from the picture, not from habit:',
  '- The FACE. Pick the one from the supplied list whose description fits the',
  '  real object. A vehicle plate, a painted door number, a chalk board and an',
  '  engraved plaque are four different kinds of lettering.',
  '- The COLOUR. Read it off the photo. If the surface already carries lettering,',
  '  match it. Never pure black or pure white: nothing in a photograph is pure',
  '  anything, and it is the clearest giveaway under zoom.',
  '- The SOFTNESS. Match how sharp that part of the PHOTO is. Lettering crisper',
  '  than the pixels around it reads as an overlay even when nobody can say why.',
  '  A sharp, well-lit close-up wants near zero; a distant, motion-blurred or',
  '  shallow-depth-of-field surface wants much more.',
  '- The SPACING and CASE. Plates and signs are usually capitals and often set',
  '  wide. Handwriting is not.',
  '- The WEIGHT. Match it; do not reach for a bold face by default. Ordinary',
  '  printing on paper, a typed label, a receipt, a book page are all set at a',
  '  normal weight, and a bold substitute reads as the wrong font immediately',
  '  even when the shapes are right. The list contains plain faces as well as',
  '  heavy ones; the heavy ones are for plates, road signs and posters.',
  '- The FILL. How much of the marked surface real lettering would occupy,',
  '  leaving the margin the real object has.',
  '',
  'Return STRICT JSON only:',
  '{"fontName": "<exact name from the list>", "ink": "#rrggbb",',
  ' "uppercase": true|false, "tracking": <number>, "fill": <number>,',
  ' "softness": <number>, "opacity": <number>, "note": "<one short sentence>"}',
  '',
  'tracking is extra space between characters as a fraction of type size,',
  `${LIMITS.tracking[0]} to ${LIMITS.tracking[1]} (negative is tighter).`,
  `fill is ${LIMITS.fill[0]} to ${LIMITS.fill[1]}.`,
  `softness is blur as a fraction of the surface's height, ${LIMITS.softness[0]} to ${LIMITS.softness[1]}.`,
  `opacity is ${LIMITS.opacity[0]} to ${LIMITS.opacity[1]}; slightly under 1 lets the`,
  'surface texture show through the way real paint does.',
  '',
  'note is for the performer: say in plain words what you matched and why, so a',
  'human can tell whether you looked at the right thing. No jargon.',
].join('\n');

async function ask(messages) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      response_format: { type: 'json_object' },
      max_tokens: 500,
      // Low but not zero: this is a judgement about an image, and the refine
      // step is useless if asking again always returns the identical answer.
      temperature: 0.3,
    }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`Model refused (${r.status}): ${body.slice(0, 300)}`);
  }
  const json = await r.json();
  const text = json?.choices?.[0]?.message?.content;
  if (!text) throw new Error('Model returned nothing');
  return JSON.parse(text);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: 'OPENAI_API_KEY is not configured' });
  }

  try {
    // Vercel usually parses JSON for us, but not always -- sketch.js learned
    // the same lesson.
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
    const { photo, crop, kind, fonts, current, instruction } = body || {};
    if (!photo) return res.status(400).json({ error: 'No photo' });
    if (!Array.isArray(fonts) || !fonts.length) {
      return res.status(400).json({ error: 'No font list' });
    }

    const catalogue = fonts
      .map((f) => `- ${f.name} :: ${f.label}`)
      .join('\n');

    const content = [
      {
        type: 'text',
        text: [
          `The value that will land here is a ${kind === 'number' ? 'NUMBER' : 'WORD'}.`,
          '',
          'Choose fontName from exactly this list, copying the name verbatim:',
          catalogue,
          '',
          // Refining is a continuation, not a fresh look: without the current
          // template the model re-decides everything and "a bit wider" comes
          // back with a different face as well.
          current
            ? `The template right now is ${JSON.stringify(current)}. Change it as asked and leave everything else alone.`
            : 'There is no template yet. Propose one.',
          instruction
            ? `The performer says: "${instruction}"`
            : '',
        ].filter(Boolean).join('\n'),
      },
      { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${photo}`, detail: 'high' } },
    ];
    if (crop) {
      content.push({ type: 'text', text: 'Close crop of the marked surface:' });
      content.push({
        type: 'image_url',
        image_url: { url: `data:image/jpeg;base64,${crop}`, detail: 'high' },
      });
    }

    const out = await ask([
      { role: 'system', content: SYSTEM },
      { role: 'user', content },
    ]);

    // A font name the app does not have would fall back to the system font at
    // render time and look, to Shine, like the feature quietly did nothing. So
    // an unknown name is an explicit failure of THIS call, not a silent
    // downgrade discovered later on a stage.
    const known = fonts.some((f) => f.name === out.fontName);
    if (!known) {
      return res.status(502).json({
        error: `Model chose a font that is not installed: ${out.fontName}`,
      });
    }

    const ink = typeof out.ink === 'string' && /^#[0-9a-fA-F]{6}$/.test(out.ink.trim())
      ? out.ink.trim()
      : '#1a1a1f';

    res.json({
      fontName: out.fontName,
      ink,
      uppercase: out.uppercase === true,
      tracking: clamp(out.tracking, LIMITS.tracking, -0.02),
      fill: clamp(out.fill, LIMITS.fill, 0.86),
      softness: clamp(out.softness, LIMITS.softness, 0.012),
      opacity: clamp(out.opacity, LIMITS.opacity, 0.92),
      note: typeof out.note === 'string' ? out.note.slice(0, 300) : '',
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
};

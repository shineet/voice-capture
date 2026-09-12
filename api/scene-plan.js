// api/scene-plan.js
// POST { instruction, found: [{ index, text, width, height }] } -> a plan
//
// Turns one sentence -- "replace the licence plate number but keep the HZK" --
// into a decision about which piece of writing in the photograph is the target
// and how much of it survives.
//
// Note what is NOT asked here: where anything is. The app has already read the
// photograph with Vision and knows the exact corners of every piece of text in
// it, to the pixel, with its real perspective. Asking a model for coordinates
// was tried and does not work -- it put the box on the grille above the plate,
// then on the bumper below it. So the model is given the STRINGS and asked the
// only question it is better at than code: which of these did the performer
// mean, and which part of it should stay.
//
// A language decision made by a language model; a measurement made by a
// measuring tool. Each doing what it is good at is the whole design.

const MODEL = process.env.SCENE_PLAN_MODEL || 'gpt-4o';

const SYSTEM = [
  'A performer has a photograph and wants a value revealed inside it, written',
  'onto something already in the picture. You are given every piece of text the',
  'photograph contains, already located exactly, and one sentence describing',
  'what they want. Decide which piece of text is the target and how much of it',
  'is kept.',
  '',
  'Return STRICT JSON only:',
  '{"index": <number>, "keep": "<text that stays, or empty>",',
  ' "kind": "number"|"word", "note": "<one short sentence in plain words>"}',
  '',
  'index is the index of the chosen piece of text, from the list given.',
  '',
  'keep is the part of that text which must REMAIN, with the revealed value',
  'going after it. For "replace the plate number but keep the HZK" on a plate',
  'reading "HZK 1313", keep is "HZK". For "replace the whole house number",',
  'keep is empty. Copy the kept part EXACTLY as it appears in the text you were',
  'given, including its capitals -- it is going to be redrawn character for',
  'character, and a letter changed here is a letter changed on the plate.',
  '',
  'kind is what the performer will be revealing: "number" for digits, "word"',
  'for letters. Read it from the sentence; if it does not say, infer it from',
  'the part being replaced -- digits replaced by digits, letters by letters.',
  '',
  'Choose the target by what the sentence describes, not by size or position.',
  'A licence plate, a house number and a shop sign may all be in one photo.',
  'If the sentence names something that is not in the list at all, set index to',
  '-1 and explain in the note. Do not substitute the nearest thing: a plan for',
  'the wrong piece of writing looks exactly like a plan that worked, and the',
  'performer finds out in front of an audience.',
].join('\n');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: 'OPENAI_API_KEY is not configured' });
  }

  try {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
    const { instruction, found } = body || {};
    const want = (typeof instruction === 'string' ? instruction : '').trim();
    if (!want) return res.status(400).json({ error: 'Say what you want replaced' });
    if (!Array.isArray(found) || !found.length) {
      return res.status(400).json({ error: 'No writing was found in this photo' });
    }

    const list = found
      .map((f, i) => `${i}: "${f.text}"  (${Math.round(f.width)} x ${Math.round(f.height)} pixels)`)
      .join('\n');

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        response_format: { type: 'json_object' },
        max_tokens: 300,
        temperature: 0,
        messages: [
          { role: 'system', content: SYSTEM },
          {
            role: 'user',
            content: `The performer says: "${want}"\n\nText found in the photograph:\n${list}`,
          },
        ],
      }),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      return res.status(502).json({ error: `Model refused (${r.status}): ${text.slice(0, 300)}` });
    }
    const out = JSON.parse((await r.json())?.choices?.[0]?.message?.content || '{}');

    const index = Number(out.index);
    if (!Number.isInteger(index) || index < 0) {
      return res.status(404).json({
        error: out.note || `Nothing in this photo matches "${want}"`,
      });
    }
    if (index >= found.length) {
      return res.status(502).json({ error: 'The model chose a piece of text that does not exist' });
    }

    // The kept part must genuinely be part of the chosen text. A model that
    // invents or reformats it would have the app redraw something that was
    // never on the plate, which is the one failure that still looks correct.
    let keep = typeof out.keep === 'string' ? out.keep.trim() : '';
    if (keep && !found[index].text.includes(keep)) {
      return res.status(502).json({
        error: `It wanted to keep "${keep}", which is not part of "${found[index].text}"`,
      });
    }

    res.json({
      index,
      keep,
      kind: out.kind === 'word' ? 'word' : 'number',
      note: typeof out.note === 'string' ? out.note.slice(0, 300) : '',
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
};

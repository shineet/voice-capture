// api/handwriting.js
// POST { strokes: [{x:[...], y:[...], t:[...]}, ...] } -> { candidates: [string] }
//
// MyScript Cloud handwriting recognition, proxied.
//
// WHY THIS IS A SERVER ENDPOINT AND NOT A CALL FROM THE APP. MyScript
// authenticates with an application key AND an HMAC key, and both would have to
// ship inside the iOS binary to call the service directly. Anyone can crack an
// app open and read a string out of it, and the quota being spent is Shine's.
// So the keys live here, in Vercel env, on the same principle that keeps the
// OpenAI key out of transcribe.js's callers.
//
// IT TAKES STROKES, NOT AN IMAGE. The pad reports pen coordinates with
// timestamps, and MyScript reads handwriting the way it was written -- order,
// direction, rhythm. Rendering to a picture first would throw all of that away
// and hand a stroke engine the one input it has no advantage on.
//
// Free tier is 2000 recognitions a month, which is far beyond one performer's
// use, so nothing here tries to batch or cache.

const crypto = require('crypto');

const ENDPOINT = 'https://cloud.myscript.com/api/v4.0/iink/batch';

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  const applicationKey = process.env.MYSCRIPT_APPLICATION_KEY;
  const hmacKey = process.env.MYSCRIPT_HMAC_KEY;
  if (!applicationKey || !hmacKey) {
    // Named plainly. "Recognition failed" would send someone hunting through
    // stroke parsing for a missing environment variable.
    return res.status(503).json({
      error: 'MyScript keys are not configured on the server',
      candidates: [],
    });
  }

  const strokes = (req.body && req.body.strokes) || [];
  if (!Array.isArray(strokes) || strokes.length === 0) {
    return res.status(400).json({ error: 'no strokes', candidates: [] });
  }

  // MyScript wants each stroke as parallel x/y/t arrays, which is the shape the
  // app already sends. Timestamps are optional to the API and material to the
  // result, so they are passed through when present rather than dropped for
  // tidiness.
  const strokeGroups = [{
    strokes: strokes
      .filter((s) => Array.isArray(s.x) && s.x.length > 1)
      .map((s) => {
        const stroke = { x: s.x, y: s.y };
        if (Array.isArray(s.t) && s.t.length === s.x.length) stroke.t = s.t;
        return stroke;
      }),
  }];

  if (strokeGroups[0].strokes.length === 0) {
    return res.status(400).json({ error: 'no usable strokes', candidates: [] });
  }

  const payload = {
    configuration: {
      lang: 'en_US',
      export: { jiix: { text: { chars: false, words: true } } },
      text: {
        guides: { enable: false },
        // No smart guide and no margin: this is one word on a blank pad, not a
        // page of notes, and the layout helpers only add assumptions.
        smartGuide: false,
      },
    },
    xDPI: 96,
    yDPI: 96,
    contentType: 'Text',
    strokeGroups,
  };

  const body = JSON.stringify(payload);
  // The user key is the two keys concatenated, per MyScript's scheme, and the
  // signature covers the exact bytes sent.
  const hmac = crypto
    .createHmac('sha512', applicationKey + hmacKey)
    .update(body)
    .digest('hex');

  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // JIIX carries the alternates. Plain text would give one answer, and
        // the second guess is often the right one for a name.
        Accept: 'application/vnd.myscript.jiix',
        applicationKey,
        hmac,
      },
      body,
    });

    const text = await response.text();
    if (!response.ok) {
      // MyScript's own message is far more useful than a status code --
      // "access not granted" and "bad request" need completely different fixes.
      return res.status(response.status).json({
        error: text.slice(0, 500),
        candidates: [],
      });
    }

    return res.status(200).json({ candidates: extractCandidates(text) });
  } catch (err) {
    return res.status(502).json({ error: String(err), candidates: [] });
  }
};

// JIIX is a nested document and the useful parts sit at different depths
// depending on what was written, so this reads defensively rather than assuming
// one shape. Best guess first, then any alternates, deduplicated.
function extractCandidates(raw) {
  let jiix;
  try {
    jiix = JSON.parse(raw);
  } catch {
    // Not JSON at all: some configurations answer in plain text. That is still
    // an answer.
    const line = raw.trim();
    return line ? [line] : [];
  }

  const out = [];
  const add = (value) => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  };

  add(jiix.label);
  for (const word of jiix.words || []) {
    add(word.label);
    for (const candidate of word.candidates || []) add(candidate);
  }
  for (const element of jiix.elements || []) {
    add(element.label);
    for (const word of element.words || []) {
      add(word.label);
      for (const candidate of word.candidates || []) add(candidate);
    }
  }
  return out;
}

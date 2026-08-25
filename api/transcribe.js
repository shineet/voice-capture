// api/transcribe.js
// POST either JSON { audio: base64 string, mimeType: string } (web app), or
// raw audio bytes with Content-Type set to the mime type (native app).
// -> { text: string }
// Forwards the captured clip to OpenAI's audio transcription endpoint.

const EXT_BY_MIME = {
  'audio/mp4':  'm4a',
  'audio/webm': 'webm',
  'audio/ogg':  'ogg',
  'audio/wav':  'wav',
  'audio/mpeg': 'mp3',
};

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

module.exports = async function handler(req, res) {
  // Keep-warm ping (see vercel.json cron) -- hits this function on a timer so
  // Vercel doesn't cold-start a fresh container on the first real capture of
  // a show, without spending anything on an actual Whisper call.
  if (req.method === 'GET') return res.status(200).json({ status: 'warm' });

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY is not configured' });

  // Two request shapes share this endpoint: the web app posts JSON with a
  // base64 `audio` field (kept for backward compatibility), while the native
  // app posts the raw audio bytes directly with Content-Type set to the
  // mime type -- skipping base64 (~33% smaller) and JSON parsing entirely,
  // which is the main lever available for cutting latency without touching
  // the Whisper call itself.
  const contentType = req.headers['content-type'] || '';
  // Optional bias flag from the native app (?names=indian). When set, the
  // Whisper prompt below is swapped for one seeded with example Indian names,
  // which nudges the model toward spelling South-Asian names the way they're
  // actually written instead of anglicizing them at the source. Off by
  // default so it never hurts accuracy on Western names at non-Indian shows.
  // Parsed straight off req.url since bodyParser is disabled (req.query isn't
  // guaranteed here); a plain substring check is enough for a single flag.
  const indianNames = /[?&]names=indian(?:&|$)/.test(req.url || '');
  // Same idea for Song Mode captures (?songs=indian): seed Whisper with Indian-
  // music context so a Bollywood/regional title spoken in the clip comes back
  // closer to searchable rather than transliterated into something Spotify
  // won't find. Separate flag from names so the two toggles are independent.
  const indianSongs = /[?&]songs=indian(?:&|$)/.test(req.url || '');
  const rawBody = await readRawBody(req);
  if (rawBody.length === 0) return res.status(400).json({ error: 'Missing audio' });

  let buffer, mimeType;
  if (contentType.includes('application/json')) {
    let parsed;
    try {
      parsed = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }
    const { audio, mimeType: mt } = parsed || {};
    if (!audio) return res.status(400).json({ error: 'Missing audio' });
    buffer = Buffer.from(audio, 'base64');
    mimeType = mt;
  } else {
    buffer = rawBody;
    mimeType = contentType;
  }

  try {
    const ext = EXT_BY_MIME[mimeType] || 'webm';
    const blob = new Blob([buffer], { type: mimeType || 'application/octet-stream' });

    const form = new FormData();
    form.append('file', blob, `capture.${ext}`);
    // Tried gpt-4o-transcribe (OpenAI's newer, generally more accurate model)
    // but it consistently rejected real on-device recordings from Safari's
    // MediaRecorder ("audio file might be corrupted or unsupported") even
    // though a synthetic test file worked fine -- almost certainly stricter
    // handling of the fragmented-MP4 container MediaRecorder actually
    // produces than whisper-1's more lenient ingestion. Reverted to whisper-1
    // as the known-good, verified-working model for this app's real audio.
    form.append('model', 'whisper-1');
    // Plain text instead of json -- OpenAI skips wrapping the response, which
    // is a small but free latency/parsing saving with zero effect on the
    // transcription itself. Errors still come back as JSON regardless, so
    // that path below is unaffected.
    form.append('response_format', 'text');
    // Without this, the model auto-detects language from the audio -- on a
    // very short clip (one word/name) it sometimes guesses wrong and
    // transcribes or transliterates into another language entirely. Forcing
    // English stops that guesswork; it doesn't affect accuracy on names/
    // places said in English, which is all this app is ever used for.
    form.append('language', 'en');
    // Short, single-word/name/place captures -- nudges the model toward not
    // padding output with filler or guessing at a longer phrase than was said.
    // With the Indian-names bias on, the prompt is seeded with example names
    // spanning regions/genders so Whisper spells the captured name the Indian
    // way rather than defaulting to a similar-sounding English word.
    let whisperPrompt = 'A single word, name, or place, spoken clearly.';
    if (indianNames) {
      whisperPrompt = 'A single Indian name, spoken clearly. Examples: Aarav, Vivaan, Aditya, Arjun, Rohan, Karthik, Rahul, Sanjay, Vijay, Deepak, Rajesh, Suresh, Anil, Ravi, Nikhil, Pranav, Aryan, Ishaan, Krishna, Aakash, Priya, Ananya, Aishwarya, Divya, Meera, Kavya, Neha, Pooja, Sneha, Lakshmi, Anjali, Shreya, Riya, Nisha, Deepika, Swati, Radha, Sita, Fatima, Zoya.';
    } else if (indianSongs) {
      whisperPrompt = 'A conversation about an Indian song -- Bollywood/film or regional (Hindi, Tamil, Telugu, Punjabi). Titles and singers such as Tum Hi Ho, Kal Ho Naa Ho, Chaiyya Chaiyya, Jai Ho, Kesariya, Arijit Singh, Shreya Ghoshal, Lata Mangeshkar, Kishore Kumar, A.R. Rahman may be mentioned.';
    }
    form.append('prompt', whisperPrompt);

    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
      body: form,
    });

    if (!r.ok) {
      const data = await r.json();
      console.error('Whisper error:', data);
      return res.status(502).json({ error: data.error?.message || 'Transcription failed' });
    }

    const text = await r.text();
    return res.status(200).json({ text: text.trim() });
  } catch (err) {
    console.error('transcribe error:', err);
    return res.status(500).json({ error: err.message });
  }
};

// Vercel's automatic req.body parsing is unreliable for arbitrary binary
// content types like audio/mp4 (it doesn't consistently hand back a Buffer),
// so the handler above reads the request stream directly instead of
// trusting req.body -- this opts out of the automatic parsing entirely.
module.exports.config = { api: { bodyParser: false } };

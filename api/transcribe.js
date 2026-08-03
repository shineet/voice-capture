// api/transcribe.js
// POST { audio: base64 string, mimeType: string } -> { text: string }
// Forwards the captured clip to OpenAI's Whisper transcription endpoint.

const EXT_BY_MIME = {
  'audio/mp4':  'm4a',
  'audio/webm': 'webm',
  'audio/ogg':  'ogg',
  'audio/wav':  'wav',
  'audio/mpeg': 'mp3',
};

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY is not configured' });

  const { audio, mimeType } = req.body || {};
  if (!audio) return res.status(400).json({ error: 'Missing audio' });

  try {
    const buffer = Buffer.from(audio, 'base64');
    const ext = EXT_BY_MIME[mimeType] || 'webm';
    const blob = new Blob([buffer], { type: mimeType || 'application/octet-stream' });

    const form = new FormData();
    form.append('file', blob, `capture.${ext}`);
    form.append('model', 'whisper-1');
    form.append('response_format', 'json');
    // Without this, Whisper auto-detects language from the audio -- on a very
    // short clip (one word/name) it sometimes guesses wrong and transcribes
    // or transliterates into another language entirely. Forcing English stops
    // that guesswork; it doesn't affect accuracy on names/places said in
    // English, which is all this app is ever used for.
    form.append('language', 'en');
    // Short, single-word/name/place captures -- nudges the model toward not
    // padding output with filler or guessing at a longer phrase than was said.
    form.append('prompt', 'A single word, name, or place, spoken clearly.');

    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
      body: form,
    });

    const data = await r.json();
    if (!r.ok) {
      console.error('Whisper error:', data);
      return res.status(502).json({ error: data.error?.message || 'Transcription failed' });
    }

    return res.status(200).json({ text: data.text || '' });
  } catch (err) {
    console.error('transcribe error:', err);
    return res.status(500).json({ error: err.message });
  }
};

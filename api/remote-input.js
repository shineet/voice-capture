// api/remote-input.js
// A tiny mailbox so a standalone web page (plant.html) can hand a typed word to
// the VoiceCapture app running on Shine's phone during a show.
//
//   POST { room, word }         -> stores the word (overwrites the last)
//   GET  ?room=...&since=<id>   -> { word, id }  (id is a millisecond stamp)
//
// The app polls GET with the id it last acted on; when a newer id comes back it
// feeds that word into its normal pipeline (Motherboard + print + destinations),
// exactly as if Shine had dialled it. `room` is a private token Shine embeds in
// the link he texts to his wife -- it scopes the mailbox so nobody else's page
// can reach his phone. Single word at a time is all a show needs; there is no
// history and nothing sensitive is stored.

const { put, list } = require('@vercel/blob');
const { blobPublicUrl } = require('./_blob-url.js');

function roomKey(raw) {
  return String(raw || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 64);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return res.status(500).json({ error: 'Blob storage not configured' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }

  const room = roomKey((req.query && req.query.room) || (body && body.room));
  if (!room) return res.status(400).json({ error: 'Missing room' });
  const PATH = `remote-input/${room}.json`;

  if (req.method === 'GET') {
    try {
      // Read the mailbox straight from its public URL. list() used to run here
      // on every poll, and it is a metered API call -- the app polls every few
      // seconds during a show, which exhausted the monthly allowance and got
      // the store paused. A CDN fetch is not metered. See _blob-url.js.
      const direct = blobPublicUrl(PATH);
      let r = direct ? await fetch(direct + '?t=' + Date.now(), { cache: 'no-store' }) : null;

      // A 404 means one of two things -- nothing posted to this room yet, or a
      // wrong address -- and they must not be confused. Treating 404 as "empty"
      // would silently break the mailbox forever if the URL were ever wrong, so
      // it is confirmed with list() instead. That costs a metered call only
      // while the mailbox is empty; once a word is in it, every poll for the
      // rest of the show is free, which is the case that ran up the bill.
      if (!r || !r.ok) {
        const { blobs } = await list({ prefix: PATH, limit: 1 });
        if (!blobs.length) return res.status(200).json({ word: '', id: 0 });
        if (direct) console.warn('remote-input: derived blob URL missed, falling back', direct);
        r = await fetch(blobs[0].url + '?t=' + Date.now(), { cache: 'no-store' });
      }
      const raw = r.ok ? (await r.text()).trim() : '';
      let parsed = {};
      try { parsed = JSON.parse(raw); } catch { /* ignore */ }
      return res.status(200).json({ word: parsed.word || '', id: parsed.id || 0 });
    } catch (err) {
      console.error('remote-input GET error:', err);
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method === 'POST') {
    const word = (body && typeof body.word === 'string') ? body.word.trim() : '';
    if (!word) return res.status(400).json({ error: 'Missing word' });
    if (word.length > 200) return res.status(400).json({ error: 'Word too long' });
    // The page sends the same id on the realtime broadcast and this mailbox
    // write, so the app can de-dupe across both channels. Fall back to now.
    const clientId = Number(body && body.id);
    const id = Number.isFinite(clientId) && clientId > 0 ? Math.floor(clientId) : Date.now();
    try {
      await put(PATH, JSON.stringify({ word, id }), {
        access: 'public',
        contentType: 'application/json',
        addRandomSuffix: false,
        allowOverwrite: true,
        // A mailbox is the opposite of a static file: Blob's default cache is a
        // YEAR, so an overwritten word kept serving the stale copy from the CDN
        // (the word appeared to send only on the second try, or after a long
        // wait). 0 makes every read fresh.
        cacheControlMaxAge: 0,
      });
      return res.status(200).json({ success: true, id });
    } catch (err) {
      console.error('remote-input POST error:', err);
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};

// api/mb-send.js
// POST { text, token } -> forwards the word to the MotherBoard cloud API as
// TEXT. This lets a link texted to a helper (send2motherboard.html) send a name
// straight to the board, with no phone in the loop. The board's API key stays
// server-side here -- it is never in the link or the page.
//
// Env vars (voice-capture Vercel project):
//   MOTHERBOARD_API_ID  -- the board's mb_... key (sent as X-Motherboard-Api-Id)
//   SEND2MB_TOKEN       -- shared secret; the link carries it as ?t= and the
//                          page posts it here. Required, so the endpoint is not
//                          open to anyone who finds the URL.
// Optional:
//   MOTHERBOARD_ENDPOINT -- override the default display endpoint.

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method === 'GET') return res.status(200).json({ status: 'warm' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiId = process.env.MOTHERBOARD_API_ID;
  const gate = process.env.SEND2MB_TOKEN;
  const endpoint = process.env.MOTHERBOARD_ENDPOINT
    || 'https://api.motherboard.conjuringlab.com/api/display';
  if (!apiId || !gate) {
    return res.status(500).json({ error: 'Not configured (need MOTHERBOARD_API_ID and SEND2MB_TOKEN)' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
  const token = (body && typeof body.token === 'string') ? body.token : '';
  const text = (body && typeof body.text === 'string') ? body.text.trim() : '';

  // Shared-secret gate -- stops anyone who finds the URL from driving the board.
  if (token !== gate) return res.status(401).json({ error: 'Unauthorized' });
  if (!text) return res.status(400).json({ error: 'Missing text' });
  if (text.length > 200) return res.status(400).json({ error: 'Text too long' });

  try {
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'X-Motherboard-Api-Id': apiId,
      },
      body: JSON.stringify({ kind: 'text', text }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error('Motherboard error:', r.status, data);
      return res.status(502).json({ error: (data && data.message) || `Board send failed (HTTP ${r.status})` });
    }
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('mb-send error:', err);
    return res.status(500).json({ error: err.message });
  }
};

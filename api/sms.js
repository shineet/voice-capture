// api/sms.js
// POST { to, body } -> sends an SMS via Twilio, reusing the same Twilio account
// as the booking app (booking is at Vercel's 12-function cap, so this lives
// here on voice-capture instead).
//
// Env vars (add to the voice-capture Vercel project -- same values as booking):
//   TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM
// Optional: SMS_TOKEN -- if set, the caller must send it as the x-sms-token
// header. The app does. This stops anyone who finds the URL from spending your
// Twilio credit. Leave it unset and the endpoint is open (works, unprotected).

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-sms-token');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method === 'GET') return res.status(200).json({ status: 'warm' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const sid = process.env.TWILIO_SID;
  const token = process.env.TWILIO_TOKEN;
  const from = process.env.TWILIO_FROM;
  if (!sid || !token || !from) {
    return res.status(500).json({ error: 'Twilio not configured (need TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM)' });
  }

  // Optional shared-secret gate.
  if (process.env.SMS_TOKEN && req.headers['x-sms-token'] !== process.env.SMS_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
  const to = (body && typeof body.to === 'string') ? body.to.trim() : '';
  const message = (body && typeof body.body === 'string') ? body.body.trim() : '';
  if (!to) return res.status(400).json({ error: 'Missing to' });
  if (!message) return res.status(400).json({ error: 'Missing body' });
  if (message.length > 640) return res.status(400).json({ error: 'Message too long' });

  try {
    const form = new URLSearchParams({ To: to, From: from, Body: message });
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error('Twilio error:', data);
      return res.status(502).json({ error: data.message || `SMS send failed (HTTP ${r.status})` });
    }
    return res.status(200).json({ success: true, sid: data.sid });
  } catch (err) {
    console.error('sms error:', err);
    return res.status(500).json({ error: err.message });
  }
};

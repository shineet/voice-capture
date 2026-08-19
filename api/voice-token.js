// api/voice-token.js
// Mints a short-lived Twilio Voice access token so the phone app can place
// outbound calls through our TwiML App (which runs api/voice-twiml.js). Gated by
// x-sms-token so only our app can request one.
//
// Env vars (voice-capture Vercel project):
//   TWILIO_SID              -- Account SID (AC...), already set for SMS
//   TWILIO_API_KEY_SID      -- Standard API Key SID (SK...)
//   TWILIO_API_KEY_SECRET   -- that API Key's secret
//   TWILIO_TWIML_APP_SID    -- the TwiML App SID (AP...) whose Voice URL is
//                              /api/voice-twiml?k=<SMS_TOKEN>

const crypto = require('crypto');

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'x-sms-token');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const {
    TWILIO_SID, TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET, TWILIO_TWIML_APP_SID, SMS_TOKEN,
  } = process.env;

  if (!TWILIO_SID || !TWILIO_API_KEY_SID || !TWILIO_API_KEY_SECRET || !TWILIO_TWIML_APP_SID) {
    return res.status(500).json({ error: 'Voice not configured (need TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET, TWILIO_TWIML_APP_SID)' });
  }
  if (SMS_TOKEN && req.headers['x-sms-token'] !== SMS_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const identity = 'performer';
  const now = Math.floor(Date.now() / 1000);
  const header = { cty: 'twilio-fpa;v=1', typ: 'JWT', alg: 'HS256' };
  const payload = {
    jti: TWILIO_API_KEY_SID + '-' + now,
    iss: TWILIO_API_KEY_SID,
    sub: TWILIO_SID,
    iat: now,
    exp: now + 3600,
    grants: {
      identity: identity,
      voice: {
        outgoing: { application_sid: TWILIO_TWIML_APP_SID },
        incoming: { allow: false },
      },
    },
  };

  const signingInput = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac('sha256', TWILIO_API_KEY_SECRET).update(signingInput).digest());
  return res.status(200).json({ token: signingInput + '.' + sig, identity });
};

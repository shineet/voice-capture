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

  // ── Video, for the FaceTime leg on a borrowed phone ────────────────────
  //
  // The routine ends with the assistant calling back on FaceTime, and on a
  // spectator's phone that is impossible: the assistant has no handle to reach
  // it, the disguise depends on renaming a contact in the PERFORMER'S address
  // book, and Safari cannot receive FaceTime at all. So the video happens
  // inside the page instead -- which is also stronger, because the caller
  // identity on screen is drawn rather than faked through Contacts.
  //
  // Here rather than in api/video-token.js because this project sits on
  // exactly twelve functions and Vercel Hobby allows twelve. A thirteenth file
  // fails the BUILD and takes the working endpoints with it.
  //
  // `room` is required and scopes the grant: a token is only ever good for one
  // room, so one leaking cannot be used to join another performance.
  const kind = String((req.query && req.query.kind) || 'voice');
  if (kind === 'video') {
    const room = String((req.query && req.query.room) || '');
    if (!/^[A-Za-z0-9_-]{3,40}$/.test(room)) {
      return res.status(400).json({ error: 'a room is required for a video token' });
    }
    // Who is joining. Only ever two, and the page labels the other side, so
    // this is for Twilio's benefit rather than anything shown on screen.
    const who = String((req.query && req.query.who) || '') === 'assistant'
      ? 'assistant' : 'spectator';
    return res.status(200).json(
      mintToken({
        identity: who,
        grants: { video: { room: 'ringer-' + room } },
        TWILIO_SID, TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET,
      }));
  }

  // ── The assistant answering in a browser instead of on his mobile ──────
  //
  // The divert used to <Dial> his real phone, which puts the second half of the
  // call on the PSTN: G.711, 3.4kHz, and no codec choice at the performer's end
  // changes it. An audience member listening to one of these said the assistant
  // sounded like AI. Browser to browser it is Opus wideband instead.
  //
  // INCOMING ONLY, and scoped to one room. This token can receive the call that
  // <Client>assistant-<room></Client> sends and can do nothing else -- there is
  // no outgoing grant at all, so one leaking off the assistant's phone cannot
  // place a call on the account. Same reasoning as the video grant above, and
  // the same reason it lives in this file rather than its own: twelve
  // functions is the Hobby ceiling and a thirteenth fails the BUILD.
  if (kind === 'client') {
    const room = String((req.query && req.query.room) || '');
    if (!/^[A-Za-z0-9_-]{3,40}$/.test(room)) {
      return res.status(400).json({ error: 'a room is required for a client token' });
    }
    return res.status(200).json(
      mintToken({
        identity: 'assistant-' + room,
        grants: { voice: { incoming: { allow: true } } },
        TWILIO_SID, TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET,
      }));
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

// The same JWT shape the voice path builds by hand, factored out so the video
// grant cannot drift from it. One hour, same as the voice token: long enough
// for any show, short enough that a leaked one is worthless tomorrow.
function mintToken({ identity, grants, TWILIO_SID, TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET }) {
  const now = Math.floor(Date.now() / 1000);
  const header = { cty: 'twilio-fpa;v=1', typ: 'JWT', alg: 'HS256' };
  const payload = {
    jti: TWILIO_API_KEY_SID + '-' + now,
    iss: TWILIO_API_KEY_SID,
    sub: TWILIO_SID,
    iat: now,
    exp: now + 3600,
    grants: Object.assign({ identity }, grants),
  };
  const signingInput = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac('sha256', TWILIO_API_KEY_SECRET).update(signingInput).digest());
  return { token: signingInput + '.' + sig, identity };
}

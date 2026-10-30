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
  // The App Store build (CallFriend) carries RINGER_PUBLIC_TOKEN, never the
  // SMS token: a store binary is readable by anyone who downloads it. Its
  // calls go out as identity "public", which voice-twiml holds to US/Canada,
  // the Twilio number as caller ID and a daily limit.
  const given = req.headers['x-sms-token'];
  const isPublic = Boolean(process.env.RINGER_PUBLIC_TOKEN) && given === process.env.RINGER_PUBLIC_TOKEN;
  if (SMS_TOKEN && given !== SMS_TOKEN && !isPublic) {
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

  // ── Ringer: every phone is an assistant, known by its own number ───────
  //
  // Shine, 2026-10-28: no assistant mode, no room. Any Ringer phone can be
  // anyone's assistant; the performer sets the assistant's NUMBER, as he
  // always has, and the divert rings the Ringer that owns that number.
  //
  // The number has to be proved, or anyone could claim Shine's and receive
  // the calls (and video) meant for him. iOS will not tell an app its own
  // number, so it is confirmed once by a texted code. STATELESS, because a
  // store means a thirteenth function or a database for six digits: the code
  // is an HMAC of the number and the moment it was sent, so checking it needs
  // nothing but the secret. The proof that comes back is an HMAC of the
  // number alone; the phone keeps it and presents it for every token.
  //
  // The secret is derived from TWILIO_API_KEY_SECRET with a label, so no new
  // env var, and rotating the API key re-verifies everyone, which is right.
  // ── FaceTime from Recents, to a locked phone ───────────────────────────
  //
  // The performer taps FaceTime Video in Ringer's Recents with no call up
  // (Shine, 2026-10-29). The video rings through the room's flag, which the
  // assistant's Ringer only reads while it is open; a locked phone never saw
  // it. So this also places a call to the assistant's Ringer, which arrives
  // by VoIP push like any call and is shown as an incoming FaceTime Video.
  // Answering it opens the video; the call itself is never accepted, so no
  // voice leg ever connects. kind=facetime-cancel ends it when the performer
  // gives up. Gated on the CALLER's number proof, so only a confirmed Ringer
  // can make another phone ring. Here because this project is at twelve
  // functions.
  if (kind === 'facetime-ring' || kind === 'facetime-cancel') {
    const { TWILIO_TOKEN } = process.env;
    if (!TWILIO_TOKEN) return res.status(500).json({ error: 'calls not configured' });
    const q = req.query || {};
    const mine = '+' + String(q.number || '').replace(/[^0-9]/g, '');
    const proof = String(q.proof || '');
    const want = Buffer.from(ringerProof(mine.slice(1), TWILIO_API_KEY_SECRET));
    const got = Buffer.from(proof.padEnd(want.length, 'x').slice(0, want.length));
    if (!/^\+[1-9][0-9]{7,14}$/.test(mine) || proof.length !== want.length || !crypto.timingSafeEqual(want, got)) {
      return res.status(401).json({ error: 'this number has not been confirmed on this phone' });
    }
    const auth = 'Basic ' + Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64');
    if (kind === 'facetime-cancel') {
      const sid = String(q.sid || '');
      if (!/^CA[0-9a-f]{32}$/.test(sid)) return res.status(400).json({ error: 'sid required' });
      // Canceled while ringing; completed if it somehow got further.
      for (const Status of ['canceled', 'completed']) {
        const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Calls/${sid}.json`, {
          method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ Status }).toString(),
        });
        if (r.ok) return res.status(200).json({ ok: true, status: Status });
      }
      return res.status(200).json({ ok: false });
    }
    const to = '+' + String(q.assistant || '').replace(/[^0-9]/g, '');
    const room = String(q.room || '').slice(0, 64);
    if (!/^\+[1-9][0-9]{7,14}$/.test(to) || room.length < 3) {
      return res.status(400).json({ error: 'assistant and room required' });
    }
    // Two phones on one number (Shine testing): the other phone cannot be
    // reached by number, and the call would ring the caller itself.
    if (to === mine) return res.status(200).json({ skipped: 'same number' });
    // The invite's custom parameters ride on the client address.
    const params = new URLSearchParams({
      kind: 'facetime', room, back: mine,
      performer: String(q.performer || '').slice(0, 60),
    }).toString();
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Calls.json`, {
      method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        To: 'client:' + ringerIdentity(to) + '?' + params,
        From: 'client:facetime',
        Twiml: '<Response><Pause length="60"/></Response>',
        Timeout: '45',
      }).toString(),
    });
    const d = await r.json().catch(() => ({}));
    console.log('[facetime-ring] to=..' + to.slice(-4) + ' room=' + room + ' status=' + r.status + (d.sid ? ' sid=' + d.sid : ' ' + (d.message || '')));
    if (!r.ok) return res.status(502).json({ error: d.message || `Twilio refused (${r.status})` });
    return res.status(200).json({ sid: d.sid });
  }

  if (kind === 'verify-start' || kind === 'verify-check' || kind === 'ringer') {
    // Forgiving about the form, strict about the result: a "+" that arrived
    // as a space, no country code on a ten-digit US number, or punctuation.
    let raw = String((req.query && req.query.number) || '').trim();
    let digits0 = raw.replace(/[^0-9]/g, '');
    if (!raw.startsWith('+')) {
      if (digits0.length === 10) digits0 = '1' + digits0;
    }
    const number = '+' + digits0;
    if (!/^\+[1-9][0-9]{7,14}$/.test(number)) {
      return res.status(400).json({ error: 'a number in +15125551234 form is required' });
    }
    const digits = number.slice(1);

    if (kind === 'verify-start') {
      // A store copy may text a code to US/Canada numbers only.
      if (isPublic && !/^\+1[2-9][0-9]{9}$/.test(number)) {
        return res.status(400).json({ error: 'Only US and Canada numbers can be confirmed.' });
      }
      const { TWILIO_TOKEN, TWILIO_FROM } = process.env;
      if (!TWILIO_TOKEN || !TWILIO_FROM) return res.status(500).json({ error: 'SMS not configured' });
      const ts = String(Math.floor(Date.now() / 1000));
      const code = verifyCode(digits, ts, TWILIO_API_KEY_SECRET);
      const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
        method: 'POST',
        headers: {
          Authorization: 'Basic ' + Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ To: number, From: TWILIO_FROM, Body: `Your Ringer code is ${code}` }).toString(),
      });
      if (!r.ok) {
        const why = await r.json().catch(() => ({}));
        return res.status(502).json({ error: why.message || `Twilio refused the text (${r.status})` });
      }
      return res.status(200).json({ ts });
    }

    if (kind === 'verify-check') {
      const ts = String((req.query && req.query.ts) || '');
      const code = String((req.query && req.query.code) || '').trim();
      const age = Math.floor(Date.now() / 1000) - Number(ts);
      // Ten minutes: long enough to find the text, short enough that six
      // digits cannot be walked in the time.
      if (!/^[0-9]{10}$/.test(ts) || !(age >= 0 && age <= 600)) {
        return res.status(400).json({ error: 'That code has expired. Send a new one.' });
      }
      const want = Buffer.from(verifyCode(digits, ts, TWILIO_API_KEY_SECRET));
      const got = Buffer.from(code.padEnd(want.length, 'x').slice(0, want.length));
      if (!crypto.timingSafeEqual(want, got) || code.length !== want.length) {
        return res.status(400).json({ error: 'That code is not right.' });
      }
      return res.status(200).json({ proof: ringerProof(digits, TWILIO_API_KEY_SECRET) });
    }

    // kind === 'ringer': an incoming-only token for this number's identity,
    // and only with the proof that the number was confirmed on this phone.
    const proof = String((req.query && req.query.proof) || '');
    const want = Buffer.from(ringerProof(digits, TWILIO_API_KEY_SECRET));
    const got = Buffer.from(proof.padEnd(want.length, 'x').slice(0, want.length));
    if (proof.length !== want.length || !crypto.timingSafeEqual(want, got)) {
      return res.status(401).json({ error: 'this number has not been confirmed on this phone' });
    }
    const voice = { incoming: { allow: true } };
    const push = String((req.query && req.query.push) || '');
    const cred = push === 'sandbox' ? process.env.TWILIO_PUSH_CRED_SANDBOX
      : push === 'production' ? process.env.TWILIO_PUSH_CRED_PRODUCTION : '';
    if (push && !cred) return res.status(500).json({ error: `no Twilio push credential for ${push}` });
    if (cred) voice.push_credential_sid = cred;
    return res.status(200).json(
      mintToken({
        identity: ringerIdentity(number),
        grants: { voice },
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
    // Ringer's Assistant mode (the app, not the web page) also needs Twilio to
    // WAKE it for the call, through Apple's VoIP push. `push` says which of
    // Apple's servers the phone's token belongs to: a build installed from the
    // Mac is sandbox, TestFlight is production, and Twilio keeps one push
    // credential (CR...) for each. The web page never sends `push`, so its
    // token is unchanged.
    const voice = { incoming: { allow: true } };
    const push = String((req.query && req.query.push) || '');
    const cred = push === 'sandbox' ? process.env.TWILIO_PUSH_CRED_SANDBOX
      : push === 'production' ? process.env.TWILIO_PUSH_CRED_PRODUCTION : '';
    if (push && !cred) {
      return res.status(500).json({ error: `no Twilio push credential for ${push}` });
    }
    if (cred) voice.push_credential_sid = cred;
    return res.status(200).json(
      mintToken({
        identity: 'assistant-' + room,
        grants: { voice },
        TWILIO_SID, TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET,
      }));
  }

  const identity = isPublic ? 'public' : 'performer';
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

function verifyCode(digits, ts, secret) {
  const h = crypto.createHmac('sha256', 'ringer-verify|' + secret).update(digits + '|' + ts).digest();
  return String(h.readUInt32BE(0) % 1000000).padStart(6, '0');
}

function ringerProof(digits, secret) {
  return crypto.createHmac('sha256', 'ringer-proof|' + secret).update(digits).digest('hex');
}

/// The Twilio identity of the Ringer that owns a number. voice-twiml.js
/// dials the same string and has its own copy: each file here is a separate
/// function bundle, so they cannot share a module. Change both or neither.
function ringerIdentity(e164) { return 'ringer_' + String(e164).replace(/[^0-9]/g, ''); }

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

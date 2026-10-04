// api/voice-twiml.js
// The call script Twilio runs when the phone app places a call. The app passes
// `mode`: "voicemail" (first dial) or "divert" (second dial -> the assistant).
// The number the audience dialed is cosmetic (shown in the app + CallKit); the
// routing here is always to voicemail or the assistant, never the dialed number,
// so no random stranger is ever called.
//
// The TwiML App's Voice Request URL must include ?k=<SMS_TOKEN> so only the
// Twilio requests we configured are honored -- keeps the assistant's number from
// leaking to anyone who probes the endpoint.

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function xml(res, body) {
  res.setHeader('Content-Type', 'text/xml');
  res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response>' + body + '</Response>');
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).send('Method not allowed');

  const k = (req.query && req.query.k) || '';
  if (process.env.SMS_TOKEN && k !== process.env.SMS_TOKEN) return res.status(403).send('Forbidden');

  let body = req.body;
  if (typeof body === 'string') { try { body = require('querystring').parse(body); } catch { body = {}; } }
  const mode = (body && body.mode) || (req.query && req.query.mode) || 'voicemail';

  // The web dialler on a spectator's phone cannot carry any of this -- the
  // assistant's number is a real person's, and the voicemail wording is the
  // performer's script. It sends only its ROOM; Ringer pushed the rest to the
  // show server beforehand, and we fetch it here machine to machine.
  let fromRoom = null;
  const roomRaw = (body && body.room) || (req.query && req.query.room) || '';
  const room = /^[A-Za-z0-9_-]{1,40}$/.test(String(roomRaw)) ? String(roomRaw) : '';
  if (room) {
    try {
      const r = await fetch(
        'https://mindgames.fly.dev/api/ringer/' + encodeURIComponent(room) + '/assistant',
        { headers: { 'x-sms-token': process.env.SMS_TOKEN || '' } });
      if (r.ok) fromRoom = await r.json();
    } catch (e) { /* every use below tolerates null */ }
  }

  // Dialling the assistant's real mobile. Factored out because it is now reached
  // from two places: the ordinary divert, and the fallback when he was supposed
  // to answer in a browser and did not.
  function divertToPhone() {
    // The assistant number is configured in the APP and passed at call time
    // (not hard-coded). ASSISTANT_NUMBER env is only an optional fallback.
    //
    // A THIRD source, for the web dialler on a spectator's phone: that page
    // cannot hold the number -- it is a real person's, on a public URL -- so it
    // sends only its ROOM, and we fetch the number from the show server here,
    // machine to machine. Shine works with different assistants on different
    // shows and a friend testing has their own, which is also why this is not
    // one environment variable.
    const raw = (body && body.assistant) || (req.query && req.query.assistant)
      || (fromRoom && fromRoom.assistant) || process.env.ASSISTANT_NUMBER || '';
    const assistant = /^\+?[0-9]{7,15}$/.test(String(raw).trim()) ? String(raw).trim() : '';
    // Caller ID shown on the assistant's phone. Default = the Twilio number. If
    // DIVERT_CALLER_ID is set to the performer's own VERIFIED number, the assistant
    // sees the call as coming from the performer, so tapping FaceTime on the native
    // call screen reaches the performer directly. Only the assistant sees this.
    const from = process.env.DIVERT_CALLER_ID || process.env.TWILIO_FROM;
    if (!assistant) return xml(res, '<Say>Assistant number is not configured.</Say>');
    // answerOnBridge -> the caller hears ringing until the assistant picks up.
    return xml(res, '<Dial callerId="' + esc(from) + '" answerOnBridge="true">' + esc(assistant) + '</Dial>');
  }

  // ── Second half of the client route ──────────────────────────────────────
  //
  // Reached as the `action` of the <Client> dial below, so it runs once that
  // dial has finished one way or another.
  //
  //   completed  -- they talked and somebody hung up. Stop. WITHOUT this the
  //                 call would carry straight on to the next verb and ring the
  //                 assistant's mobile the instant the conversation ended,
  //                 which in front of an audience is worse than no fallback.
  //   anything   -- not registered, didn't answer, browser asleep. His real
  //   else          phone, exactly as before. The spectator has heard nothing
  //                 but ringing throughout.
  if (mode === 'afterclient') {
    const st = String((body && body.DialCallStatus) || (req.query && req.query.DialCallStatus) || '');
    if (st === 'completed' || st === 'answered') return xml(res, '<Hangup/>');
    return divertToPhone();
  }

  if (mode === 'divert') {
    // The assistant answering in a BROWSER rather than on his mobile. This is
    // the only arrangement in which the call is wideband: a mobile leg is G.711
    // narrowband no matter what codec this end prefers, and an audience member
    // listening to one said the assistant sounded like AI.
    //
    // Opt-in per room, set by the app when it pushes the night's config. Absent
    // it, everything below is the behaviour this endpoint has always had.
    //
    // 15 seconds, then his phone. Long enough for him to tap Answer, short
    // enough that the spectator is still hearing a plausible ring.
    if (room && fromRoom && fromRoom.via === 'client') {
      // Absolute. Twilio does resolve a relative action against the request
      // URL, but the cost of being wrong about that is the fallback silently
      // not happening in front of an audience, and the host is right here.
      const host = (req.headers && req.headers.host) || 'voice-capture-bice.vercel.app';
      const action = 'https://' + host + '/api/voice-twiml?k=' + encodeURIComponent(k)
        + '&mode=afterclient&room=' + encodeURIComponent(room);
      // The number the Spectator dialled, handed to the assistant's page so its
      // call screen can show it the way a phone would. Cosmetic, and absent on
      // paths that do not send it, which the page tolerates.
      const dialled = String((body && body.To) || (body && body.caller) || '')
        .replace(/[^0-9+]/g, '').slice(0, 16);
      return xml(res,
        '<Dial answerOnBridge="true" timeout="15" method="POST" action="' + esc(action) + '">'
        + '<Client>assistant-' + esc(room) + '</Client>'
        + (dialled ? '<Parameter name="dialled" value="' + esc(dialled) + '"/>' : '')
        + '</Dial>');
    }
    return divertToPhone();
  }

  // voicemail (first dial). Priority: app-provided text (chosen per show) ->
  // hosted recording (VOICEMAIL_URL env) -> default greeting.
  const vmText = (body && body.vm) || (req.query && req.query.vm)
    || (fromRoom && fromRoom.vm) || '';
  const vmVoiceRaw = (body && body.vmvoice) || (req.query && req.query.vmvoice)
    || (fromRoom && fromRoom.vmvoice) || 'alice';
  const vmVoice = /^[A-Za-z0-9.\-]+$/.test(String(vmVoiceRaw)) ? String(vmVoiceRaw) : 'alice';
  if (vmText) {
    return xml(res, '<Say voice="' + esc(vmVoice) + '">' + esc(vmText) + '</Say><Pause length="1"/>');
  }
  if (process.env.VOICEMAIL_URL) {
    return xml(res, '<Play>' + esc(process.env.VOICEMAIL_URL) + '</Play>');
  }
  return xml(res,
    '<Say voice="alice">The person you are trying to reach is not available. '
    + 'Please leave a message after the tone.</Say>'
    + '<Pause length="1"/>');
};

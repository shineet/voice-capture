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
/// The Twilio identity of the Ringer that owns a number. Same as in
/// voice-token.js, which mints it: change both or neither.
function ringerIdentity(e164) { return 'ringer_' + String(e164).replace(/[^0-9]/g, ''); }
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
  // The fallback is asked for in the ACTION URL's query (mode=afterclient),
  // but Twilio's callback body repeats the call's original parameters,
  // mode=divert included, and the body used to win: every unanswered client
  // leg started the divert again, every 20 seconds, for as long as the
  // performer stayed on (2026-10-28). The URL's afterclient outranks it.
  const queryMode = req.query && req.query.mode;
  const mode = (queryMode === 'afterclient' || queryMode === 'callbackafter') ? queryMode
    : ((body && body.mode) || queryMode || 'voicemail');

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
    // Why a divert ended up on the mobile, when it did. Last four digits only.
    console.log('[divert] client leg ended', st || '(none)', 'room=' + (room || '-'));
    if (st === 'completed' || st === 'answered') return xml(res, '<Hangup/>');
    return divertToPhone();
  }

  // ── Call back ──────────────────────────────────────────────────────────
  //
  // The assistant ringing the performer again after the line dropped, from
  // Ringer's Call Back bar (2026-10-28). Same shape as the divert: the
  // performer's Ringer first, by its number, then their mobile after 15 s.
  // `assistant` here is the number being called back; `back` is the caller's
  // own, so the performer can call back in turn.
  if (mode === 'callback' || mode === 'callbackafter') {
    const toRaw = String((body && body.assistant) || (req.query && req.query.assistant) || '').trim();
    const to = /^\+[1-9][0-9]{7,14}$/.test(toRaw) ? toRaw : '';
    if (!to) return xml(res, '<Say>That number cannot be called back.</Say>');
    if (mode === 'callbackafter') {
      const st = String((body && body.DialCallStatus) || '');
      console.log('[callback] client leg ended', st || '(none)');
      if (st === 'completed' || st === 'answered') return xml(res, '<Hangup/>');
      const from = process.env.DIVERT_CALLER_ID || process.env.TWILIO_FROM;
      return xml(res, '<Dial callerId="' + esc(from) + '" answerOnBridge="true">' + esc(to) + '</Dial>');
    }
    const host = (req.headers && req.headers.host) || 'voice-capture-bice.vercel.app';
    const action = 'https://' + host + '/api/voice-twiml?k=' + encodeURIComponent(k)
      + '&mode=callbackafter&assistant=' + encodeURIComponent(to);
    const backRaw = String((body && body.back) || '').trim();
    const back = /^\+[1-9][0-9]{7,14}$/.test(backRaw) ? backRaw : '';
    const who = String((body && body.performer) || '').replace(/[^\p{L}\p{N} .'-]/gu, '').slice(0, 40);
    const params = (room ? '<Parameter name="room" value="' + esc(room) + '"/>' : '')
      + (who ? '<Parameter name="performer" value="' + esc(who) + '"/>' : '')
      + (back ? '<Parameter name="back" value="' + esc(back) + '"/>' : '');
    console.log('[callback] to=..' + to.slice(-4), 'room=' + (room || '-'));
    return xml(res, '<Dial answerOnBridge="true" timeout="15" method="POST" action="' + esc(action) + '">'
      + '<Client><Identity>' + esc(ringerIdentity(to)) + '</Identity>' + params + '</Client></Dial>');
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
    // Since 2026-10-28 every Ringer is also an assistant, signed up with
    // Twilio as ringer_<its own number>. So "VoIP all the way" needs nothing
    // but the assistant's number, which the performer's app sends with every
    // call (`via=client`); the room is only for the video leg. The old way,
    // a room pushed with via=client and a page or app registered as
    // assistant-<room>, still rings too: both are dialled at once and the
    // first to answer takes the call.
    const viaClient = String((body && body.via) || '') === 'client'
      || !!(fromRoom && fromRoom.via === 'client');
    const assistantRaw = (body && body.assistant) || (req.query && req.query.assistant)
      || (fromRoom && fromRoom.assistant) || '';
    const assistantNum = /^\+[1-9][0-9]{7,14}$/.test(String(assistantRaw).trim()) ? String(assistantRaw).trim() : '';
    console.log('[divert] via=' + (viaClient ? 'client' : 'phone'),
      'assistant=..' + (assistantNum ? assistantNum.slice(-4) : (String(assistantRaw).slice(-4) || 'none')),
      'room=' + (room || '-'));
    // KILL SWITCH. Set RINGER_CLIENT_LEG=off (and redeploy) to send every
    // divert straight to the mobile. Used on 2026-10-28 when the Duo kept
    // ringing for its own divert with both of Shine's phones on one number;
    // Ringer now steps out of assistant calls while calling its own number.
    const CLIENT_LEG_ENABLED = process.env.RINGER_CLIENT_LEG !== 'off';
    if (CLIENT_LEG_ENABLED && viaClient && (assistantNum || room)) {
      const host = (req.headers && req.headers.host) || 'voice-capture-bice.vercel.app';
      // Absolute: Twilio would resolve a relative action, but being wrong
      // about that means the fallback silently not happening on stage.
      // The fallback needs the number again: Twilio's callback carries none
      // of the app's own parameters, and there may be no room to look it up.
      const action = 'https://' + host + '/api/voice-twiml?k=' + encodeURIComponent(k)
        + '&mode=afterclient'
        + (room ? '&room=' + encodeURIComponent(room) : '')
        + (assistantNum ? '&assistant=' + encodeURIComponent(assistantNum) : '');
      const dialled = String((body && body.To) || (body && body.caller) || '')
        .replace(/[^0-9+]/g, '').slice(0, 16);
      const performer = String((body && body.performer) || '').replace(/[^\p{L}\p{N} .'-]/gu, '').slice(0, 40);
      // The performer's own confirmed number, so the assistant can ring them
      // back after the line drops (mode=callback below).
      const backRaw = String((body && body.back) || '').trim();
      const back = /^\+[1-9][0-9]{7,14}$/.test(backRaw) ? backRaw : '';
      const params = (room ? '<Parameter name="room" value="' + esc(room) + '"/>' : '')
        + (back ? '<Parameter name="back" value="' + esc(back) + '"/>' : '')
        + (performer ? '<Parameter name="performer" value="' + esc(performer) + '"/>' : '')
        + (dialled ? '<Parameter name="dialled" value="' + esc(dialled) + '"/>' : '');
      const clients = (assistantNum
          ? '<Client><Identity>' + esc(ringerIdentity(assistantNum)) + '</Identity>' + params + '</Client>' : '')
        + (room ? '<Client><Identity>assistant-' + esc(room) + '</Identity>' + params + '</Client>' : '');
      // ringTone: an app ringing makes no ringback of its own (a phone
      // number's carrier supplies one), so the performer heard silence.
      return xml(res, '<Dial answerOnBridge="true" ringTone="us" timeout="15" method="POST" action="' + esc(action) + '">'
        + clients + '</Dial>');
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

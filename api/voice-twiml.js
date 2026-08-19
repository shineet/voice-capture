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

  if (mode === 'divert') {
    // The assistant number is configured in the APP and passed at call time
    // (not hard-coded). ASSISTANT_NUMBER env is only an optional fallback.
    const raw = (body && body.assistant) || (req.query && req.query.assistant) || process.env.ASSISTANT_NUMBER || '';
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

  // voicemail (first dial). Priority: app-provided text (chosen per show) ->
  // hosted recording (VOICEMAIL_URL env) -> default greeting.
  const vmText = (body && body.vm) || (req.query && req.query.vm) || '';
  const vmVoiceRaw = (body && body.vmvoice) || (req.query && req.query.vmvoice) || 'alice';
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

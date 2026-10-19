// lib/mystio-gate.js
// The server lock on the paid services (2026-10-19). MystIO sends its
// per-phone access code as x-mystio-code; mindgames.fly.dev says whether that
// code has the module. Shine ticks modules per tester at
// mindgames.fly.dev/mystio/admin.
//
// Off unless MYSTIO_LOCK=on, so deploying this changes nothing until Shine's
// own phone carries its code. No shared-token bypass: the SMS token is inside
// every copy of the apps, so it would open the lock to anyone who looked (and
// none of Shine's other apps calls these endpoints). If mindgames cannot be
// reached the request goes ahead: a show must not stop because of the lock.

const cache = new Map();
const TTL = 5 * 60 * 1000;

async function mystioAllowed(req, modules) {
  if (process.env.MYSTIO_LOCK !== 'on') return true;
  const code = String(req.headers['x-mystio-code'] || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!code) return false;
  const key = code + '|' + modules;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.ok;
  try {
    const r = await fetch('https://mindgames.fly.dev/api/mystio/check?code=' + encodeURIComponent(code) +
                          '&module=' + encodeURIComponent(modules));
    const j = await r.json();
    cache.set(key, { ok: !!j.ok, at: Date.now() });
    return !!j.ok;
  } catch (e) {
    return true;
  }
}

// One line at the top of a handler: true means it has already answered.
async function refuseIfLocked(req, res, modules) {
  if (req.method !== 'POST') return false;
  if (await mystioAllowed(req, modules)) return false;
  res.status(403).json({ error: 'Not enabled for this MystIO code' });
  return true;
}

module.exports = { mystioAllowed, refuseIfLocked };

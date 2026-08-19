// api/destination.js
// GET               -> { value: string, destinations: [{id,label,template,enabled}] }
// POST { value }                 -> legacy single-destination write (web app)
// POST { destinations: [...] }   -> full multi-destination write (native app)
//
// Server-side store for destination(s), so they're shared across devices
// instead of stuck in one phone's localStorage/UserDefaults. `value` is kept
// as the primary/first-enabled template so the original web app (which only
// ever reads/writes a single string) keeps working unchanged; `destinations`
// carries the full list for clients that support more than one.

const { put, list } = require('@vercel/blob');

const PATHNAME = 'destination.txt';

function legacyDestination(template) {
  return { id: 'legacy', label: 'Destination', template, enabled: true };
}

module.exports = async function handler(req, res) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return res.status(500).json({ error: 'Blob storage not configured -- enable Blob storage for this project in the Vercel dashboard.' });
  }

  if (req.method === 'GET') {
    try {
      const { blobs } = await list({ prefix: PATHNAME, limit: 1 });
      if (!blobs.length) return res.status(200).json({ value: '', destinations: [] });
      const r = await fetch(blobs[0].url);
      const raw = r.ok ? (await r.text()).trim() : '';

      let parsed = null;
      try { parsed = JSON.parse(raw); } catch { /* pre-existing plain-text blob */ }

      if (parsed && typeof parsed === 'object') {
        const destinations = Array.isArray(parsed.destinations) ? parsed.destinations : [];
        const value = typeof parsed.value === 'string' ? parsed.value : (destinations.find(d => d.enabled) || destinations[0] || {}).template || '';
        return res.status(200).json({ value, destinations });
      }

      // Legacy plain-text format from before destinations existed.
      return res.status(200).json({ value: raw, destinations: raw ? [legacyDestination(raw)] : [] });
    } catch (err) {
      console.error('destination GET error:', err);
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method === 'POST') {
    const { value, destinations } = req.body || {};
    let payload;

    if (Array.isArray(destinations)) {
      const cleaned = destinations
        .filter(d => d && typeof d.template === 'string' && d.template.trim())
        .map(d => ({
          id: typeof d.id === 'string' && d.id ? d.id : Date.now().toString(36) + Math.random().toString(36).slice(2),
          label: typeof d.label === 'string' ? d.label : '',
          template: d.template.trim(),
          enabled: !!d.enabled,
        }));

      // Guard against wiping the backup. A fresh install loads an empty list
      // before it has synced from here; if it then saved, an empty POST used to
      // overwrite the stored destinations and they were lost everywhere. Refuse
      // to replace a non-empty stored list with an empty one unless the caller
      // explicitly means it (allowEmpty:true for a genuine "clear all").
      if (cleaned.length === 0 && !(req.body && req.body.allowEmpty)) {
        try {
          const { blobs } = await list({ prefix: PATHNAME, limit: 1 });
          if (blobs.length) {
            const r = await fetch(blobs[0].url + '?t=' + Date.now(), { cache: 'no-store' });
            const raw = r.ok ? (await r.text()).trim() : '';
            let stored = null; try { stored = JSON.parse(raw); } catch { /* ignore */ }
            if (stored && Array.isArray(stored.destinations) && stored.destinations.length) {
              // Keep the existing list; tell the client nothing was overwritten.
              return res.status(200).json({ success: true, preserved: true });
            }
          }
        } catch (_) { /* fall through to normal write */ }
      }

      const primary = cleaned.find(d => d.enabled) || cleaned[0];
      payload = { value: primary ? primary.template : '', destinations: cleaned };
    } else if (typeof value === 'string' && value.trim()) {
      // Legacy single-value write (web app) -- keep it working untouched,
      // and reflect it into destinations too so a native client reading
      // right after a web-app save sees it.
      const trimmed = value.trim();
      payload = { value: trimmed, destinations: [legacyDestination(trimmed)] };
    } else {
      return res.status(400).json({ error: 'Missing value or destinations' });
    }

    try {
      await put(PATHNAME, JSON.stringify(payload), {
        access: 'public',
        contentType: 'application/json',
        addRandomSuffix: false,
        allowOverwrite: true,
      });
      return res.status(200).json({ success: true });
    } catch (err) {
      console.error('destination POST error:', err);
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};

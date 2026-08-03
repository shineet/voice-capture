// api/destination.js
// GET               -> { value: string }
// POST { value }    -> { success: true }
//
// Small server-side store for the destination URL template, so it's shared
// across devices instead of stuck in one phone's localStorage. localStorage
// stays the primary read-path for actual captures (fast, synchronous, no
// network dependency mid-show) -- this exists purely to sync that cached
// value on page load, when Settings is opened, and on save.

const { put, list } = require('@vercel/blob');

const PATHNAME = 'destination.txt';

module.exports = async function handler(req, res) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return res.status(500).json({ error: 'Blob storage not configured -- enable Blob storage for this project in the Vercel dashboard.' });
  }

  if (req.method === 'GET') {
    try {
      const { blobs } = await list({ prefix: PATHNAME, limit: 1 });
      if (!blobs.length) return res.status(200).json({ value: '' });
      const r = await fetch(blobs[0].url);
      const value = r.ok ? (await r.text()).trim() : '';
      return res.status(200).json({ value });
    } catch (err) {
      console.error('destination GET error:', err);
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method === 'POST') {
    const { value } = req.body || {};
    if (typeof value !== 'string' || !value.trim()) {
      return res.status(400).json({ error: 'Missing value' });
    }
    try {
      await put(PATHNAME, value.trim(), {
        access: 'public',
        contentType: 'text/plain',
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

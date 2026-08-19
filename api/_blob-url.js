// api/_blob-url.js
// Builds a blob's public URL without asking the Blob API for it.
//
// WHY THIS EXISTS: reading used to start with list(), which is a metered API
// call against the store. The app polls its mailbox every few seconds during a
// show, so one long session could burn the whole free monthly allowance -- and
// on 2026-08-18 it did, and Vercel paused the store for 30 days.
//
// Nothing about that call was necessary. Every blob here is written with
// addRandomSuffix:false, so its pathname IS its address, and the store's public
// hostname is derivable from the token: BLOB_READ_WRITE_TOKEN looks like
// vercel_blob_rw_<storeId>_<secret>. Reading the URL directly is a plain CDN
// fetch, which is not metered.
//
// If the token ever stops matching that shape this returns null and the callers
// fall back to list(), so a format change degrades to the old behaviour rather
// than breaking the show.

function blobPublicUrl(pathname) {
  const token = process.env.BLOB_READ_WRITE_TOKEN || '';
  const parts = token.split('_');
  // vercel_blob_rw_<storeId>_<secret>
  if (parts.length < 5 || parts[0] !== 'vercel' || parts[1] !== 'blob') return null;
  const storeId = parts[3];
  if (!storeId) return null;
  return `https://${storeId}.public.blob.vercel-storage.com/${pathname}`;
}

module.exports = { blobPublicUrl };

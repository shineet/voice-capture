// api/song.js
// POST { transcript: string } -> { title, artist, spotifyUri, spotifyUrl }
//
// Two-step resolution, not just text cleanup: a raw conversational transcript
// ("oh my first crush... let me think, I think it was... Yesterday by the
// Beatles") isn't clean enough to reliably hit ONE song on Spotify by itself
// -- titles collide across artists/covers, and speech-to-text mangles names.
// So this (1) asks an LLM to pull a rough title/artist guess out of the
// transcript, then (2) verifies that guess against Spotify's own Search API
// and returns whatever Spotify itself resolves it to -- a real catalog match,
// not a hopeful string. The response includes a direct spotify:track: URI,
// which opens that exact song with zero ambiguity, rather than a text search
// the destination app would still have to disambiguate itself.

module.exports = async function handler(req, res) {
  // ── Diagnostic sink ────────────────────────────────────────────────────────
  // A POST carrying `diag` is not a song lookup. It is the app reporting what
  // actually happened on a Spotify playback attempt, so a fault can be read
  // here instead of relayed through a tester one sentence at a time.
  //
  // HERE rather than in its own api/ file because this project is at the
  // twelve-function Vercel Hobby cap, same as shine-booking. No database on
  // this backend either, so it goes to the runtime log -- which on Hobby is
  // kept for ONE HOUR. Read it promptly or it is gone.
  //
  // Deliberately carries no token and no credential; it is device names, track
  // ids and HTTP results.
  if (req.method === 'POST') {
    let b = req.body;
    if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = null; } }
    if (b && b.diag) {
      console.log('SPOTIFY-DIAG ' + JSON.stringify(b.diag).slice(0, 4000));
      return res.status(200).json({ logged: true });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY is not configured' });
  if (!process.env.SPOTIFY_CLIENT_ID || !process.env.SPOTIFY_CLIENT_SECRET) {
    return res.status(500).json({ error: 'SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET are not configured' });
  }

  // The app sends the market it read from the listener's own Spotify profile.
  // Defaulting to US rather than omitting it: an omitted market is what caused
  // the silent no-op, and US is right for every tester so far. A wrong market
  // fails loudly (no match) instead of silently (accepted, never plays).
  const { transcript, indian, market } = req.body || {};
  const mkt = (typeof market === 'string' && /^[A-Za-z]{2}$/.test(market))
    ? market.toUpperCase() : 'US';
  if (typeof transcript !== 'string' || !transcript.trim()) {
    return res.status(400).json({ error: 'Missing transcript' });
  }

  try {
    const guess = await extractSongGuess(transcript.trim(), indian === true);
    if (!guess || !guess.title) {
      return res.status(200).json({ error: 'No song identifiable in that transcript' });
    }

    const track = await searchSpotifyTrack(guess.title, guess.artist, mkt);
    if (!track) {
      return res.status(200).json({ error: `No Spotify match for "${guess.title}"${guess.artist ? ' by ' + guess.artist : ''}` });
    }

    // is_playable comes back only when a market was supplied, which is the
    // other reason to always send one: it lets the app say WHY nothing played
    // instead of reporting a successful request that did nothing.
    if (track.is_playable === false) {
      console.log('SPOTIFY-DIAG', JSON.stringify({
        note: 'match found but NOT playable in market', market: mkt,
        uri: track.uri, title: track.name,
      }));
    }

    return res.status(200).json({
      title: track.name,
      artist: track.artists.map((a) => a.name).join(', '),
      spotifyUri: track.uri,
      spotifyUrl: track.external_urls && track.external_urls.spotify,
      market: mkt,
      playable: track.is_playable !== false,
    });
  } catch (err) {
    console.error('song resolve error:', err);
    return res.status(500).json({ error: err.message });
  }
};

// Deliberately asks for STRICT JSON back (response_format) rather than
// parsing free-form prose -- this is a server endpoint feeding a live
// performance, not a chat UI, so the output needs to be reliably parseable,
// not just readable.
async function extractSongGuess(transcript, indian) {
  // With the Indian-songs bias on, the extractor is told the song is likely
  // Indian (Bollywood/film or regional) and to lean toward playback singers,
  // romanized titles, and the film name as artist context -- which is what
  // actually makes the downstream Spotify search resolve a Hindi/Tamil/etc.
  // title instead of missing. Off by default so it never skews a Western song.
  const systemContent = indian
    ? 'You extract the song being discussed in a conversation transcript. ' +
      'The song is likely Indian -- a Bollywood/film song or a regional ' +
      '(Hindi, Tamil, Telugu, Punjabi, etc.) song. The transcript is English ' +
      'speech-to-text and may have mangled the title or artist. Use your ' +
      'knowledge of Indian music to recover the actual song: give the ' +
      'commonly-searchable romanized title, and for a film song set the ' +
      'playback singer(s) as artist when you know them (e.g. Arijit Singh, ' +
      'Shreya Ghoshal, Lata Mangeshkar, Kishore Kumar, Sonu Nigam, ' +
      'A.R. Rahman, Neha Kakkar), otherwise the music director or film name. ' +
      'Respond with ONLY a JSON object: {"title": string, "artist": string}. ' +
      'If an artist is not identifiable, use "" for artist. ' +
      'If no specific song is identifiable, respond with {"title": "", "artist": ""}.'
    : 'You extract the song being discussed in a conversation transcript. ' +
      'Respond with ONLY a JSON object: {"title": string, "artist": string}. ' +
      'If an artist is not mentioned or you are not confident, use "" for artist. ' +
      'If no specific song is identifiable, respond with {"title": "", "artist": ""}.';

  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemContent },
        { role: 'user', content: transcript },
      ],
      temperature: 0,
    }),
  });

  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    throw new Error(data.error?.message || 'Song extraction failed');
  }

  const data = await r.json();
  const content = data.choices?.[0]?.message?.content || '{}';
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  const title = typeof parsed.title === 'string' ? parsed.title.trim() : '';
  const artist = typeof parsed.artist === 'string' ? parsed.artist.trim() : '';
  return title ? { title, artist } : null;
}

// Client Credentials flow (app-level auth, no Spotify user login needed --
// this app only ever does catalog search, never anything user-specific).
// Cached at module scope so a warm serverless container reuses the same
// token across requests instead of re-authenticating every single capture;
// tokens last an hour, refreshed a minute early to avoid an edge-of-expiry
// race.
let cachedSpotifyToken = null;
let cachedSpotifyTokenExpiresAt = 0;

async function getSpotifyToken() {
  if (cachedSpotifyToken && Date.now() < cachedSpotifyTokenExpiresAt) {
    return cachedSpotifyToken;
  }
  const creds = Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64');
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${creds}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    throw new Error(data.error_description || 'Spotify auth failed');
  }
  const data = await r.json();
  cachedSpotifyToken = data.access_token;
  cachedSpotifyTokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
  return cachedSpotifyToken;
}

// Comparable form of a title: lower case, no punctuation, no bracketed or
// dashed suffix. Spotify's own titles carry a lot of those -- "Liberian Girl -
// 2012 Remastered Version", "Song (feat. X)" -- and none of it is what anybody
// said out loud.
function normaliseTitle(t) {
  return String(t || '')
    .toLowerCase()
    .split(' - ')[0]
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// How close two strings are, 0 to 1, by edit distance over the longer one.
// Small and dependency-free on purpose: this file has no npm packages and the
// strings are a few words long.
function similarity(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return 1 - prev[n] / Math.max(m, n);
}

async function spotifySearch(q, limit, token, market) {
  // The market is not a nicety. Searching WITHOUT it returns catalogue-wide
  // track ids that may not be playable where the listener actually is, and
  // Spotify does not refuse a play aimed at one -- it accepts the request and
  // then loads nothing, leaving the player at is_playing=false with a null
  // item. That is precisely the trace Greg kept producing. With a market,
  // Spotify relinks to the id that IS playable for him.
  const url = `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=${limit}`
    + (market ? `&market=${encodeURIComponent(market)}` : '');
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    throw new Error(data.error?.message || 'Spotify search failed');
  }
  const data = await r.json();
  return data.tracks?.items || [];
}

const artistMatches = (track, artist) => {
  if (!artist) return true;
  const want = String(artist).toLowerCase();
  return (track.artists || []).some((a) => {
    const got = String(a.name || '').toLowerCase();
    return got.includes(want) || want.includes(got) || similarity(got, want) >= 0.7;
  });
};

/// Find the track, tolerating a misheard word.
///
/// Whisper gets one syllable wrong and the whole effect dies: "Liberian Girl"
/// comes back as "Librarian Girl", `track:Librarian Girl` is a FIELD match, and
/// a field match does not do near-misses. One search, no match, nothing played.
///
/// So: three tries, loosening only after the tighter one finds nothing. The
/// strict query stays first because it is what stops "same title, different
/// artist" -- the ambiguity this endpoint exists to remove. Nothing that
/// succeeds today changes; this only reaches cases that already returned null.
async function searchSpotifyTrack(title, artist, market) {
  const token = await getSpotifyToken();
  const wanted = normaliseTitle(title);

  // 1. Exact, field-scoped. Precision first.
  const strict = artist ? `track:${title} artist:${artist}` : title;
  const exact = await spotifySearch(strict, 1, token, market);
  if (exact[0]) return exact[0];

  // 2. Plain keywords. Spotify's own matcher is far more forgiving than a
  //    field query, and this is where most single-word mishearings recover.
  //    The artist is still CHECKED, just not used as a filter -- a loose search
  //    will happily hand back the right title by the wrong singer.
  const loose = await spotifySearch([title, artist].filter(Boolean).join(' '), 10, token, market);
  const byArtist = loose.filter((t) => artistMatches(t, artist));
  if (byArtist[0]) return byArtist[0];

  // 3. Everything by that artist, then the closest title. This is the one that
  //    turns "Librarian Girl" into "Liberian Girl": same artist, one letter
  //    out, and comparing the words directly finds what no query would.
  if (artist) {
    const catalogue = await spotifySearch(`artist:${artist}`, 50, token, market);
    let best = null, bestScore = 0;
    for (const t of catalogue) {
      if (!artistMatches(t, artist)) continue;
      const score = similarity(normaliseTitle(t.name), wanted);
      if (score > bestScore) { best = t; bestScore = score; }
    }
    // 0.62 keeps "librarian girl" -> "liberian girl" (0.86) and rejects a
    // different song by the same artist, which would be worse than failing:
    // a wrong track plays confidently and nobody knows why.
    if (best && bestScore >= 0.62) return best;
  }

  // 4. Last try, unfiltered, for when the ARTIST was the misheard part.
  if (loose[0] && similarity(normaliseTitle(loose[0].name), wanted) >= 0.62) return loose[0];

  return null;
}

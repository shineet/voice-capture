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
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY is not configured' });
  if (!process.env.SPOTIFY_CLIENT_ID || !process.env.SPOTIFY_CLIENT_SECRET) {
    return res.status(500).json({ error: 'SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET are not configured' });
  }

  const { transcript } = req.body || {};
  if (typeof transcript !== 'string' || !transcript.trim()) {
    return res.status(400).json({ error: 'Missing transcript' });
  }

  try {
    const guess = await extractSongGuess(transcript.trim());
    if (!guess || !guess.title) {
      return res.status(200).json({ error: 'No song identifiable in that transcript' });
    }

    const track = await searchSpotifyTrack(guess.title, guess.artist);
    if (!track) {
      return res.status(200).json({ error: `No Spotify match for "${guess.title}"${guess.artist ? ' by ' + guess.artist : ''}` });
    }

    return res.status(200).json({
      title: track.name,
      artist: track.artists.map((a) => a.name).join(', '),
      spotifyUri: track.uri,
      spotifyUrl: track.external_urls && track.external_urls.spotify,
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
async function extractSongGuess(transcript) {
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
        {
          role: 'system',
          content:
            'You extract the song being discussed in a conversation transcript. ' +
            'Respond with ONLY a JSON object: {"title": string, "artist": string}. ' +
            'If an artist is not mentioned or you are not confident, use "" for artist. ' +
            'If no specific song is identifiable, respond with {"title": "", "artist": ""}.',
        },
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

async function searchSpotifyTrack(title, artist) {
  const token = await getSpotifyToken();
  // Structured query (track:/artist: fields) when an artist guess exists --
  // meaningfully narrows results versus a loose keyword search, which is
  // exactly the ambiguity (same title, different artist) this endpoint
  // exists to avoid. Falls back to a plain title search when no artist was
  // extracted at all, rather than search for artist:"" and getting nothing.
  const q = artist ? `track:${title} artist:${artist}` : title;
  const url = `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=1`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    throw new Error(data.error?.message || 'Spotify search failed');
  }
  const data = await r.json();
  const track = data.tracks?.items?.[0];
  return track || null;
}

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

    // ── Celebrity -> the thing they are best known for ───────────────────────
    // POST { famousFor: "Tom Cruise" } -> { title, kind, alternates: [] }
    //
    // HERE rather than in api/famous.js for the same reason the diagnostic
    // sink above is here: this project sits on exactly twelve functions and
    // Vercel Hobby allows twelve. A thirteenth file does not fail at runtime,
    // it fails the BUILD, and takes the working endpoints down with it.
    //
    // It belongs here anyway. This file already means "a rough human phrase
    // in, one authoritative title out, the credential staying server-side",
    // which is the whole job.
    //
    // No TMDB. The obvious source for this is TMDB's known_for, which is
    // ranked by real popularity rather than by a model's impression of it --
    // but it needs an account, a key, and a key rotation story, and OPENAI_API
    // _KEY is already here. If the answers disappoint, TMDB is the upgrade and
    // this function is where it goes.
    // ── Keypad digits -> the name they spell ─────────────────────────────────
    // POST { t9: "77492" } -> { names: [ "Priya", ... ] }
    //
    // Only reached when the app's own bundled lists have already missed. The
    // offline path handles the common names instantly and without a signal;
    // this exists for Siobhan, Anushka, Kwame and everyone else no bundled
    // list of eight hundred names was ever going to contain.
    //
    // The digits constrain the answer hard, which is what makes a model
    // trustworthy here: it is not inventing a name, it is being asked which
    // real names fit a pattern that admits very few.
    if (b && typeof b.t9 === 'string' && /^[2-9]+$/.test(b.t9.trim())) {
      if (!process.env.OPENAI_API_KEY) {
        return res.status(500).json({ error: 'OPENAI_API_KEY is not configured' });
      }
      try {
        const found = await namesForKeypad(b.t9.trim());
        // `debug` returns what the model actually said alongside what survived
        // verification. Without it a rejected answer and an empty answer look
        // identical from the outside, which is a whole deploy wasted guessing
        // which one happened.
        return res.status(200).json(
          b.debug ? found : { names: found.names }
        );
      } catch (e) {
        return res.status(200).json({ error: String(e && e.message ? e.message : e) });
      }
    }

    if (b && typeof b.famousFor === 'string' && b.famousFor.trim()) {
      if (!process.env.OPENAI_API_KEY) {
        return res.status(500).json({ error: 'OPENAI_API_KEY is not configured' });
      }
      try {
        const found = await bestKnownWork(b.famousFor.trim());
        if (!found || !found.title) {
          return res.status(200).json({ error: `Nothing found for "${b.famousFor.trim()}"` });
        }
        return res.status(200).json(found);
      } catch (e) {
        return res.status(200).json({ error: String(e && e.message ? e.message : e) });
      }
    }
    // ── A song title -> the YouTube video that IS that song ────────────────
    // POST { youtube: "Yesterday The Beatles" }
    //   -> { videoId, title, channel, alternates: [{ videoId, title, channel }] }
    //
    // Fourth mode in this file, same twelve-function reason as the three above.
    //
    // A search URL was the obvious shortcut and is the wrong thing entirely:
    // youtube.com/results?search_query=... lands on a LIST, and a spectator
    // holding their own phone is then looking at search results with the song
    // they named sitting in them, which reads as a search having been typed.
    // Only a /watch?v= URL opens the app already playing, which is the effect.
    //
    // Asking a model for the video id is the "Sandy for 77492" failure again:
    // an eleven-character opaque id is exactly the kind of string a model will
    // produce confidently and wrongly, and a wrong id is a 404 in the
    // spectator's hand. So this is a real search against YouTube's own index,
    // and what comes back is a video that certainly exists.
    //
    // Alternates ride along because the search returns five results for the
    // same 100 quota units as one. The first hit is nearly always the official
    // video; when it is a cover or a lyric video, having the next four already
    // in hand is the difference between choosing again and starting over.
    if (b && typeof b.youtube === 'string' && b.youtube.trim()) {
      if (!process.env.YOUTUBE_API_KEY) {
        return res.status(500).json({ error: 'YOUTUBE_API_KEY is not configured' });
      }
      try {
        const found = await youtubeSearch(b.youtube.trim());
        if (!found || !found.videoId) {
          return res.status(200).json({ error: `Nothing on YouTube for "${b.youtube.trim()}"` });
        }
        return res.status(200).json(found);
      } catch (e) {
        return res.status(200).json({ error: String(e && e.message ? e.message : e) });
      }
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

// One name in, the work they are best known for out.
//
// ALTERNATES ARE RETURNED, not just the winner, and that is deliberate. "Best
// known" is genuinely arguable for a lot of people -- Tom Cruise is Top Gun to
// one room and Mission: Impossible to the next -- so the app is given the
// runners-up to fall back on, the same way a handwriting recogniser hands over
// its other candidates instead of insisting on the first.
//
// Asked for the single most POPULAR rather than the best or the most
// acclaimed: a spectator naming a celebrity is thinking of the famous one, not
// the one that won things.
async function bestKnownWork(name) {
  const body = {
    model: process.env.FAMOUS_MODEL || 'gpt-4o-mini',
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          'You name the single film or television show a person is MOST FAMOUS for. ' +
          'Most popular and most widely recognised, not most acclaimed and not most recent. ' +
          'Answer JSON only: {"title": string, "kind": "film"|"tv", "alternates": [string, string]}. ' +
          'title is the work\'s common name with no year and no subtitle unless the subtitle is how ' +
          'everyone says it. alternates are the next two best-known works, most famous first. ' +
          'If the name is not a real public figure, or you are not confident, answer {"title": ""}.',
      },
      { role: 'user', content: name },
    ],
  };
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status}`);
  const json = await r.json();
  let parsed = {};
  try { parsed = JSON.parse(json.choices[0].message.content); } catch { parsed = {}; }
  const title = typeof parsed.title === 'string' ? parsed.title.trim() : '';
  const alternates = Array.isArray(parsed.alternates)
    ? parsed.alternates.filter((a) => typeof a === 'string' && a.trim()).slice(0, 2)
    : [];
  return { title, kind: parsed.kind === 'tv' ? 'tv' : 'film', alternates };
}

// Which real first names a keypad sequence spells.
//
// The letters under the keys are given to the model rather than assumed,
// and the length is stated, because both are the constraints that stop it
// answering with a name that does not actually fit. Verified again here
// afterwards: a model that returns a name of the wrong length has answered a
// different question, and passing that through would put a wrong name in
// front of a room.
async function namesForKeypad(digits) {
  const KEYS = { 2: 'ABC', 3: 'DEF', 4: 'GHI', 5: 'JKL', 6: 'MNO', 7: 'PQRS', 8: 'TUV', 9: 'WXYZ' };
  // Stated PER POSITION, not as a legend.
  //
  // The first version handed over "7=PQRS 7=PQRS 4=GHI 9=WXYZ 2=ABC" and asked
  // for names matching it. For 77492 -- Priya -- it answered "Sandy", three
  // times, which spells 72639. Applying a key map letter by letter is exactly
  // the kind of mechanical character work these models are worst at, and a
  // legend leaves the applying to them.
  //
  // Naming the allowed letters at each position turns it from a mapping task
  // into a constraint-satisfaction one, which is a question a language model
  // can actually answer.
  const spelled = digits
    .split('')
    .map((d, i) => `letter ${i + 1} is one of ${KEYS[d].split('').join('/')}`)
    .join(', ');
  const body = {
    // A stronger model than the film lookup uses, deliberately. This is
    // per-character constraint work, which mini demonstrably cannot do: it
    // answered Sandy for Priya's digits, then nothing at all.
    model: process.env.T9_MODEL || 'gpt-4o',
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          `List real human FIRST NAMES of exactly ${digits.length} letters where ${spelled}. ` +
          'Any culture, any origin. Check each letter against its rule before answering. ' +
          'Most common names first. Answer JSON only: {"names": [string]}. At most five. ' +
          'If nothing real fits every rule, answer {"names": []}. Never invent a name.',
      },
      { role: 'user', content: spelled },
    ],
  };
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status}`);
  const json = await r.json();
  let parsed = {};
  try { parsed = JSON.parse(json.choices[0].message.content); } catch { parsed = {}; }
  const raw = Array.isArray(parsed.names) ? parsed.names : [];

  // Checked against the keypad here, not taken on trust. A name of the wrong
  // length, or one whose letters do not map back to these digits, is an answer
  // to some other question.
  const keyFor = {};
  for (const [digit, letters] of Object.entries(KEYS)) {
    for (const letter of letters) keyFor[letter] = digit;
  }
  const fits = (name) => {
    const up = String(name || '').trim().toUpperCase();
    if (up.length !== digits.length) return false;
    for (let i = 0; i < up.length; i += 1) {
      if (keyFor[up[i]] !== digits[i]) return false;
    }
    return true;
  };
  const names = raw
    .filter(fits)
    .map((n) => String(n).trim())
    .map((n) => n[0].toUpperCase() + n.slice(1).toLowerCase())
    .slice(0, 5);
  return { names, raw, spelled };
}


// ── YouTube search ────────────────────────────────────────────────────
// One search.list call: 100 quota units out of a free 10,000 a day, so about a
// hundred reveals daily at no cost, and the quota resets at midnight Pacific.
//
// The key is restricted to this one API, so a leak costs the quota and nothing
// else. It never reaches the browser: the phone asks this endpoint, this
// endpoint asks Google.
async function youtubeSearch(query) {
  const url = 'https://www.googleapis.com/youtube/v3/search'
    + '?part=snippet'
    + '&type=video'           // a channel or a playlist has no /watch?v= to open
    + '&maxResults=5'
    + '&q=' + encodeURIComponent(query)
    + '&key=' + encodeURIComponent(process.env.YOUTUBE_API_KEY);

  const r = await fetch(url);
  const data = await r.json().catch(() => null);

  if (!r.ok) {
    // Google states the reason in a shape worth surfacing verbatim: a quota
    // error and a bad key read identically as "it did not work" otherwise, and
    // they need opposite fixes.
    const reason = data && data.error && data.error.errors && data.error.errors[0]
      ? data.error.errors[0].reason : '';
    const message = data && data.error ? data.error.message : ('HTTP ' + r.status);
    if (reason === 'quotaExceeded') {
      return { error: 'YouTube daily search quota is used up. It resets at midnight Pacific.' };
    }
    return { error: 'YouTube: ' + message };
  }

  const items = (data && Array.isArray(data.items) ? data.items : [])
    .filter((it) => it && it.id && it.id.videoId)
    .map((it) => ({
      videoId: it.id.videoId,
      // YouTube titles carry HTML entities (&amp;, &#39;) because the API
      // returns them ready for a web page. This value is shown in the app and
      // spoken about out loud, so they have to come out.
      title: decodeEntities(String((it.snippet && it.snippet.title) || '')),
      channel: decodeEntities(String((it.snippet && it.snippet.channelTitle) || '')),
    }));

  if (!items.length) return { videoId: '', title: '', channel: '', alternates: [] };

  return {
    videoId: items[0].videoId,
    title: items[0].title,
    channel: items[0].channel,
    alternates: items.slice(1),
  };
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

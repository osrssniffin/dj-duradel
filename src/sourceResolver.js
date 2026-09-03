import { spawn } from 'node:child_process';

const YTDLP = process.env.YTDLP_PATH || 'yt-dlp';

const MAX_PLAYLIST_TRACKS = Math.max(
  1,
  Math.min(500, Number(process.env.MAX_PLAYLIST_TRACKS || 200))
);

const SPOTIFY_SEARCH_CONCURRENCY = Math.max(
  1,
  Math.min(8, Number(process.env.SPOTIFY_SEARCH_CONCURRENCY || 4))
);

function runYtDlp(args, { jsonLines = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(YTDLP, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', d => {
      stdout += d.toString();
    });

    child.stderr.on('data', d => {
      stderr += d.toString();
    });

    child.once('error', err => {
      reject(
        new Error(
          `Could not start yt-dlp (${YTDLP}). ${err.message}`
        )
      );
    });

    child.once('close', code => {
      if (code !== 0) {
        reject(
          new Error(
            stderr.trim() || `yt-dlp exited with code ${code}`
          )
        );
        return;
      }

      if (!jsonLines) {
        resolve(stdout.trim());
        return;
      }

      const rows = stdout
        .split(/\r?\n/)
        .map(s => s.trim())
        .filter(Boolean)
        .map(line => JSON.parse(line));

      resolve(rows);
    });
  });
}

function cleanInput(input) {
  let value = String(input || '').trim();

  if (!value) {
    return '';
  }

  // Discord/autolink wrappers and copied HTML entities.
  value = value
    .replace(/&amp;/gi, '&')
    .trim();

  if (
    value.startsWith('<') &&
    value.endsWith('>')
  ) {
    value = value
      .slice(1, -1)
      .trim();
  }

  /*
   * If someone pastes:
   *
   * check this out https://youtube.com/...
   *
   * use the URL instead of treating the entire
   * message as a YouTube search.
   */
  const urlMatch = value.match(
    /https?:\/\/[^\s<>]+/i
  );

  if (urlMatch) {
    value = urlMatch[0]
      .replace(/[),.;!?]+$/g, '')
      .trim();
  }

  return value;
}

function isUrl(input) {
  try {
    const url = new URL(input);

    return (
      url.protocol === 'http:' ||
      url.protocol === 'https:'
    );
  } catch {
    return false;
  }
}

function normalizeUrl(input) {
  if (!isUrl(input)) {
    return input;
  }

  const url = new URL(input);

  /*
   * URL fragments are irrelevant for playback and
   * occasionally confuse extractors.
   */
  url.hash = '';

  const host = url.hostname
    .toLowerCase()
    .replace(/^www\./, '');

  /*
   * Normalize mobile YouTube.
   *
   * Keep query params intact on purpose.
   * That includes:
   *
   * list=
   * t=
   * start=
   * si=
   * pp=
   * feature=
   *
   * yt-dlp is good at understanding them.
   */
  if (host === 'm.youtube.com') {
    url.hostname = 'youtube.com';
  }

  return url.toString();
}

function spotifyKind(url) {
  try {
    const u = new URL(url);

    if (
      !/(^|\.)open\.spotify\.com$/i.test(
        u.hostname
      )
    ) {
      return null;
    }

    const parts = u.pathname
      .split('/')
      .filter(Boolean);

    const index = parts.findIndex(part =>
      [
        'track',
        'playlist',
        'album'
      ].includes(part)
    );

    if (
      index === -1 ||
      !parts[index + 1]
    ) {
      return null;
    }

    return {
      kind: parts[index],
      id: parts[index + 1]
    };
  } catch {
    return null;
  }
}

let spotifyTokenCache = {
  token: null,
  expiresAt: 0
};

async function spotifyToken() {
  const id =
    process.env.SPOTIFY_CLIENT_ID;

  const secret =
    process.env.SPOTIFY_CLIENT_SECRET;

  if (!id || !secret) {
    return null;
  }

  if (
    spotifyTokenCache.token &&
    Date.now() <
      spotifyTokenCache.expiresAt -
        30_000
  ) {
    return spotifyTokenCache.token;
  }

  const auth = Buffer
    .from(`${id}:${secret}`)
    .toString('base64');

  const response = await fetch(
    'https://accounts.spotify.com/api/token',
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type':
          'application/x-www-form-urlencoded'
      },
      body: 'grant_type=client_credentials'
    }
  );

  if (!response.ok) {
    throw new Error(
      `Spotify token request failed (${response.status})`
    );
  }

  const body =
    await response.json();

  spotifyTokenCache = {
    token: body.access_token,
    expiresAt:
      Date.now() +
      body.expires_in * 1000
  };

  return body.access_token;
}

async function spotifyApi(pathname) {
  const token =
    await spotifyToken();

  if (!token) {
    return null;
  }

  const response = await fetch(
    `https://api.spotify.com/v1${pathname}`,
    {
      headers: {
        Authorization:
          `Bearer ${token}`
      }
    }
  );

  if (!response.ok) {
    throw new Error(
      `Spotify API failed (${response.status})`
    );
  }

  return response.json();
}

async function spotifyApiAbsolute(
  url,
  token
) {
  const response = await fetch(url, {
    headers: {
      Authorization:
        `Bearer ${token}`
    }
  });

  if (!response.ok) {
    throw new Error(
      `Spotify API failed (${response.status})`
    );
  }

  return response.json();
}

async function spotifyOembed(url) {
  const response = await fetch(
    `https://open.spotify.com/oembed?url=${encodeURIComponent(
      url
    )}`
  );

  if (!response.ok) {
    throw new Error(
      `Spotify metadata lookup failed (${response.status})`
    );
  }

  return response.json();
}

async function mapLimit(
  items,
  limit,
  mapper
) {
  const output =
    new Array(items.length);

  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex++;

      if (index >= items.length) {
        return;
      }

      try {
        output[index] =
          await mapper(
            items[index],
            index
          );
      } catch (error) {
        console.error(
          '[spotify resolve]',
          error
        );

        output[index] = null;
      }
    }
  }

  const workerCount = Math.min(
    limit,
    items.length
  );

  await Promise.all(
    Array.from(
      {
        length: workerCount
      },
      () => worker()
    )
  );

  return output;
}

function spotifySearchText(track) {
  if (!track) {
    return '';
  }

  const artists =
    track.artists
      ?.map(artist => artist.name)
      .filter(Boolean)
      .join(' ') || '';

  return `${
    track.name || ''
  } ${artists}`.trim();
}

async function resolveSpotify(
  url,
  requestedBy
) {
  const info =
    spotifyKind(url);

  if (!info) {
    return null;
  }

  const token =
    await spotifyToken();

  /*
   * Single Spotify tracks work without
   * Spotify API credentials.
   *
   * Spotify gives us metadata and then
   * we find the song on YouTube.
   */
  if (
    !token &&
    info.kind === 'track'
  ) {
    const metadata =
      await spotifyOembed(url);

    const search = `${
      String(
        metadata.title || ''
      ).trim()
    } ${
      String(
        metadata.author_name || ''
      ).trim()
    }`.trim();

    if (!search) {
      throw new Error(
        'Could not read Spotify track metadata.'
      );
    }

    return resolveInput(
      search,
      requestedBy,
      {
        bypassSpotify: true,
        single: true
      }
    );
  }

  if (!token) {
    throw new Error(
      'Spotify playlists and albums need Spotify API credentials configured on the bot.'
    );
  }

  const searches = [];

  if (info.kind === 'track') {
    const track =
      await spotifyApi(
        `/tracks/${info.id}`
      );

    const search =
      spotifySearchText(track);

    if (search) {
      searches.push(search);
    }
  }

  if (info.kind === 'album') {
    let next =
      `/albums/${info.id}/tracks?limit=50`;

    while (
      next &&
      searches.length <
        MAX_PLAYLIST_TRACKS
    ) {
      const page =
        next.startsWith('http')
          ? await spotifyApiAbsolute(
              next,
              token
            )
          : await spotifyApi(next);

      for (
        const track of
          page.items || []
      ) {
        const search =
          spotifySearchText(track);

        if (search) {
          searches.push(search);
        }

        if (
          searches.length >=
          MAX_PLAYLIST_TRACKS
        ) {
          break;
        }
      }

      next = page.next;
    }
  }

  if (info.kind === 'playlist') {
    let next =
      `/playlists/${info.id}/tracks?limit=100`;

    while (
      next &&
      searches.length <
        MAX_PLAYLIST_TRACKS
    ) {
      const page =
        next.startsWith('http')
          ? await spotifyApiAbsolute(
              next,
              token
            )
          : await spotifyApi(next);

      for (
        const item of
          page.items || []
      ) {
        const search =
          spotifySearchText(
            item?.track
          );

        if (search) {
          searches.push(search);
        }

        if (
          searches.length >=
          MAX_PLAYLIST_TRACKS
        ) {
          break;
        }
      }

      next = page.next;
    }
  }

  if (!searches.length) {
    throw new Error(
      'No playable tracks were found in that Spotify link.'
    );
  }

  /*
   * Resolve Spotify tracks concurrently instead
   * of one-by-one.
   *
   * This massively improves larger playlists.
   */
  const resolved =
    await mapLimit(
      searches,
      SPOTIFY_SEARCH_CONCURRENCY,
      async search => {
        const found =
          await resolveInput(
            search,
            requestedBy,
            {
              bypassSpotify: true,
              single: true
            }
          );

        return (
          found[0] ||
          null
        );
      }
    );

  const tracks =
    resolved.filter(Boolean);

  if (!tracks.length) {
    throw new Error(
      'Spotify metadata loaded, but no matching playable tracks were found.'
    );
  }

  return tracks;
}

function normalizeEntry(
  entry,
  requestedBy
) {
  const webpageUrl =
    entry.webpage_url ||
    entry.original_url ||
    entry.url;

  const title =
    entry.title ||
    entry.fulltitle ||
    'Unknown title';

  const duration =
    Number.isFinite(
      entry.duration
    )
      ? entry.duration
      : null;

  const thumbnail =
    entry.thumbnail ||
    (
      Array.isArray(
        entry.thumbnails
      ) &&
      entry.thumbnails.length
        ? entry.thumbnails[
            entry.thumbnails.length -
              1
          ]?.url
        : null
    );

  return {
    id: entry.id || null,
    title,
    url: webpageUrl,
    duration,
    thumbnail:
      thumbnail || null,
    uploader:
      entry.artist ||
      entry.uploader ||
      entry.channel ||
      null,
    source:
      entry.extractor_key ||
      entry.extractor ||
      'Web',
    requestedBy
  };
}

/*
 * Handles:
 *
 * search text
 * youtube.com/watch
 * youtu.be
 * YouTube Shorts
 * YouTube Music
 * YouTube playlists
 * watch?v=...&list=...
 * copied tracking parameters
 * generic yt-dlp supported links
 * Spotify tracks
 * Spotify albums
 * Spotify playlists
 */
export async function resolveInput(
  input,
  requestedBy,
  opts = {}
) {
  const cleaned =
    cleanInput(input);

  if (!cleaned) {
    throw new Error(
      'Nothing to play.'
    );
  }

  const normalized =
    isUrl(cleaned)
      ? normalizeUrl(cleaned)
      : cleaned;

  if (
    !opts.bypassSpotify &&
    isUrl(normalized) &&
    spotifyKind(normalized)
  ) {
    return resolveSpotify(
      normalized,
      requestedBy
    );
  }

  const target =
    isUrl(normalized)
      ? normalized
      : `ytsearch1:${normalized}`;

  /*
   * yt-dlp is deliberately the catch-all.
   *
   * Do not manually whitelist YouTube URL
   * patterns unless absolutely necessary.
   */
  const stdout =
    await runYtDlp([
      '--dump-single-json',
      '--ignore-errors',
      '--no-warnings',
      '--no-call-home',

      '--playlist-end',
      String(
        opts.single
          ? 1
          : MAX_PLAYLIST_TRACKS
      ),

      target
    ]);

  const data =
    JSON.parse(stdout);

  let entries;

  if (
    Array.isArray(
      data.entries
    )
  ) {
    entries =
      data.entries.filter(
        Boolean
      );
  } else {
    entries = [data];
  }

  if (opts.single) {
    entries =
      entries.slice(0, 1);
  }

  const tracks =
    entries
      .map(entry =>
        normalizeEntry(
          entry,
          requestedBy
        )
      )
      .filter(
        track => track.url
      )
      .slice(
        0,
        opts.single
          ? 1
          : MAX_PLAYLIST_TRACKS
      );

  if (!tracks.length) {
    throw new Error(
      'No playable media was found for that link or search.'
    );
  }

  return tracks;
}

/*
 * Autoplay recommendation.
 */
export async function resolveRecommended(
  track,
  requestedBy,
  excluded = new Set()
) {
  const query = `${
    track.uploader || ''
  } ${
    track.title || ''
  } similar music`.trim();

  const stdout =
    await runYtDlp([
      '--dump-single-json',
      '--ignore-errors',
      '--no-warnings',
      '--no-call-home',
      `ytsearch8:${query}`
    ]);

  const data =
    JSON.parse(stdout);

  const entries =
    Array.isArray(
      data.entries
    )
      ? data.entries.filter(
          Boolean
        )
      : [data];

  const blocked =
    new Set(
      [
        track.id,
        track.url,
        ...excluded
      ].filter(Boolean)
    );

  return (
    entries
      .map(entry =>
        normalizeEntry(
          entry,
          requestedBy
        )
      )
      .find(
        candidate =>
          candidate.url &&
          !blocked.has(
            candidate.id
          ) &&
          !blocked.has(
            candidate.url
          )
      ) ||
    null
  );
}

/*
 * Get a fresh direct audio URL.
 *
 * Never permanently store direct URLs because
 * YouTube/CDN stream URLs expire.
 */
export async function getFreshAudio(
  track
) {
  const stdout =
    await runYtDlp([
      '--dump-single-json',
      '--no-playlist',
      '--no-warnings',
      '--no-call-home',
      '-f',
      'bestaudio/best',
      track.url
    ]);

  const data =
    JSON.parse(stdout);

  let streamUrl =
    data.url;

  if (
    !streamUrl &&
    Array.isArray(
      data.requested_formats
    )
  ) {
    const audio =
      data.requested_formats.find(
        format =>
          format.acodec &&
          format.acodec !==
            'none' &&
          format.url
      );

    streamUrl =
      audio?.url;
  }

  if (!streamUrl) {
    throw new Error(
      'yt-dlp found the item but did not return a playable audio stream.'
    );
  }

  return {
    streamUrl,
    codec:
      data.acodec || null,
    abr:
      data.abr ||
      data.tbr ||
      null,
    format:
      data.ext ||
      data.audio_ext ||
      null
  };
}

import { spawn } from 'node:child_process';

const YTDLP = process.env.YTDLP_PATH || 'yt-dlp';

function runYtDlp(args, { jsonLines = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(YTDLP, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', d => stdout += d.toString());
    child.stderr.on('data', d => stderr += d.toString());

    child.once('error', err => {
      reject(new Error(`Could not start yt-dlp (${YTDLP}). ${err.message}`));
    });

    child.once('close', code => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `yt-dlp exited with code ${code}`));
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

function isUrl(input) {
  try {
    const url = new URL(input);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function spotifyKind(url) {
  try {
    const u = new URL(url);
    if (!/(^|\.)open\.spotify\.com$/i.test(u.hostname)) return null;
    const parts = u.pathname.split('/').filter(Boolean);
    const idx = parts.findIndex(p => ['track', 'playlist', 'album'].includes(p));
    if (idx === -1 || !parts[idx + 1]) return null;
    return { kind: parts[idx], id: parts[idx + 1] };
  } catch {
    return null;
  }
}

let spotifyTokenCache = { token: null, expiresAt: 0 };

async function spotifyToken() {
  const id = process.env.SPOTIFY_CLIENT_ID;
  const secret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!id || !secret) return null;

  if (spotifyTokenCache.token && Date.now() < spotifyTokenCache.expiresAt - 30_000) {
    return spotifyTokenCache.token;
  }

  const auth = Buffer.from(`${id}:${secret}`).toString('base64');
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });

  if (!res.ok) throw new Error(`Spotify token request failed (${res.status})`);
  const body = await res.json();
  spotifyTokenCache = {
    token: body.access_token,
    expiresAt: Date.now() + body.expires_in * 1000
  };
  return body.access_token;
}

async function spotifyApi(pathname) {
  const token = await spotifyToken();
  if (!token) return null;
  const res = await fetch(`https://api.spotify.com/v1${pathname}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) throw new Error(`Spotify API failed (${res.status})`);
  return res.json();
}

async function spotifyOembed(url) {
  const res = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`);
  if (!res.ok) throw new Error(`Spotify metadata lookup failed (${res.status})`);
  return res.json();
}

async function resolveSpotify(url, requestedBy) {
  const info = spotifyKind(url);
  if (!info) return null;

  const token = await spotifyToken();

  // No API credentials required for a single track: use public oEmbed metadata.
  if (!token && info.kind === 'track') {
    const o = await spotifyOembed(url);
    const title = String(o.title || '').trim();
    if (!title) throw new Error('Could not read Spotify track metadata.');
    return resolveInput(title, requestedBy);
  }

  if (!token) {
    throw new Error(
      'Spotify playlist/album expansion needs SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in .env. ' +
      'Single Spotify tracks work without them.'
    );
  }

  let searches = [];

  if (info.kind === 'track') {
    const t = await spotifyApi(`/tracks/${info.id}`);
    searches = [`${t.name} ${t.artists?.map(a => a.name).join(' ') || ''}`.trim()];
  } else if (info.kind === 'album') {
    let next = `/albums/${info.id}/tracks?limit=50`;
    while (next) {
      const page = next.startsWith('http')
        ? await (async () => {
            const res = await fetch(next, { headers: { Authorization: `Bearer ${token}` } });
            if (!res.ok) throw new Error(`Spotify API failed (${res.status})`);
            return res.json();
          })()
        : await spotifyApi(next);
      searches.push(...page.items.map(t => `${t.name} ${t.artists?.map(a => a.name).join(' ') || ''}`.trim()));
      next = page.next;
    }
  } else if (info.kind === 'playlist') {
    let next = `/playlists/${info.id}/tracks?limit=100`;
    while (next) {
      const page = next.startsWith('http')
        ? await (async () => {
            const res = await fetch(next, { headers: { Authorization: `Bearer ${token}` } });
            if (!res.ok) throw new Error(`Spotify API failed (${res.status})`);
            return res.json();
          })()
        : await spotifyApi(next);

      searches.push(...page.items
        .map(x => x.track)
        .filter(Boolean)
        .map(t => `${t.name} ${t.artists?.map(a => a.name).join(' ') || ''}`.trim()));
      next = page.next;
    }
  }

  const tracks = [];
  for (const search of searches) {
    const found = await resolveInput(search, requestedBy, { bypassSpotify: true, single: true });
    if (found[0]) tracks.push(found[0]);
  }
  return tracks;
}

function normalizeEntry(x, requestedBy) {
  const webpageUrl = x.webpage_url || x.original_url || x.url;
  const title = x.title || x.fulltitle || 'Unknown title';
  const duration = Number.isFinite(x.duration) ? x.duration : null;
  const thumb =
    x.thumbnail ||
    (Array.isArray(x.thumbnails) && x.thumbnails.length
      ? x.thumbnails[x.thumbnails.length - 1]?.url
      : null);

  return {
    id: x.id || null,
    title,
    url: webpageUrl,
    duration,
    thumbnail: thumb || null,
    uploader: x.artist || x.uploader || x.channel || null,
    source: x.extractor_key || x.extractor || 'Web',
    requestedBy
  };
}

/**
 * Resolve text, a video URL, playlist URL, generic embed URL, or Spotify link.
 * yt-dlp intentionally acts as the broad catch-all. Text becomes ytsearch1:<query>.
 */
export async function resolveInput(input, requestedBy, opts = {}) {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('Nothing to play.');

  if (!opts.bypassSpotify && isUrl(trimmed) && spotifyKind(trimmed)) {
    return await resolveSpotify(trimmed, requestedBy);
  }

  const target = isUrl(trimmed) ? trimmed : `ytsearch1:${trimmed}`;

  // --flat-playlist is NOT used here: we want complete metadata and stable webpage URLs.
  // --ignore-errors lets valid entries in a playlist survive a broken/unavailable item.
  const rows = await runYtDlp([
    '--dump-single-json',
    '--ignore-errors',
    '--no-warnings',
    '--no-call-home',
    target
  ]);

  const data = JSON.parse(rows);

  let entries;
  if (Array.isArray(data.entries)) {
    entries = data.entries.filter(Boolean);
  } else {
    entries = [data];
  }

  if (opts.single) entries = entries.slice(0, 1);

  const tracks = entries.map(x => normalizeEntry(x, requestedBy)).filter(t => t.url);
  if (!tracks.length) throw new Error('No playable media was found for that input.');
  return tracks;
}

/**
 * Returns a fresh direct audio URL. Never store these long-term; many expire.
 */
export async function getFreshAudio(track) {
  const stdout = await runYtDlp([
    '--dump-single-json',
    '--no-playlist',
    '--no-warnings',
    '--no-call-home',
    '-f',
    'bestaudio/best',
    track.url
  ]);

  const data = JSON.parse(stdout);
  let streamUrl = data.url;

  // Some extractors expose requested_formats instead of a top-level direct URL.
  if (!streamUrl && Array.isArray(data.requested_formats)) {
    const audio = data.requested_formats.find(f => f.acodec && f.acodec !== 'none' && f.url);
    streamUrl = audio?.url;
  }

  if (!streamUrl) throw new Error('yt-dlp found the item but did not return a playable audio stream.');

  return {
    streamUrl,
    codec: data.acodec || null,
    abr: data.abr || data.tbr || null,
    format: data.ext || data.audio_ext || null
  };
}

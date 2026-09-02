# EASY REPLIT SETUP (NO GITHUB)

This build includes `.replit` and `replit.nix`.

Replit should provide Node.js 22 and `yt-dlp` from the Nix environment automatically.

1. Open https://replit.com/import
2. Choose ZIP.
3. Upload this project ZIP.
4. Add the required secrets in Replit.
5. Open Shell and run:
   `npm install`
6. Then run:
   `npm run setup`
7. Click Run to test.
8. Publish as a Reserved VM to keep the Discord bot online continuously.

The bot now searches the last 50 messages in the configured music channel for its existing
`🎵 Peak Music` panel if local state disappears after a deployment, preventing duplicate
panel messages during normal redeploys.

---

# Peak Music Bot

A private Discord music bot built around one persistent `#music` control panel.

## What this first build does

- `/play <song name or link>`
- Automatically joins the voice channel of the person who requested the music
- One persistent music panel instead of posting a new "now playing" message every song
- Panel buttons:
  - Add Song
  - Pause / Resume
  - Skip
  - Stop
  - Queue
  - Shuffle
  - Loop
  - Volume down/up
  - Leave
- Shows:
  - title
  - thumbnail
  - uploader/artist when available
  - progress
  - duration
  - source
  - approximate source bitrate/codec when yt-dlp reports it
  - requester
  - queue length
  - next song
- Entire playlists are expanded when the source is supported by yt-dlp
- Text searches use YouTube search
- Very broad URL support through yt-dlp's extractors + generic/embed extractor
- Spotify:
  - single track links work from public metadata, then match to a playable search result
  - playlist/album expansion works when optional Spotify API client credentials are supplied
- Leaves an empty VC after the configured idle timeout

## Important architecture note

The actual Discord voice process must run as a persistent Node process.

Cloudflare Workers are useful for normal HTTP/interactions/status pieces, but they are not being put in the live audio path in this build. Discord voice requires a persistent Gateway/voice connection plus real-time audio processing/FFmpeg.

## Requirements

- Node.js 22.12+ (Node 22 recommended)
- yt-dlp installed and available as `yt-dlp`
- Internet access
- A Discord application/bot
- Windows, Linux, or macOS

FFmpeg is included through the `ffmpeg-static` npm package.

## Discord Developer Dashboard setup

1. Go to Discord Developer Portal.
2. Create a new application, e.g. `Peak Music`.
3. Open **Bot**.
4. Create/reset the bot token and copy it.
5. You do NOT need Message Content Intent for this build.
6. Under OAuth2 / URL Generator (or the current Installation page), install the bot to your server with:
   - `bot`
   - `applications.commands`
7. Bot permissions:
   - View Channels
   - Send Messages
   - Embed Links
   - Read Message History
   - Connect
   - Speak

Do not give the bot Administrator unless you specifically want to.

## Find IDs

Enable Discord Developer Mode, then copy:

- Application/Client ID -> `DISCORD_CLIENT_ID`
- Server ID -> `DISCORD_GUILD_ID`
- `#music` channel ID -> `MUSIC_CHANNEL_ID`

## Install

Copy `.env.example` to `.env` and fill it in.

Windows PowerShell:

```powershell
Copy-Item .env.example .env
npm install
```

Install yt-dlp if needed:

```powershell
winget install yt-dlp.yt-dlp
```

Verify:

```powershell
yt-dlp --version
node --version
```

## Register the commands

```powershell
npm run register
```

Guild commands normally appear quickly because they are registered directly to your server.

## Start it

```powershell
npm start
```

The bot creates one persistent panel in the configured `#music` channel and remembers that message ID in `data/state.json`.

## Spotify playlist + album support

Single Spotify track links do not require Spotify API credentials.

For Spotify playlists and albums, create a Spotify developer app and put these in `.env`:

```env
SPOTIFY_CLIENT_ID=...
SPOTIFY_CLIENT_SECRET=...
```

The bot reads Spotify's track metadata, searches for playable versions, and queues them. It does not attempt to bypass Spotify DRM or stream protected Spotify audio directly.

## Broad-link behavior

For normal URLs, the bot gives the URL to yt-dlp. That means supported extractors, embedded players, generic extractor URLs, direct media pages, and supported playlists can work without us maintaining a giant hard-coded domain list.

This is intentionally "try the URL and report a clean error" rather than pretending every website is guaranteed forever. Sites change their players and anti-bot rules constantly.

## Current limitations / next pass

This is the first runnable architecture. Good next upgrades:

- queue pagination + remove/move buttons
- seek controls
- `/volume 0-200`
- per-user DJ permissions
- saved favorites/playlists
- history
- reconnect/recovery after process restart
- cached Spotify resolution
- Apple Music metadata resolver
- Deezer metadata resolver
- SoundCloud-specific search polish
- optional web dashboard/Cloudflare companion
- container/VPS deployment file
- per-guild configuration if the bot ever leaves Peak PvM

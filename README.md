# Peak Music Bot

A persistent-panel Discord music bot for Peak PvM. It runs as a Node.js process with
Discord Gateway/voice connections, yt-dlp, and FFmpeg.

## Features

- One polished MatchBox-style `💿 Now Playing` panel with progress, artwork, queue preview,
  requester, audio details, and every common playback control
- `/play`, `/playtop`, `/playskip`, `/queue`, `/pause`, `/resume`, `/skip`, `/back`,
  `/replay`, `/seek`, `/stop`, `/clear`, `/remove`, `/shuffle`, `/loop`, `/autoplay`,
  `/volume`, `/filter`, `/stay`, `/leave`, `/help`, and `/panel`
- Queue, back, pause/resume, skip, autoplay, loop, rewind, fast-forward, replay, stop,
  add-song, shuffle, 24/7, and volume buttons
- Clean, bass boost, nightcore, vaporwave, 8D, and karaoke audio modes
- Related-song autoplay and a 50-track playback history
- YouTube search and broad URL/playlist support through yt-dlp
- Spotify track metadata matching; optional Spotify playlist/album expansion
- Automatic voice-channel join, idle leave, and optional 24/7 stay mode
- Same-channel control protection so listeners elsewhere cannot hijack playback
- Dynamic Discord activity showing the current song and an easy `/help` quick start
- Existing-panel recovery after a restart, even when local state is gone

## Recommended host: Cloudflare Containers

This repository is ready for Cloudflare Containers. A normal Cloudflare Worker cannot
run Discord voice by itself; the Worker here starts and fronts one Linux container that
runs the actual bot.

Cloudflare Containers require the Workers Paid plan. This project uses one `basic`
instance because FFmpeg and yt-dlp need more headroom than the smallest `lite` instance.
The container is intentionally kept alive when HTTP traffic is idle because Discord
Gateway and voice traffic do not pass through the Worker's health endpoint. A five-minute
Cloudflare health schedule also starts it again automatically after an interruption.

### 1. Discord values

You need these four private values:

- `DISCORD_TOKEN`: Discord Developer Portal → your application → Bot → Reset/Copy Token
- `DISCORD_CLIENT_ID`: Developer Portal → General Information → Application ID
- `DISCORD_GUILD_ID`: right-click your Discord server → Copy Server ID
- `MUSIC_CHANNEL_ID`: right-click the text channel for the panel → Copy Channel ID

Enable Developer Mode under Discord Settings → Advanced before copying server/channel IDs.
Never put the token in GitHub, `.env.example`, `wrangler.jsonc`, or a screenshot.

### 2. Connect the GitHub repository

1. In Cloudflare, open **Workers & Pages** and connect this GitHub repository through
   Workers Builds.
2. Use `npx wrangler deploy` as the deploy command. The Dockerfile is built automatically.
3. The first deployment creates the Worker and container application.

### 3. Add Cloudflare secrets

In the deployed Worker, open **Settings → Variables and Secrets** and add these as
encrypted secrets:

```text
DISCORD_TOKEN
DISCORD_CLIENT_ID
DISCORD_GUILD_ID
MUSIC_CHANNEL_ID
```

Optional Spotify album/playlist expansion uses two more encrypted secrets:

```text
SPOTIFY_CLIENT_ID
SPOTIFY_CLIENT_SECRET
```

After saving secrets, redeploy if Cloudflare asks. Open the Worker URL once for an immediate
start, or wait up to five minutes for the automatic health schedule. `/health` returns JSON.
When `discordReady` becomes `true`, the bot is connected and the persistent panel should
appear in the chosen text channel. Slash commands are registered automatically at startup.

### 4. Discord permissions

Install the bot with the `bot` and `applications.commands` scopes and grant:

- View Channels
- Send Messages
- Embed Links
- Read Message History
- Connect
- Speak

Administrator and Message Content Intent are not required.

## Local setup

Requirements: Node.js 22.12+, yt-dlp, Internet access, and a Discord application.
FFmpeg is supplied locally by the `ffmpeg-static` npm package.

1. Copy `.env.example` to `.env` and fill in the four required Discord values.
2. Run `npm install`.
3. Run `npm run setup` once to register the Discord commands.
4. Run `npm start`.

Useful checks:

```text
npm run check
npm run cf:types
npm run cf:check
```

## Replit fallback

The original `.replit` and `replit.nix` files remain available. Import the repository,
add the same four secrets, run `npm install`, then `npm run setup`. A Reserved VM is
required for continuous operation.

## Secrets safety

`.gitignore` excludes `.env`, `.env.*`, `.dev.vars`, `.dev.vars.*`, local state, logs,
and Wrangler's local directory. Only blank examples may be committed.

## Notes

- `data/state.json` is intentionally local and ignored. On a fresh container, the bot
  searches recent messages and reuses its existing panel.
- Container disk is ephemeral; the Discord panel is the source of continuity.
- Source sites can change or block automated media access. yt-dlp should be kept current
  by rebuilding/redeploying the container.
- The bot streams playable public media; it does not bypass DRM.

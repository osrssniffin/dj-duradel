import { Container, getContainer } from '@cloudflare/containers';

interface BotEnv {
  MUSIC_BOT: DurableObjectNamespace<MusicBotContainer>;
  DISCORD_TOKEN?: string;
  DISCORD_CLIENT_ID?: string;
  DISCORD_GUILD_ID?: string;
  MUSIC_CHANNEL_ID?: string;
  SPOTIFY_CLIENT_ID?: string;
  SPOTIFY_CLIENT_SECRET?: string;
  DEFAULT_VOLUME: string;
  IDLE_LEAVE_MINUTES: string;
  YTDLP_PATH: string;
  FFMPEG_PATH: string;
  PORT: string;
}

const requiredSecrets = [
  'DISCORD_TOKEN',
  'DISCORD_CLIENT_ID',
  'DISCORD_GUILD_ID',
  'MUSIC_CHANNEL_ID'
] as const;

function missingSecrets(env: BotEnv): string[] {
  return requiredSecrets.filter(key => !env[key]);
}

async function fetchBot(request: Request, env: BotEnv): Promise<Response> {
  return getContainer(env.MUSIC_BOT, 'peak-music-bot').fetch(request);
}

export class MusicBotContainer extends Container<BotEnv> {
  defaultPort = 8080;
  sleepAfter = '10m';
  enableInternet = true;

  constructor(ctx: DurableObjectState<{}>, env: BotEnv) {
    super(ctx, env);
    this.envVars = {
      DISCORD_TOKEN: env.DISCORD_TOKEN ?? '',
      DISCORD_CLIENT_ID: env.DISCORD_CLIENT_ID ?? '',
      DISCORD_GUILD_ID: env.DISCORD_GUILD_ID ?? '',
      MUSIC_CHANNEL_ID: env.MUSIC_CHANNEL_ID ?? '',
      SPOTIFY_CLIENT_ID: env.SPOTIFY_CLIENT_ID ?? '',
      SPOTIFY_CLIENT_SECRET: env.SPOTIFY_CLIENT_SECRET ?? '',
      DEFAULT_VOLUME: env.DEFAULT_VOLUME,
      IDLE_LEAVE_MINUTES: env.IDLE_LEAVE_MINUTES,
      YTDLP_PATH: env.YTDLP_PATH,
      FFMPEG_PATH: env.FFMPEG_PATH,
      PORT: env.PORT
    };
  }

  override onStart(): void {
    console.log(JSON.stringify({ event: 'music_bot_container_started' }));
  }

  override onStop(params: { exitCode: number; reason: string }): void {
    console.log(JSON.stringify({ event: 'music_bot_container_stopped', ...params }));
  }

  override async onActivityExpired(): Promise<void> {
    // Discord's Gateway and voice traffic do not arrive through container.fetch().
    // Renew instead of stopping just because the public health endpoint is idle.
    this.renewActivityTimeout();
  }

  override onError(error: unknown): never {
    console.error(JSON.stringify({
      event: 'music_bot_container_error',
      error: error instanceof Error ? error.message : String(error)
    }));
    throw error;
  }
}

export default {
  async fetch(request: Request, env: BotEnv): Promise<Response> {
    const missing = missingSecrets(env);
    if (missing.length > 0) {
      return Response.json(
        {
          ok: false,
          error: 'The Discord secrets have not been configured in Cloudflare yet.',
          missing
        },
        { status: 503 }
      );
    }

    try {
      return await fetchBot(request, env);
    } catch (error) {
      console.error(JSON.stringify({
        event: 'music_bot_proxy_error',
        error: error instanceof Error ? error.message : String(error)
      }));
      return Response.json({ ok: false, error: 'Music bot container unavailable.' }, { status: 503 });
    }
  },

  scheduled(_controller: ScheduledController, env: BotEnv, ctx: ExecutionContext): void {
    if (missingSecrets(env).length > 0) return;

    ctx.waitUntil((async () => {
      try {
        const response = await fetchBot(new Request('https://container.internal/health'), env);
        if (!response.ok) {
          console.warn(JSON.stringify({ event: 'music_bot_health_check', status: response.status }));
        }
      } catch (error) {
        console.error(JSON.stringify({
          event: 'music_bot_scheduled_restart_failed',
          error: error instanceof Error ? error.message : String(error)
        }));
      }
    })());
  }
} satisfies ExportedHandler<BotEnv>;

import { spawn } from 'node:child_process';
import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel
} from '@discordjs/voice';
import ffmpegPath from 'ffmpeg-static';
import { getFreshAudio } from './sourceResolver.js';

const FFMPEG = process.env.FFMPEG_PATH || ffmpegPath;

export class MusicSession {
  constructor(guild, onChange) {
    this.guild = guild;
    this.onChange = onChange;

    this.connection = null;
    this.player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause }
    });

    this.queue = [];
    this.current = null;
    this.volume = Math.max(0, Math.min(2, Number(process.env.DEFAULT_VOLUME || 0.7)));
    this.loop = false;
    this.shuffle = false;
    this.paused = false;
    this.startedAt = null;
    this.pauseStartedAt = null;
    this.pausedMs = 0;
    this.ffmpeg = null;
    this.streamInfo = null;
    this.idleTimer = null;

    this.player.on(AudioPlayerStatus.Idle, async () => {
      if (!this.current) return;
      await this.advance();
    });

    this.player.on('error', async error => {
      console.error('[player error]', error);
      await this.advance();
    });
  }

  getElapsedSeconds() {
    if (!this.current || !this.startedAt) return 0;
    const end = this.paused && this.pauseStartedAt ? this.pauseStartedAt : Date.now();
    return Math.max(0, (end - this.startedAt - this.pausedMs) / 1000);
  }

  async connect(voiceChannel) {
    if (this.connection?.joinConfig?.channelId === voiceChannel.id) return;

    this.connection?.destroy();
    this.connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: true
    });

    await entersState(this.connection, VoiceConnectionStatus.Ready, 20_000);
    this.connection.subscribe(this.player);
  }

  async enqueue(tracks) {
    this.queue.push(...tracks);
    if (!this.current) await this.advance();
    else await this.changed();
  }

  async advance() {
    this.killFfmpeg();

    if (this.loop && this.current) {
      this.queue.unshift(this.current);
    }

    this.current = this.shuffle && this.queue.length > 1
      ? this.queue.splice(Math.floor(Math.random() * this.queue.length), 1)[0]
      : this.queue.shift() || null;

    this.paused = false;
    this.startedAt = null;
    this.pauseStartedAt = null;
    this.pausedMs = 0;
    this.streamInfo = null;

    if (!this.current) {
      this.player.stop(true);
      await this.changed();
      return;
    }

    try {
      const fresh = await getFreshAudio(this.current);
      this.streamInfo = fresh;

      const ffmpeg = spawn(FFMPEG, [
        '-hide_banner',
        '-loglevel', 'error',
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '5',
        '-i', fresh.streamUrl,
        '-vn',
        '-ac', '2',
        '-ar', '48000',
        '-c:a', 'libopus',
        '-b:a', '128k',
        '-f', 'ogg',
        'pipe:1'
      ], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      this.ffmpeg = ffmpeg;
      ffmpeg.stderr.on('data', d => console.error('[ffmpeg]', d.toString().trim()));
      ffmpeg.once('error', err => console.error('[ffmpeg spawn]', err));

      const resource = createAudioResource(ffmpeg.stdout, {
        inlineVolume: true
      });
      resource.volume.setVolume(this.volume);

      this.player.play(resource);
      this.startedAt = Date.now();
      await this.changed();
    } catch (error) {
      console.error(`[track failed] ${this.current?.title}`, error);
      this.current = null;
      await this.advance();
    }
  }

  async togglePause() {
    if (!this.current) return;
    if (this.paused) {
      this.player.unpause();
      if (this.pauseStartedAt) this.pausedMs += Date.now() - this.pauseStartedAt;
      this.pauseStartedAt = null;
      this.paused = false;
    } else {
      this.player.pause(true);
      this.pauseStartedAt = Date.now();
      this.paused = true;
    }
    await this.changed();
  }

  async skip() {
    if (!this.current) return;
    // Temporarily prevent loop from re-adding a manually skipped track.
    const wasLoop = this.loop;
    this.loop = false;
    this.player.stop(true);
    this.loop = wasLoop;
  }

  async stop() {
    this.queue = [];
    this.current = null;
    this.streamInfo = null;
    this.killFfmpeg();
    this.player.stop(true);
    await this.changed();
  }

  async leave() {
    await this.stop();
    this.connection?.destroy();
    this.connection = null;
    await this.changed();
  }

  async toggleShuffle() {
    this.shuffle = !this.shuffle;
    await this.changed();
  }

  async toggleLoop() {
    this.loop = !this.loop;
    await this.changed();
  }

  async adjustVolume(delta) {
    this.volume = Math.max(0, Math.min(2, this.volume + delta));
    const r = this.player.state.resource;
    r?.volume?.setVolume(this.volume);
    await this.changed();
  }

  scheduleIdleLeave() {
    clearTimeout(this.idleTimer);
    const mins = Math.max(1, Number(process.env.IDLE_LEAVE_MINUTES || 5));
    this.idleTimer = setTimeout(() => this.leave().catch(console.error), mins * 60_000);
  }

  cancelIdleLeave() {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  killFfmpeg() {
    if (this.ffmpeg && !this.ffmpeg.killed) {
      try { this.ffmpeg.kill('SIGKILL'); } catch {}
    }
    this.ffmpeg = null;
  }

  async changed() {
    try {
      await this.onChange?.();
    } catch (err) {
      console.error('[panel update]', err);
    }
  }
}

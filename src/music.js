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
import { getFreshAudio, resolveRecommended } from './sourceResolver.js';

const FFMPEG = process.env.FFMPEG_PATH || ffmpegPath;

export const AUDIO_FILTERS = {
  off: { label: 'Clean', ffmpeg: null },
  bassboost: { label: 'Bass Boost', ffmpeg: 'bass=g=8:f=110:w=0.6' },
  nightcore: { label: 'Nightcore', ffmpeg: 'asetrate=48000*1.18,aresample=48000,atempo=1.06' },
  vaporwave: { label: 'Vaporwave', ffmpeg: 'asetrate=48000*0.82,aresample=48000,atempo=0.96' },
  eightd: { label: '8D', ffmpeg: 'apulsator=hz=0.09' },
  karaoke: { label: 'Karaoke', ffmpeg: 'pan=stereo|c0=c0-c1|c1=c1-c0' }
};

export class MusicSession {
  constructor(guild, onChange) {
    this.guild = guild;
    this.onChange = onChange;
    this.connection = null;
    this.player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause }
    });
    this.queue = [];
    this.history = [];
    this.current = null;
    this.volume = Math.max(0, Math.min(2, Number(process.env.DEFAULT_VOLUME || 0.7)));
    this.loop = false;
    this.shuffle = false;
    this.autoplay = false;
    this.stay247 = false;
    this.filter = 'off';
    this.paused = false;
    this.startedAt = null;
    this.pauseStartedAt = null;
    this.pausedMs = 0;
    this.ffmpeg = null;
    this.streamInfo = null;
    this.idleTimer = null;
    this.ignoreNextIdle = false;
    this.skipLoopOnce = false;

    this.player.on(AudioPlayerStatus.Idle, async () => {
      if (this.ignoreNextIdle) {
        this.ignoreNextIdle = false;
        return;
      }
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
    if (this.connection?.joinConfig?.channelId === voiceChannel.id) {
      try {
        await entersState(this.connection, VoiceConnectionStatus.Ready, 45_000);
        return;
      } catch {
        this.connection.destroy();
        this.connection = null;
      }
    }

    this.connection?.destroy();
    this.connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: true
    });

    try {
      await entersState(this.connection, VoiceConnectionStatus.Ready, 45_000);
      this.connection.subscribe(this.player);
    } catch (error) {
      this.connection.destroy();
      this.connection = null;
      if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
        throw new Error('Voice connection timed out. Check Connect and Speak permissions, then try once more.');
      }
      throw error;
    }
  }

  async enqueue(tracks, { top = false, playNow = false } = {}) {
    let interrupted = null;
    if (playNow && this.current) {
      interrupted = this.current;
      this.current = null;
      this.stopPlaybackOnly();
    }
    if (playNow) this.queue.unshift(...tracks, ...(interrupted ? [interrupted] : []));
    else if (top) this.queue.unshift(...tracks);
    else this.queue.push(...tracks);
    if (!this.current) await this.advance();
    else await this.changed();
  }

  async advance() {
    this.killFfmpeg();
    const finished = this.current;
    if (finished) {
      if (this.loop && !this.skipLoopOnce) this.queue.unshift(finished);
      else {
        this.history.push(finished);
        this.history = this.history.slice(-50);
      }
    }
    this.skipLoopOnce = false;

    if (!this.queue.length && this.autoplay && finished) {
      try {
        const excluded = new Set(this.history.flatMap(t => [t.id, t.url]).filter(Boolean));
        const related = await resolveRecommended(finished, finished.requestedBy, excluded);
        if (related) this.queue.push({ ...related, autoplay: true });
      } catch (error) {
        console.error('[autoplay]', error);
      }
    }

    this.current = this.shuffle && this.queue.length > 1
      ? this.queue.splice(Math.floor(Math.random() * this.queue.length), 1)[0]
      : this.queue.shift() || null;
    this.resetTiming();

    if (!this.current) {
      this.player.stop(true);
      await this.changed();
      return;
    }
    await this.startCurrent(0);
  }

  async startCurrent(seekSeconds = 0) {
    if (!this.current) return;
    try {
      const fresh = await getFreshAudio(this.current);
      this.streamInfo = fresh;
      const args = [
        '-hide_banner', '-loglevel', 'error',
        '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5'
      ];
      if (seekSeconds > 0) args.push('-ss', String(Math.floor(seekSeconds)));
      args.push('-i', fresh.streamUrl, '-vn');
      const selectedFilter = AUDIO_FILTERS[this.filter] || AUDIO_FILTERS.off;
      if (selectedFilter.ffmpeg) args.push('-af', selectedFilter.ffmpeg);
      args.push('-ac', '2', '-ar', '48000', '-c:a', 'libopus', '-b:a', '128k', '-f', 'ogg', 'pipe:1');

      const ffmpeg = spawn(FFMPEG, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      this.ffmpeg = ffmpeg;
      ffmpeg.stderr.on('data', d => console.error('[ffmpeg]', d.toString().trim()));
      ffmpeg.once('error', err => console.error('[ffmpeg spawn]', err));

      const resource = createAudioResource(ffmpeg.stdout, { inlineVolume: true });
      resource.volume.setVolume(this.volume);
      this.player.play(resource);
      this.startedAt = Date.now() - seekSeconds * 1000;
      this.pauseStartedAt = null;
      this.pausedMs = 0;
      this.paused = false;
      await this.changed();
    } catch (error) {
      console.error(`[track failed] ${this.current?.title}`, error);
      this.current = null;
      await this.advance();
    }
  }

  async restartCurrent(seekSeconds = 0) {
    if (!this.current) return false;
    if (this.player.state.status !== AudioPlayerStatus.Idle) this.ignoreNextIdle = true;
    this.killFfmpeg();
    this.player.stop(true);
    this.resetTiming();
    await this.startCurrent(seekSeconds);
    return true;
  }

  async togglePause() {
    if (!this.current) return false;
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
    return true;
  }

  async skip() {
    if (!this.current) return false;
    this.skipLoopOnce = true;
    this.player.stop(true);
    return true;
  }

  async back() {
    const previous = this.history.pop();
    if (!previous) return false;
    if (this.current) this.queue.unshift(this.current);
    this.current = previous;
    await this.restartCurrent(0);
    return true;
  }

  async replay() { return this.restartCurrent(0); }

  async seek(deltaSeconds) {
    if (!this.current) return false;
    const max = Number.isFinite(this.current.duration) ? Math.max(0, this.current.duration - 1) : Infinity;
    const target = Math.max(0, Math.min(max, this.getElapsedSeconds() + deltaSeconds));
    return this.restartCurrent(target);
  }

  async seekTo(seconds) {
    if (!this.current) return false;
    const max = Number.isFinite(this.current.duration) ? Math.max(0, this.current.duration - 1) : Infinity;
    const target = Math.max(0, Math.min(max, Number(seconds)));
    return this.restartCurrent(target);
  }

  async stop() {
    this.queue = [];
    this.current = null;
    this.killFfmpeg();
    this.player.stop(true);
    this.resetTiming();
    await this.changed();
  }

  async clearQueue() {
    this.queue = [];
    await this.changed();
  }

  async removeAt(position) {
    const index = Number(position) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= this.queue.length) return null;
    const [removed] = this.queue.splice(index, 1);
    await this.changed();
    return removed;
  }

  async leave() {
    await this.stop();
    this.connection?.destroy();
    this.connection = null;
    await this.changed();
  }

  async toggleShuffle() {
    this.shuffle = !this.shuffle;
    if (this.shuffle) this.queue.sort(() => Math.random() - 0.5);
    await this.changed();
  }

  async toggleLoop() { this.loop = !this.loop; await this.changed(); }
  async toggleAutoplay() { this.autoplay = !this.autoplay; await this.changed(); }

  async toggle247() {
    this.stay247 = !this.stay247;
    if (this.stay247) this.cancelIdleLeave();
    await this.changed();
  }

  async setFilter(name) {
    if (!AUDIO_FILTERS[name]) throw new Error('Unknown audio filter.');
    this.filter = name;
    if (this.current) await this.restartCurrent(this.getElapsedSeconds());
    else await this.changed();
  }

  async adjustVolume(delta) { return this.setVolume(this.volume + delta); }

  async setVolume(value) {
    this.volume = Math.max(0, Math.min(2, Number(value)));
    this.player.state.resource?.volume?.setVolume(this.volume);
    await this.changed();
    return this.volume;
  }

  scheduleIdleLeave() {
    if (this.stay247) return;
    clearTimeout(this.idleTimer);
    const mins = Math.max(1, Number(process.env.IDLE_LEAVE_MINUTES || 5));
    this.idleTimer = setTimeout(() => this.leave().catch(console.error), mins * 60_000);
  }

  cancelIdleLeave() { clearTimeout(this.idleTimer); this.idleTimer = null; }

  resetTiming() {
    this.paused = false;
    this.startedAt = null;
    this.pauseStartedAt = null;
    this.pausedMs = 0;
    this.streamInfo = null;
  }

  stopPlaybackOnly() {
    this.killFfmpeg();
    this.player.stop(true);
    this.resetTiming();
  }

  killFfmpeg() {
    if (this.ffmpeg && !this.ffmpeg.killed) {
      try { this.ffmpeg.kill('SIGKILL'); } catch {}
    }
    this.ffmpeg = null;
  }

  async changed() {
    try { await this.onChange?.(); }
    catch (error) { console.error('[panel update]', error); }
  }
}

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder
} from 'discord.js';
import { AUDIO_FILTERS } from './music.js';

function fmt(seconds) {
  if (!Number.isFinite(seconds)) return 'LIVE';
  const value = Math.max(0, Math.floor(seconds));
  const h = Math.floor(value / 3600);
  const m = Math.floor((value % 3600) / 60);
  const s = value % 60;
  return h
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

function progressBar(elapsed, duration) {
  const slots = 15;
  if (!Number.isFinite(duration) || duration <= 0) return '🔘' + '▬'.repeat(slots - 1);
  const ratio = Math.max(0, Math.min(1, elapsed / duration));
  const position = Math.min(slots - 1, Math.floor(ratio * slots));
  return Array.from({ length: slots }, (_, index) => index === position ? '🔘' : '▬').join('');
}

function short(text, max = 70) {
  const value = String(text || 'Unknown track');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function queuePreview(session) {
  if (!session.queue.length) return session.autoplay
    ? '✨ Autoplay will choose a related song.'
    : 'Nothing queued — press **ADD SONG**.';
  const rows = session.queue.slice(0, 3).map((track, index) =>
    `**${index + 1}.** [${short(track.title, 54)}](${track.url}) • ${fmt(track.duration)}`
  );
  if (session.queue.length > 3) rows.push(`*+${session.queue.length - 3} more*`);
  return rows.join('\n');
}

function activeModes(session) {
  return [
    session.loop ? '🔁 Loop' : null,
    session.shuffle ? '🔀 Shuffle' : null,
    session.autoplay ? '✨ Autoplay' : null,
    session.stay247 ? '♾️ 24/7' : null
  ].filter(Boolean).join(' • ') || 'Normal';
}

export function buildPanel(session) {
  const track = session.current;
  const elapsed = session.getElapsedSeconds();
  const filter = AUDIO_FILTERS[session.filter] || AUDIO_FILTERS.off;

  const embed = new EmbedBuilder()
    .setColor(track ? 0x57f287 : 0x2b2d31)
    .setTitle(track ? '💿 Now Playing' : '🎧 DJ DURADEL')
    .setDescription(track
      ? `### [${short(track.title, 100)}](${track.url})\n${track.uploader ? `by **${short(track.uploader, 80)}**\n` : ''}\n${progressBar(elapsed, track.duration)}\n\`${fmt(elapsed)} / ${fmt(track.duration)}\`${session.paused ? '  •  ⏸️ **Paused**' : ''}`
      : '### Ready when you are\n**1.** Join a voice channel\n**2.** Press **ADD SONG**\n**3.** Paste a song name or link'
    )
    .setFooter({ text: 'DJ Duradel • simple controls, serious sound' })
    .setTimestamp();

  if (track?.thumbnail) embed.setThumbnail(track.thumbnail);

  if (track) {
    embed.addFields(
      {
        name: '👤 Requested by',
        value: track.autoplay ? '✨ Autoplay' : track.requestedBy ? `<@${track.requestedBy}>` : '—',
        inline: true
      },
      {
        name: '🔊 Sound',
        value: `${Math.round(session.volume * 100)}% • ${filter.label}`,
        inline: true
      },
      {
        name: '⚙️ Modes',
        value: activeModes(session),
        inline: true
      },
      {
        name: `📜 Up Next • ${session.queue.length}`,
        value: queuePreview(session),
        inline: false
      }
    );
  }

  const playback = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('music_queue').setLabel('QUEUE').setEmoji('📜').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('music_back').setLabel('BACK').setEmoji('⏮️').setStyle(ButtonStyle.Success).setDisabled(!session.history.length),
    new ButtonBuilder().setCustomId('music_pause').setLabel('PAUSE / RESUME').setEmoji(session.paused ? '▶️' : '⏸️').setStyle(ButtonStyle.Secondary).setDisabled(!track),
    new ButtonBuilder().setCustomId('music_skip').setLabel('SKIP').setEmoji('⏭️').setStyle(ButtonStyle.Success).setDisabled(!track),
    new ButtonBuilder().setCustomId('music_autoplay').setLabel('AUTOPLAY').setEmoji('✨').setStyle(session.autoplay ? ButtonStyle.Success : ButtonStyle.Secondary)
  );

  const timeline = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('music_loop').setLabel('LOOP').setEmoji('🔁').setStyle(session.loop ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('music_rewind').setLabel('REWIND').setEmoji('⏪').setStyle(ButtonStyle.Success).setDisabled(!track),
    new ButtonBuilder().setCustomId('music_stop').setLabel('STOP').setEmoji('⏹️').setStyle(ButtonStyle.Danger).setDisabled(!track),
    new ButtonBuilder().setCustomId('music_forward').setLabel('FORWARD').setEmoji('⏩').setStyle(ButtonStyle.Success).setDisabled(!track),
    new ButtonBuilder().setCustomId('music_replay').setLabel('REPLAY').setEmoji('🔄').setStyle(ButtonStyle.Success).setDisabled(!track)
  );

  const controls = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('music_add').setLabel('ADD SONG').setEmoji('➕').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('music_shuffle').setLabel('SHUFFLE').setEmoji('🔀').setStyle(session.shuffle ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('music_247').setLabel('24/7').setEmoji('♾️').setStyle(session.stay247 ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('music_vol_down').setLabel('-10%').setEmoji('🔉').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('music_vol_up').setLabel('+10%').setEmoji('🔊').setStyle(ButtonStyle.Secondary)
  );

  const filters = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('music_filter')
      .setPlaceholder(`Audio filter: ${filter.label}`)
      .addOptions(Object.entries(AUDIO_FILTERS).map(([value, item]) => ({
        label: item.label,
        value,
        description: value === 'off' ? 'Original clean sound' : `Apply the ${item.label} sound effect`,
        emoji: value === 'off' ? '🎧' : value === 'bassboost' ? '🔊' : value === 'eightd' ? '🌀' : '🎚️',
        default: value === session.filter
      })))
  );

  return { embeds: [embed], components: [playback, timeline, controls, filters] };
}

export function formatQueue(session) {
  const lines = [];
  if (session.current) lines.push(`### 🎶 Now\n[${short(session.current.title, 90)}](${session.current.url}) • ${fmt(session.current.duration)}`);
  if (session.queue.length) lines.push('\n### 📜 Up next');
  session.queue.slice(0, 20).forEach((track, index) => {
    lines.push(`${index + 1}. [${short(track.title, 75)}](${track.url}) • ${fmt(track.duration)}${track.requestedBy ? ` • <@${track.requestedBy}>` : ''}`);
  });
  if (session.queue.length > 20) lines.push(`…and ${session.queue.length - 20} more.`);
  if (session.queue.length) lines.push('\nUse `/remove position:` to remove one song or `/clear` to clear upcoming songs.');
  return lines.length ? lines.join('\n') : 'The queue is empty. Press **ADD SONG** to start it.';
}

export function formatHelp() {
  return [
    '### 🎧 DJ Duradel — Quick Start',
    '**1.** Join a voice channel',
    '**2.** Press **ADD SONG** on the player',
    '**3.** Enter a song, artist, or link',
    '',
    '**The buttons handle almost everything.** Use `/play` to queue quickly, `/queue` to see the full list, and `/remove` to remove a numbered song.',
    '',
    '✨ **Autoplay** keeps the music going  •  🎚️ **Filter** changes the sound  •  ♾️ **24/7** keeps the bot in voice',
    '',
    'Spotify tracks, YouTube searches, and most public media or playlist links are supported.'
  ].join('\n');
}

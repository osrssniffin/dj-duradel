import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder
} from 'discord.js';

function fmt(seconds) {
  if (!Number.isFinite(seconds)) return 'LIVE / unknown';
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`;
}

function progressBar(elapsed, duration) {
  if (!Number.isFinite(duration) || duration <= 0) return '▬▬▬▬▬▬▬▬▬▬';
  const slots = 12;
  const ratio = Math.max(0, Math.min(1, elapsed / duration));
  const pos = Math.min(slots - 1, Math.floor(ratio * slots));
  return Array.from({ length: slots }, (_, i) => i === pos ? '🔘' : '▬').join('');
}

export function buildPanel(session) {
  const t = session.current;
  const elapsed = session.getElapsedSeconds();

  const embed = new EmbedBuilder()
    .setTitle('🎵 Peak Music')
    .setDescription(
      t
        ? `**[${t.title}](${t.url})**${t.uploader ? `\n${t.uploader}` : ''}`
        : 'Nothing playing.\nUse **Add Song** below or `/play` while you are in a voice channel.'
    )
    .setFooter({ text: 'One panel • no music-channel spam' });

  if (t?.thumbnail) embed.setThumbnail(t.thumbnail);

  const queueCount = session.queue.length;
  const next = session.queue[0];

  embed.addFields(
    {
      name: 'Playback',
      value: t
        ? `${fmt(elapsed)}  ${progressBar(elapsed, t.duration)}  ${fmt(t.duration)}`
        : 'Stopped',
      inline: false
    },
    {
      name: 'Source',
      value: t
        ? `${t.source || 'Web'}${session.streamInfo?.abr ? ` • ~${Math.round(session.streamInfo.abr)} kbps` : ''}${session.streamInfo?.codec ? ` • ${session.streamInfo.codec}` : ''}`
        : '—',
      inline: true
    },
    {
      name: 'Queue',
      value: `${queueCount} track${queueCount === 1 ? '' : 's'}`,
      inline: true
    },
    {
      name: 'Mode',
      value: `${session.loop ? '🔁 Loop' : 'Loop off'} • ${session.shuffle ? '🔀 Shuffle' : 'Shuffle off'} • ${Math.round(session.volume * 100)}%`,
      inline: true
    }
  );

  if (t?.requestedBy) {
    embed.addFields({ name: 'Requested by', value: `<@${t.requestedBy}>`, inline: true });
  }
  if (next) {
    embed.addFields({ name: 'Up next', value: `[${next.title}](${next.url})`, inline: false });
  }

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('music_add').setLabel('Add Song').setEmoji('➕').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('music_pause').setLabel(t && session.paused ? 'Resume' : 'Pause').setEmoji(t && session.paused ? '▶️' : '⏸️').setStyle(ButtonStyle.Secondary).setDisabled(!t),
    new ButtonBuilder().setCustomId('music_skip').setLabel('Skip').setEmoji('⏭️').setStyle(ButtonStyle.Secondary).setDisabled(!t),
    new ButtonBuilder().setCustomId('music_stop').setLabel('Stop').setEmoji('⏹️').setStyle(ButtonStyle.Danger).setDisabled(!t),
    new ButtonBuilder().setCustomId('music_queue').setLabel('Queue').setEmoji('📜').setStyle(ButtonStyle.Secondary)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('music_shuffle').setLabel('Shuffle').setEmoji('🔀').setStyle(session.shuffle ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('music_loop').setLabel('Loop').setEmoji('🔁').setStyle(session.loop ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('music_vol_down').setLabel('-10%').setEmoji('🔉').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('music_vol_up').setLabel('+10%').setEmoji('🔊').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('music_leave').setLabel('Leave').setEmoji('👋').setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [embed], components: [row1, row2] };
}

export function formatQueue(session) {
  const lines = [];
  if (session.current) lines.push(`**Now:** ${session.current.title}`);
  session.queue.slice(0, 20).forEach((t, i) => {
    lines.push(`${i + 1}. ${t.title}${t.requestedBy ? ` — <@${t.requestedBy}>` : ''}`);
  });
  if (session.queue.length > 20) lines.push(`…and ${session.queue.length - 20} more.`);
  return lines.length ? lines.join('\n') : 'Queue is empty.';
}

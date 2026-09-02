import 'dotenv/config';
import {
  ActivityType,
  Client,
  GatewayIntentBits,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder
} from 'discord.js';

import { AUDIO_FILTERS, MusicSession } from './music.js';
import { startHealthServer } from './health.js';
import { buildPanel, formatHelp, formatQueue } from './panel.js';
import { resolveInput } from './sourceResolver.js';
import { loadState, saveState } from './store.js';

const required = ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_GUILD_ID', 'MUSIC_CHANNEL_ID'];
for (const key of required) {
  if (!process.env[key]) throw new Error(`Missing ${key} in .env`);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates
  ]
});

let state = await loadState();
let session;
let panelUpdateTimer = null;

const healthServer = startHealthServer(() => ({
  ok: client.isReady(),
  discordReady: client.isReady(),
  playing: Boolean(session?.current),
  paused: Boolean(session?.paused),
  queueLength: session?.queue?.length || 0,
  uptimeSeconds: Math.floor(process.uptime())
}));

async function musicChannel() {
  const ch = await client.channels.fetch(process.env.MUSIC_CHANNEL_ID);
  if (!ch?.isTextBased()) throw new Error('MUSIC_CHANNEL_ID is not a text channel.');
  return ch;
}

async function ensurePanel() {
  const channel = await musicChannel();
  let msg = null;

  // First try the locally remembered message ID.
  if (state.panelMessageId && state.panelChannelId === channel.id) {
    try { msg = await channel.messages.fetch(state.panelMessageId); } catch {}
  }

  // Replit deployments have non-persistent local files. If state.json vanished
  // after a redeploy, recover the existing panel instead of posting another one.
  if (!msg) {
    try {
      const recent = await channel.messages.fetch({ limit: 50 });
      const panelTitles = new Set(['🎵 Peak Music', '🎶 NOW PLAYING', '💿 Now Playing', '🎧 DJ DURADEL']);
      msg = recent.find(m =>
        m.author?.id === client.user?.id &&
        m.embeds?.some(e => panelTitles.has(e.title))
      ) || null;
    } catch {}
  }

  if (!msg) {
    msg = await channel.send(buildPanel(session));
  } else {
    await msg.edit(buildPanel(session));
  }

  state.panelMessageId = msg.id;
  state.panelChannelId = channel.id;
  await saveState(state);

  return msg;
}

async function updatePanel() {
  const channel = await musicChannel();
  if (!state.panelMessageId) return ensurePanel();

  try {
    const msg = await channel.messages.fetch(state.panelMessageId);
    await msg.edit(buildPanel(session));
  } catch {
    state.panelMessageId = null;
    await saveState(state);
    await ensurePanel();
  }
}

async function makeActivePanel(message) {
  const previousId = state.panelMessageId;
  const previousChannelId = state.panelChannelId;

  state.panelMessageId = message.id;
  state.panelChannelId = message.channelId;
  await saveState(state);

  if (previousId && previousId !== message.id) {
    try {
      const previousChannel = await client.channels.fetch(previousChannelId || process.env.MUSIC_CHANNEL_ID);
      if (previousChannel?.isTextBased()) {
        const previous = await previousChannel.messages.fetch(previousId);
        await previous.delete();
      }
    } catch {}
  }

  return message;
}

async function movePanelToBottom() {
  const channel = await musicChannel();
  const message = await channel.send(buildPanel(session));
  return makeActivePanel(message);
}

function startPanelTicker() {
  clearInterval(panelUpdateTimer);
  panelUpdateTimer = setInterval(() => {
    if (session?.current && !session.paused) updatePanel().catch(console.error);
  }, 15_000);
}

function voiceFor(interaction) {
  return interaction.member?.voice?.channel || null;
}

async function requireVoice(interaction) {
  const voice = voiceFor(interaction);
  if (!voice) {
    await interaction.reply({
      content: 'Join a voice channel first.',
      ephemeral: true
    });
    return null;
  }

  const activeChannelId = session?.connection?.joinConfig?.channelId;
  if (activeChannelId && activeChannelId !== voice.id) {
    await interaction.reply({
      content: `Join <#${activeChannelId}> to control this player.`,
      ephemeral: true
    });
    return null;
  }
  return voice;
}

function updateActivity() {
  if (!client.user) return;
  const title = session?.current?.title;
  client.user.setActivity(title ? title.slice(0, 120) : 'music • /play', {
    type: ActivityType.Listening
  });
}

async function addInput(interaction, input, options = {}) {
  const voice = await requireVoice(interaction);
  if (!voice) return;

  const inMusicChannel = interaction.channelId === process.env.MUSIC_CHANNEL_ID;
  await interaction.deferReply({ ephemeral: !inMusicChannel });

  try {
    await session.connect(voice);
    const tracks = await resolveInput(input, interaction.user.id);
    await session.enqueue(tracks, options);

    const label = tracks.length === 1 ? `**${tracks[0].title}**` : `**${tracks.length} tracks**`;
    const message = options.playNow
      ? `▶️ Playing ${label} now.`
      : options.top
        ? `⬆️ Added ${label} to the top of the queue.`
        : session.current === tracks[0]
          ? `▶️ Now playing ${label}.`
          : `✅ Queued ${label} • ${session.queue.length} upcoming.`;
    if (inMusicChannel) {
      const panelMessage = await interaction.editReply(buildPanel(session));
      await makeActivePanel(panelMessage);
    } else {
      const panelMessage = await movePanelToBottom();
      await interaction.editReply(`${message}\n[Open the player](${panelMessage.url})`);
    }
  } catch (err) {
    console.error(err);
    await interaction.editReply(`Couldn't queue that: ${err.message.slice(0, 1700)}`);
  }
}

client.once('clientReady', async () => {
  const guild = await client.guilds.fetch(process.env.DISCORD_GUILD_ID);
  session = new MusicSession(guild, async () => {
    updateActivity();
    await updatePanel();
  });

  updateActivity();
  await ensurePanel();
  startPanelTicker();

  console.log(`Logged in as ${client.user.tag}`);
  console.log(`Music panel: channel ${process.env.MUSIC_CHANNEL_ID}`);
});

client.on('voiceStateUpdate', async (oldState, newState) => {
  if (!session?.connection) return;
  const channelId = session.connection.joinConfig.channelId;
  const channel = oldState.guild.channels.cache.get(channelId) || newState.guild.channels.cache.get(channelId);
  if (!channel?.isVoiceBased()) return;

  const humans = channel.members.filter(m => !m.user.bot);
  if (humans.size === 0) session.scheduleIdleLeave();
  else session.cancelIdleLeave();
});

client.on('interactionCreate', async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'play') {
        await addInput(interaction, interaction.options.getString('input', true));
        return;
      }

      if (interaction.commandName === 'playtop') {
        await addInput(interaction, interaction.options.getString('input', true), { top: true });
        return;
      }

      if (interaction.commandName === 'playskip') {
        await addInput(interaction, interaction.options.getString('input', true), { playNow: true });
        return;
      }

      if (interaction.commandName === 'panel') {
        await ensurePanel();
        await interaction.reply({ content: 'Music panel refreshed.', ephemeral: true });
        return;
      }

      if (interaction.commandName === 'queue') {
        await interaction.reply({ content: formatQueue(session), ephemeral: true });
        return;
      }

      if (interaction.commandName === 'help') {
        await interaction.reply({ content: formatHelp(), ephemeral: true });
        return;
      }

      if (!await requireVoice(interaction)) return;

      if (interaction.commandName === 'pause' || interaction.commandName === 'resume') {
        const shouldPause = interaction.commandName === 'pause';
        if (!session.current) {
          await interaction.reply({ content: 'Nothing is playing.', ephemeral: true });
        } else if (session.paused === shouldPause) {
          await interaction.reply({ content: shouldPause ? 'Already paused.' : 'Already playing.', ephemeral: true });
        } else {
          await session.togglePause();
          await interaction.reply({ content: shouldPause ? 'Paused.' : 'Resumed.', ephemeral: true });
        }
        return;
      }

      if (interaction.commandName === 'skip') {
        const changed = await session.skip();
        await interaction.reply({ content: changed ? 'Skipped.' : 'Nothing is playing.', ephemeral: true });
        return;
      }

      if (interaction.commandName === 'back') {
        const changed = await session.back();
        await interaction.reply({ content: changed ? 'Playing the previous song.' : 'There is no previous song yet.', ephemeral: true });
        return;
      }

      if (interaction.commandName === 'replay') {
        const changed = await session.replay();
        await interaction.reply({ content: changed ? 'Restarted the song.' : 'Nothing is playing.', ephemeral: true });
        return;
      }

      if (interaction.commandName === 'seek') {
        await interaction.deferReply({ ephemeral: true });
        const seconds = interaction.options.getInteger('seconds', true);
        const changed = await session.seekTo(seconds);
        await interaction.editReply(changed
          ? `Jumped to ${seconds} seconds.`
          : 'Nothing is playing.');
        return;
      }

      if (interaction.commandName === 'stop') {
        await session.stop();
        await interaction.reply({ content: 'Stopped and cleared the queue.', ephemeral: true });
        return;
      }

      if (interaction.commandName === 'clear') {
        await session.clearQueue();
        await interaction.reply({ content: 'Cleared the upcoming queue.', ephemeral: true });
        return;
      }

      if (interaction.commandName === 'remove') {
        const removed = await session.removeAt(interaction.options.getInteger('position', true));
        await interaction.reply({
          content: removed ? `Removed **${removed.title}**.` : 'That queue position does not exist.',
          ephemeral: true
        });
        return;
      }

      if (interaction.commandName === 'shuffle') {
        await session.toggleShuffle();
        await interaction.reply({ content: `Shuffle ${session.shuffle ? 'on' : 'off'}.`, ephemeral: true });
        return;
      }

      if (interaction.commandName === 'loop') {
        await session.toggleLoop();
        await interaction.reply({ content: `Loop ${session.loop ? 'on' : 'off'}.`, ephemeral: true });
        return;
      }

      if (interaction.commandName === 'autoplay') {
        await session.toggleAutoplay();
        await interaction.reply({ content: `Autoplay ${session.autoplay ? 'on' : 'off'}.`, ephemeral: true });
        return;
      }

      if (interaction.commandName === 'volume') {
        await session.setVolume(interaction.options.getInteger('percent', true) / 100);
        await interaction.reply({ content: `Volume ${Math.round(session.volume * 100)}%.`, ephemeral: true });
        return;
      }

      if (interaction.commandName === 'filter') {
        await interaction.deferReply({ ephemeral: true });
        const mode = interaction.options.getString('mode', true);
        await session.setFilter(mode);
        await interaction.editReply(`Audio filter: **${AUDIO_FILTERS[mode].label}**.`);
        return;
      }

      if (interaction.commandName === 'stay') {
        await session.toggle247();
        await interaction.reply({ content: `24/7 mode ${session.stay247 ? 'on' : 'off'}.`, ephemeral: true });
        return;
      }

      if (interaction.commandName === 'leave') {
        await session.leave();
        await interaction.reply({ content: 'Disconnected.', ephemeral: true });
        return;
      }
    }

    if (interaction.isButton()) {
      const id = interaction.customId;

      if (id === 'music_queue') {
        await interaction.reply({ content: formatQueue(session), ephemeral: true });
        return;
      }

      if (id === 'music_add') {
        if (!await requireVoice(interaction)) return;

        const modal = new ModalBuilder()
          .setCustomId('music_add_modal')
          .setTitle('Add Music');

        const input = new TextInputBuilder()
          .setCustomId('music_input')
          .setLabel('Song, search, or media/playlist link')
          .setPlaceholder('Song name or https://...')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(1000);

        modal.addComponents(new ActionRowBuilder().addComponents(input));
        await interaction.showModal(modal);
        return;
      }

      if (!await requireVoice(interaction)) return;

      if (id === 'music_pause') {
        await session.togglePause();
        await interaction.reply({ content: session.paused ? 'Paused.' : 'Resumed.', ephemeral: true });
        return;
      }

      if (id === 'music_skip') {
        const changed = await session.skip();
        await interaction.reply({ content: changed ? 'Skipped.' : 'Nothing is playing.', ephemeral: true });
        return;
      }

      if (id === 'music_back') {
        await interaction.deferReply({ ephemeral: true });
        const changed = await session.back();
        await interaction.editReply(changed ? 'Playing the previous song.' : 'There is no previous song yet.');
        return;
      }

      if (id === 'music_replay') {
        await interaction.deferReply({ ephemeral: true });
        const changed = await session.replay();
        await interaction.editReply(changed ? 'Restarted the song.' : 'Nothing is playing.');
        return;
      }

      if (id === 'music_rewind' || id === 'music_forward') {
        await interaction.deferReply({ ephemeral: true });
        const seconds = id === 'music_rewind' ? -10 : 10;
        const changed = await session.seek(seconds);
        await interaction.editReply(changed
          ? `${seconds < 0 ? 'Rewound' : 'Moved forward'} 10 seconds.`
          : 'Nothing is playing.');
        return;
      }

      if (id === 'music_stop') {
        await session.stop();
        await interaction.reply({ content: 'Stopped and cleared.', ephemeral: true });
        return;
      }

      if (id === 'music_shuffle') {
        await session.toggleShuffle();
        await interaction.reply({ content: `Shuffle ${session.shuffle ? 'on' : 'off'}.`, ephemeral: true });
        return;
      }

      if (id === 'music_loop') {
        await session.toggleLoop();
        await interaction.reply({ content: `Loop ${session.loop ? 'on' : 'off'}.`, ephemeral: true });
        return;
      }

      if (id === 'music_autoplay') {
        await session.toggleAutoplay();
        await interaction.reply({ content: `Autoplay ${session.autoplay ? 'on' : 'off'}.`, ephemeral: true });
        return;
      }

      if (id === 'music_247') {
        await session.toggle247();
        await interaction.reply({ content: `24/7 mode ${session.stay247 ? 'on' : 'off'}.`, ephemeral: true });
        return;
      }

      if (id === 'music_vol_down') {
        await session.adjustVolume(-0.1);
        await interaction.reply({ content: `Volume ${Math.round(session.volume * 100)}%.`, ephemeral: true });
        return;
      }

      if (id === 'music_vol_up') {
        await session.adjustVolume(0.1);
        await interaction.reply({ content: `Volume ${Math.round(session.volume * 100)}%.`, ephemeral: true });
        return;
      }

      if (id === 'music_leave') {
        await session.leave();
        await interaction.reply({ content: 'Disconnected.', ephemeral: true });
        return;
      }
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'music_filter') {
      if (!await requireVoice(interaction)) return;
      await interaction.deferReply({ ephemeral: true });
      const mode = interaction.values[0];
      await session.setFilter(mode);
      await interaction.editReply(`Audio filter: **${AUDIO_FILTERS[mode].label}**.`);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId === 'music_add_modal') {
      const input = interaction.fields.getTextInputValue('music_input');
      await addInput(interaction, input);
    }
  } catch (err) {
    console.error('[interaction]', err);
    const msg = `Something went wrong: ${err.message?.slice(0, 1700) || 'unknown error'}`;

    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: msg, ephemeral: true }).catch(() => {});
    } else {
      await interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
    }
  }
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; shutting down.`);
  clearInterval(panelUpdateTimer);
  try { await session?.leave(); } catch {}
  client.destroy();
  healthServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

client.login(process.env.DISCORD_TOKEN);

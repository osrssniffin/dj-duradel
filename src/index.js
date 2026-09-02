import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder
} from 'discord.js';

import { MusicSession } from './music.js';
import { startHealthServer } from './health.js';
import { buildPanel, formatQueue } from './panel.js';
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
      msg = recent.find(m =>
        m.author?.id === client.user?.id &&
        m.embeds?.some(e => e.title === '🎵 Peak Music')
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
  return voice;
}

async function addInput(interaction, input) {
  const voice = await requireVoice(interaction);
  if (!voice) return;

  await interaction.deferReply({ ephemeral: true });

  try {
    await session.connect(voice);
    const tracks = await resolveInput(input, interaction.user.id);
    await session.enqueue(tracks);

    await interaction.editReply(
      tracks.length === 1
        ? `Queued **${tracks[0].title}**.`
        : `Queued **${tracks.length} tracks**.`
    );
  } catch (err) {
    console.error(err);
    await interaction.editReply(`Couldn't queue that: ${err.message.slice(0, 1700)}`);
  }
}

client.once('ready', async () => {
  const guild = await client.guilds.fetch(process.env.DISCORD_GUILD_ID);
  session = new MusicSession(guild, updatePanel);

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

      if (interaction.commandName === 'panel') {
        await ensurePanel();
        await interaction.reply({ content: 'Music panel refreshed.', ephemeral: true });
        return;
      }

      if (interaction.commandName === 'queue') {
        await interaction.reply({ content: formatQueue(session), ephemeral: true });
        return;
      }

      if (interaction.commandName === 'skip') {
        await session.skip();
        await interaction.reply({ content: 'Skipped.', ephemeral: true });
        return;
      }

      if (interaction.commandName === 'stop') {
        await session.stop();
        await interaction.reply({ content: 'Stopped and cleared the queue.', ephemeral: true });
        return;
      }
    }

    if (interaction.isButton()) {
      const id = interaction.customId;

      if (id === 'music_add') {
        const voice = voiceFor(interaction);
        if (!voice) {
          await interaction.reply({ content: 'Join a voice channel first.', ephemeral: true });
          return;
        }

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

      if (id === 'music_pause') {
        await session.togglePause();
        await interaction.reply({ content: session.paused ? 'Paused.' : 'Resumed.', ephemeral: true });
        return;
      }

      if (id === 'music_skip') {
        await session.skip();
        await interaction.reply({ content: 'Skipped.', ephemeral: true });
        return;
      }

      if (id === 'music_stop') {
        await session.stop();
        await interaction.reply({ content: 'Stopped and cleared.', ephemeral: true });
        return;
      }

      if (id === 'music_queue') {
        await interaction.reply({ content: formatQueue(session), ephemeral: true });
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

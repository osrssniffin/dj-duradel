import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder } from 'discord.js';

const required = ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_GUILD_ID'];
for (const key of required) {
  if (!process.env[key]) throw new Error(`Missing ${key} in .env`);
}

const inputOption = builder => builder.addStringOption(option =>
  option.setName('input')
    .setDescription('Song name or media/playlist URL')
    .setRequired(true)
);

const commands = [
  inputOption(new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play or add a song, link, playlist, or search')),
  inputOption(new SlashCommandBuilder()
    .setName('playtop')
    .setDescription('Put a song or playlist at the front of the queue')),
  inputOption(new SlashCommandBuilder()
    .setName('playskip')
    .setDescription('Play a song immediately, then return to the current queue')),
  new SlashCommandBuilder().setName('panel').setDescription('Create or refresh the permanent music panel'),
  new SlashCommandBuilder().setName('queue').setDescription('Show the current music queue'),
  new SlashCommandBuilder().setName('pause').setDescription('Pause the current song'),
  new SlashCommandBuilder().setName('resume').setDescription('Resume the current song'),
  new SlashCommandBuilder().setName('skip').setDescription('Skip the current song'),
  new SlashCommandBuilder().setName('back').setDescription('Go back to the previous song'),
  new SlashCommandBuilder().setName('replay').setDescription('Restart the current song'),
  new SlashCommandBuilder()
    .setName('seek')
    .setDescription('Move forward or backward in the current song')
    .addIntegerOption(option => option.setName('seconds')
      .setDescription('Positive moves forward; negative rewinds')
      .setMinValue(-3600).setMaxValue(3600).setRequired(true)),
  new SlashCommandBuilder().setName('stop').setDescription('Stop playback and clear the queue'),
  new SlashCommandBuilder().setName('clear').setDescription('Clear upcoming songs without stopping the current one'),
  new SlashCommandBuilder()
    .setName('remove')
    .setDescription('Remove a numbered song from the queue')
    .addIntegerOption(option => option.setName('position')
      .setDescription('Queue number shown by /queue').setMinValue(1).setRequired(true)),
  new SlashCommandBuilder().setName('shuffle').setDescription('Toggle queue shuffle'),
  new SlashCommandBuilder().setName('loop').setDescription('Toggle looping the current song'),
  new SlashCommandBuilder().setName('autoplay').setDescription('Toggle related-song autoplay when the queue ends'),
  new SlashCommandBuilder()
    .setName('volume')
    .setDescription('Set music volume')
    .addIntegerOption(option => option.setName('percent')
      .setDescription('0 to 200 percent').setMinValue(0).setMaxValue(200).setRequired(true)),
  new SlashCommandBuilder()
    .setName('filter')
    .setDescription('Apply an audio effect')
    .addStringOption(option => option.setName('mode')
      .setDescription('Audio effect').setRequired(true)
      .addChoices(
        { name: 'Clean / Off', value: 'off' },
        { name: 'Bass Boost', value: 'bassboost' },
        { name: 'Nightcore', value: 'nightcore' },
        { name: 'Vaporwave', value: 'vaporwave' },
        { name: '8D', value: 'eightd' },
        { name: 'Karaoke', value: 'karaoke' }
      )),
  new SlashCommandBuilder().setName('stay').setDescription('Toggle 24/7 voice-channel mode'),
  new SlashCommandBuilder().setName('leave').setDescription('Disconnect the bot from voice')
].map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

await rest.put(
  Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, process.env.DISCORD_GUILD_ID),
  { body: commands }
);

console.log(`Registered ${commands.length} guild commands.`);

import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder } from 'discord.js';

const required = ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_GUILD_ID'];
for (const key of required) {
  if (!process.env[key]) throw new Error(`Missing ${key} in .env`);
}

const commands = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play or queue a song, link, playlist, or search')
    .addStringOption(o =>
      o.setName('input')
        .setDescription('Song name or media/playlist URL')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('panel')
    .setDescription('Create or refresh the permanent music panel'),
  new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Show the current music queue'),
  new SlashCommandBuilder()
    .setName('skip')
    .setDescription('Skip the current song'),
  new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stop playback and clear the queue')
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

await rest.put(
  Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, process.env.DISCORD_GUILD_ID),
  { body: commands }
);

console.log(`Registered ${commands.length} guild commands.`);

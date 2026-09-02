import 'dotenv/config';
import { spawnSync } from 'node:child_process';

console.log('Registering Discord slash commands...');
const reg = spawnSync(process.execPath, ['scripts/register-commands.js'], {
  stdio: 'inherit',
  env: process.env
});
if (reg.status !== 0) process.exit(reg.status ?? 1);

console.log('\nCommands registered successfully.');
console.log('Now click Run, or run: npm start');

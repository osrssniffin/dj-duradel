import fs from 'node:fs/promises';
import path from 'node:path';

const STATE_PATH = path.resolve('data/state.json');

const emptyState = {
  panelMessageId: null,
  panelChannelId: null
};

export async function loadState() {
  try {
    const raw = await fs.readFile(STATE_PATH, 'utf8');
    return { ...emptyState, ...JSON.parse(raw) };
  } catch {
    return { ...emptyState };
  }
}

export async function saveState(state) {
  await fs.mkdir(path.dirname(STATE_PATH), { recursive: true });
  await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2));
}

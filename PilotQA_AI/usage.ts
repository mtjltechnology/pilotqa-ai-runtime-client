import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

const DEFAULT_USAGE_FILE = path.join(os.tmpdir(), 'pilotqa-usage.json');

function usageFile(): string {
  return process.env.PILOTQA_USAGE_PATH || DEFAULT_USAGE_FILE;
}

function currentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

async function readData(): Promise<Record<string, Record<string, number>>> {
  try {
    const raw = await fs.readFile(usageFile(), 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function writeData(data: Record<string, Record<string, number>>): Promise<void> {
  await fs.writeFile(usageFile(), JSON.stringify(data, null, 2), 'utf8');
}

export async function logExecution(userId: string): Promise<void> {
  const month = currentMonth();
  const data = await readData();
  if (!data[userId]) data[userId] = {};
  data[userId][month] = (data[userId][month] ?? 0) + 1;
  await writeData(data);
}

export async function executionsThisMonth(userId: string): Promise<number> {
  const month = currentMonth();
  const data = await readData();
  return data[userId]?.[month] ?? 0;
}

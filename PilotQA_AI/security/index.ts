import { executionsThisMonth as accountExecutionsThisMonth, logExecution as accountLogExecution } from '../account';
import type { Plan } from '../account';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export type PlanType = 'free' | 'pro';

export interface User {
  id: string;
  plan: PlanType;
}

let cachedPublicKeyPromise: Promise<string> | null = null;

async function fetchRemotePublicKey(): Promise<string> {
  const baseUrl = process.env.TOKEN_SERVICE_URL;
  if (!baseUrl) throw new Error('TOKEN_PUBLIC_KEY not configured');
  const apiKey = process.env.API_KEY;
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/tokens`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
  } as any);
  if (!res.ok) {
    throw new Error(`Failed to fetch public key: ${res.status} ${res.statusText}`);
  }
  // Try plain text first; fall back to JSON { publicKey }
  const text = await res.text();
  try {
    // If server returned JSON, parse it
    const maybe = JSON.parse(text);
    if (maybe && typeof maybe.publicKey === 'string') return maybe.publicKey as string;
  } catch {
    // not JSON, assume PEM text
  }
  return text;
}

async function loadPublicKey(): Promise<string> {
  if (cachedPublicKeyPromise) return cachedPublicKeyPromise;

  cachedPublicKeyPromise = (async () => {
    // 1) Explicit PEM or path via TOKEN_PUBLIC_KEY
    const keyEnv = process.env.TOKEN_PUBLIC_KEY;
    if (keyEnv) {
      return fs.existsSync(keyEnv) ? fs.readFileSync(keyEnv, 'utf-8') : keyEnv;
    }

    // 2) Path via TOKEN_PUBLIC_KEY_PATH or PUBLIC_KEY_PATH
    const keyPath =
      process.env.TOKEN_PUBLIC_KEY_PATH || process.env.PUBLIC_KEY_PATH;
    if (keyPath) {
      const p = path.resolve(keyPath);
      if (!fs.existsSync(p)) throw new Error(`Public key file not found: ${p}`);
      return fs.readFileSync(p, 'utf-8');
    }

    // 2b) Default shipped path inside the repo: PilotQA_AI/keys/public.pem
    const defaultPemPath = path.resolve(__dirname, '../keys/public.pem');
    if (fs.existsSync(defaultPemPath)) {
      return fs.readFileSync(defaultPemPath, 'utf-8');
    }

    // 3) Fetch from token service if configured
    if (process.env.TOKEN_SERVICE_URL) {
      return await fetchRemotePublicKey();
    }

    throw new Error('TOKEN_PUBLIC_KEY not configured');
  })();

  return cachedPublicKeyPromise;
}

export async function validateToken(token: string): Promise<User | null> {
  try {
    const publicKey = await loadPublicKey();
    const payload = jwt.verify(token, publicKey, { algorithms: ['RS256'] }) as any;
    const { userId, plan } = payload;
    return { id: userId, plan };
  } catch {
    return null;
  }
}

export async function executionsThisMonth(token: string): Promise<{ plan: Plan; usage: number }> {
  const user = await validateToken(token);
  if (!user) throw new Error('Invalid token');
  return accountExecutionsThisMonth(token);
}

export async function logExecution(token: string): Promise<void> {
  const user = await validateToken(token);
  if (!user) throw new Error('Invalid token');
  await accountLogExecution(token);
}

// Client build: do not expose local token CLI helpers by default.
const generateToken = undefined;
const revokeToken = undefined;
export { generateToken, revokeToken };
export type { Plan };

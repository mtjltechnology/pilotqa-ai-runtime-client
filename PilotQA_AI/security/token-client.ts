import 'dotenv/config';
import fs from 'fs';
import path from 'path';

export interface TokenRequest {
  userId: string;
  plan: string;
}

/**
 * Request a signed token from the remote token service.
 */
export async function requestToken(
  userId: string,
  plan: string = 'basic',
): Promise<string> {
  const baseUrl = process.env.TOKEN_SERVICE_URL;
  const apiKey = process.env.API_KEY;
  if (!baseUrl) throw new Error('TOKEN_SERVICE_URL not configured');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  // Include the Authorization header only when an API key is configured
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/tokens`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ userId, plan } satisfies TokenRequest),
  });
  if (!res.ok) {
    throw new Error(`Failed to request token: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  if (!data.token) throw new Error('Token not returned by service');
  return data.token as string;
}

// CLI usage: ts-node token-client.ts <userId> or ts-node token-client.ts <plan> <userId>
if (process.argv[1] && process.argv[1].endsWith('token-client.ts')) {
  const [, , arg1, arg2] = process.argv;
  let planArg: string;
  let userArg: string;
  if (arg1 && arg2) {
    planArg = arg1;
    userArg = arg2;
  } else if (arg1) {
    planArg = 'basic';
    userArg = arg1;
  } else {
    console.error('Usage: token-client <userId> or token-client <plan> <userId>');
    process.exit(1);
  }
  requestToken(userArg, planArg)
    .then((token) => {
      const envPath = path.join(process.cwd(), '.env');
      if (fs.existsSync(envPath)) {
        let content = fs.readFileSync(envPath, 'utf-8');
        if (content.includes('PILOTQA_AUTH_TOKEN')) {
          content = content.replace(/PILOTQA_AUTH_TOKEN=.*/g, `PILOTQA_AUTH_TOKEN=${token}`);
        } else {
          content += `\nPILOTQA_AUTH_TOKEN=${token}\n`;
        }
        fs.writeFileSync(envPath, content);
        console.log(`Token saved to ${envPath}`);
      } else {
        console.log(token);
      }
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}

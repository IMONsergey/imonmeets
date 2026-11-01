import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const template = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
const values = {
  BETTER_AUTH_SECRET: randomBytes(48).toString('base64url'),
  POSTGRES_PASSWORD: randomBytes(32).toString('hex'),
  APP_DATABASE_PASSWORD: randomBytes(32).toString('hex'),
  LIVEKIT_API_KEY: `IMON${randomBytes(12).toString('hex')}`,
  LIVEKIT_API_SECRET: randomBytes(48).toString('base64url'),
};
const text = template.replace(/^(\w+)=GENERATE_ME$/gm, (_, key) => `${key}=${values[key]}`);
try {
  await writeFile(new URL('../.env', import.meta.url), text, { flag: 'wx', mode: 0o600 });
  console.log('Created .env with random secrets. Existing files are never overwritten.');
} catch (error) {
  if (error.code === 'EEXIST') {
    console.error('.env already exists; leaving it unchanged.');
    process.exitCode = 1;
  } else throw error;
}

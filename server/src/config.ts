import { randomBytes } from 'crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';

const MIN_SECRET_LENGTH = 32;

function checkSecret(secret: string, source: string) {
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`The JWT secret from ${source} is too short: use at least ${MIN_SECRET_LENGTH} characters.`);
  }
  return secret;
}

// The only place the JWT signing secret comes from, and there is no fallback value: without a
// secret the server refuses to start instead of signing tokens with one written in the source.
//   JWT_SECRET       the secret itself. Production sets this from its secret store.
//   JWT_SECRET_FILE  a file holding the secret. If the file doesn't exist yet, a random secret is
//                    generated into it once. docker compose uses this so a clean start works
//                    without a secret checked into git.
function loadJwtSecret() {
  const fromEnv = process.env.JWT_SECRET?.trim();
  if (fromEnv) {
    return checkSecret(fromEnv, 'JWT_SECRET');
  }

  const file = process.env.JWT_SECRET_FILE?.trim();
  if (file) {
    try {
      mkdirSync(dirname(file), { recursive: true });
      // 'wx' only creates the file if it is missing, so an existing secret is never overwritten.
      writeFileSync(file, randomBytes(48).toString('hex'), { mode: 0o600, flag: 'wx' });
      console.log(`Generated a new JWT secret in ${file}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    return checkSecret(readFileSync(file, 'utf8').trim(), file);
  }

  throw new Error('No JWT secret configured. Set JWT_SECRET (or JWT_SECRET_FILE) before starting the server.');
}

export const JWT_SECRET = loadJwtSecret();

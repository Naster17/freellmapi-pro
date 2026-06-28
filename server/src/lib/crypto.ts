import crypto from 'crypto';
import Database from 'better-sqlite3';

const ALGORITHM = 'aes-256-gcm';

let cachedKey: Buffer | null = null;

/**
 * AES-256-GCM uses a 32-byte key, hex-encoded as 64 chars.
 * Validate the length up front and fail fast with an actionable message.
 */
const KEY_BYTES = 32;
const KEY_HEX_LEN = KEY_BYTES * 2;
const PLACEHOLDER_KEY = 'your-64-char-hex-key-here';

function parseHexKey(value: string, source: 'env' | 'db'): Buffer {
  if (value.length !== KEY_HEX_LEN || !/^[0-9a-fA-F]+$/.test(value)) {
    throw new Error(
      `Invalid ENCRYPTION_KEY (${source}): expected ${KEY_HEX_LEN} hex chars (32 bytes), got ${value.length} chars. ` +
      `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
    );
  }
  return Buffer.from(value, 'hex');
}

// Outside production we auto-generate and persist a key so a fresh clone
// (`npm run dev`) boots without manual setup — the placeholder ENCRYPTION_KEY
// in .env.example would otherwise crash the server on boot, which surfaces in
// the client as "Can't reach the server". Production still requires an explicit
// env key: a generated key lives only in the local DB and silently losing it
// would make every stored API key undecryptable.
function isDevFallbackAllowed(): boolean {
  return process.env.NODE_ENV !== 'production';
}

function missingKeyError(): Error {
  return new Error(
    'ENCRYPTION_KEY is required in production for API key encryption. ' +
    `Set a ${KEY_HEX_LEN}-char hex key (generate one with: ` +
    `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"). ` +
    'Outside production a local DB-stored key is auto-generated.',
  );
}

/**
 * Initialize encryption key.
 *
 * Resolution order: DB first (the key that encrypted existing data wins), then
 * env var (used to bootstrap the DB key on first boot, or to override in
 * production). Changing the env var after a DB key exists is ignored unless
 * the env key is *different* from the DB key and the env explicitly opts in
 * via `FORCE_ENCRYPTION_KEY=1` — this prevents accidental `.env` edits from
 * silently bricking every stored API key.
 *
 * Outside production, if neither DB nor env has a key, we auto-generate and
 * persist a key so a fresh clone boots without manual setup.
 */
export function initEncryptionKey(db: Database.Database): void {
  const envKey = process.env.ENCRYPTION_KEY;
  const envValid = envKey && envKey !== PLACEHOLDER_KEY;

  // 1. DB always wins (the key that encrypted existing data)
  const row = db.prepare("SELECT value FROM settings WHERE key = 'encryption_key'").get() as { value: string } | undefined;
  if (row) {
    if (envValid && envKey !== row.value && process.env.FORCE_ENCRYPTION_KEY !== '1') {
      console.warn(
        `[crypto] ENCRYPTION_KEY in .env differs from the DB-stored key — ` +
        `using the DB key to keep existing API keys decryptable. ` +
        `Set FORCE_ENCRYPTION_KEY=1 to override (existing API keys will be undecryptable).`,
      );
    } else if (envValid && process.env.FORCE_ENCRYPTION_KEY === '1') {
      console.warn('[crypto] FORCE_ENCRYPTION_KEY=1 set — overriding DB key with ENCRYPTION_KEY from env.');
      cachedKey = parseHexKey(envKey!, 'env');
      return;
    }
    cachedKey = parseHexKey(row.value, 'db');
    return;
  }

  // 2. First boot: bootstrap from env var
  if (envValid) {
    cachedKey = parseHexKey(envKey!, 'env');
    db.prepare("INSERT INTO settings (key, value) VALUES ('encryption_key', ?)").run(envKey);
    console.warn('[crypto] Bootstrapped encryption key from ENCRYPTION_KEY env var and persisted it to the DB. Future .env changes will be ignored — the DB key is now the source of truth.');
    return;
  }

  if (!isDevFallbackAllowed()) {
    throw missingKeyError();
  }

  // 3. Dev fallback: generate and persist
  cachedKey = crypto.randomBytes(KEY_BYTES);
  db.prepare("INSERT INTO settings (key, value) VALUES ('encryption_key', ?)").run(cachedKey.toString('hex'));
  console.warn('[crypto] No ENCRYPTION_KEY set — generated and persisted a local dev key. Set ENCRYPTION_KEY for production.');
}

function getEncryptionKey(): Buffer {
  if (!cachedKey) {
    throw new Error('Encryption key not initialized. Call initEncryptionKey() first.');
  }
  return cachedKey;
}

export function isEncryptionKeyInitialized(): boolean {
  return cachedKey !== null;
}

export function encrypt(text: string): { encrypted: string; iv: string; authTag: string } {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');

  return {
    encrypted,
    iv: iv.toString('hex'),
    authTag,
  };
}

// AUTH_TAG_BYTES pins the GCM tag length to 16 bytes. Without this option Node
// will accept any tag of length 4–16 bytes (RFC 5116 §3.2), which lets anyone
// who can rewrite a row in `api_keys` swap in a 4-byte tag and start brute-
// forcing forgeries at 2^32 attempts. Pinning closes that truncation path.
const AUTH_TAG_BYTES = 16;

export function decrypt(encrypted: string, iv: string, authTag: string): string {
  const key = getEncryptionKey();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'hex'), { authTagLength: AUTH_TAG_BYTES });
  decipher.setAuthTag(Buffer.from(authTag, 'hex'));

  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

export function maskKey(key: string): string {
  if (key.length <= 8) return '****' + key.slice(-4);
  return key.slice(0, 4) + '...' + key.slice(-4);
}

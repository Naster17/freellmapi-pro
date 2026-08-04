process.env.ENCRYPTION_KEY = '0'.repeat(64);
const { initDb, getDb } = await import('./src/db/index.js');
const { routePinnedModel } = await import('./src/services/router.js');
const { encrypt } = await import('./src/lib/crypto.js');

initDb(':memory:');
const db = getDb();
function addKey(baseUrl: string, secret: string) {
  const e = encrypt(secret);
  const r = db.prepare("INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, base_url, status, enabled) VALUES ('custom', 'c', ?, ?, ?, ?, 'healthy', 1)")
    .run(e.encrypted, e.iv, e.authTag, baseUrl);
  return Number(r.lastInsertRowid);
}
function addModel(modelId: string, keyId: number, scope: string) {
  const r = db.prepare("INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, supports_tools, supports_vision, enabled, key_id, endpoint_scope, source) VALUES ('custom', ?, ?, 50, 50, 1, 0, 1, ?, ?, 'user')")
    .run(modelId, modelId, keyId, scope);
  return Number(r.lastInsertRowid);
}
const ENDPOINT = 'http://127.0.0.1:18080/v1';
const other = 'http://127.0.0.1:18081/v1';
const k1 = addKey(ENDPOINT, 'shared-secret');
const k2 = addKey(other, 'shared-secret');
addModel('relay-model', k1, ENDPOINT);
const m2 = addModel('other-model', k2, other);
const route = await routePinnedModel(m2);
console.log('route:', route ? { keyId: route.keyId, apiKey: route.apiKey, modelDbId: route.modelDbId, providerBaseUrl: (route.provider as any).baseUrl } : null);

process.env.ENCRYPTION_KEY = '0'.repeat(64);
const { createApp } = await import('./src/app.js');
const { initDb, getDb, getUnifiedApiKey } = await import('./src/db/index.js');
const { routePinnedModel } = await import('./src/services/router.js');

initDb(':memory:');
const app = createApp();
const server = app.listen(0);
const port = (server.address() as any).port;
const base = `http://127.0.0.1:${port}`;
const token = getUnifiedApiKey();
async function post(path: string, body: any) {
  const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, cookie: '' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}
const ENDPOINT = 'http://127.0.0.1:18080/v1';
const other = 'http://127.0.0.1:18081/v1';
console.log('p1', await post('/api/keys/custom', { baseUrl: ENDPOINT, model: 'relay-model', apiKey: 'shared-secret' }));
console.log('p2', await post('/api/keys/custom', { baseUrl: other, model: 'other-model', apiKey: 'shared-secret' }));
const db = getDb();
console.log('keys:', db.prepare("SELECT id, base_url, status FROM api_keys WHERE platform='custom'").all());
console.log('models:', db.prepare("SELECT id, model_id, key_id, endpoint_scope FROM models WHERE platform='custom'").all());
const m = db.prepare("SELECT id FROM models WHERE platform='custom' AND model_id='other-model'").get() as any;
const route = await routePinnedModel(m.id);
console.log('route:', route && { keyId: route.keyId, baseUrl: (route.provider as any).baseUrl });
server.close();
process.exit(0);

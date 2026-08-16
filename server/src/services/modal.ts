import { getDb } from '../db/index.js';
import { encrypt, maskKey } from '../lib/crypto.js';
import { ensureV1Suffix } from '../lib/endpoint-scope.js';
import { assessProviderUrl } from '../lib/url-guard.js';
import { discoverEndpointModels } from './model-discovery.js';

export const MODAL_MONTHLY_BUDGET_USD = 30;

export interface AddModalKeyResult {
  keyId: number;
  maskedKey: string;
  modelScope: string[] | null;
}

async function discoverModalModelIds(baseUrl: string, apiKey: string): Promise<string[]> {
  const discovered = await discoverEndpointModels(baseUrl, apiKey);
  return [...new Set(discovered.map(model => model.id).filter(Boolean))];
}

export async function addModalKey(baseUrl: string, keyValue: string, label?: string): Promise<AddModalKeyResult> {
  const normalized = ensureV1Suffix(baseUrl);
  const verdict = await assessProviderUrl(normalized);
  if (!verdict.allowed) {
    throw Object.assign(new Error(`baseUrl rejected: ${verdict.reason}`), { status: 400 });
  }

  let modelScope: string[] | null = null;
  try {
    const ids = await discoverModalModelIds(normalized, keyValue.trim());
    if (ids.length > 0) modelScope = ids;
  } catch (err) {
    console.warn(`[modal] could not discover models for ${normalized}: ${(err as Error)?.message}`);
  }

  const { encrypted, iv, authTag } = encrypt(keyValue.trim());
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url, model_scope_json)
    VALUES ('modal', ?, ?, ?, ?, 'unknown', 1, ?, ?)
  `).run(label?.trim() ?? '', encrypted, iv, authTag, normalized, modelScope ? JSON.stringify(modelScope) : null);

  return { keyId: Number(result.lastInsertRowid), maskedKey: maskKey(keyValue.trim()), modelScope };
}

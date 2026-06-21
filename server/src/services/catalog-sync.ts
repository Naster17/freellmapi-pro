import crypto from 'crypto';
import type DatabaseType from 'better-sqlite3';
import { getDb, getSetting, setSetting } from '../db/index.js';
import { applyModelMetadataCorrections } from '../db/model-metadata-corrections.js';
import { hasProvider } from '../providers/index.js';
import type { Platform } from '@freellmapi/shared/types.js';

/**
 * catalog-sync — keeps the local model catalog in step with the published one.
 *
 * Twice a day (and on demand) the server pulls the catalog from the selected
 * catalog service. A valid Premium license key (Bearer) gets the live tier,
 * refreshed every 2-3 days; everyone else gets the monthly snapshot — so free
 * installs still self-heal, just on a slower cadence. The official response is
 * verified against a pinned Ed25519 public key over the exact bytes received;
 * anything unsigned or tampered with is discarded, which means a compromised
 * CDN or MITM cannot inject models or quirks into the router. The naster17
 * source is intentionally accepted unsigned.
 *
 * The bundled migrations remain the baseline: a fetched catalog is applied
 * only when it is NEWER than what the binary shipped with (MIN_CATALOG_VERSION
 * below), so a stale monthly snapshot can never roll back models that a newer
 * app version added via migrations.
 */

const DEFAULT_BASE_URL = 'https://api.freellmapi.co';
const DEFAULT_NASTER17_BASE_URL = 'https://naster17.github.io/freellmapi-catalog';

// The Ed25519 public key the production catalog is signed with. The private
// half was generated on the catalog host and has never left it. Self-hosters
// running their own catalog server can override both via env.
const PINNED_CATALOG_PUBKEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAq9yv4+3EeyMHKsfVYBhkcz1lYgIXSUeHNnN6tNgYX3k=
-----END PUBLIC KEY-----
`;

// Catalogs older than this are ignored. Bump to today's date whenever a model
// migration lands, so the bundled DB is always the floor.
export const MIN_CATALOG_VERSION = '2026.06.07';

const SYNC_INTERVAL_MS = 12 * 60 * 60 * 1000; // twice daily
const BOOT_DELAY_MS = 10 * 1000; // let the server settle before first sync
const FETCH_TIMEOUT_MS = 60 * 1000;

// settings table keys
export const SETTING_LICENSE_KEY = 'premium_license_key';
export const SETTING_LICENSE_STATUS = 'premium_license_status'; // JSON LicenseStatus
const SETTING_APPLIED_VERSION = 'catalog_applied_version';
const SETTING_APPLIED_TIER = 'catalog_applied_tier';
const SETTING_APPLIED_SOURCE = 'catalog_applied_source';
const SETTING_APPLIED_JSON = 'catalog_applied_json';
const SETTING_PREVIOUS_JSON = 'catalog_previous_json';
const SETTING_LAST_SYNC_MS = 'catalog_last_sync_ms';
const SETTING_LAST_ERROR = 'catalog_last_error';
export const SETTING_CATALOG_SOURCE = 'catalog_source';

export type CatalogSource = 'freellmapi.co' | 'naster17';

export function catalogSource(): CatalogSource {
  return getSetting(SETTING_CATALOG_SOURCE) === 'naster17' ? 'naster17' : 'freellmapi.co';
}

export function setCatalogSource(source: CatalogSource): void {
  setSetting(SETTING_CATALOG_SOURCE, source);
}

export function officialCatalogBaseUrl(): string {
  return (process.env.CATALOG_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, '');
}

export function catalogBaseUrl(source: CatalogSource = catalogSource()): string {
  if (source === 'naster17') {
    return (process.env.NASTER17_CATALOG_BASE_URL ?? DEFAULT_NASTER17_BASE_URL).replace(/\/$/, '');
  }
  return officialCatalogBaseUrl();
}

function catalogPublicKey(): crypto.KeyObject {
  const pem = process.env.CATALOG_PUBKEY ? process.env.CATALOG_PUBKEY.replace(/\\n/g, '\n') : PINNED_CATALOG_PUBKEY;
  return crypto.createPublicKey({ key: pem, format: 'pem' });
}

export interface LicenseStatus {
  valid: boolean;
  plan: 'annual' | 'lifetime' | null;
  status: string | null;
  expiresAt: string | null;
  cancelAtPeriodEnd?: boolean;
  reason?: string;
  checkedAtMs: number;
}

interface CatalogQuirk {
  slug: string;
  title: string;
  body: string;
  severity: 'blocker' | 'warning' | 'info';
  targets: { platform: string | null; modelGlob: string | null }[];
}

interface CatalogModel {
  platform: string;
  modelId: string;
  displayName: string;
  intelligenceRank: number;
  speedRank: number;
  sizeLabel: string;
  limits: { rpm: number | null; rpd: number | null; tpm: number | null; tpd: number | null };
  monthlyTokenBudget: string | null;
  contextWindow: number | null;
  enabled: boolean;
  supportsVision: boolean;
  supportsTools: boolean;
}

interface Catalog {
  version: string;
  generatedAt: string;
  tier: 'live' | 'monthly';
  models: CatalogModel[];
  quirks: CatalogQuirk[];
}

export interface CatalogSnapshotSummary {
  version: string;
  generatedAt: string;
  tier: 'live' | 'monthly';
  totalModels: number;
  enabledModels: number;
  platforms: number;
  quirks: number;
}

export interface CatalogModelChange {
  key: string;
  platform: string;
  modelId: string;
  displayName: string;
  fields: string[];
}

export interface CatalogDiffSummary {
  hasPrevious: boolean;
  fromVersion: string | null;
  fromTier: 'live' | 'monthly' | null;
  toVersion: string;
  toTier: 'live' | 'monthly';
  added: CatalogModelChange[];
  removed: CatalogModelChange[];
  changed: CatalogModelChange[];
  quirks: { added: string[]; removed: string[]; changed: string[] };
  counts: {
    added: number;
    removed: number;
    changed: number;
    quirksAdded: number;
    quirksRemoved: number;
    quirksChanged: number;
  };
}

export interface SyncResult {
  ok: boolean;
  action: 'applied' | 'up_to_date' | 'skipped_older' | 'error';
  version?: string;
  tier?: string;
  detail?: string;
  counts?: { updated: number; inserted: number; removed: number; skippedUnknownPlatform: number; quirks: number };
}

/** Minimal structural check — enough to fail loudly on a wrong/garbled body. */
function isCatalog(value: unknown): value is Catalog {
  const c = value as Catalog;
  return (
    !!c &&
    typeof c.version === 'string' &&
    (c.tier === 'live' || c.tier === 'monthly') &&
    Array.isArray(c.models) &&
    Array.isArray(c.quirks) &&
    c.models.every(
      (m) =>
        typeof m?.platform === 'string' &&
        typeof m?.modelId === 'string' &&
        typeof m?.displayName === 'string' &&
        typeof m?.enabled === 'boolean' &&
        !!m?.limits &&
        typeof m.limits === 'object',
    ) &&
    c.quirks.every((q) => typeof q?.slug === 'string' && Array.isArray(q?.targets))
  );
}

function parseCatalogSetting(key: string): Catalog | null {
  const raw = getSetting(key);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isCatalog(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function modelKey(model: CatalogModel): string {
  return `${model.platform}:${model.modelId}`;
}

function summarizeCatalog(catalog: Catalog): CatalogSnapshotSummary {
  return {
    version: catalog.version,
    generatedAt: catalog.generatedAt,
    tier: catalog.tier,
    totalModels: catalog.models.length,
    enabledModels: catalog.models.filter((m) => m.enabled).length,
    platforms: new Set(catalog.models.map((m) => m.platform)).size,
    quirks: catalog.quirks.length,
  };
}

function asModelChange(model: CatalogModel, fields: string[] = []): CatalogModelChange {
  return {
    key: modelKey(model),
    platform: model.platform,
    modelId: model.modelId,
    displayName: model.displayName,
    fields,
  };
}

function changedModelFields(before: CatalogModel, after: CatalogModel): string[] {
  const fields: string[] = [];
  if (before.displayName !== after.displayName) fields.push('name');
  if (before.enabled !== after.enabled) fields.push('availability');
  if (before.intelligenceRank !== after.intelligenceRank || before.speedRank !== after.speedRank) fields.push('ranking');
  if (before.sizeLabel !== after.sizeLabel) fields.push('size');
  if (JSON.stringify(before.limits) !== JSON.stringify(after.limits)) fields.push('limits');
  if (before.monthlyTokenBudget !== after.monthlyTokenBudget) fields.push('quota');
  if (before.contextWindow !== after.contextWindow) fields.push('context');
  if (before.supportsVision !== after.supportsVision || before.supportsTools !== after.supportsTools) fields.push('capabilities');
  return fields;
}

function diffCatalogs(previous: Catalog | null, current: Catalog): CatalogDiffSummary {
  const added: CatalogModelChange[] = [];
  const removed: CatalogModelChange[] = [];
  const changed: CatalogModelChange[] = [];
  const quirks = { added: [] as string[], removed: [] as string[], changed: [] as string[] };

  if (previous) {
    const previousModels = new Map(previous.models.map((model) => [modelKey(model), model]));
    const currentModels = new Map(current.models.map((model) => [modelKey(model), model]));

    for (const model of current.models) {
      const before = previousModels.get(modelKey(model));
      if (!before) {
        added.push(asModelChange(model));
        continue;
      }
      const fields = changedModelFields(before, model);
      if (fields.length > 0) changed.push(asModelChange(model, fields));
    }

    for (const model of previous.models) {
      if (!currentModels.has(modelKey(model))) removed.push(asModelChange(model));
    }

    const previousQuirks = new Map(previous.quirks.map((quirk) => [quirk.slug, quirk]));
    const currentQuirks = new Map(current.quirks.map((quirk) => [quirk.slug, quirk]));
    for (const quirk of current.quirks) {
      const before = previousQuirks.get(quirk.slug);
      if (!before) quirks.added.push(quirk.title);
      else if (JSON.stringify(before) !== JSON.stringify(quirk)) quirks.changed.push(quirk.title);
    }
    for (const quirk of previous.quirks) {
      if (!currentQuirks.has(quirk.slug)) quirks.removed.push(quirk.title);
    }
  }

  return {
    hasPrevious: Boolean(previous),
    fromVersion: previous?.version ?? null,
    fromTier: previous?.tier ?? null,
    toVersion: current.version,
    toTier: current.tier,
    added,
    removed,
    changed,
    quirks,
    counts: {
      added: added.length,
      removed: removed.length,
      changed: changed.length,
      quirksAdded: quirks.added.length,
      quirksRemoved: quirks.removed.length,
      quirksChanged: quirks.changed.length,
    },
  };
}

/**
 * Apply a verified catalog to the local DB inside one transaction.
 *
 * Rules of engagement with user data:
 *  - metadata (name, ranks, limits, context, capabilities) always tracks the
 *    catalog — that is the whole point of the product;
 *  - catalog enabled=false force-disables (the model is dead upstream), but
 *    enabled=true never re-enables a model the user turned off themselves;
 *  - models the user added via custom providers (platform='custom' or bound to
 *    a key) are never touched;
 *  - models that vanished from the catalog are deleted, exactly like the
 *    dead-model migrations do (fallback_config row first, FK order).
 */
export function applyCatalog(db: DatabaseType.Database, catalog: Catalog): NonNullable<SyncResult['counts']> {
  const counts = { updated: 0, inserted: 0, removed: 0, skippedUnknownPlatform: 0, quirks: 0 };

  const selectModel = db.prepare('SELECT id, enabled FROM models WHERE platform = ? AND model_id = ?');
  const updateModel = db.prepare(`
    UPDATE models SET
      display_name = @displayName, intelligence_rank = @intelligenceRank, speed_rank = @speedRank,
      size_label = @sizeLabel, rpm_limit = @rpm, rpd_limit = @rpd, tpm_limit = @tpm, tpd_limit = @tpd,
      monthly_token_budget = @monthlyTokenBudget, context_window = @contextWindow,
      supports_vision = @supportsVision, supports_tools = @supportsTools,
      enabled = @enabled
    WHERE id = @id
  `);
  const insertModel = db.prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
                        rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window,
                        enabled, supports_vision, supports_tools)
    VALUES (@platform, @modelId, @displayName, @intelligenceRank, @speedRank, @sizeLabel,
            @rpm, @rpd, @tpm, @tpd, @monthlyTokenBudget, @contextWindow,
            @enabled, @supportsVision, @supportsTools)
  `);

  const apply = db.transaction(() => {
    const inCatalog = new Set<string>();

    for (const m of catalog.models) {
      if (m.platform === 'custom' || !hasProvider(m.platform as Platform)) {
        // An older binary may receive models for providers it cannot route yet;
        // skip them — they will appear after the user updates the app.
        counts.skippedUnknownPlatform++;
        continue;
      }
      inCatalog.add(`${m.platform}:${m.modelId}`);

      const row = selectModel.get(m.platform, m.modelId) as { id: number; enabled: number } | undefined;
      const fields = {
        displayName: m.displayName,
        intelligenceRank: m.intelligenceRank,
        speedRank: m.speedRank,
        sizeLabel: m.sizeLabel,
        rpm: m.limits.rpm,
        rpd: m.limits.rpd,
        tpm: m.limits.tpm,
        tpd: m.limits.tpd,
        monthlyTokenBudget: m.monthlyTokenBudget,
        contextWindow: m.contextWindow,
        supportsVision: m.supportsVision ? 1 : 0,
        supportsTools: m.supportsTools ? 1 : 0,
      };
      if (row) {
        // Catalog disable wins (dead upstream); local disable also wins.
        const enabled = m.enabled ? row.enabled : 0;
        updateModel.run({ ...fields, id: row.id, enabled });
        counts.updated++;
      } else {
        insertModel.run({ ...fields, platform: m.platform, modelId: m.modelId, enabled: m.enabled ? 1 : 0 });
        counts.inserted++;
      }
    }

    // Ensure every model has a fallback_config row (same invariant migrations keep).
    const missingFb = db
      .prepare(
        `SELECT m.id FROM models m LEFT JOIN fallback_config f ON m.id = f.model_db_id WHERE f.id IS NULL`,
      )
      .all() as { id: number }[];
    if (missingFb.length > 0) {
      const maxPriority = (db.prepare('SELECT COALESCE(MAX(priority), 0) AS mx FROM fallback_config').get() as { mx: number }).mx;
      const addFb = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)');
      missingFb.forEach((r, i) => addFb.run(r.id, maxPriority + 1 + i));
    }

    // Profiles are the active routing source. Catalog/migration additions must
    // be appended there too, otherwise the model exists in Usage Limits but not
    // in the Models explorer or router chain.
    const profiles = db.prepare('SELECT id FROM profiles ORDER BY sort_order ASC, id ASC').all() as { id: number }[];
    const missingProfileModels = db.prepare(`
      SELECT fc.model_db_id, fc.enabled
      FROM fallback_config fc
      LEFT JOIN profile_models pm ON pm.profile_id = ? AND pm.model_db_id = fc.model_db_id
      JOIN models m ON m.id = fc.model_db_id
      WHERE pm.id IS NULL AND m.enabled = 1
      ORDER BY fc.priority ASC
    `);
    const maxProfilePriority = db.prepare('SELECT COALESCE(MAX(priority), 0) AS mx FROM profile_models WHERE profile_id = ?');
    const addProfileModel = db.prepare('INSERT OR IGNORE INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, ?, ?)');
    for (const profile of profiles) {
      const missing = missingProfileModels.all(profile.id) as { model_db_id: number; enabled: number }[];
      if (missing.length === 0) continue;
      const maxPriority = (maxProfilePriority.get(profile.id) as { mx: number }).mx;
      missing.forEach((row, i) => addProfileModel.run(profile.id, row.model_db_id, maxPriority + 1 + i, row.enabled));
    }

    // Remove catalog-managed models that the catalog no longer lists.
    const candidates = db
      .prepare(`SELECT id, platform, model_id FROM models WHERE platform != 'custom' AND key_id IS NULL`)
      .all() as { id: number; platform: string; model_id: string }[];
    const deleteFb = db.prepare('DELETE FROM fallback_config WHERE model_db_id = ?');
    const deleteModel = db.prepare('DELETE FROM models WHERE id = ?');
    for (const c of candidates) {
      if (!hasProvider(c.platform as Platform)) continue; // not catalog-managed by this binary
      if (!inCatalog.has(`${c.platform}:${c.model_id}`)) {
        deleteFb.run(c.id);
        deleteModel.run(c.id);
        counts.removed++;
      }
    }

    // Quirks are pure content: replace wholesale.
    db.prepare('DELETE FROM quirk_targets').run();
    db.prepare('DELETE FROM quirks').run();
    const insertQuirk = db.prepare(
      `INSERT INTO quirks (slug, title, body, severity, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const insertTarget = db.prepare(
      `INSERT INTO quirk_targets (quirk_id, platform, model_glob) VALUES (?, ?, ?)`,
    );
    const now = Date.now();
    for (const q of catalog.quirks) {
      const info = insertQuirk.run(q.slug, q.title, q.body, q.severity, now, now);
      for (const t of q.targets) insertTarget.run(info.lastInsertRowid, t.platform ?? null, t.modelGlob ?? null);
      counts.quirks++;
    }

    applyModelMetadataCorrections(db);
  });

  apply();
  return counts;
}

/**
 * Fetch the catalog, verify its signature, and apply it if it moves us forward.
 * `force` skips the `since` short-circuit — used right after a license key is
 * added or removed, where the tier can change without the version changing.
 */
export async function syncCatalog(force = false): Promise<SyncResult> {
  const db = getDb();
  const source = catalogSource();
  const key = getSetting(SETTING_LICENSE_KEY);
  const applied = getSetting(SETTING_APPLIED_VERSION);

  try {
    const headers: Record<string, string> = {};
    if (source === 'freellmapi.co' && key) headers.Authorization = `Bearer ${key}`;
    const url = new URL(`${catalogBaseUrl(source)}/v1/latest`);
    if (applied && !force) url.searchParams.set('since', applied);

    const res = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

    if (res.status === 304) {
      setSetting(SETTING_LAST_SYNC_MS, String(Date.now()));
      setSetting(SETTING_LAST_ERROR, '');
      return { ok: true, action: 'up_to_date', version: applied };
    }
    if (!res.ok) throw new Error(`catalog fetch failed: HTTP ${res.status}`);

    const bytes = Buffer.from(await res.arrayBuffer());
    if (source === 'freellmapi.co') {
      const signature = res.headers.get('x-catalog-signature');
      if (!signature) throw new Error('catalog response missing signature');
      const verified = crypto.verify(null, bytes, catalogPublicKey(), Buffer.from(signature, 'base64'));
      if (!verified) throw new Error('catalog signature verification FAILED — discarding response');
    }

    const parsed: unknown = JSON.parse(bytes.toString('utf8'));
    if (!isCatalog(parsed)) throw new Error('catalog payload has unexpected shape');
    const catalog = parsed;

    if (catalog.version < MIN_CATALOG_VERSION) {
      // Older than the bundled baseline (e.g. monthly snapshot lagging a fresh
      // app release) — applying it would roll back migrations. Wait it out.
      setSetting(SETTING_LAST_SYNC_MS, String(Date.now()));
      setSetting(SETTING_LAST_ERROR, '');
      return { ok: true, action: 'skipped_older', version: catalog.version, tier: catalog.tier };
    }

    const sameAsApplied =
      applied === catalog.version &&
      getSetting(SETTING_APPLIED_TIER) === catalog.tier &&
      (getSetting(SETTING_APPLIED_SOURCE) ?? 'freellmapi.co') === source;
    if (!sameAsApplied) {
      const previousCatalogRaw = getSetting(SETTING_APPLIED_JSON);
      const counts = applyCatalog(db, catalog);
      setSetting(SETTING_APPLIED_VERSION, catalog.version);
      setSetting(SETTING_APPLIED_TIER, catalog.tier);
      setSetting(SETTING_APPLIED_SOURCE, source);
      if (previousCatalogRaw) setSetting(SETTING_PREVIOUS_JSON, previousCatalogRaw);
      // Cache the accepted document so boots can re-apply it offline (see
      // reapplyCachedCatalog). Official catalogs are signature-verified;
      // naster17 catalogs are intentionally trusted unsigned.
      setSetting(SETTING_APPLIED_JSON, bytes.toString('utf8'));
      console.log(
        `[catalog-sync] applied ${source} ${catalog.tier} v${catalog.version}: ` +
          `${counts.updated} updated, ${counts.inserted} new, ${counts.removed} removed, ` +
          `${counts.quirks} quirks` +
          (counts.skippedUnknownPlatform ? `, ${counts.skippedUnknownPlatform} skipped (unknown platform)` : ''),
      );
      setSetting(SETTING_LAST_SYNC_MS, String(Date.now()));
      setSetting(SETTING_LAST_ERROR, '');
      return { ok: true, action: 'applied', version: catalog.version, tier: catalog.tier, counts };
    }

    setSetting(SETTING_LAST_SYNC_MS, String(Date.now()));
    setSetting(SETTING_LAST_ERROR, '');
    return { ok: true, action: 'up_to_date', version: catalog.version, tier: catalog.tier };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[catalog-sync] ${message}`);
    setSetting(SETTING_LAST_ERROR, message);
    return { ok: false, action: 'error', detail: message };
  }
}

/** Revalidate the stored license against the catalog service and cache the result. */
export async function refreshLicenseStatus(): Promise<LicenseStatus | null> {
  const key = getSetting(SETTING_LICENSE_KEY);
  if (!key) return null;
  try {
    const res = await fetch(`${officialCatalogBaseUrl()}/v1/license/check`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok && res.status !== 401) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as Omit<LicenseStatus, 'checkedAtMs'>;
    const status: LicenseStatus = { ...body, checkedAtMs: Date.now() };
    setSetting(SETTING_LICENSE_STATUS, JSON.stringify(status));
    return status;
  } catch (err) {
    // Offline or service down: keep the cached status. Entitlement is enforced
    // server-side at /v1/latest anyway — this cache is informational UI state.
    console.warn(`[catalog-sync] license check unreachable: ${err instanceof Error ? err.message : err}`);
    return getCachedLicenseStatus();
  }
}

export function getCachedLicenseStatus(): LicenseStatus | null {
  const raw = getSetting(SETTING_LICENSE_STATUS);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as LicenseStatus;
  } catch {
    return null;
  }
}

export interface CatalogSyncState {
  source: CatalogSource;
  baseUrl: string;
  appliedVersion: string | null;
  appliedTier: string | null;
  appliedSource: string | null;
  lastSyncMs: number | null;
  lastError: string | null;
  snapshot: CatalogSnapshotSummary | null;
  changes: CatalogDiffSummary | null;
}

export function getSyncState(): CatalogSyncState {
  const source = catalogSource();
  const current = parseCatalogSetting(SETTING_APPLIED_JSON);
  const previous = parseCatalogSetting(SETTING_PREVIOUS_JSON);
  return {
    source,
    baseUrl: catalogBaseUrl(source),
    appliedVersion: getSetting(SETTING_APPLIED_VERSION) ?? null,
    appliedTier: getSetting(SETTING_APPLIED_TIER) ?? null,
    appliedSource: getSetting(SETTING_APPLIED_SOURCE) ?? null,
    lastSyncMs: Number(getSetting(SETTING_LAST_SYNC_MS)) || null,
    lastError: getSetting(SETTING_LAST_ERROR) || null,
    snapshot: current ? summarizeCatalog(current) : null,
    changes: current ? diffCatalogs(previous, current) : null,
  };
}

/**
 * Re-apply the cached (already signature-verified) catalog after boot.
 *
 * Migrations run on every boot and re-assert the bundled baseline — they
 * INSERT OR IGNORE baseline models the catalog may have deleted and re-run
 * the family-rule resets — while the boot-time network sync 304s on an
 * unchanged version and so would NOT re-apply. Without this step every
 * restart drifts the DB back toward the baseline until the next catalog
 * version bump. Re-applying from the local cache is synchronous, needs no
 * network, and keeps the catalog authoritative even offline.
 *
 * Legacy upgrade path: installs that applied a catalog before the cache
 * existed have an applied-version setting but no cached document. Clearing
 * the applied version makes the next poll fetch the full catalog (no `since`
 * short-circuit), which re-applies it and populates the cache.
 */
export function reapplyCachedCatalog(): { reapplied: boolean; version?: string } {
  try {
    const raw = getSetting(SETTING_APPLIED_JSON);
    if (!raw) {
      if (getSetting(SETTING_APPLIED_VERSION)) {
        getDb().prepare('DELETE FROM settings WHERE key = ?').run(SETTING_APPLIED_VERSION);
      }
      return { reapplied: false };
    }
    const parsed: unknown = JSON.parse(raw);
    if (!isCatalog(parsed) || parsed.version < MIN_CATALOG_VERSION) return { reapplied: false };
    applyCatalog(getDb(), parsed);
    console.log(`[catalog-sync] re-applied cached ${parsed.tier} v${parsed.version} after boot`);
    return { reapplied: true, version: parsed.version };
  } catch (err) {
    console.warn(`[catalog-sync] cached catalog re-apply failed: ${err instanceof Error ? err.message : err}`);
    return { reapplied: false };
  }
}

let intervalId: ReturnType<typeof setInterval> | null = null;
let bootTimer: ReturnType<typeof setTimeout> | null = null;

export function startCatalogSync(): void {
  if (intervalId) return;
  if (process.env.CATALOG_SYNC_DISABLED === '1') {
    console.log('[catalog-sync] disabled via CATALOG_SYNC_DISABLED=1');
    return;
  }
  reapplyCachedCatalog();
  const run = () => {
    void refreshLicenseStatus();
    void syncCatalog();
  };
  bootTimer = setTimeout(run, BOOT_DELAY_MS);
  intervalId = setInterval(run, SYNC_INTERVAL_MS);
  console.log(`[catalog-sync] polling ${catalogBaseUrl()} every ${SYNC_INTERVAL_MS / 3600000}h`);
}

export function stopCatalogSync(): void {
  if (bootTimer) {
    clearTimeout(bootTimer);
    bootTimer = null;
  }
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

import type Database from 'better-sqlite3';

function tableExists(db: Database.Database, name: string): boolean {
  return !!db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(name);
}

function hourKey(createdAt: string): string {
  return createdAt.slice(0, 13) + ':00:00';
}

export function up(db: Db): void {
  if (!tableExists(db, 'request_hourly')) {
    db.prepare(`
      CREATE TABLE request_hourly (
        hour TEXT PRIMARY KEY,
        total_requests INTEGER NOT NULL DEFAULT 0,
        success_count INTEGER NOT NULL DEFAULT 0,
        error_count INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0
      )
    `).run();
    db.prepare(`CREATE INDEX idx_request_hourly_hour ON request_hourly(hour)`).run();
  }

  if (tableExists(db, 'requests')) {
    const bucket = db.prepare(`
      SELECT
        substr(created_at, 1, 13) || ':00:00' AS hour,
        COUNT(*) AS total_requests,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success_count,
        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error_count,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens
      FROM requests
      GROUP BY substr(created_at, 1, 13)
    `).all() as Array<{
      hour: string;
      total_requests: number;
      success_count: number;
      error_count: number;
      input_tokens: number;
      output_tokens: number;
    }>;

    const upsert = db.prepare(`
      INSERT INTO request_hourly (hour, total_requests, success_count, error_count, input_tokens, output_tokens)
      VALUES (@hour, @total_requests, @success_count, @error_count, @input_tokens, @output_tokens)
      ON CONFLICT(hour) DO UPDATE SET
        total_requests = excluded.total_requests,
        success_count  = excluded.success_count,
        error_count    = excluded.error_count,
        input_tokens   = excluded.input_tokens,
        output_tokens  = excluded.output_tokens
    `);

    const tx = db.transaction((rows: typeof bucket) => {
      for (const row of rows) upsert.run(row);
    });
    tx(bucket);

    const totals = db.prepare(`
      SELECT
        COUNT(*) AS total_requests,
        COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
        COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
        MIN(created_at) AS first_request_at
      FROM requests
    `).get() as { total_requests: number; total_input_tokens: number; total_output_tokens: number; first_request_at: string | null };

    const setSetting = db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    setSetting.run('total_requests', String(totals.total_requests));
    setSetting.run('total_input_tokens', String(totals.total_input_tokens));
    setSetting.run('total_output_tokens', String(totals.total_output_tokens));
    if (totals.first_request_at) {
      setSetting.run('first_request_at', totals.first_request_at);
    }
  }
}

export function down(db: Db): void {
  db.prepare(`DROP INDEX IF EXISTS idx_request_hourly_hour`).run();
  db.prepare(`DROP TABLE IF EXISTS request_hourly`).run();
  db.prepare(`DELETE FROM settings WHERE key IN (
    'total_requests', 'total_input_tokens', 'total_output_tokens', 'first_request_at'
  )`).run();
}

export { hourKey };
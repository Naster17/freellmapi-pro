import type { Db } from '../types.js';
import { createRequestDailyTables, AGGREGATE_METRIC_SELECT } from '../../lib/request-aggregate.js';

const COLUMN_LIST =
  'total_requests, success_count, error_count, canceled_count, chat_count, embedding_count,' +
  'input_tokens, output_tokens, cached_tokens, success_input_tokens, success_output_tokens, success_cached_tokens,' +
  'latency_sum_ms, latency_count, ttfb_sum_ms, ttfb_count, pinned_count, pin_honored_count, tps_sum, tps_count';

export function up(db: Db): void {
  createRequestDailyTables(db);

  db.prepare(`
    INSERT INTO request_daily_platform (day, platform, ${COLUMN_LIST})
    SELECT substr(created_at, 1, 10), platform, ${AGGREGATE_METRIC_SELECT}
    FROM requests
    GROUP BY substr(created_at, 1, 10), platform
  `).run();

  db.prepare(`
    INSERT INTO request_daily_model (day, platform, model_id, ${COLUMN_LIST})
    SELECT substr(created_at, 1, 10), platform, model_id, ${AGGREGATE_METRIC_SELECT}
    FROM requests
    GROUP BY substr(created_at, 1, 10), platform, model_id
  `).run();

  db.prepare(`
    INSERT INTO request_daily_client (day, client_agent, ${COLUMN_LIST}, max_created_at)
    SELECT substr(created_at, 1, 10), COALESCE(client_agent, 'unknown'), ${AGGREGATE_METRIC_SELECT}, MAX(created_at)
    FROM requests
    GROUP BY substr(created_at, 1, 10), COALESCE(client_agent, 'unknown')
  `).run();

  db.prepare(`
    INSERT INTO request_daily_key (day, key_id, ${COLUMN_LIST})
    SELECT substr(created_at, 1, 10), key_id, ${AGGREGATE_METRIC_SELECT}
    FROM requests
    WHERE key_id IS NOT NULL
    GROUP BY substr(created_at, 1, 10), key_id
  `).run();

  db.prepare('CREATE INDEX IF NOT EXISTS idx_requests_status_created ON requests(status, created_at)').run();
}

export function down(db: Db): void {
  db.exec(`
    DROP TABLE IF EXISTS request_daily_platform;
    DROP TABLE IF EXISTS request_daily_model;
    DROP TABLE IF EXISTS request_daily_client;
    DROP TABLE IF EXISTS request_daily_key;
  `);
  db.prepare('DROP INDEX IF EXISTS idx_requests_status_created').run();
}
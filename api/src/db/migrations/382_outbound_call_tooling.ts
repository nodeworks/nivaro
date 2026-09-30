import type { Knex } from 'knex'
import { utcNow } from '../dialect.js'

/**
 * Outbound call tooling (#626 flight recorder, #605 redaction, #612 health
 * probes, #603 SLO metrics, #604 mock record mode, #623 contract from traffic).
 *
 *   - nivaro_outbound_log (the always-on counter row per partner call) gains
 *     the call's detail — url, endpoint_id, triggered_by, redacted request /
 *     response headers and bodies. Bodies are blanked after 24 hours (the
 *     flight recorder ring); the counter row itself stays 31 days for SLOs.
 *   - nivaro_outbound_side_log (new): outbound HTTP that is NOT a partner call
 *     and must never count toward partner health — token fetches, health
 *     probes, token probes, editor test calls. Health / token probe rows stay
 *     31 days (uptime); the rest 24 hours.
 *   - nivaro_external_apis: redaction (text JSON {headers[], body_paths[]}),
 *     health_path / health_method / health_expect_status and the newest probe
 *     verdict (health_last_ok / _at / _detail).
 *   - nivaro_metric_definitions: three catalog rows for per-API SLO alerts
 *     (error rate, p95 latency, availability), inserted only when absent.
 *
 * Mock record mode rides the existing mock_config JSON (`record: true` per
 * instance) — no column.
 */

const OUTBOUND_COLS: Array<[string, (t: Knex.AlterTableBuilder) => void]> = [
  ['url', (t) => t.string('url', 2048).nullable()],
  ['endpoint_id', (t) => t.integer('endpoint_id').nullable()],
  ['triggered_by', (t) => t.string('triggered_by', 100).nullable()],
  ['request_headers', (t) => t.text('request_headers').nullable()],
  ['request_body', (t) => t.text('request_body').nullable()],
  ['response_headers', (t) => t.text('response_headers').nullable()],
  ['response_body', (t) => t.text('response_body').nullable()]
]

const API_COLS: Array<[string, (t: Knex.AlterTableBuilder) => void]> = [
  ['redaction', (t) => t.text('redaction').nullable()],
  ['health_path', (t) => t.string('health_path', 500).nullable()],
  ['health_method', (t) => t.string('health_method', 10).nullable()],
  ['health_expect_status', (t) => t.integer('health_expect_status').nullable()],
  ['health_last_ok', (t) => t.boolean('health_last_ok').nullable()],
  ['health_last_at', (t) => t.dateTime('health_last_at').nullable()],
  ['health_last_detail', (t) => t.string('health_last_detail', 500).nullable()]
]

const METRIC_DEFS = [
  {
    metric_key: 'external_api_error_rate',
    name: 'External API error rate',
    description:
      'Share of calls to an external API that failed (non-2xx or no answer) over the last N minutes. Scope by API name; window defaults to 15 minutes.',
    unit: 'percent',
    default_operator: 'gt',
    default_threshold: 5,
    metric: 'error_rate',
    sort: 900
  },
  {
    metric_key: 'external_api_p95_ms',
    name: 'External API p95 latency (ms)',
    description:
      'The 95th-percentile response time of calls to an external API over the last N minutes, in milliseconds.',
    unit: 'ms',
    default_operator: 'gt',
    default_threshold: 5000,
    metric: 'p95_ms',
    sort: 901
  },
  {
    metric_key: 'external_api_availability',
    name: 'External API availability',
    description:
      'Share of health probes (or, without probes, calls) that succeeded over the last N minutes.',
    unit: 'percent',
    default_operator: 'lt',
    default_threshold: 99,
    metric: 'availability',
    sort: 902
  }
]

export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('nivaro_outbound_log')) {
    for (const [name, add] of OUTBOUND_COLS) {
      if (!(await knex.schema.hasColumn('nivaro_outbound_log', name)))
        await knex.schema.alterTable('nivaro_outbound_log', (t) => add(t))
    }
  }

  if (!(await knex.schema.hasTable('nivaro_outbound_side_log'))) {
    await knex.schema.createTable('nivaro_outbound_side_log', (t) => {
      t.increments('id')
      t.integer('api_id').notNullable()
      t.string('kind', 20).notNullable()
      t.string('method', 12).nullable()
      t.string('url', 2048).nullable()
      t.integer('status').nullable()
      t.boolean('ok').notNullable().defaultTo(false)
      t.integer('duration_ms').notNullable().defaultTo(0)
      t.string('error', 500).nullable()
      t.string('triggered_by', 100).nullable()
      t.text('request_headers').nullable()
      t.text('request_body').nullable()
      t.text('response_headers').nullable()
      t.text('response_body').nullable()
      t.dateTime('created_at').notNullable().defaultTo(utcNow(knex))
      t.index(['api_id', 'created_at'])
      t.index(['kind', 'created_at'])
    })
  }

  if (await knex.schema.hasTable('nivaro_external_apis')) {
    for (const [name, add] of API_COLS) {
      if (!(await knex.schema.hasColumn('nivaro_external_apis', name)))
        await knex.schema.alterTable('nivaro_external_apis', (t) => add(t))
    }
  }

  if (await knex.schema.hasTable('nivaro_metric_definitions')) {
    for (const d of METRIC_DEFS) {
      const exists = await knex('nivaro_metric_definitions')
        .where({ metric_key: d.metric_key })
        .first('id')
      if (exists) continue
      await knex('nivaro_metric_definitions').insert({
        name: d.name,
        description: d.description,
        metric_key: d.metric_key,
        category: 'integrations',
        unit: d.unit,
        default_operator: d.default_operator,
        default_threshold: d.default_threshold,
        metric_source: JSON.stringify({
          type: 'external_api_slo',
          metric: d.metric,
          window_minutes: 15
        }),
        supported_filters: JSON.stringify([
          { key: 'api', label: 'External API (name or id)' },
          { key: 'window_minutes', label: 'Window in minutes (default 15)' }
        ]),
        status: 'active',
        sort: d.sort,
        created_at: utcNow(knex)
      })
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('nivaro_metric_definitions')) {
    await knex('nivaro_metric_definitions')
      .whereIn(
        'metric_key',
        METRIC_DEFS.map((d) => d.metric_key)
      )
      .delete()
  }
  if (await knex.schema.hasTable('nivaro_external_apis')) {
    for (const [name] of API_COLS) {
      if (await knex.schema.hasColumn('nivaro_external_apis', name))
        await knex.schema.alterTable('nivaro_external_apis', (t) => t.dropColumn(name))
    }
  }
  await knex.schema.dropTableIfExists('nivaro_outbound_side_log')
  if (await knex.schema.hasTable('nivaro_outbound_log')) {
    for (const [name] of OUTBOUND_COLS) {
      if (await knex.schema.hasColumn('nivaro_outbound_log', name))
        await knex.schema.alterTable('nivaro_outbound_log', (t) => t.dropColumn(name))
    }
  }
}

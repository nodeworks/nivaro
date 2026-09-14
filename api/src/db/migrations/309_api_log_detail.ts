import type { Knex } from 'knex'

/**
 * Migration 309 — per-request detail on nivaro_api_logs (2026-09-14).
 *
 * The request logger only ever kept method/path/status/latency/user, which
 * answers "how is the API doing" but not "what did MWF's push at 10:42 say".
 * Adds:
 *  - auth       — how the caller authenticated: session | token | api_key |
 *                 masquerade | none. "Inbound integrations" = every non-session
 *                 caller, no per-user flag needed.
 *  - ip         — first hop of x-forwarded-for, else the socket peer.
 *  - user_agent — first 300 chars.
 *  - error      — first 1000 chars of a 4xx/5xx response body, so a rejected
 *                 push can be read back without re-running it.
 * All nullable; historic rows simply read blank. Index (created_at, user)
 * backs the request list + per-caller roll-ups.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_api_logs'))) return
  const add = async (col: string, fn: (t: Knex.CreateTableBuilder) => void) => {
    if (!(await knex.schema.hasColumn('nivaro_api_logs', col))) {
      await knex.schema.alterTable('nivaro_api_logs', fn)
    }
  }
  await add('auth', (t) => t.string('auth', 20).nullable())
  await add('ip', (t) => t.string('ip', 64).nullable())
  await add('user_agent', (t) => t.string('user_agent', 300).nullable())
  await add('error', (t) => t.string('error', 1000).nullable())
  const idx = await knex.raw(
    "SELECT 1 AS present FROM sys.indexes WHERE name = 'idx_api_logs_created_user' AND object_id = OBJECT_ID('nivaro_api_logs')"
  )
  const rows = (Array.isArray(idx) ? (idx[0] ?? idx) : idx) as unknown
  const present = Array.isArray(rows) ? rows.length > 0 : false
  if (!present) {
    await knex.raw(
      'CREATE NONCLUSTERED INDEX idx_api_logs_created_user ON nivaro_api_logs (created_at DESC, [user]) INCLUDE (method, path, status, latency_ms, api_key_id, auth)'
    )
  }
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_api_logs'))) return
  await knex.raw(
    "IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_api_logs_created_user') DROP INDEX idx_api_logs_created_user ON nivaro_api_logs"
  )
  for (const col of ['auth', 'ip', 'user_agent', 'error']) {
    if (await knex.schema.hasColumn('nivaro_api_logs', col)) {
      await knex.schema.alterTable('nivaro_api_logs', (t) => t.dropColumn(col))
    }
  }
}

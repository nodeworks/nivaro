/**
 * Environment refresh — the safety pass. ALWAYS runs after the source's copy lands (even when an
 * earlier step after the restore failed), so a refreshed environment can never mail, push to or
 * call the source's people and partners:
 *
 *   - mail / SMS / push / Teams test mode on (the target's own recipients and allowlists apply),
 *   - external APIs the target never had (new from the source) answer from a mock on the target's
 *     instance (switched off when the target's instance key is unknown); the ones it had already
 *     got its own endpoints and credentials back from the keep set,
 *   - webhooks, partner sync jobs and scheduled report emails the target never had: off,
 *   - partner submissions waiting to be re-sent, pending outbox deliveries and automatic mail
 *     retries (migration 536): held,
 *   - browser/phone push registrations and Teams conversations that are not the target's: removed,
 *   - agent triggers the target never had: off; their pending deliveries: dead,
 *   - flows the target never had that call out (a webhook step): off,
 *   - copied credentials of accounts the target does not keep: static tokens cleared, API keys
 *     switched off, rows of the legacy session table removed (passwords and two-factor secrets
 *     stay — people still sign in; OAuth, device and session tokens live in each environment's
 *     own Redis and never arrive with the copy).
 *
 * In a dry run it reads the SOURCE (what will land) and writes nothing.
 */
import { qcol, qtable, type SavedKeepSet, type SqlRunner, sqlError } from './keep-set.js'

/**
 * Every table the safety pass changes — the outbound guard test (env-refresh-registry.test.ts)
 * counts these as covered.
 */
export const SAFETY_TABLES: readonly string[] = [
  'nivaro_settings',
  'nivaro_external_apis',
  'nivaro_webhooks',
  'nivaro_sync_jobs',
  'nivaro_scheduled_reports',
  'nivaro_erp_submissions',
  'nivaro_outbox',
  'nivaro_mail_log',
  'nivaro_push_subscriptions',
  'nivaro_teams_links',
  'nivaro_agent_triggers',
  'nivaro_agent_trigger_deliveries',
  'nivaro_flows',
  'nivaro_users',
  'nivaro_api_keys',
  'nivaro_sessions'
]

/** Flow step types that send something out of the instance by themselves. */
export const OUTBOUND_FLOW_OPS = ['webhook'] as const

export interface SafetyAction {
  id: string
  /** Plain words: what is switched off or held. */
  label: string
  /** How many rows (in a dry run: would be). */
  count: number
  /** Names of the rows when few (external APIs, webhooks …). */
  names?: string[]
  error?: string
}

export const MOCK_REASON = 'environment refresh — this API was new from the source'

/** The names (natural keys) the target had for a columns entry, from the saved keep set. */
export function keptNames(
  saved: SavedKeepSet | null,
  entryId: string,
  column = 'name'
): Set<string> {
  const e = saved?.entries.find((x) => x.id === entryId)
  return new Set(
    (e?.rows ?? []).map((r) =>
      String(r[column] ?? '')
        .trim()
        .toLowerCase()
    )
  )
}

/** The ids the target had for a whole-table entry. */
export function keptIds(saved: SavedKeepSet | null, entryId: string): Set<string> {
  const e = saved?.entries.find((x) => x.id === entryId)
  return new Set((e?.rows ?? []).map((r) => String(r.id ?? '').toLowerCase()))
}

/**
 * Pure: the external API rows that need a mock (or to be switched off), and the new mock_config.
 * A row whose name the target had is left alone (the keep set gave it the target's values).
 */
export function decideExternalApis(
  rows: Array<{ id: unknown; name: unknown; mock_config?: unknown; enabled?: unknown }>,
  targetNames: Set<string>,
  instanceKey: string | null
): Array<{ id: unknown; name: string; mock_config?: string; enabled?: boolean }> {
  const out: Array<{ id: unknown; name: string; mock_config?: string; enabled?: boolean }> = []
  for (const r of rows) {
    const name = String(r.name ?? '')
    if (targetNames.has(name.trim().toLowerCase())) continue
    if (!instanceKey) {
      if (r.enabled === false || r.enabled === 0) continue
      out.push({ id: r.id, name, enabled: false })
      continue
    }
    let all: Record<string, unknown> = {}
    if (typeof r.mock_config === 'string' && r.mock_config.trim()) {
      try {
        const parsed = JSON.parse(r.mock_config)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) all = parsed
      } catch {
        all = {}
      }
    }
    const mine = all[instanceKey]
    if (mine && typeof mine === 'object' && (mine as { enabled?: unknown }).enabled === true)
      continue
    all[instanceKey] = {
      ...(mine && typeof mine === 'object' ? mine : {}),
      enabled: true,
      fallback: { status: 200, body: { mock: true, reason: MOCK_REASON } }
    }
    out.push({ id: r.id, name, mock_config: JSON.stringify(all) })
  }
  return out
}

async function columnsOf(sql: SqlRunner, db: string, table: string): Promise<string[]> {
  const rows = await sql.raw(
    `SELECT c.name AS name FROM [${db}].sys.columns c JOIN [${db}].sys.tables t ON t.object_id = c.object_id WHERE t.name = ?`,
    [table]
  )
  return rows.map((r) => String(r.name))
}

const TEST_MODES = ['mail_test_mode', 'sms_test_mode', 'push_test_mode', 'teams_test_mode']

/**
 * Runs (or, with `dry`, previews against `readDb`) the safety pass. `writeDb` is the target.
 * Never throws: each action carries its own error.
 */
export async function runSafetyPass(
  sql: SqlRunner,
  o: {
    readDb: string
    writeDb: string
    instanceKey: string | null
    saved: SavedKeepSet | null
    dry: boolean
  }
): Promise<SafetyAction[]> {
  const actions: SafetyAction[] = []
  const db = o.dry ? o.readDb : o.writeDb
  type Outcome = { count: number; names?: string[] }
  const step = async (id: string, label: string, fn: () => Promise<Outcome>) => {
    const a: SafetyAction = { id, label, count: 0 }
    try {
      const r = await fn()
      a.count = r.count
      if (r.names?.length) a.names = r.names.slice(0, 50)
    } catch (e) {
      a.error = sqlError(e)
    }
    actions.push(a)
  }
  const count = async (q: string) => Number((await sql.raw(q))[0]?.n ?? 0)
  const none: Outcome = { count: 0 }

  // 1. test modes on
  await step('test-modes', 'Mail, SMS, push and Teams test mode on', async () => {
    const have = await columnsOf(sql, db, 'nivaro_settings')
    const cols = TEST_MODES.filter((c) => have.includes(c))
    if (!cols.length) return none
    const T = qtable(db, 'nivaro_settings')
    const n = await count(
      `SELECT COUNT(*) AS n FROM ${T} WHERE ${cols.map((c) => `ISNULL(${qcol(c)}, 0) = 0`).join(' OR ')}`
    )
    if (!o.dry && n)
      await sql.raw(`UPDATE ${T} SET ${cols.map((c) => `${qcol(c)} = 1`).join(', ')}`)
    return { count: n, names: cols }
  })

  // 2. external APIs new from the source → mock (or off)
  await step(
    'external-apis',
    o.instanceKey
      ? `External APIs the target never had answer from a mock on "${o.instanceKey}"`
      : 'External APIs the target never had are switched off',
    async () => {
      const have = await columnsOf(sql, db, 'nivaro_external_apis')
      if (!have.length) return none
      const T = qtable(db, 'nivaro_external_apis')
      const mock = have.includes('mock_config')
      const rows = await sql.raw(
        `SELECT [id], [name], ${mock ? '[mock_config]' : 'NULL AS mock_config'}, [enabled] FROM ${T}`
      )
      const decisions = decideExternalApis(
        rows as Array<{ id: unknown; name: unknown; mock_config?: unknown; enabled?: unknown }>,
        keptNames(o.saved, 'core:external-apis'),
        mock ? o.instanceKey : null
      )
      if (!o.dry)
        for (const d of decisions) {
          if (d.mock_config !== undefined)
            await sql.raw(`UPDATE ${T} SET [mock_config] = ? WHERE [id] = ?`, [d.mock_config, d.id])
          else await sql.raw(`UPDATE ${T} SET [enabled] = 0 WHERE [id] = ?`, [d.id])
        }
      return { count: decisions.length, names: decisions.map((d) => d.name) }
    }
  )

  // 3. webhooks / sync jobs / scheduled reports the target never had → off
  for (const [id, table, flag, entry, label] of [
    [
      'webhooks',
      'nivaro_webhooks',
      'enabled',
      'core:webhooks',
      'Webhooks the target never had — switched off'
    ],
    [
      'sync-jobs',
      'nivaro_sync_jobs',
      'is_active',
      'core:sync-jobs',
      'Partner sync jobs the target never had — switched off'
    ],
    [
      'scheduled-reports',
      'nivaro_scheduled_reports',
      'is_active',
      'core:scheduled-reports',
      'Scheduled report emails the target never had — switched off'
    ]
  ] as const) {
    await step(id, label, async () => {
      const have = await columnsOf(sql, db, table)
      if (!have.includes(flag) || !have.includes('name')) return none
      const T = qtable(db, table)
      const rows = await sql.raw(`SELECT [id], [name] FROM ${T} WHERE ${qcol(flag)} = 1`)
      const names = keptNames(o.saved, entry)
      const off = rows.filter(
        (r) =>
          !names.has(
            String(r.name ?? '')
              .trim()
              .toLowerCase()
          )
      )
      if (!o.dry)
        for (const r of off)
          await sql.raw(`UPDATE ${T} SET ${qcol(flag)} = 0 WHERE [id] = ?`, [r.id])
      return { count: off.length, names: off.map((r) => String(r.name)) }
    })
  }

  // 4. held: partner re-sends + pending outbox deliveries
  await step('erp-retries', 'Partner submissions waiting to be re-sent — held', async () => {
    const have = await columnsOf(sql, db, 'nivaro_erp_submissions')
    if (!have.includes('next_retry_at')) return none
    const T = qtable(db, 'nivaro_erp_submissions')
    const n = await count(`SELECT COUNT(*) AS n FROM ${T} WHERE [next_retry_at] IS NOT NULL`)
    if (!o.dry && n)
      await sql.raw(`UPDATE ${T} SET [next_retry_at] = NULL WHERE [next_retry_at] IS NOT NULL`)
    return { count: n }
  })
  await step('outbox', 'Pending event deliveries from the source — held', async () => {
    const have = await columnsOf(sql, db, 'nivaro_outbox')
    if (!have.includes('status')) return none
    const T = qtable(db, 'nivaro_outbox')
    const n = await count(`SELECT COUNT(*) AS n FROM ${T} WHERE [status] = 'pending'`)
    if (!o.dry && n)
      await sql.raw(
        `UPDATE ${T} SET [status] = 'dead'${have.includes('last_error') ? ", [last_error] = 'held by an environment refresh'" : ''} WHERE [status] = 'pending'`
      )
    return { count: n }
  })

  await step('mail-retries', 'Failed emails waiting for an automatic retry — held', async () => {
    const have = await columnsOf(sql, db, 'nivaro_mail_log')
    if (!have.includes('retry_at')) return none
    const T = qtable(db, 'nivaro_mail_log')
    const n = await count(`SELECT COUNT(*) AS n FROM ${T} WHERE [retry_at] IS NOT NULL`)
    if (!o.dry && n) await sql.raw(`UPDATE ${T} SET [retry_at] = NULL WHERE [retry_at] IS NOT NULL`)
    return { count: n }
  })

  // 5. devices + Teams chats that are not the target's
  for (const [id, table, entry, label] of [
    [
      'push-subscriptions',
      'nivaro_push_subscriptions',
      'core:push-subscriptions',
      'Browser and phone push registrations from the source — removed'
    ],
    [
      'teams-links',
      'nivaro_teams_links',
      'core:teams-links',
      'Teams conversations from the source — removed'
    ]
  ] as const) {
    await step(id, label, async () => {
      const have = await columnsOf(sql, db, table)
      if (!have.includes('id')) return none
      const T = qtable(db, table)
      const ids = keptIds(o.saved, entry)
      const foreign = (await sql.raw(`SELECT [id] FROM ${T}`)).filter(
        (r) => !ids.has(String(r.id).toLowerCase())
      )
      if (!o.dry)
        for (let i = 0; i < foreign.length; i += 500) {
          const chunk = foreign.slice(i, i + 500)
          await sql.raw(
            `DELETE FROM ${T} WHERE [id] IN (${chunk.map(() => '?').join(', ')})`,
            chunk.map((r) => r.id)
          )
        }
      return { count: foreign.length }
    })
  }
  // 6. agent triggers the target never had → off; their pending deliveries → dead
  await step('agent-triggers', 'Agent triggers the target never had — switched off', async () => {
    const have = await columnsOf(sql, db, 'nivaro_agent_triggers')
    if (!have.includes('enabled') || !have.includes('name')) return none
    const T = qtable(db, 'nivaro_agent_triggers')
    const names = keptNames(o.saved, 'core:agent-triggers')
    const off = (await sql.raw(`SELECT [id], [name] FROM ${T} WHERE [enabled] = 1`)).filter(
      (r) =>
        !names.has(
          String(r.name ?? '')
            .trim()
            .toLowerCase()
        )
    )
    if (!o.dry)
      for (const r of off) await sql.raw(`UPDATE ${T} SET [enabled] = 0 WHERE [id] = ?`, [r.id])
    return { count: off.length, names: off.map((r) => String(r.name)) }
  })
  await step(
    'agent-trigger-deliveries',
    'Agent trigger deliveries waiting to be sent — held',
    async () => {
      const have = await columnsOf(sql, db, 'nivaro_agent_trigger_deliveries')
      if (!have.includes('status')) return none
      const T = qtable(db, 'nivaro_agent_trigger_deliveries')
      const pending = "[status] IN ('retrying', 'sending')"
      const n = await count(`SELECT COUNT(*) AS n FROM ${T} WHERE ${pending}`)
      if (!o.dry && n)
        await sql.raw(
          `UPDATE ${T} SET [status] = 'dead'${have.includes('last_error') ? ", [last_error] = 'held by an environment refresh'" : ''}${have.includes('next_attempt_at') ? ', [next_attempt_at] = NULL' : ''} WHERE ${pending}`
        )
      return { count: n }
    }
  )

  // 7. flows the target never had that call out by themselves → off
  await step(
    'flows',
    'Flows the target never had that call out (webhook steps) — switched off',
    async () => {
      const have = await columnsOf(sql, db, 'nivaro_flows')
      const ops = await columnsOf(sql, db, 'nivaro_flow_operations')
      if (!have.includes('status') || !ops.includes('type')) return none
      const F = qtable(db, 'nivaro_flows')
      const O = qtable(db, 'nivaro_flow_operations')
      const rows = await sql.raw(
        `SELECT f.[id], f.[name] FROM ${F} f WHERE f.[status] = 'active' AND EXISTS (SELECT 1 FROM ${O} o WHERE o.[flow] = f.[id] AND o.[type] IN (${OUTBOUND_FLOW_OPS.map((t) => `'${t}'`).join(', ')}))`
      )
      const names = keptNames(o.saved, 'core:flows')
      const off = rows.filter(
        (r) =>
          !names.has(
            String(r.name ?? '')
              .trim()
              .toLowerCase()
          )
      )
      if (!o.dry)
        for (const r of off)
          await sql.raw(`UPDATE ${F} SET [status] = 'inactive' WHERE [id] = ?`, [r.id])
      return { count: off.length, names: off.map((r) => String(r.name)) }
    }
  )

  // 8. copied credentials of accounts the target does not keep
  const keptUsers = keptIds(o.saved, 'core:accounts')
  const keptKeys = keptIds(o.saved, 'core:api-keys')
  await step(
    'static-tokens',
    'Static tokens of accounts the target does not keep — cleared',
    async () => {
      const have = await columnsOf(sql, db, 'nivaro_users')
      if (!have.includes('static_token')) return none
      const T = qtable(db, 'nivaro_users')
      const ids = (await sql.raw(`SELECT [id] FROM ${T} WHERE [static_token] IS NOT NULL`))
        .map((r) => r.id)
        .filter((id) => !keptUsers.has(String(id).toLowerCase()))
      if (!o.dry)
        for (let i = 0; i < ids.length; i += 500) {
          const chunk = ids.slice(i, i + 500)
          await sql.raw(
            `UPDATE ${T} SET [static_token] = NULL WHERE [id] IN (${chunk.map(() => '?').join(', ')})`,
            chunk
          )
        }
      return { count: ids.length }
    }
  )
  await step('api-keys', 'API keys the target does not keep — switched off', async () => {
    const have = await columnsOf(sql, db, 'nivaro_api_keys')
    if (!have.includes('is_active')) return none
    const T = qtable(db, 'nivaro_api_keys')
    const rows = await sql.raw(`SELECT [id], [name] FROM ${T} WHERE [is_active] = 1`)
    const off = rows.filter((r) => !keptKeys.has(String(r.id).toLowerCase()))
    if (!o.dry)
      for (let i = 0; i < off.length; i += 500) {
        const chunk = off.slice(i, i + 500)
        await sql.raw(
          `UPDATE ${T} SET [is_active] = 0 WHERE [id] IN (${chunk.map(() => '?').join(', ')})`,
          chunk.map((r) => r.id)
        )
      }
    return { count: off.length, names: off.map((r) => String(r.name)) }
  })
  await step('sessions', 'Sign-in sessions copied from the source — removed', async () => {
    const have = await columnsOf(sql, db, 'nivaro_sessions')
    if (!have.length) return none
    const T = qtable(db, 'nivaro_sessions')
    const n = await count(`SELECT COUNT(*) AS n FROM ${T}`)
    if (!o.dry && n) await sql.raw(`DELETE FROM ${T}`)
    return { count: n }
  })
  return actions
}

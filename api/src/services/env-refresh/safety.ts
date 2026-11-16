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
 *   - partner submissions waiting to be re-sent and pending outbox deliveries: held,
 *   - browser/phone push registrations and Teams conversations that are not the target's: removed.
 *
 * In a dry run it reads the SOURCE (what will land) and writes nothing.
 */
import { qcol, qtable, type SavedKeepSet, type SqlRunner, sqlError } from './keep-set.js'

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
  return actions
}

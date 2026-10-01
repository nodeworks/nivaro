/**
 * Extension schema steps (#826) — versioned DDL / registry changes an
 * extension owns, declared with `ctx.schema.step(id, {up, check})` inside
 * register() and run right after it, in declaration order, under the same
 * lock core migrations take. A step that ran once on a database is recorded
 * in `nivaro_extension_schema_steps` with the schema diff it produced (the
 * migration-effects listing) and never runs again there; a step that threw
 * is recorded as `error` and tried again on the next boot. `check` is run
 * after the step and on every readiness read, so drift — someone dropped
 * the column by hand — is reported instead of discovered by a failing cron.
 *
 * The table is created lazily on the first step, like nivaro_migration_effects:
 * per-database bookkeeping, RUNTIME in config-inventory.
 */
import type { SchemaCheckResult, SchemaStepDef } from '@nivaro/extension-kit'
import type { Knex } from 'knex'
import { MIGRATION_LOCK_NAME, PG_LOCK_KEY } from '../db/index.js'
import { diffSchema, listSchema, summarizeEffects } from '../db/migration-effects.js'
import { NIVARO_VERSION } from '../version.js'

export const SCHEMA_STEPS_TABLE = 'nivaro_extension_schema_steps'

export interface SchemaStepRow {
  extension: string
  step: string
  status: 'applied' | 'error'
  ran_at: Date | null
  duration_ms: number | null
  schema_changed: boolean
  summary: string | null
  effects: { added: string[]; removed: string[]; truncated: boolean } | null
  error: string | null
  app_version: string | null
  check_ok: boolean | null
  check_detail: string | null
  checked_at: Date | null
}

export interface SchemaStepStatus extends Omit<SchemaStepRow, 'extension' | 'status'> {
  description: string
  /** 'pending' = declared this boot and not yet run (or the run was skipped). */
  status: 'applied' | 'error' | 'pending'
  has_check: boolean
}

const STEP_ID = /^[a-z0-9][a-z0-9_-]*$/i
const CAP = 400

/** Steps declared per extension this boot, in declaration order. */
const declared = new Map<string, SchemaStepDef[]>()
/** The database each extension's steps run against (its ctx.database). */
const databases = new Map<string, Knex>()
/** Last known ledger rows per extension (refreshed by runSchemaSteps / checks). */
const lastRows = new Map<string, SchemaStepRow[]>()

export function declareSchemaStep(extId: string, def: SchemaStepDef): void {
  if (!def || typeof def !== 'object') throw new Error('A schema step needs a definition')
  if (!STEP_ID.test(def.id ?? '')) {
    throw new Error(`Schema step id "${def.id}" must be kebab-case (letters, digits, - _)`)
  }
  if (typeof def.up !== 'function') throw new Error(`Schema step "${def.id}" needs up()`)
  const list = declared.get(extId) ?? []
  if (list.some((s) => s.id === def.id)) {
    throw new Error(`Schema step "${def.id}" is declared twice by ${extId}`)
  }
  list.push(def)
  declared.set(extId, list)
}

export function declaredSchemaSteps(extId: string): SchemaStepDef[] {
  return declared.get(extId) ?? []
}

export function clearSchemaSteps(extId?: string): void {
  if (extId) {
    declared.delete(extId)
    databases.delete(extId)
    lastRows.delete(extId)
  } else {
    declared.clear()
    databases.clear()
    lastRows.clear()
  }
}

async function ensureTable(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable(SCHEMA_STEPS_TABLE)) return
  await knex.schema.createTable(SCHEMA_STEPS_TABLE, (t) => {
    t.increments('id')
    t.string('extension', 120).notNullable()
    t.string('step', 120).notNullable()
    t.string('status', 20).notNullable()
    t.dateTime('ran_at')
    t.integer('duration_ms')
    t.boolean('schema_changed').notNullable().defaultTo(false)
    t.string('summary', 500)
    t.text('effects')
    t.text('error')
    t.string('app_version', 40)
    t.boolean('check_ok')
    t.string('check_detail', 500)
    t.dateTime('checked_at')
    t.unique(['extension', 'step'])
  })
}

function parseRow(r: Record<string, unknown>): SchemaStepRow {
  let effects: SchemaStepRow['effects'] = null
  if (typeof r.effects === 'string' && r.effects) {
    try {
      effects = JSON.parse(r.effects)
    } catch {
      effects = null
    }
  }
  const bool = (v: unknown) => (v == null ? null : v === true || v === 1 || v === '1')
  return {
    extension: String(r.extension),
    step: String(r.step),
    status: r.status === 'applied' ? 'applied' : 'error',
    ran_at: r.ran_at ? new Date(r.ran_at as string) : null,
    duration_ms: r.duration_ms == null ? null : Number(r.duration_ms),
    schema_changed: bool(r.schema_changed) === true,
    summary: (r.summary as string) ?? null,
    effects,
    error: (r.error as string) ?? null,
    app_version: (r.app_version as string) ?? null,
    check_ok: bool(r.check_ok),
    check_detail: (r.check_detail as string) ?? null,
    checked_at: r.checked_at ? new Date(r.checked_at as string) : null
  }
}

async function readRows(knex: Knex, extId: string): Promise<SchemaStepRow[]> {
  if (!(await knex.schema.hasTable(SCHEMA_STEPS_TABLE).catch(() => false))) return []
  const rows = (await knex(SCHEMA_STEPS_TABLE).where({ extension: extId })) as Array<
    Record<string, unknown>
  >
  return rows.map(parseRow)
}

async function upsertRow(
  knex: Knex,
  extId: string,
  step: string,
  patch: Record<string, unknown>
): Promise<void> {
  await ensureTable(knex)
  const existing = await knex(SCHEMA_STEPS_TABLE).where({ extension: extId, step }).first()
  if (existing) await knex(SCHEMA_STEPS_TABLE).where({ extension: extId, step }).update(patch)
  else await knex(SCHEMA_STEPS_TABLE).insert({ extension: extId, step, ...patch })
}

function dialectOf(knex: Knex): string {
  // biome-ignore lint/suspicious/noExplicitAny: knex client config is untyped
  return String((knex as any).client?.config?.client ?? '')
}

/**
 * Take the migration lock ON THIS TRANSACTION's connection. Session-owned
 * locks taken through a pool may be released on another connection and
 * linger; a transaction-owned lock dies with the transaction, on the one
 * connection the step's DDL also runs on.
 */
async function lockOnTransaction(trx: Knex.Transaction, timeoutMs: number): Promise<void> {
  const dialect = dialectOf(trx)
  if (dialect === 'mssql') {
    const res = await trx.raw(
      `DECLARE @r INT;
       EXEC @r = sp_getapplock @Resource = ?, @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = ?;
       SELECT @r AS result;`,
      [MIGRATION_LOCK_NAME, timeoutMs]
    )
    const row = Array.isArray(res) ? res[0] : res
    const result = row?.result ?? row?.[0]?.result ?? -999
    if (result < 0) throw new Error(`Could not take the migration lock within ${timeoutMs}ms`)
    return
  }
  if (dialect === 'pg' || dialect === 'postgres' || dialect === 'postgresql') {
    await trx.raw(`SET LOCAL lock_timeout = ${Math.max(1, Math.floor(timeoutMs))}`)
    await trx.raw('SELECT pg_advisory_xact_lock(?)', [PG_LOCK_KEY])
    return
  }
  if (dialect.startsWith('mysql')) {
    const res = await trx.raw('SELECT GET_LOCK(?, ?) AS result', [
      MIGRATION_LOCK_NAME,
      Math.ceil(timeoutMs / 1000)
    ])
    const rows = Array.isArray(res) ? res[0] : res
    const ok = (Array.isArray(rows) ? rows[0]?.result : rows?.result) === 1
    if (!ok) throw new Error(`Could not take the migration lock within ${timeoutMs}ms`)
  }
  // Unknown dialect (a test double): no lock.
}

function errorText(err: unknown): string {
  const e = err as { message?: string; errors?: Array<{ message?: string }> }
  const inner = Array.isArray(e?.errors)
    ? e.errors
        .map((x) => x?.message)
        .filter(Boolean)
        .slice(0, 3)
        .join(' · ')
    : ''
  const head = String(e?.message ?? err ?? 'unknown error')
  return (inner && !head.includes(inner) ? `${head} — ${inner}` : head).slice(0, 2000)
}

async function runCheck(
  def: SchemaStepDef,
  knex: Knex
): Promise<{ ok: boolean; detail: string | null } | null> {
  if (typeof def.check !== 'function') return null
  try {
    const r = (await def.check(knex)) as SchemaCheckResult | boolean
    if (typeof r === 'boolean') return { ok: r, detail: null }
    return { ok: !!r?.ok, detail: r?.detail ? String(r.detail).slice(0, 500) : null }
  } catch (err) {
    return { ok: false, detail: `check threw: ${errorText(err)}`.slice(0, 500) }
  }
}

export interface RunSchemaStepsOptions {
  timeoutMs?: number
  logger?: { info: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void }
  /** Overrides for tests. */
  listSchema?: (knex: Knex) => Promise<Set<string>>
}

export interface RunSchemaStepsResult {
  applied: string[]
  skipped: string[]
  failed: Array<{ step: string; error: string }>
}

/**
 * Run the steps an extension declared, in order, against its database.
 * A step recorded `applied` is skipped (its check still runs); the first
 * step that throws stops the rest — a later step usually builds on it.
 */
export async function runSchemaSteps(
  extId: string,
  knex: Knex,
  opts: RunSchemaStepsOptions = {}
): Promise<RunSchemaStepsResult> {
  const steps = declared.get(extId) ?? []
  const result: RunSchemaStepsResult = { applied: [], skipped: [], failed: [] }
  databases.set(extId, knex)
  if (steps.length === 0) return result
  // SKIP_BOOT_MIGRATIONS=1 (pnpm dev:db) leaves the database exactly as found:
  // extension schema steps are migrations too.
  if (process.env.SKIP_BOOT_MIGRATIONS === '1') {
    result.skipped.push(...steps.map((s) => s.id))
    return result
  }
  const list = opts.listSchema ?? listSchema
  const timeoutMs = opts.timeoutMs ?? 60_000
  let rows = await readRows(knex, extId).catch(() => [] as SchemaStepRow[])
  for (const def of steps) {
    const row = rows.find((r) => r.step === def.id)
    if (row?.status === 'applied') {
      result.skipped.push(def.id)
      const c = await runCheck(def, knex)
      if (c) {
        await upsertRow(knex, extId, def.id, {
          check_ok: c.ok,
          check_detail: c.detail,
          checked_at: new Date()
        }).catch(() => {})
      }
      continue
    }
    const started = Date.now()
    try {
      let effects: { added: string[]; removed: string[] } | null = null
      await knex.transaction(async (trx) => {
        await lockOnTransaction(trx, timeoutMs)
        const before = await list(trx).catch(() => null)
        await def.up(trx)
        const after = before ? await list(trx).catch(() => null) : null
        effects = before && after ? diffSchema(before, after) : null
      })
      const ms = Date.now() - started
      const c = await runCheck(def, knex)
      await upsertRow(knex, extId, def.id, {
        status: 'applied',
        ran_at: new Date(),
        duration_ms: ms,
        schema_changed: effects
          ? (effects as { added: string[]; removed: string[] }).added.length +
              (effects as { added: string[]; removed: string[] }).removed.length >
            0
          : false,
        summary: effects
          ? summarizeEffects(effects)
          : 'Schema could not be listed — effect unknown',
        effects: effects
          ? JSON.stringify({
              added: (effects as { added: string[] }).added.slice(0, CAP),
              removed: (effects as { removed: string[] }).removed.slice(0, CAP),
              truncated:
                (effects as { added: string[] }).added.length > CAP ||
                (effects as { removed: string[] }).removed.length > CAP
            })
          : null,
        error: null,
        app_version: NIVARO_VERSION,
        check_ok: c?.ok ?? null,
        check_detail: c?.detail ?? null,
        checked_at: c ? new Date() : null
      })
      result.applied.push(def.id)
      opts.logger?.info(
        { extension: extId, step: def.id, ms },
        `[schema-steps] ${extId}: ${def.id} applied — ${effects ? summarizeEffects(effects) : 'effect unknown'}`
      )
    } catch (err) {
      const error = errorText(err)
      result.failed.push({ step: def.id, error })
      await upsertRow(knex, extId, def.id, {
        status: 'error',
        ran_at: new Date(),
        duration_ms: Date.now() - started,
        error,
        app_version: NIVARO_VERSION
      }).catch(() => {})
      opts.logger?.error(
        { extension: extId, step: def.id, err: error },
        `[schema-steps] ${extId}: ${def.id} FAILED — later steps of this extension were not run`
      )
      break
    }
  }
  rows = await readRows(knex, extId).catch(() => [])
  lastRows.set(extId, rows)
  return result
}

/** Re-run every applied step's check now and refresh the stored verdicts. */
export async function runSchemaChecks(extId: string): Promise<SchemaStepStatus[]> {
  const knex = databases.get(extId)
  if (!knex) return schemaStepStatus(extId)
  const rows = await readRows(knex, extId).catch(() => [] as SchemaStepRow[])
  for (const def of declared.get(extId) ?? []) {
    const row = rows.find((r) => r.step === def.id)
    if (row?.status !== 'applied') continue
    const c = await runCheck(def, knex)
    if (!c) continue
    row.check_ok = c.ok
    row.check_detail = c.detail
    row.checked_at = new Date()
    await upsertRow(knex, extId, def.id, {
      check_ok: c.ok,
      check_detail: c.detail,
      checked_at: row.checked_at
    }).catch(() => {})
  }
  lastRows.set(extId, rows)
  return schemaStepStatus(extId)
}

/** The declared steps with their ledger state, in declaration order. */
export function schemaStepStatus(extId: string): SchemaStepStatus[] {
  const rows = lastRows.get(extId) ?? []
  return (declared.get(extId) ?? []).map((def) => {
    const row = rows.find((r) => r.step === def.id)
    return {
      step: def.id,
      description: def.description,
      has_check: typeof def.check === 'function',
      status: row?.status ?? 'pending',
      ran_at: row?.ran_at ?? null,
      duration_ms: row?.duration_ms ?? null,
      schema_changed: row?.schema_changed ?? false,
      summary: row?.summary ?? null,
      effects: row?.effects ?? null,
      error: row?.error ?? null,
      app_version: row?.app_version ?? null,
      check_ok: row?.check_ok ?? null,
      check_detail: row?.check_detail ?? null,
      checked_at: row?.checked_at ?? null
    }
  })
}

export function extensionsWithSchemaSteps(): string[] {
  return [...declared.keys()].filter((k) => (declared.get(k)?.length ?? 0) > 0)
}

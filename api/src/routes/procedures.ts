import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { config } from '../config.js'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import {
  type DeployResult,
  type DriftStatus,
  deployManagedProcedure,
  managedStatusOf,
  registerManagedProcReadiness,
  saveAndDeployManaged
} from '../services/managed-procedures/deploy.js'
import { procDeployHash } from '../services/managed-procedures/normalize.js'
import { appManagedProcedures, procedureOwner } from '../services/managed-procedures/owners.js'
import {
  adoptLiveProcedure,
  getManagedProcedure,
  getManagedVersion,
  listManagedProcedures,
  listManagedVersions,
  ManagedProcError,
  type ManagedProcedure,
  markManagedDropped,
  putBackManaged,
  unmarkManagedDropped
} from '../services/managed-procedures/store.js'
import { definitionNameMatches, liveProcedureDefinitions } from '../services/procedure-deploy.js'

/**
 * Stored-procedure management (admin) — the Developer → Procedures page.
 *
 * Two sources of truth, by owner (services/managed-procedures/owners.ts, the one answer):
 *   - an app-managed procedure's body lives in CONFIG (nivaro_managed_procedures, one row per
 *     proc, one version row per saved body). Every write here goes through config — save a
 *     version, then deploy it (services/managed-procedures/deploy.ts) — so the change travels with
 *     promote and Undo is "restore version N". A procedure created here is born managed; editing
 *     or dropping an unmanaged live proc adopts it first (its live text becomes version 1). There
 *     is no unmanaged write path left. A drop marks the row dropped (versions kept) and drops the
 *     live proc.
 *   - an import-owned procedure's body lives on its import definition: every write route here
 *     refuses it with 409 APP_MANAGED (change it in Imports → Definitions).
 *   - any other procedure (never adopted) — the database is the truth; it is listed and readable
 *     and executable, and the first edit or drop adopts it.
 *
 * Trust model: requireAdmin end to end, same tier as custom queries (an
 * admin there already authors arbitrary SQL that executes on demand). Every
 * save/adopt/drop/restore/deploy/exec is activity-logged (collection
 * `sys.procedures`, item = name, comment `v<version> · <note>`).
 *
 * Parameter "auto-parsing" reads sys.parameters — the engine's own catalog —
 * so the execute form always matches the deployed signature, never a regex's
 * guess at the header.
 */

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

interface ProcParam {
  name: string // includes the leading @
  type: string
  max_length: number
  precision: number
  scale: number
  is_output: boolean
  has_default: boolean
  position: number
}

async function procParams(name: string): Promise<ProcParam[]> {
  const rows = (await db.raw(
    `SELECT pa.name, t.name AS type_name, pa.max_length, pa.precision, pa.scale,
            pa.is_output, pa.has_default_value, pa.parameter_id
     FROM sys.parameters pa
     JOIN sys.procedures p ON p.object_id = pa.object_id
     JOIN sys.types t ON t.user_type_id = pa.user_type_id
     WHERE p.name = ? AND pa.parameter_id > 0
     ORDER BY pa.parameter_id`,
    [name]
  )) as Array<{
    name: string
    type_name: string
    max_length: number
    precision: number
    scale: number
    is_output: boolean
    has_default_value: boolean
    parameter_id: number
  }>
  return rows.map((r) => ({
    name: r.name,
    type: r.type_name,
    max_length: r.max_length,
    precision: r.precision,
    scale: r.scale,
    is_output: !!r.is_output,
    // sys.parameters.has_default_value is only populated for CLR procs; for
    // T-SQL the definition carries the defaults. The client treats every
    // param as omittable and lets the engine complain when one is required.
    has_default: !!r.has_default_value,
    position: r.parameter_id
  }))
}

/** Engine-accurate context for the AI routes: referenced base tables with
 * live columns/indexes/row counts, plus where the app invokes the proc. */
async function gatherProcContext(
  name: string
): Promise<{ tables: string[]; schemaCtx: string[]; usage: string[] }> {
  let tables: string[] = []
  try {
    const refs = (await db.raw(
      `SELECT DISTINCT referenced_entity_name AS t
       FROM sys.dm_sql_referenced_entities(?, 'OBJECT')
       WHERE referenced_minor_id = 0 AND referenced_entity_name IS NOT NULL`,
      [`dbo.${name}`]
    )) as Array<{ t: string }>
    tables = refs
      .map((r) => r.t)
      .filter((t) => NAME_RE.test(t))
      .slice(0, 12)
  } catch {
    /* unresolved refs — proceed without table context */
  }
  if (tables.length) {
    const real = (await db('information_schema.tables')
      .whereIn('table_name', tables)
      .where('table_type', 'BASE TABLE')
      .pluck('table_name')) as string[]
    tables = real
  }
  const schemaCtx: string[] = []
  for (const t of tables) {
    const cols = (await db('information_schema.columns')
      .where({ table_name: t })
      .orderBy('ordinal_position')
      .select('column_name', 'data_type', 'is_nullable')) as Array<{
      column_name: string
      data_type: string
      is_nullable: string
    }>
    const idx = (await db.raw(
      `SELECT i.name, i.type_desc, i.is_unique,
              STRING_AGG(c.name, ',') WITHIN GROUP (ORDER BY ic.key_ordinal) AS cols
       FROM sys.indexes i
       JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0
       JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
       WHERE i.object_id = OBJECT_ID(?) AND i.type > 0
       GROUP BY i.name, i.type_desc, i.is_unique`,
      [`dbo.${t}`]
    )) as Array<{ name: string; type_desc: string; is_unique: boolean; cols: string }>
    const cnt = (await db
      .raw(
        `SELECT SUM(ps.row_count) AS n FROM sys.dm_db_partition_stats ps
         WHERE ps.object_id = OBJECT_ID(?) AND ps.index_id IN (0, 1)`,
        [`dbo.${t}`]
      )
      .catch(() => [{ n: null }])) as Array<{ n: number | null }>
    schemaCtx.push(
      `TABLE ${t} (~${cnt[0]?.n ?? '?'} rows)\n  columns: ${cols
        .map((c) => `${c.column_name} ${c.data_type}${c.is_nullable === 'YES' ? '?' : ''}`)
        .join(', ')}\n  indexes: ${
        idx.length
          ? idx.map((i) => `${i.name}(${i.cols})${i.is_unique ? ' UNIQUE' : ''}`).join('; ')
          : 'NONE beyond heap'
      }`
    )
  }
  const usage: string[] = []
  try {
    const cq = (await db('nivaro_custom_queries')
      .where('sql_text', 'like', `%${name}%`)
      .pluck('slug')) as string[]
    if (cq.length) usage.push(`custom queries: ${cq.slice(0, 10).join(', ')}`)
    const defs = (await db('nivaro_import_definitions')
      .where({ procedure: name })
      .pluck('key')
      .catch(() => [])) as string[]
    if (defs.length) usage.push(`staged-import definitions: ${defs.join(', ')}`)
    const rules = (await db('nivaro_rules')
      .where('actions', 'like', `%${name}%`)
      .pluck('name')
      .catch(() => [])) as string[]
    if (rules.length) usage.push(`automation rules: ${rules.slice(0, 6).join(', ')}`)
  } catch {
    /* usage context is best-effort */
  }
  return { tables, schemaCtx, usage }
}

/** How the page shows a proc's owner: an import definition, or a managed row with its drift. */
type ManagedInfo =
  | { kind: 'import'; key: string }
  | { kind: 'managed'; status: DriftStatus; version: number; owner: string | null }

const NOTE_EDIT = 'Edited in the Procedures page'
const NOTE_CREATE = 'Created in the Procedures page'
const NOTE_ADOPT = 'Adopted from the live database'
const NOTE_ADOPT_EDIT = 'Adopted from the live database before an edit'
const NOTE_ADOPT_DROP = 'Adopted from the live database before a drop'
const NOTE_KEEP_LIVE = "Kept the database's version"
const NOTE_MAX = 500

/** The import-owned refusal (message unchanged from before config): 409 APP_MANAGED. */
const importOwned = (name: string, key: string) =>
  new ManagedProcError(
    409,
    'APP_MANAGED',
    `${name} is managed by the import definition "${key}". Change it there (Imports → Definitions); a deploy here would be overwritten by the import and fight it.`,
    { definition: key }
  )

/** Answer a ManagedProcError with its status and `{ error, code, ...extra }`; rethrow others. */
function sendManagedError(reply: FastifyReply, e: unknown) {
  if (e instanceof ManagedProcError) {
    return reply.code(e.status).send({ error: e.message, code: e.code, ...(e.extra ?? {}) })
  }
  throw e
}

/** 400 for a bad name, 409 for an import-owned one; null when the route may go on. */
async function refuseName(name: string, reply: FastifyReply) {
  if (!NAME_RE.test(name)) {
    return reply.code(400).send({ error: 'Invalid procedure name', code: 'PROC_NAME_INVALID' })
  }
  const owner = await procedureOwner(name)
  if (owner?.kind === 'import') return sendManagedError(reply, importOwned(name, owner.key))
  return null
}

/** One dbo proc as SQL Server keeps it — its spelling and text ('' = encrypted, unreadable) —
 *  or null when it is not there. */
async function liveProc(name: string): Promise<{ name: string; text: string } | null> {
  const rows = (await db.raw(
    `SELECT p.name, m.definition FROM sys.procedures p
       JOIN sys.schemas s ON s.schema_id = p.schema_id
       LEFT JOIN sys.sql_modules m ON m.object_id = p.object_id
      WHERE p.name = ? AND s.name = 'dbo' AND p.is_ms_shipped = 0`,
    [name]
  )) as Array<{ name: string; definition: string | null }>
  const r = rows?.[0]
  return r ? { name: String(r.name), text: r.definition ?? '' } : null
}

const unreadable = (name: string) =>
  new ManagedProcError(
    409,
    'PROC_UNREADABLE',
    `dbo.${name} is encrypted — its text cannot be read, so it cannot be adopted into config`
  )

const staleNoConfig = () =>
  new ManagedProcError(
    409,
    'PROC_STALE',
    'This procedure was changed since you opened it — reload to see the current version',
    { current: null }
  )

const actor = (req: FastifyRequest) => `user:${req.user?.id ?? 'unknown'}`
const noteOf = (v: unknown, fallback: string) => {
  const s = typeof v === 'string' ? v.trim() : ''
  return (s || fallback).slice(0, NOTE_MAX)
}

const fieldError = (field: string, what: string) =>
  new ManagedProcError(400, 'PROC_FIELD_INVALID', `${field} must be ${what}`, { field })

/** An optional string field: absent = undefined, null kept, anything else not a string → 400. */
function optText(body: Record<string, unknown>, field: string): string | null | undefined {
  const v = body[field]
  if (v === undefined || v === null) return v as undefined | null
  if (typeof v !== 'string') throw fieldError(field, 'a string or null')
  return v
}

/**
 * The bases a write was opened on: `base_hash` / `base_version` (the config row; null =
 * "there was none") and `base_live_hash` (the live text's procDeployHash as GET /:name gave it;
 * null = "it was not live"). Absent = no check. A wrong type → 400 PROC_FIELD_INVALID.
 */
function readBase(body: Record<string, unknown> | undefined) {
  const b = body ?? {}
  const out: {
    baseHash?: string | null
    baseVersion?: number | null
    baseLiveHash?: string | null
  } = {}
  const hash = optText(b, 'base_hash')
  if (hash !== undefined) out.baseHash = hash
  const live = optText(b, 'base_live_hash')
  if (live !== undefined) out.baseLiveHash = live
  const v = b.base_version
  if (v === null) out.baseVersion = null
  else if (v !== undefined) {
    const n = typeof v === 'string' && /^\d{1,9}$/.test(v) ? Number(v) : v
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
      throw fieldError('base_version', 'a positive whole number or null')
    }
    out.baseVersion = n
  }
  return out
}

/** 409 PROC_DRIFTED (`live_hash` = the live text now) when live changed since it was opened. */
function assertLiveUnchanged(
  baseLiveHash: string | null | undefined,
  live: { text: string } | null
): void {
  if (baseLiveHash === undefined) return
  const now = live == null ? null : procDeployHash(live.text)
  if (now === baseLiveHash) return
  throw new ManagedProcError(
    409,
    'PROC_DRIFTED',
    "The procedure was changed in the database since you opened it — keep the database's version, or overwrite it",
    { live_hash: now }
  )
}

const isStampFailure = (e: unknown) =>
  e instanceof ManagedProcError && e.code === 'DEPLOY_STAMP_FAILED'

function parseVersion(v: string): number | null {
  if (!/^\d{1,9}$/.test(v)) return null
  const n = Number(v)
  return n >= 1 ? n : null
}

/** The managed row's answer for the page. */
function managedInfo(row: ManagedProcedure, live: string | null): ManagedInfo {
  return {
    kind: 'managed',
    status: managedStatusOf(row, live),
    version: row.version,
    owner: row.owner
  }
}

async function log(
  req: FastifyRequest,
  action: string,
  name: string,
  version: number | null,
  note: string
) {
  await logActivity({
    action,
    user: req.user?.id,
    collection: 'sys.procedures',
    item: name,
    comment: `${version != null ? `v${version} · ` : ''}${note}`.slice(0, 255),
    req
  })
}

/** Adopt an unmanaged live proc (its text becomes version 1) and log it. `null` base: a writer
 *  that adopted it meanwhile makes this 409 PROC_STALE. */
async function adoptForWrite(req: FastifyRequest, name: string, note: string) {
  const adopted = await adoptLiveProcedure(name, {
    userId: req.user?.id ?? null,
    note,
    by: actor(req),
    baseHash: null
  })
  await log(req, 'procedure-adopt', name, adopted.version, note)
  return adopted
}

/**
 * Undo an adoption made for a write that then failed with live unchanged — otherwise the proc
 * stays managed and promote carries this database's body to the next environment. Guarded (a
 * writer that moved the row on keeps it). Resolves whether config no longer has the row.
 */
async function undoAdoption(
  req: FastifyRequest,
  name: string,
  adopted: { procedure: ManagedProcedure; version: number },
  what: 'edit' | 'drop'
): Promise<boolean> {
  try {
    await putBackManaged(null, adopted.procedure.id, adopted.version)
    if (await getManagedProcedure(name)) return false
  } catch (err) {
    req.log.error({ err, procedure: name }, 'could not undo the adoption made for a failed write')
    return false
  }
  await log(req, 'procedure-adopt', name, adopted.version, `undone: ${what} failed`)
  return true
}

/** A DDL that ran but was not recorded still changed live: log it before answering. */
async function logIfStampFailed(
  req: FastifyRequest,
  e: unknown,
  action: string,
  name: string,
  note: string
) {
  if (!isStampFailure(e)) return
  const v = Number((e as ManagedProcError).extra?.version)
  await log(req, action, name, Number.isFinite(v) && v > 0 ? v : null, `${note} (not stamped)`)
}

export async function procedureRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin)
  registerManagedProcReadiness()

  // ── List: live procs plus config-only ones (not deployed / dropped) ──────
  app.get('/', async (_req, reply) => {
    const [rows, owners, managed] = await Promise.all([
      db.raw(`
      SELECT p.name, p.create_date, p.modify_date, LEN(m.definition) AS bytes,
             (SELECT COUNT(*) FROM sys.parameters pa
               WHERE pa.object_id = p.object_id AND pa.parameter_id > 0) AS param_count
      FROM sys.procedures p
      JOIN sys.sql_modules m ON m.object_id = p.object_id
      WHERE p.is_ms_shipped = 0
      ORDER BY p.name`) as Promise<Array<Record<string, unknown>>>,
      appManagedProcedures(),
      listManagedProcedures()
    ])
    const liveDefs = managed.length
      ? await liveProcedureDefinitions(managed.map((m) => m.name))
      : new Map<string, string>()
    const byName = new Map(managed.map((m) => [m.name.toLowerCase(), m]))
    const info = (name: string): ManagedInfo | null => {
      const owner = owners.get(name.toLowerCase())
      if (owner?.kind === 'import') return { kind: 'import', key: owner.key }
      const row = byName.get(name.toLowerCase())
      return row ? managedInfo(row, liveDefs.get(name.toLowerCase()) ?? null) : null
    }
    const seen = new Set<string>()
    const data = rows.map((r) => {
      const name = String(r.name)
      seen.add(name.toLowerCase())
      return {
        name,
        created: r.create_date as string | null,
        modified: r.modify_date as string | null,
        bytes: Number(r.bytes ?? 0),
        param_count: Number(r.param_count ?? 0),
        live: true,
        managed: info(name)
      }
    })
    for (const m of managed) {
      if (seen.has(m.name.toLowerCase())) continue
      data.push({
        name: m.name,
        created: null,
        modified: null,
        bytes: 0,
        param_count: 0,
        live: false,
        managed: info(m.name)
      })
    }
    data.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
    return reply.send({ data, warning: config.PROCEDURE_EDIT_WARNING ?? null })
  })

  // ── Read one: live definition + catalog-parsed parameters + config ───────
  app.get<{ Params: { name: string } }>('/:name', async (req, reply) => {
    const { name } = req.params
    if (!NAME_RE.test(name)) return reply.code(400).send({ error: 'Invalid procedure name' })
    const [row, owner] = await Promise.all([
      db.raw(
        `SELECT p.name, p.create_date, p.modify_date, m.definition
       FROM sys.procedures p JOIN sys.sql_modules m ON m.object_id = p.object_id
       WHERE p.name = ? AND p.is_ms_shipped = 0`,
        [name]
      ) as Promise<
        Array<{ name: string; create_date: Date; modify_date: Date; definition: string | null }>
      >,
      procedureOwner(name)
    ])
    const liveRow = row[0] ?? null
    if (!liveRow && !owner) return reply.code(404).send({ error: 'Procedure not found' })
    const config = owner?.kind === 'managed' ? await getManagedProcedure(name) : null
    const definition = liveRow?.definition ?? null
    const managed: ManagedInfo | null =
      owner?.kind === 'import'
        ? { kind: 'import', key: owner.key }
        : config
          ? managedInfo(config, liveRow ? (definition ?? '') : null)
          : null
    return reply.send({
      data: {
        name: liveRow?.name ?? config?.name ?? owner?.name ?? name,
        created: liveRow?.create_date ?? null,
        modified: liveRow?.modify_date ?? null,
        definition,
        // What a write sends back as base_live_hash (case kept: a case-only change counts).
        live_hash: liveRow ? procDeployHash(definition ?? '') : null,
        params: liveRow ? await procParams(name) : [],
        managed,
        config: config
          ? {
              body: config.body,
              body_hash: config.body_hash,
              version: config.version,
              deployed_hash: config.deployed_hash,
              deployed_at: config.deployed_at,
              deployed_by: config.deployed_by,
              dropped_at: config.dropped_at,
              owner: config.owner,
              description: config.description,
              updated_at: config.updated_at,
              updated_by: config.updated_by
            }
          : null
      }
    })
  })

  // ── Save + deploy (create, edit, revive) — always through config ─────────
  app.put<{
    Params: { name: string }
    Body: {
      definition?: string
      note?: string
      base_hash?: string | null
      base_version?: number | null
      base_live_hash?: string | null
      create?: boolean
      owner?: string | null
      description?: string | null
    }
  }>('/:name', async (req, reply) => {
    const { name } = req.params
    const body = (req.body ?? {}) as Record<string, unknown>
    const definition = typeof body.definition === 'string' ? body.definition : ''
    if (!NAME_RE.test(name)) return reply.code(400).send({ error: 'Invalid procedure name' })
    if (!definition.trim()) return reply.code(400).send({ error: 'definition is required' })
    const refused = await refuseName(name, reply)
    if (refused) return refused
    if (!definitionNameMatches(definition, name)) {
      return reply.code(400).send({
        error: `The definition must be a CREATE [OR ALTER] PROCEDURE for "${name}" — the statement's name doesn't match.`,
        code: 'PROC_HEADER_MISMATCH'
      })
    }
    try {
      const fields = readBase(body)
      const owner = optText(body, 'owner')
      const description = optText(body, 'description')
      const [current, live] = await Promise.all([getManagedProcedure(name), liveProc(name)])
      const create = body.create === true
      if (create && (current || live)) {
        return reply.code(409).send({
          error: current?.dropped_at
            ? `${name} was dropped — restore one of its versions instead of creating it again`
            : `A procedure named ${name} already exists`,
          code: 'PROC_EXISTS',
          live: !!live,
          managed: !!current,
          dropped: !!current?.dropped_at
        })
      }
      assertLiveUnchanged(fields.baseLiveHash, live)
      let base: { baseHash?: string | null; baseVersion?: number | null } = create
        ? { baseHash: null }
        : { baseHash: fields.baseHash, baseVersion: fields.baseVersion }
      let adopted: Awaited<ReturnType<typeof adoptForWrite>> | null = null
      if (!current && live) {
        // An edit makes a proc managed: its live text becomes version 1 first. A caller that saw
        // a config row (any base_hash / base_version) is stale — there is none.
        if (live.text === '') throw unreadable(name)
        if (base.baseHash !== undefined || base.baseVersion !== undefined) throw staleNoConfig()
        adopted = await adoptForWrite(req, live.name, NOTE_ADOPT_EDIT)
        base = { baseHash: adopted.procedure.body_hash, baseVersion: adopted.version }
      }
      const isNew = !current && !live
      const action = isNew ? 'procedure-create' : 'procedure-update'
      const note = noteOf(body.note, isNew ? NOTE_CREATE : NOTE_EDIT)
      let saved: Awaited<ReturnType<typeof saveAndDeployManaged>>
      try {
        saved = await saveAndDeployManaged({
          name,
          body: definition,
          note,
          userId: req.user?.id ?? null,
          ...(base.baseHash !== undefined ? { baseHash: base.baseHash } : {}),
          ...(base.baseVersion !== undefined ? { baseVersion: base.baseVersion } : {}),
          ...(owner !== undefined ? { owner } : {}),
          ...(description !== undefined ? { description } : {}),
          by: actor(req)
        })
      } catch (e) {
        await logIfStampFailed(req, e, action, name, note)
        // Live is unchanged unless only the stamp failed: the adoption goes too.
        if (adopted && !isStampFailure(e)) await undoAdoption(req, name, adopted, 'edit')
        throw e
      }
      await log(req, action, name, saved.version, saved.unchanged ? `${note} (unchanged)` : note)
      return reply.send({
        ok: true,
        created: isNew,
        version: saved.version,
        unchanged: saved.unchanged,
        deployed: saved.deployed
      })
    } catch (e) {
      return sendManagedError(reply, e)
    }
  })

  // ── Adopt: store the live text as a version ─────────────────────────────
  // A managed proc is refused (409 PROC_ALREADY_MANAGED) unless `?keep_live=1` — the explicit
  // "keep the database's version" answer to drift: the live text becomes the next version.
  app.post<{
    Params: { name: string }
    Querystring: { keep_live?: string }
    Body: { note?: string; keep_live?: boolean } | undefined
  }>('/:name/adopt', async (req, reply) => {
    const { name } = req.params
    const refused = await refuseName(name, reply)
    if (refused) return refused
    const keepLive =
      req.query?.keep_live === '1' ||
      req.query?.keep_live === 'true' ||
      req.body?.keep_live === true
    try {
      const [current, live] = await Promise.all([getManagedProcedure(name), liveProc(name)])
      if (current && !keepLive) {
        return reply.code(409).send({
          error: `${name} is already app-managed — deploy its config, or keep the database's version (keep_live=1)`,
          code: 'PROC_ALREADY_MANAGED',
          version: current.version
        })
      }
      if (live?.text === '') throw unreadable(name)
      const note = noteOf(req.body?.note, current ? NOTE_KEEP_LIVE : NOTE_ADOPT)
      // Stored under the spelling SQL Server keeps; guarded on the row we read (or its absence).
      const adopted = await adoptLiveProcedure(live?.name ?? name, {
        userId: req.user?.id ?? null,
        note,
        by: actor(req),
        baseHash: current ? current.body_hash : null
      })
      await log(req, 'procedure-adopt', name, adopted.version, note)
      return reply.send({ data: { version: adopted.version, unchanged: adopted.unchanged } })
    } catch (e) {
      return sendManagedError(reply, e)
    }
  })

  // ── Drop: mark dropped in config, then drop live (versions kept) ─────────
  app.delete<{
    Params: { name: string }
    Querystring: { base_version?: string }
    Body: { base_version?: number | null } | undefined
  }>('/:name', async (req, reply) => {
    const { name } = req.params
    const refused = await refuseName(name, reply)
    if (refused) return refused
    try {
      const { baseVersion } = readBase({
        base_version: req.body?.base_version ?? req.query?.base_version
      })
      const [found, live] = await Promise.all([getManagedProcedure(name), liveProc(name)])
      if (!found && !live) return reply.code(404).send({ error: 'Procedure not found' })
      if (baseVersion !== undefined && (found?.version ?? null) !== baseVersion) {
        throw new ManagedProcError(
          409,
          'PROC_STALE',
          'This procedure was changed since you opened it — reload to see the current version',
          { current: found ? { body_hash: found.body_hash, version: found.version } : null }
        )
      }
      let current = found
      let adopted: Awaited<ReturnType<typeof adoptForWrite>> | null = null
      if (!current && live) {
        // So the drop travels with config and Undo (restore a version) works.
        if (live.text === '') throw unreadable(name)
        adopted = await adoptForWrite(req, live.name, NOTE_ADOPT_DROP)
        current = adopted.procedure
      }
      const before = current as ManagedProcedure
      await markManagedDropped(name, req.user?.id ?? null)
      const result = await deployManagedProcedure(name, { by: actor(req) })
      if (result.action === 'failed') {
        if (result.phase === 'stamp') {
          await log(req, 'procedure-drop', name, before.version, 'dropped (not stamped)')
          throw new ManagedProcError(
            500,
            'DEPLOY_STAMP_FAILED',
            result.reason ?? 'Dropped, but recording the drop failed',
            { version: before.version }
          )
        }
        // The database refused the drop: config must not claim it (nor keep an adoption).
        if (adopted) await undoAdoption(req, name, adopted, 'drop')
        else if (!before.dropped_at) {
          try {
            await unmarkManagedDropped(before)
          } catch (err) {
            req.log.error({ err, procedure: name }, 'could not put back the dropped mark')
          }
        }
        const left = await getManagedProcedure(name).catch(() => before)
        const configDropped = !!left?.dropped_at
        throw new ManagedProcError(
          400,
          'DROP_FAILED',
          `${result.reason ?? 'Drop failed'}${configDropped ? ' — config still marks it dropped, so the next deploy will drop it' : ''}`,
          { config_dropped: configDropped }
        )
      }
      await log(req, 'procedure-drop', name, before.version, result.action)
      return reply.code(204).send()
    } catch (e) {
      return sendManagedError(reply, e)
    }
  })

  // ── Versions ────────────────────────────────────────────────────────────
  app.get<{ Params: { name: string } }>('/:name/versions', async (req, reply) => {
    const { name } = req.params
    const refused = await refuseName(name, reply)
    if (refused) return refused
    return reply.send({ data: await listManagedVersions(name) })
  })

  app.get<{ Params: { name: string; version: string } }>(
    '/:name/versions/:version',
    async (req, reply) => {
      const { name } = req.params
      const refused = await refuseName(name, reply)
      if (refused) return refused
      const n = parseVersion(req.params.version)
      if (n == null) return reply.code(400).send({ error: 'Invalid version' })
      const v = await getManagedVersion(name, n)
      if (!v)
        return reply.code(404).send({ error: 'Version not found', code: 'PROC_VERSION_NOT_FOUND' })
      return reply.send({
        data: {
          version: v.version,
          body: v.body,
          body_hash: v.body_hash,
          note: v.note,
          created_at: v.created_at,
          created_by: v.created_by
        }
      })
    }
  )

  // ── Restore (Undo): save version N's body as the next version, deploy ───
  app.post<{
    Params: { name: string; version: string }
    Body:
      | {
          base_hash?: string | null
          base_version?: number | null
          base_live_hash?: string | null
          note?: string
        }
      | undefined
  }>('/:name/versions/:version/restore', async (req, reply) => {
    const { name } = req.params
    const refused = await refuseName(name, reply)
    if (refused) return refused
    const n = parseVersion(req.params.version)
    if (n == null) return reply.code(400).send({ error: 'Invalid version' })
    try {
      const v = await getManagedVersion(name, n)
      if (!v) {
        return reply.code(404).send({ error: 'Version not found', code: 'PROC_VERSION_NOT_FOUND' })
      }
      const { baseLiveHash, ...base } = readBase(req.body as Record<string, unknown> | undefined)
      assertLiveUnchanged(baseLiveHash, await liveProc(name))
      const note = noteOf(req.body?.note, `Restored version ${n}`)
      let saved: Awaited<ReturnType<typeof saveAndDeployManaged>>
      try {
        saved = await saveAndDeployManaged({
          name,
          body: v.body,
          note,
          userId: req.user?.id ?? null,
          ...base,
          by: actor(req)
        })
      } catch (e) {
        await logIfStampFailed(req, e, 'procedure-restore', name, note)
        throw e
      }
      await log(req, 'procedure-restore', name, saved.version, note)
      return reply.send({
        data: { version: saved.version, unchanged: saved.unchanged, deployed: saved.deployed }
      })
    } catch (e) {
      return sendManagedError(reply, e)
    }
  })

  // ── Deploy the config as it stands (the drift fix) ──────────────────────
  app.post<{ Params: { name: string } }>('/:name/deploy', async (req, reply) => {
    const { name } = req.params
    const refused = await refuseName(name, reply)
    if (refused) return refused
    try {
      const result: DeployResult = await deployManagedProcedure(name, { by: actor(req) })
      if (result.action === 'failed') {
        const stamp = result.phase === 'stamp'
        if (stamp) {
          // The DDL ran: live changed. reason = "<action>, but recording … failed".
          const did = /^(created|altered|dropped|unchanged|absent)\b/.exec(result.reason ?? '')
          const row = await getManagedProcedure(name).catch(() => null)
          await log(
            req,
            'procedure-deploy-config',
            name,
            row?.version ?? null,
            `${did?.[1] ?? 'deployed'} (not stamped)`
          )
        }
        return reply.code(stamp ? 500 : 400).send({
          error: result.reason ?? 'Deploy failed',
          code: stamp ? 'DEPLOY_STAMP_FAILED' : 'DEPLOY_FAILED',
          data: result
        })
      }
      const row = await getManagedProcedure(name)
      await log(req, 'procedure-deploy-config', name, row?.version ?? null, result.action)
      return reply.send({ data: result })
    } catch (e) {
      return sendManagedError(reply, e)
    }
  })

  // ── AI review ────────────────────────────────────────────────────────────
  // Gathers ENGINE-ACCURATE context (sys.dm_sql_referenced_entities for the
  // tables the proc actually touches, live columns/indexes/row counts for
  // each) plus where the app uses the proc, and asks the model for a summary,
  // improvements, and index suggestions. The model only ever SUGGESTS —
  // nothing here executes its output.
  app.post<{ Params: { name: string } }>('/:name/ai-review', async (req, reply) => {
    const { name } = req.params
    if (!NAME_RE.test(name)) return reply.code(400).send({ error: 'Invalid procedure name' })
    const row = (await db.raw(
      `SELECT m.definition FROM sys.procedures p
       JOIN sys.sql_modules m ON m.object_id = p.object_id
       WHERE p.name = ? AND p.is_ms_shipped = 0`,
      [name]
    )) as Array<{ definition: string }>
    if (!row.length) return reply.code(404).send({ error: 'Procedure not found' })
    const definition = row[0].definition

    const { getAiClient } = await import('../services/ai-client.js')
    const client = await getAiClient()
    if (!client) return reply.code(503).send({ error: 'AI is not configured (no Anthropic key)' })

    const { tables, schemaCtx, usage } = await gatherProcContext(name)

    const { model } = await (await import('../services/ai-client.js')).getAiModelSettings()
    const prompt = `You are reviewing a SQL Server stored procedure for a production system.

PROCEDURE DEFINITION:
${definition.slice(0, 24000)}

LIVE SCHEMA OF REFERENCED TABLES (columns, existing indexes, approx row counts):
${schemaCtx.join('\n\n') || '(dependency resolution unavailable)'}

WHERE THE APP USES IT:
${usage.join('\n') || '(no registered app usage found — may be invoked externally or by cron)'}

Respond with ONLY a JSON object, no fences:
{
  "summary": "2-4 sentences: what this procedure does and when it runs",
  "improvements": ["specific, actionable improvement", ...],
  "index_suggestions": [{"table": "...", "columns": "col1, col2", "reason": "which predicate/join this serves", "create_sql": "CREATE INDEX ... ON ..."}],
  "risks": ["correctness or operational risk worth knowing", ...]
}
Rules: suggest an index ONLY when the definition's predicates/joins hit columns the listed indexes do not cover AND the table is large enough to matter; empty arrays are fine; never invent tables or columns not shown above.`

    try {
      const message = await client.messages.create({
        model,
        max_tokens: 1800,
        messages: [{ role: 'user', content: prompt }]
      })
      const text = message.content
        .map((b) => ('text' in b ? b.text : ''))
        .join('')
        .trim()
      const jsonText = text.replace(/^```(json)?\s*/i, '').replace(/```\s*$/, '')
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(jsonText)
      } catch {
        parsed = { summary: text, improvements: [], index_suggestions: [], risks: [] }
      }
      await logActivity({
        action: 'procedure-ai-review',
        user: req.user?.id,
        collection: 'sys.procedures',
        item: name,
        req
      })
      return reply.send({ data: { ...parsed, tables_analyzed: tables } })
    } catch (e) {
      return reply.code(502).send({ error: `AI review failed: ${(e as Error).message}` })
    }
  })

  // ── AI fix ───────────────────────────────────────────────────────────────
  // Produce a corrected FULL definition addressing ONE named finding. The
  // result is returned as a DRAFT for the editor — it is never deployed here;
  // the human reviews and hits Deploy like any hand edit.
  app.post<{
    Params: { name: string }
    Body: { issue?: string; issues?: string[]; definition?: string }
  }>('/:name/ai-fix', async (req, reply) => {
    const { name } = req.params
    // Single finding or a whole section's worth — a batch goes to the model
    // as ONE request so the fixes come out coherent instead of N sequential
    // rewrites stepping on each other.
    const issues = (
      Array.isArray(req.body?.issues)
        ? req.body.issues.map((i) => String(i))
        : [String(req.body?.issue ?? '')]
    )
      .map((i) => i.trim())
      .filter(Boolean)
      .slice(0, 12)
    const issue = issues.map((it, i) => (issues.length > 1 ? `${i + 1}. ${it}` : it)).join('\n')
    if (!NAME_RE.test(name)) return reply.code(400).send({ error: 'Invalid procedure name' })
    if (!issue) return reply.code(400).send({ error: 'issue is required' })
    // Fix against the editor's CURRENT draft when supplied, so sequential
    // fixes stack instead of each starting from the deployed version.
    let definition = String(req.body?.definition ?? '')
    if (!definition.trim()) {
      const row = (await db.raw(
        `SELECT m.definition FROM sys.procedures p
           JOIN sys.sql_modules m ON m.object_id = p.object_id
           WHERE p.name = ? AND p.is_ms_shipped = 0`,
        [name]
      )) as Array<{ definition: string }>
      if (!row.length) return reply.code(404).send({ error: 'Procedure not found' })
      definition = row[0].definition
    }
    const { getAiClient, getAiModelSettings } = await import('../services/ai-client.js')
    const client = await getAiClient()
    if (!client) return reply.code(503).send({ error: 'AI is not configured (no Anthropic key)' })
    const { schemaCtx, usage } = await gatherProcContext(name)
    const { model } = await getAiModelSettings()
    const prompt = `You are fixing ${issues.length > 1 ? `${issues.length} specific issues` : 'ONE specific issue'} in a SQL Server stored procedure for a production system.

CURRENT DEFINITION:
${definition.slice(0, 24000)}

LIVE SCHEMA OF REFERENCED TABLES (columns, existing indexes, approx row counts):
${schemaCtx.join('\n\n') || '(dependency resolution unavailable)'}

WHERE THE APP USES IT:
${usage.join('\n') || '(no registered app usage found)'}

THE ISSUE${issues.length > 1 ? 'S' : ''} TO FIX (address every one):
${issue.slice(0, 4000)}

Respond with ONLY a JSON object, no fences:
{
  "definition": "the COMPLETE corrected procedure as CREATE OR ALTER PROCEDURE ${name} ... — full body, not a diff",
  "explanation": "2-4 sentences: exactly what changed and why it fixes the issue(s)"
}
Rules: change the MINIMUM needed to address the stated issue; preserve every other behavior, parameter, and output shape exactly; never reference tables or columns not shown above; the procedure name must remain ${name}.`
    try {
      const message = await client.messages.create({
        model,
        max_tokens: issues.length > 1 ? 12000 : 8000,
        messages: [{ role: 'user', content: prompt }]
      })
      const text = message.content
        .map((b) => ('text' in b ? b.text : ''))
        .join('')
        .trim()
      const jsonText = text.replace(/^```(json)?\s*/i, '').replace(/```\s*$/, '')
      let parsed: { definition?: string; explanation?: string }
      try {
        parsed = JSON.parse(jsonText)
      } catch {
        return reply.code(502).send({ error: 'AI returned an unparseable fix — try again' })
      }
      const fixed = String(parsed.definition ?? '')
      if (!fixed.trim() || !definitionNameMatches(fixed, name)) {
        return reply.code(502).send({
          error: 'AI produced a definition that does not match this procedure — nothing applied'
        })
      }
      await logActivity({
        action: 'procedure-ai-fix',
        user: req.user?.id,
        collection: 'sys.procedures',
        item: name,
        comment: issue.slice(0, 200),
        req
      })
      return reply.send({
        data: { definition: fixed, explanation: String(parsed.explanation ?? '') }
      })
    } catch (e) {
      return reply.code(502).send({ error: `AI fix failed: ${(e as Error).message}` })
    }
  })

  // ── AI generate (New procedure) ──────────────────────────────────────────
  // Describe what you want; the model writes the full CREATE OR ALTER against
  // the real schema (business table names + column lists for the tables the
  // prompt mentions — same fuzzy-match context the SQL copilot uses). The
  // result fills the editor; deploying stays an explicit human action.
  app.post<{ Body: { name?: string; prompt?: string } }>('/ai-generate', async (req, reply) => {
    const name = String(req.body?.name ?? '').trim()
    const prompt = String(req.body?.prompt ?? '').trim()
    if (!NAME_RE.test(name)) return reply.code(400).send({ error: 'Invalid procedure name' })
    if (!prompt) return reply.code(400).send({ error: 'prompt is required' })
    const { getAiClient, getAiModelSettings } = await import('../services/ai-client.js')
    const client = await getAiClient()
    if (!client) return reply.code(503).send({ error: 'AI is not configured (no Anthropic key)' })

    const collections = (await db('nivaro_collections')
      .whereNot('collection', 'like', 'nivaro_%')
      .pluck('collection')) as string[]
    const referenced = new Set<string>()
    const haystack = prompt.toLowerCase()
    for (const n of collections) {
      if (
        haystack.includes(n.toLowerCase()) ||
        haystack.includes(n.toLowerCase().replace(/_/g, ' '))
      ) {
        referenced.add(n)
      }
    }
    for (const word of haystack.split(/[^a-z_]+/)) {
      if (word.length < 4) continue
      for (const n of collections) if (n.toLowerCase().includes(word)) referenced.add(n)
    }
    const columnBlocks: string[] = []
    for (const t of [...referenced].slice(0, 12)) {
      try {
        const cols = (await db('information_schema.columns')
          .where({ table_name: t })
          .orderBy('ordinal_position')
          .select('column_name', 'data_type')) as Array<{ column_name: string; data_type: string }>
        columnBlocks.push(`${t}(${cols.map((c) => `${c.column_name} ${c.data_type}`).join(', ')})`)
      } catch {
        /* skip */
      }
    }

    const { model } = await getAiModelSettings()
    const userPrompt = `Write a Microsoft SQL Server (T-SQL) stored procedure.

NAME: ${name}
WHAT IT SHOULD DO:
${prompt.slice(0, 4000)}

AVAILABLE TABLES: ${collections.join(', ')}

DETAILED SCHEMAS (tables the request mentions):
${columnBlocks.join('\n') || '(none matched — ask only for tables from the available list)'}

Respond with ONLY a JSON object, no fences:
{
  "definition": "CREATE OR ALTER PROCEDURE ${name} ... — complete, production-quality T-SQL with SET NOCOUNT ON, sensible parameters with defaults, and TRY/CATCH around any writes",
  "explanation": "2-3 sentences on what it does and any assumptions made"
}
Rules: only reference tables and columns shown above; the procedure name must be exactly ${name}; prefer read-only unless the request clearly asks for writes.`
    try {
      const message = await client.messages.create({
        model,
        max_tokens: 6000,
        messages: [{ role: 'user', content: userPrompt }]
      })
      const text = message.content
        .map((b) => ('text' in b ? b.text : ''))
        .join('')
        .trim()
      const jsonText = text.replace(/^```(json)?\s*/i, '').replace(/```\s*$/, '')
      let parsed: { definition?: string; explanation?: string }
      try {
        parsed = JSON.parse(jsonText)
      } catch {
        return reply.code(502).send({ error: 'AI returned an unparseable result — try rephrasing' })
      }
      const definition = String(parsed.definition ?? '')
      if (!definition.trim() || !definitionNameMatches(definition, name)) {
        return reply
          .code(502)
          .send({ error: 'AI produced a definition that does not match the requested name' })
      }
      await logActivity({
        action: 'procedure-ai-generate',
        user: req.user?.id,
        collection: 'sys.procedures',
        item: name,
        comment: prompt.slice(0, 200),
        req
      })
      return reply.send({ data: { definition, explanation: String(parsed.explanation ?? '') } })
    } catch (e) {
      return reply.code(502).send({ error: `AI generation failed: ${(e as Error).message}` })
    }
  })

  // ── Execute with typed params ────────────────────────────────────────────
  // Param names are validated against sys.parameters (the catalog, not the
  // request), values always BIND — nothing from the body is interpolated.
  app.post<{ Params: { name: string }; Body: { params?: Record<string, unknown> } }>(
    '/:name/execute',
    async (req, reply) => {
      const { name } = req.params
      if (!NAME_RE.test(name)) return reply.code(400).send({ error: 'Invalid procedure name' })
      const catalog = await procParams(name)
      if (catalog.length === 0) {
        const exists = (await db.raw(
          'SELECT 1 AS x FROM sys.procedures WHERE name = ? AND is_ms_shipped = 0',
          [name]
        )) as unknown[]
        if (!exists.length) return reply.code(404).send({ error: 'Procedure not found' })
      }
      const supplied = req.body?.params ?? {}
      const known = new Map(catalog.map((p) => [p.name.replace(/^@/, '').toLowerCase(), p]))
      const parts: string[] = []
      const bindings: unknown[] = []
      for (const [rawKey, value] of Object.entries(supplied)) {
        const p = known.get(rawKey.replace(/^@/, '').toLowerCase())
        if (!p) return reply.code(400).send({ error: `Unknown parameter: ${rawKey}` })
        if (value === null || value === undefined || value === '') continue
        parts.push(`${p.name} = ?`)
        bindings.push(value)
      }
      void import('../services/db-tuning/param-sets.js').then(
        ({ effectiveParams, recordParamSet }) =>
          recordParamSet('proc', name, effectiveParams(supplied as Record<string, unknown>))
      )
      const started = Date.now()
      try {
        // execCustomQuerySql = the custom-queries executor: :param
        // substitution with escaping, 120s per-request timeout (heavy report
        // procs outlive tedious's 15s connection default), row collection.
        const { execCustomQuerySql } = await import('../services/custom-query-exec.js')
        const finalParams: Record<string, unknown> = {}
        parts.length = 0
        bindings.forEach((v, i) => {
          finalParams[`p${i}`] = v
        })
        let i = 0
        for (const [rawKey, value] of Object.entries(supplied)) {
          const p = known.get(rawKey.replace(/^@/, '').toLowerCase())
          if (!p || value === null || value === undefined || value === '') continue
          parts.push(`${p.name} = :p${i}`)
          i++
        }
        const sql = `EXEC [${name}]${parts.length ? ` ${parts.join(', ')}` : ''}`
        const rows = await execCustomQuerySql(sql, finalParams)
        await logActivity({
          action: 'procedure-exec',
          user: req.user?.id,
          collection: 'sys.procedures',
          item: name,
          comment: `${rows.length} rows · ${Date.now() - started}ms`,
          req
        })
        return reply.send({
          data: {
            rows: rows.slice(0, 1000),
            row_count: rows.length,
            truncated: rows.length > 1000,
            duration_ms: Date.now() - started
          }
        })
      } catch (e) {
        const errs = (e as { errors?: Array<{ message?: string }> })?.errors ?? [e as Error]
        return reply.code(400).send({
          error:
            errs
              .map((x) => x?.message)
              .filter(Boolean)
              .join(' | ') || 'Execution failed'
        })
      }
    }
  )
}

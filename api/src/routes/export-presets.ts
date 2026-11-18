import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { csvFormulaSafe } from '../lib/csv-formula.js'
import { authenticate } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import {
  assertExportDiskRoom,
  ColumnWidths,
  ExportAborted,
  ExportBudget,
  ExportTextWriter,
  exportErrorAnswer,
  NdjsonSpool,
  sendExportFile,
  type XlsxCell,
  XlsxStreamWriter
} from '../services/export-files.js'
import type { ExportJob } from '../services/export-handoff.js'
import type { ExportPrincipal } from '../services/export-kinds.js'
import { type ExportLimitKey, exportLimit, readExportLimit } from '../services/export-limits.js'
import { ExportPager, keysetEligible } from '../services/export-paging.js'
import {
  backgroundRefusal,
  decideBackground,
  type ExportContext,
  type ExportFile,
  ExportRunError,
  exportMayHandOff,
  noteExportDuration,
  parseBackgroundMode,
  startExportRun
} from '../services/export-runs.js'
import { LIST_READ_MAX, readItems } from '../services/items.js'
import { can } from '../services/permissions.js'
import { clientGoneSignal, withReadGate } from '../services/read-gate.js'
import { compileAccessGates, visibleIds } from '../services/record-access.js'
import type { CMSRelation } from '../types.js'

/**
 * Export presets (#85): named export configurations per collection — which
 * columns, which labels, xlsx or csv — shared or personal. Running one
 * exports SERVER-side through readItems (RBAC/RLS/scopes bind exactly like
 * the browser) with the caller's current filter conditions riding along, so
 * "the Friday finance export" is one click instead of re-picking columns.
 */

interface PresetConfig {
  columns: Array<{ key: string; label?: string }>
  format: 'xlsx' | 'csv'
}

function parseConfig(raw: unknown): PresetConfig | null {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!parsed || typeof parsed !== 'object') return null
    const cfg = parsed as PresetConfig
    if (!Array.isArray(cfg.columns) || cfg.columns.length === 0) return null
    return {
      columns: cfg.columns
        .filter((c) => c && typeof c.key === 'string')
        .map((c) => ({ key: c.key, label: c.label })),
      format: cfg.format === 'csv' ? 'csv' : 'xlsx'
    }
  } catch {
    return null
  }
}

/** Base row ids whose `firstHop` related record the user can see. */
async function visibleRelated(
  user: import('../types.js').User,
  isAdmin: boolean,
  collection: string,
  ids: string[],
  firstHop: { field: string; collection: string }
): Promise<Set<string>> {
  const { selectInChunks } = await import('../services/db-batch.js')
  const links = (await selectInChunks(ids, 2000, (chunk) =>
    db(collection).whereIn('id', chunk).select('id', firstHop.field)
  )) as Array<Record<string, unknown>>
  const targets = [
    ...new Set(
      links
        .map((r) => r[firstHop.field])
        .filter((v) => v != null)
        .map(String)
    )
  ]
  const gates = await compileAccessGates(user, firstHop.collection, { actingAdmin: isAdmin })
  const seen = new Set<string>()
  for (const id of await visibleIds(gates, targets)) seen.add(id.toLowerCase())
  return new Set(
    links
      .filter((r) => r[firstHop.field] != null && seen.has(String(r[firstHop.field]).toLowerCase()))
      .map((r) => String(r.id))
  )
}

export interface PresetExportResult extends ExportFile {
  truncated: boolean
  collection: string
  name: string
}
interface PresetExportError {
  code: 404 | 403 | 500
  error: string
}

/** The preset row as the runner may use it, or why not. */
interface PresetRow {
  collection: string
  name: string
  config: string
  is_shared: boolean | number
  created_by: string | null
}

async function loadPreset(
  user: import('../types.js').User,
  isAdmin: boolean,
  presetId: string
): Promise<PresetExportError | { preset: PresetRow; config: PresetConfig }> {
  const preset = (await db('nivaro_export_presets').where('id', presetId).first()) as
    | {
        collection: string
        name: string
        config: string
        is_shared: boolean | number
        created_by: string | null
      }
    | undefined
  if (!preset) return { code: 404 as const, error: 'Not found' }
  if (!preset.is_shared && preset.created_by !== user.id && !isAdmin) {
    return { code: 403 as const, error: 'Forbidden' }
  }
  const config = parseConfig(preset.config)
  if (!config) return { code: 500 as const, error: 'Preset config is unreadable' }
  return { preset, config }
}

/** The filters a run carries: the list's `conditions`, `search` and `sort`. */
export interface PresetRunFilters {
  conditions?: string
  search?: string
  sort?: string
}

/** A stable page order: the asked sort, then `id` (never named twice — error 169). */
function pagingSort(sort: string | undefined): string[] {
  const parts = (sort ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
  if (!parts.some((p) => p.replace(/^-/, '').toLowerCase() === 'id')) parts.push('id')
  return parts
}

/**
 * How many rows a run of this preset would export (the background decision), as the runner.
 * `rows` is null when the count is not known (it timed out).
 */
export async function countPresetRows(
  user: import('../types.js').User,
  isAdmin: boolean,
  presetId: string,
  f: PresetRunFilters,
  workspaceId?: string
): Promise<{ rows: number | null; name: string; collection: string } | PresetExportError> {
  const loaded = await loadPreset(user, isAdmin, presetId)
  if ('error' in loaded) return loaded
  const res = await readItems(
    user,
    loaded.preset.collection,
    { fields: ['id'], limit: 1, ...(f.search ? { search: f.search } : {}) },
    (f.conditions ? { query: { conditions: f.conditions } } : undefined) as never,
    workspaceId
  )
  const total = (res as { total?: number | null }).total
  return {
    rows: typeof total === 'number' ? total : null,
    name: loaded.preset.name,
    collection: loaded.preset.collection
  }
}

/** One preset column value as the file holds it. */
function presetCell(r: Record<string, unknown>, key: string): string | number | boolean {
  const v = r[key]
  if (v == null) return ''
  if (typeof v === 'bigint') return v.toString()
  return typeof v === 'object' ? JSON.stringify(v) : (v as string | number | boolean)
}

/** A child sheet's cell (#180). */
function childCell(v: unknown): string | number | boolean {
  if (v == null) return ''
  if (typeof v === 'bigint') return v.toString()
  return typeof v === 'object' ? JSON.stringify(v) : (v as string | number | boolean)
}

/** Child rows one hierarchical export sheet holds (#180). */
const CHILD_ROWS_MAX = 1000

/**
 * The whole export build — the synchronous GET /:id/run AND the background job (#453, #2122)
 * run exactly this. Rows are read page by page as the runner (one read serves at most
 * LIST_READ_MAX rows — this used to ask once for 10,000 and silently export 1,000), up to
 * the preset_rows export limit (services/export-limits.ts). `ctx` reports rows done / total and
 * stops between pages on Cancel.
 *
 * Streamed (services/export-files.ts): each page is resolved (dotted relation columns per page)
 * and written to a temp file, never held. A CSV is written as it goes; an XLSX goes through a
 * spool first because its auto-fit column widths (#161) need every cell, then into a streamed
 * workbook (`Export`, continuing on `Export 2`, … past Excel's row limit). The caller removes
 * the returned file.
 */
export async function buildPresetExport(
  user: import('../types.js').User,
  isAdmin: boolean,
  presetId: string,
  f: PresetRunFilters,
  reqLike: unknown,
  workspaceId?: string,
  ctx?: ExportContext,
  opts: {
    /** `request_rows` for an answer made in the request (default), `preset_rows` in the
     *  background. */
    limitKey?: ExportLimitKey
    /** Aborted when the caller of a synchronous run leaves: stop between pages. */
    signal?: AbortSignal
  } = {}
): Promise<PresetExportResult | PresetExportError> {
  const loaded = await loadPreset(user, isAdmin, presetId)
  if ('error' in loaded) return loaded
  const { preset, config } = loaded
  await assertExportDiskRoom()
  // Rows one preset run holds; past it the answer says so (header / tray outcome).
  const maxRows = await readExportLimit(opts.limitKey ?? 'request_rows')
  const stopIfGone = async () => {
    if (opts.signal?.aborted) throw new ExportAborted()
    await ctx?.throwIfCancelled()
  }
  // Each page (its read and its dotted columns) takes a heavy-read slot like any other read.
  // Cancel (or the caller leaving) reaches a read still queued for its slot.
  const gate = <T>(fn: () => Promise<T>) =>
    withReadGate(String(user.id), fn, {
      label: `export-preset:${presetId}`,
      signal: opts.signal ?? ctx?.signal
    })

  const plain = config.columns.filter((c) => !c.key.includes('.')).map((c) => c.key)
  const dotted = config.columns.filter((c) => c.key.includes('.')).map((c) => c.key)
  const header = config.columns.map((c) => c.label ?? c.key)

  // Dotted relation columns resolve the same way the browser's related
  // columns do — batched per path over each page's ids.
  // Each path is judged as the runner, hop by hop (readable collections,
  // allowed fields, never a credential), and a leading M2O keeps only the
  // related rows the runner can see — a parent outside their scope exports
  // blank, as the browser shows it.
  const relationsCache = new Map<string, CMSRelation[]>()
  const pathHops = new Map<
    string,
    { readable: boolean; firstHop?: { field: string; collection: string } | null } | null
  >()
  const queues = dotted.length > 0 ? await import('../services/queues.js') : null
  const dottedFor = async (ids: string[]): Promise<Map<string, Map<string, string>>> => {
    const values = new Map<string, Map<string, string>>()
    if (!queues || ids.length === 0) return values
    await Promise.all(
      dotted.map(async (path) => {
        try {
          const segments = path.split('.')
          let hops = pathHops.get(path)
          if (hops === undefined) {
            hops = await queues
              .pathReadableBy(user, preset.collection, segments, relationsCache)
              .catch(() => null)
            pathHops.set(path, hops)
          }
          if (!hops?.readable) return
          const seen = hops.firstHop
            ? await visibleRelated(user, isAdmin, preset.collection, ids, hops.firstHop)
            : null
          const byRow = await queues.resolvePathValues(
            preset.collection,
            ids,
            segments,
            relationsCache
          )
          const m = new Map<string, string>()
          for (const [rowId, pv] of byRow) if (!seen || seen.has(rowId)) m.set(rowId, pv.value)
          values.set(path, m)
        } catch {
          // broken path exports blank
        }
      })
    )
    return values
  }

  // Hierarchical export (#180): each configured O2M child relation lands on
  // its own sheet, rows scoped to the exported parents (read per page, at most
  // CHILD_ROWS_MAX rows per sheet — the first parents' children first).
  const childRels = ((config as { child_relations?: string[] }).child_relations ?? [])
    .filter((f) => typeof f === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(f))
    .slice(0, 5)
  const kids: Array<{
    rel: { one_field: string; many_collection: string; many_field: string }
    rows: Array<Record<string, unknown>>
    broken: boolean
  }> = []
  if (config.format === 'xlsx' && childRels.length > 0) {
    const rels = (await db('nivaro_relations')
      .where({ one_collection: preset.collection })
      .whereIn('one_field', childRels)
      .whereNull('junction_field')
      .select('one_field', 'many_collection', 'many_field')) as Array<{
      one_field: string
      many_collection: string
      many_field: string
    }>
    for (const rel of rels) {
      // Child rows go through readItems AS THE CALLER — per-collection
      // read permission, RLS row filters and User Scopes all bind, same
      // as the parent rows above. A raw table read here would let a
      // parent-only permission leak the child collection.
      const readable = isAdmin || (await can(user, 'read', rel.many_collection).catch(() => false))
      if (readable) kids.push({ rel, rows: [], broken: false })
    }
  }
  const readKids = async (parentIds: unknown[]) => {
    for (const k of kids) {
      const room = CHILD_ROWS_MAX - k.rows.length
      if (k.broken || room <= 0 || parentIds.length === 0) continue
      try {
        const res = await readItems(user, k.rel.many_collection, {
          filter: { [k.rel.many_field]: { _in: parentIds } },
          limit: room
        })
        k.rows.push(...((res.data ?? []) as Array<Record<string, unknown>>).slice(0, room))
      } catch {
        // a broken child relation drops its sheet, never the export
        k.broken = true
      }
    }
  }

  const csv = config.format === 'csv'
  const esc = (v: unknown) => {
    // A value starting `=`/`+`/`-`/`@` opens as text, never as a formula (Low, 2026-10-27).
    const s = csvFormulaSafe(v)
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  let out: ExportTextWriter | null = null
  let spool: NdjsonSpool | null = null
  // One byte budget for every file of this export (spool + output): max_file_mb in all.
  const budget = new ExportBudget()
  const widths = new ColumnWidths(header)
  let xlsx: XlsxStreamWriter | null = null
  try {
    if (csv) out = await ExportTextWriter.open('.csv', budget)
    else spool = await NdjsonSpool.open(budget)
    // A BOM so Excel reads UTF-8.
    if (out) await out.write(`\ufeff${header.map(esc).join(',')}`)

    // readItems reads `conditions` off req.query itself — the caller's filters apply, on top of
    // RBAC/RLS/scopes as that user. The background job passes a synthetic req carrying the
    // filters captured when it started.
    let rows = 0
    let total: number | null = null
    let truncated = false
    const sort = pagingSort(f.sort)
    // Keyset on id for the default order, OFFSET otherwise (services/export-paging.ts).
    const pager = new ExportPager(sort, ['id'], undefined, await keysetEligible(preset.collection))
    for (let offset = 0; ; offset += LIST_READ_MAX) {
      await stopIfGone()
      if (rows >= maxRows) {
        const next = pager.page(maxRows)
        const more = await gate(() =>
          readItems(
            user,
            preset.collection,
            {
              fields: ['id'],
              limit: 1,
              offset: next.offset,
              ...(next.filter ? { filter: next.filter } : {}),
              sort,
              count: false,
              ...(f.search ? { search: f.search } : {})
            },
            reqLike as never,
            workspaceId
          )
        )
        truncated = (more.data as unknown[]).length > 0
        break
      }
      const asked = Math.min(LIST_READ_MAX, maxRows - rows)
      const next = pager.page(offset)
      const { page, dottedValues } = await gate(async () => {
        const read = await readItems(
          user,
          preset.collection,
          {
            fields: [...new Set(['id', ...plain])],
            limit: asked,
            offset: next.offset,
            ...(next.filter ? { filter: next.filter } : {}),
            sort,
            // The first page counts the whole set (progress); later pages skip the COUNT.
            ...(offset > 0 ? { count: false } : {}),
            ...(f.search ? { search: f.search } : {})
          },
          reqLike as never,
          workspaceId
        )
        const got = read.data as Array<Record<string, unknown>>
        return { page: read, dottedValues: await dottedFor(got.map((r) => String(r.id))) }
      })
      if (offset === 0) {
        const t = (page as { total?: number | null }).total
        total = typeof t === 'number' ? Math.min(t, maxRows) : null
      }
      const data = page.data as Array<Record<string, unknown>>
      pager.saw(data)
      let text = ''
      for (const r of data) {
        const cells = config.columns.map((c) =>
          c.key.includes('.')
            ? (dottedValues.get(c.key)?.get(String(r.id)) ?? '')
            : presetCell(r, c.key)
        )
        if (out) text += `\n${cells.map(esc).join(',')}`
        else {
          widths.see(cells)
          await spool?.write(cells)
        }
      }
      if (out) await out.write(text)
      if (kids.length > 0) await readKids(data.map((r) => r.id).filter((v) => v != null))
      rows += data.length
      ctx?.progress({ done: rows, total, phase: 'Reading rows' })
      if (data.length < asked) break
    }

    await stopIfGone()
    ctx?.progress({ done: rows, total, phase: 'Writing the file' })
    await logActivity({
      action: 'export-preset-run',
      user: user.id,
      collection: preset.collection,
      comment: `"${preset.name}": ${rows} rows (${config.format})${ctx ? ' in the background' : ''}`
    })

    // Export filename templates (#412): {{collection}} / {{preset}} / {{date}}.
    const nameTemplate = (config as { filename_template?: string }).filename_template
    const rawName = nameTemplate
      ? nameTemplate
          .replace(/\{\{\s*collection\s*\}\}/g, preset.collection)
          .replace(/\{\{\s*preset\s*\}\}/g, preset.name)
          .replace(/\{\{\s*date\s*\}\}/g, new Date().toISOString().slice(0, 10))
      : preset.name
    const safeName = rawName.replace(/[^A-Za-z0-9 ._-]/g, '').trim() || 'export'
    const done = {
      rows,
      truncated,
      limit: maxRows,
      collection: preset.collection,
      name: preset.name
    }
    if (out) {
      await out.close()
      return {
        path: out.path,
        filename: `${safeName}.csv`,
        contentType: 'text/csv; charset=utf-8',
        ...done
      }
    }

    // Xlsx auto-fit (#161): column width from the longest cell (capped 60ch).
    xlsx = await XlsxStreamWriter.open({ budget })
    xlsx.sheet('Export', { header, widths: widths.wch() })
    if (spool) {
      await spool.finish()
      let n = 0
      for await (const cells of spool.read<XlsxCell[]>()) {
        await xlsx.row(cells)
        if (++n % 5000 === 0) await stopIfGone()
      }
    }
    for (const k of kids) {
      if (k.broken || k.rows.length === 0) continue
      const kidCols = Object.keys(k.rows[0])
      const kidRows = k.rows.map((kid) => kidCols.map((c) => childCell(kid[c])))
      const kidWidths = new ColumnWidths(kidCols)
      for (const r of kidRows.slice(0, 200)) kidWidths.see(r)
      xlsx.sheet(k.rel.one_field.slice(0, 31), { header: kidCols, widths: kidWidths.wch() })
      for (const r of kidRows) await xlsx.row(r)
    }
    await xlsx.close()
    return {
      path: xlsx.path,
      filename: `${safeName}.xlsx`,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ...done
    }
  } catch (err) {
    await out?.discard()
    await xlsx?.discard()
    throw err
  } finally {
    await spool?.discard()
  }
}

/** A background preset export, rebuilt from its job (services/export-kinds.ts). */
export async function presetExportFromJob(
  job: ExportJob,
  who: ExportPrincipal,
  ctx: ExportContext
): Promise<ExportFile> {
  const filters = ((job.params as { filters?: PresetRunFilters }).filters ?? {}) as PresetRunFilters
  const result = await buildPresetExport(
    who.user,
    who.isAdmin,
    job.subject,
    filters,
    filters.conditions ? { query: { conditions: filters.conditions } } : undefined,
    job.workspace_id ?? undefined,
    ctx,
    // A background run: the background limit (no limit by default).
    { limitKey: 'preset_rows' }
  )
  if ('error' in result) throw new ExportRunError(result.code, result.error)
  return result
}

export async function exportPresetRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate)

  app.get<{ Querystring: { collection?: string } }>('/', async (req) => {
    let q = db('nivaro_export_presets').orderBy('name')
    if (req.query.collection) q = q.where({ collection: req.query.collection })
    const rows = (await q) as Array<{
      id: number
      collection: string
      name: string
      config: string
      is_shared: boolean | number
      created_by: string | null
    }>
    return {
      data: rows
        .filter((r) => r.is_shared || r.created_by === req.user?.id || req.isAdmin)
        .map((r) => ({ ...r, config: parseConfig(r.config) }))
    }
  })

  app.post<{
    Body: { collection?: string; name?: string; config?: unknown; is_shared?: boolean }
  }>('/', async (req, reply) => {
    const collection = String(req.body?.collection ?? '')
    const name = String(req.body?.name ?? '').trim()
    const config = parseConfig(req.body?.config)
    if (!collection || !name || !config) {
      return reply.code(400).send({ error: 'collection, name and a columns config are required' })
    }
    if (!req.isAdmin && !(await can(req.user!, 'read', collection))) {
      return reply.code(403).send({ error: 'Forbidden' })
    }
    const [created] = (await db('nivaro_export_presets')
      .insert({
        collection,
        name: name.slice(0, 200),
        config: JSON.stringify(config),
        // A shared preset lands on everyone's export menu: admins only.
        is_shared: !!req.isAdmin && req.body?.is_shared !== false,
        created_by: req.user?.id ?? null,
        created_at: new Date()
      })
      .returning('id')) as Array<{ id: number } | number>
    await logActivity({
      action: 'export-preset-create',
      user: req.user?.id,
      collection,
      comment: name,
      req
    })
    return reply
      .code(201)
      .send({ data: { id: typeof created === 'object' ? created.id : created } })
  })

  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const row = (await db('nivaro_export_presets').where('id', req.params.id).first()) as
      | { created_by: string | null }
      | undefined
    if (!row) return reply.code(404).send({ error: 'Not found' })
    if (row.created_by !== req.user?.id && !req.isAdmin) {
      return reply.code(403).send({ error: 'Only the creator or an admin can delete a preset' })
    }
    await db('nivaro_export_presets').where('id', req.params.id).del()
    await logActivity({
      action: 'export-preset-delete',
      user: req.user?.id,
      comment: `#${req.params.id}`,
      req
    })
    return { data: { deleted: true } }
  })

  // GET so the browser can navigate/download directly; the caller's live
  // filter state rides as the same `conditions`/`search` params the list uses.
  app.get<{ Params: { id: string } }>('/:id/run', async (req, reply) => {
    const q = req.query as Record<string, string>
    const started = Date.now()
    let result: Awaited<ReturnType<typeof buildPresetExport>>
    try {
      // Answered in the request: the request_rows cap, and it stops when the caller leaves.
      result = await buildPresetExport(
        req.user!,
        !!req.isAdmin,
        req.params.id,
        { conditions: q.conditions, search: q.search, sort: q.sort },
        req,
        req.workspaceId ?? undefined,
        undefined,
        { limitKey: 'request_rows', signal: clientGoneSignal(reply.raw) }
      )
    } catch (err) {
      const known = exportErrorAnswer(err)
      if (known) return reply.code(known.status).send(known.body)
      throw err
    }
    if ('error' in result) return reply.code(result.code).send({ error: result.error })
    noteExportDuration('preset', req.params.id, Date.now() - started, app.redis ?? null)
    if (result.truncated)
      reply.header('x-nivaro-export-truncated', String(result.limit ?? exportLimit('request_rows')))
    // Streamed from the temp file, which is removed once sent (services/export-files.ts).
    return sendExportFile(reply, result)
  })

  // #453 / #2122 — the same build as a background job: progress and Cancel in the Jobs tray,
  // the file saved privately for the runner, "Your export is ready" with the link.
  //   body.background: 'always' (default — the menu's Background button) | 'auto' (the app's
  //   own Export): a small export answers {mode: 'instant'} and the page downloads it directly
  //   through GET /:id/run; a big or usually-slow one starts the job (202).
  app.post<{
    Params: { id: string }
    Body: { conditions?: string; search?: string; sort?: string; background?: string }
  }>('/:id/run-async', async (req, reply) => {
    const user = req.user!
    const isAdmin = !!req.isAdmin
    const presetId = req.params.id
    const filters: PresetRunFilters = {
      ...(req.body?.conditions ? { conditions: String(req.body.conditions) } : {}),
      ...(req.body?.search ? { search: String(req.body.search) } : {}),
      ...(req.body?.sort ? { sort: String(req.body.sort) } : {})
    }
    const workspaceId = req.workspaceId ?? undefined
    const mode = parseBackgroundMode(req.body?.background, 'always')
    const counted = await countPresetRows(user, isAdmin, presetId, filters, workspaceId)
    if ('error' in counted) return reply.code(counted.code).send({ error: counted.error })
    const refusal = backgroundRefusal(req)
    if (refusal) {
      if (mode !== 'always') return { data: { mode: 'instant', rows: counted.rows } }
      return reply.code(403).send({ error: refusal, code: 'BACKGROUND_EXPORT_REFUSED' })
    }
    const background = await decideBackground(mode, {
      rows: counted.rows,
      kind: 'preset',
      subject: presetId,
      redis: app.redis ?? null
    })
    if (!background) return { data: { mode: 'instant', rows: counted.rows } }
    try {
      const started = await startExportRun(app, {
        user,
        isAdmin,
        kind: 'preset',
        subject: presetId,
        label: `“${counted.name}”`,
        total:
          counted.rows == null
            ? null
            : Math.min(counted.rows, await readExportLimit('preset_rows')),
        // The filters captured now: another process makes the same file from them.
        params: { filters },
        workspaceId: workspaceId ?? null,
        // Only a person's own session may run on another process (decision A).
        handOff: exportMayHandOff(req)
      })
      return reply.code(202).send({ data: { mode: 'background', ...started } })
    } catch (err) {
      if (err instanceof ExportRunError)
        return reply.code(err.statusCode).send({ error: err.message, code: err.code })
      throw err
    }
  })
}

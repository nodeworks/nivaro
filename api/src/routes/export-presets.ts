import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { csvFormulaSafe } from '../lib/csv-formula.js'
import { authenticate } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import {
  backgroundRefusal,
  decideBackground,
  type ExportContext,
  ExportRunError,
  noteExportDuration,
  parseBackgroundMode,
  startExportRun
} from '../services/export-runs.js'
import { LIST_READ_MAX, readItems } from '../services/items.js'
import { can } from '../services/permissions.js'
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

/** Rows one preset run holds; past it the answer says so (header / tray outcome). */
export const EXPORT_ROW_CAP = 50_000

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

export interface PresetExportResult {
  buffer: Buffer
  filename: string
  contentType: string
  rows: number
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

/**
 * The whole export build — the synchronous GET /:id/run AND the background job (#453, #2122)
 * run exactly this. Rows are read page by page as the runner (one read serves at most
 * LIST_READ_MAX rows — this used to ask once for 10,000 and silently export 1,000), up to
 * EXPORT_ROW_CAP. `ctx` reports rows done / total and stops between pages on Cancel.
 */
export async function buildPresetExport(
  user: import('../types.js').User,
  isAdmin: boolean,
  presetId: string,
  f: PresetRunFilters,
  reqLike: unknown,
  workspaceId?: string,
  ctx?: ExportContext
): Promise<PresetExportResult | PresetExportError> {
  const loaded = await loadPreset(user, isAdmin, presetId)
  if ('error' in loaded) return loaded
  const { preset, config } = loaded

  const plain = config.columns.filter((c) => !c.key.includes('.')).map((c) => c.key)
  const dotted = config.columns.filter((c) => c.key.includes('.')).map((c) => c.key)

  // readItems reads `conditions` off req.query itself — the caller's filters apply, on top of
  // RBAC/RLS/scopes as that user. The background job passes a synthetic req carrying the
  // filters captured when it started.
  const rows: Array<Record<string, unknown>> = []
  let total: number | null = null
  let truncated = false
  const sort = pagingSort(f.sort)
  for (let offset = 0; ; offset += LIST_READ_MAX) {
    await ctx?.throwIfCancelled()
    if (rows.length >= EXPORT_ROW_CAP) {
      const more = await readItems(
        user,
        preset.collection,
        {
          fields: ['id'],
          limit: 1,
          offset: EXPORT_ROW_CAP,
          sort,
          count: false,
          ...(f.search ? { search: f.search } : {})
        },
        reqLike as never,
        workspaceId
      )
      truncated = (more.data as unknown[]).length > 0
      break
    }
    const asked = Math.min(LIST_READ_MAX, EXPORT_ROW_CAP - rows.length)
    const page = await readItems(
      user,
      preset.collection,
      {
        fields: [...new Set(['id', ...plain])],
        limit: asked,
        offset,
        sort,
        // The first page counts the whole set (progress); later pages skip the COUNT.
        ...(offset > 0 ? { count: false } : {}),
        ...(f.search ? { search: f.search } : {})
      },
      reqLike as never,
      workspaceId
    )
    if (offset === 0) {
      const t = (page as { total?: number | null }).total
      total = typeof t === 'number' ? Math.min(t, EXPORT_ROW_CAP) : null
    }
    const data = page.data as Array<Record<string, unknown>>
    rows.push(...data)
    ctx?.progress({ done: rows.length, total, phase: 'Reading rows' })
    if (data.length < asked) break
  }

  // Dotted relation columns resolve the same way the browser's related
  // columns do — batched per path over the exported ids.
  // Each path is judged as the runner, hop by hop (readable collections,
  // allowed fields, never a credential), and a leading M2O keeps only the
  // related rows the runner can see — a parent outside their scope exports
  // blank, as the browser shows it.
  const dottedValues = new Map<string, Map<string, string>>()
  if (dotted.length > 0 && rows.length > 0) {
    const { pathReadableBy, resolvePathValues } = await import('../services/queues.js')
    const relationsCache = new Map<string, CMSRelation[]>()
    const ids = rows.map((r) => String(r.id))
    await Promise.all(
      dotted.map(async (path) => {
        try {
          const segments = path.split('.')
          const hops = await pathReadableBy(user, preset.collection, segments, relationsCache)
          if (!hops.readable) return
          const seen = hops.firstHop
            ? await visibleRelated(user, isAdmin, preset.collection, ids, hops.firstHop)
            : null
          const byRow = await resolvePathValues(preset.collection, ids, segments, relationsCache)
          const m = new Map<string, string>()
          for (const [rowId, pv] of byRow) if (!seen || seen.has(rowId)) m.set(rowId, pv.value)
          dottedValues.set(path, m)
        } catch {
          // broken path exports blank
        }
      })
    )
  }

  const header = config.columns.map((c) => c.label ?? c.key)
  const dataRows = rows.map((r) =>
    config.columns.map((c) => {
      if (c.key.includes('.')) return dottedValues.get(c.key)?.get(String(r.id)) ?? ''
      const v = r[c.key]
      if (v == null) return ''
      return typeof v === 'object' ? JSON.stringify(v) : v
    })
  )

  await ctx?.throwIfCancelled()
  ctx?.progress({ done: rows.length, total, phase: 'Writing the file' })
  await logActivity({
    action: 'export-preset-run',
    user: user.id,
    collection: preset.collection,
    comment: `"${preset.name}": ${rows.length} rows (${config.format})${ctx ? ' in the background' : ''}`
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
  const done = { rows: rows.length, truncated, collection: preset.collection, name: preset.name }
  if (config.format === 'csv') {
    const esc = (v: unknown) => {
      // A value starting `=`/`+`/`-`/`@` opens as text, never as a formula (Low, 2026-10-27).
      const s = csvFormulaSafe(v)
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    const csv = [header, ...dataRows].map((row) => row.map(esc).join(',')).join('\n')
    return {
      buffer: Buffer.from(`﻿${csv}`, 'utf8'),
      filename: `${safeName}.csv`,
      contentType: 'text/csv; charset=utf-8',
      ...done
    }
  }
  const XLSX = await import('xlsx')
  const ws = XLSX.utils.aoa_to_sheet([header, ...dataRows])
  // Xlsx auto-fit (#161): column width from the longest cell (capped 60ch).
  ws['!cols'] = header.map((h, ci) => ({
    wch: Math.min(
      60,
      Math.max(String(h).length, ...dataRows.map((r) => String(r[ci] ?? '').length)) + 2
    )
  }))
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Export')
  // Hierarchical export (#180): each configured O2M child relation lands on
  // its own sheet, rows scoped to the exported parents.
  const childRels = ((config as { child_relations?: string[] }).child_relations ?? [])
    .filter((f) => typeof f === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(f))
    .slice(0, 5)
  if (childRels.length > 0 && rows.length > 0) {
    const { db } = await import('../db/index.js')
    const rels = (await db('nivaro_relations')
      .where({ one_collection: preset.collection })
      .whereIn('one_field', childRels)
      .whereNull('junction_field')
      .select('one_field', 'many_collection', 'many_field')) as Array<{
      one_field: string
      many_collection: string
      many_field: string
    }>
    const parentIds = rows.map((r) => r.id).filter((v) => v != null)
    const { can } = await import('../services/permissions.js')
    for (const rel of rels) {
      try {
        // Child rows go through readItems AS THE CALLER — per-collection
        // read permission, RLS row filters and User Scopes all bind, same
        // as the parent rows above. A raw table read here would let a
        // parent-only permission leak the child collection.
        if (!isAdmin && !(await can(user, 'read', rel.many_collection))) continue
        const kidsRes = await readItems(user, rel.many_collection, {
          filter: { [rel.many_field]: { _in: parentIds } },
          limit: 1000
        })
        const kids = (kidsRes.data ?? []) as Array<Record<string, unknown>>
        if (kids.length === 0) continue
        const kidCols = Object.keys(kids[0])
        const kidRows = kids.map((k) =>
          kidCols.map((c) => {
            const v = k[c]
            return v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : v
          })
        )
        const kws = XLSX.utils.aoa_to_sheet([kidCols, ...kidRows])
        kws['!cols'] = kidCols.map((h, ci) => ({
          wch: Math.min(
            60,
            Math.max(h.length, ...kidRows.slice(0, 200).map((r) => String(r[ci] ?? '').length)) + 2
          )
        }))
        XLSX.utils.book_append_sheet(wb, kws, rel.one_field.slice(0, 31))
      } catch {
        // a broken child relation drops its sheet, never the export
      }
    }
  }
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
  return {
    buffer: buf,
    filename: `${safeName}.xlsx`,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ...done
  }
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
    const result = await buildPresetExport(
      req.user!,
      !!req.isAdmin,
      req.params.id,
      { conditions: q.conditions, search: q.search, sort: q.sort },
      req,
      req.workspaceId ?? undefined
    )
    if ('error' in result) return reply.code(result.code).send({ error: result.error })
    noteExportDuration('preset', req.params.id, Date.now() - started, app.redis ?? null)
    if (result.truncated) reply.header('x-nivaro-export-truncated', String(EXPORT_ROW_CAP))
    return reply
      .header('Content-Type', result.contentType)
      .header('Content-Disposition', `attachment; filename="${result.filename}"`)
      .send(result.buffer)
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
        kind: 'preset',
        subject: presetId,
        label: `“${counted.name}”`,
        total: counted.rows == null ? null : Math.min(counted.rows, EXPORT_ROW_CAP),
        build: async (ctx) => {
          const result = await buildPresetExport(
            user,
            isAdmin,
            presetId,
            filters,
            filters.conditions ? { query: { conditions: filters.conditions } } : undefined,
            workspaceId,
            ctx
          )
          if ('error' in result) throw new Error(result.error)
          return result
        }
      })
      return reply.code(202).send({ data: { mode: 'background', ...started } })
    } catch (err) {
      if (err instanceof ExportRunError)
        return reply.code(err.statusCode).send({ error: err.message, code: err.code })
      throw err
    }
  })
}

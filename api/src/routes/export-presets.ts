import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { authenticate } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { readItems } from '../services/items.js'
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

const EXPORT_ROW_CAP = 10_000

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
    const [created] = (await db('nivaro_export_presets')
      .insert({
        collection,
        name: name.slice(0, 200),
        config: JSON.stringify(config),
        is_shared: req.body?.is_shared !== false,
        created_by: req.user?.id ?? null,
        created_at: new Date()
      })
      .returning('id')) as Array<{ id: number } | number>
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
    return { data: { deleted: true } }
  })

  // GET so the browser can navigate/download directly; the caller's live
  // filter state rides as the same `conditions`/`search` params the list uses.
  app.get<{ Params: { id: string } }>('/:id/run', async (req, reply) => {
    const preset = (await db('nivaro_export_presets').where('id', req.params.id).first()) as
      | { collection: string; name: string; config: string; is_shared: boolean | number; created_by: string | null }
      | undefined
    if (!preset) return reply.code(404).send({ error: 'Not found' })
    if (!preset.is_shared && preset.created_by !== req.user?.id && !req.isAdmin) {
      return reply.code(403).send({ error: 'Forbidden' })
    }
    const config = parseConfig(preset.config)
    if (!config) return reply.code(500).send({ error: 'Preset config is unreadable' })

    const q = req.query as Record<string, string>
    const plain = config.columns.filter((c) => !c.key.includes('.')).map((c) => c.key)
    const dotted = config.columns.filter((c) => c.key.includes('.')).map((c) => c.key)

    // readItems reads `conditions` off req.query itself — pass req through so
    // the caller's filters apply, on top of RBAC/RLS/scopes as that user.
    const result = await readItems(
      req.user!,
      preset.collection,
      {
        fields: ['id', ...plain],
        limit: EXPORT_ROW_CAP,
        ...(q.search ? { search: q.search } : {}),
        ...(q.sort ? { sort: q.sort.split(',') } : {})
      },
      req,
      req.workspaceId ?? undefined
    )
    const rows = result.data as Array<Record<string, unknown>>

    // Dotted relation columns resolve the same way the browser's related
    // columns do — batched per path over the exported ids.
    const dottedValues = new Map<string, Map<string, string>>()
    if (dotted.length > 0 && rows.length > 0) {
      const { resolvePathValues } = await import('../services/queues.js')
      const relationsCache = new Map<string, CMSRelation[]>()
      const ids = rows.map((r) => String(r.id))
      await Promise.all(
        dotted.map(async (path) => {
          try {
            const byRow = await resolvePathValues(
              preset.collection,
              ids,
              path.split('.'),
              relationsCache
            )
            const m = new Map<string, string>()
            for (const [rowId, pv] of byRow) m.set(rowId, pv.value)
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

    await logActivity({
      action: 'export-preset-run',
      user: req.user?.id,
      collection: preset.collection,
      comment: `"${preset.name}": ${rows.length} rows (${config.format})`,
      req
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
    if (config.format === 'csv') {
      const esc = (v: unknown) => {
        const s = String(v ?? '')
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
      }
      const csv = [header, ...dataRows].map((row) => row.map(esc).join(',')).join('\n')
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="${safeName}.csv"`)
        .send(`﻿${csv}`)
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
      for (const rel of rels) {
        try {
          const kids = (await db(rel.many_collection)
            .whereIn(rel.many_field, parentIds as string[])
            .limit(20000)) as Array<Record<string, unknown>>
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
            wch: Math.min(60, Math.max(h.length, ...kidRows.slice(0, 200).map((r) => String(r[ci] ?? '').length)) + 2)
          }))
          XLSX.utils.book_append_sheet(wb, kws, rel.one_field.slice(0, 31))
        } catch {
          // a broken child relation drops its sheet, never the export
        }
      }
    }
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
    return reply
      .header(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      )
      .header('Content-Disposition', `attachment; filename="${safeName}.xlsx"`)
      .send(buf)
  })
}

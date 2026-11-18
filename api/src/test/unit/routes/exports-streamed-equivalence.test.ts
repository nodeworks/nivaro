import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as XLSX from 'xlsx'
import { csvFormulaSafe } from '../../../lib/csv-formula.js'
import { setStoredExportLimitsForTests } from '../../../services/export-limits.js'

// Streaming exports (2026-11-18): the files built page by page on disk are the files the
// in-memory builds made — same columns, order, labels and formatting. The references below are
// the in-memory builders as they were before streaming.

const st = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  preset: null as Record<string, unknown> | null,
  kids: [] as Array<Record<string, unknown>>,
  kidReads: [] as Array<{ filter: unknown; limit: unknown }>
}))

vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: 'U1', role: 'R1' }
    req.isAdmin = true
  },
  requireAuth: async () => {}
}))
vi.mock('../../../middleware/workspace.js', () => ({ resolveWorkspace: async () => {} }))
vi.mock('../../../services/idempotency.js', () => ({
  idempotencyPreHandler: () => async () => {}
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))
vi.mock('../../../services/permissions.js', () => ({
  can: vi.fn(async () => true),
  getAllowedFields: vi.fn(async () => ['*'])
}))
vi.mock('../../../services/help-video-files.js', () => ({ isFilesCollection: () => false }))
vi.mock('../../../services/items.js', async (orig) => {
  class ForbiddenError extends Error {}
  class CollectionNotFoundError extends Error {}
  return {
    ...(await orig<object>()),
    ForbiddenError,
    CollectionNotFoundError,
    LIST_READ_MAX: 1000,
    getActualColumns: vi.fn(async () => new Set(['id', 'name'])),
    readItems: vi.fn(
      async (
        _u: unknown,
        c: string,
        q: { limit?: number; offset?: number; fields?: string[]; filter?: unknown }
      ) => {
        if (c === 'kids') {
          st.kidReads.push({ filter: q.filter, limit: q.limit })
          const parents = (q.filter as { parent: { _in: unknown[] } }).parent._in
          return {
            data: st.kids.filter((k) => parents.includes(k.parent)).slice(0, q.limit ?? 1000)
          }
        }
        const from = q.offset ?? 0
        const page = st.rows.slice(from, from + Math.min(q.limit ?? 25, 1000))
        const fields = q.fields ?? ['*']
        return {
          data: fields.includes('*')
            ? page
            : // A field the caller may not read (or the row lacks) is not in the answer.
              page.map((r) =>
                Object.fromEntries(fields.filter((f) => f in r).map((f) => [f, r[f]]))
              ),
          total: st.rows.length
        }
      }
    )
  }
})
vi.mock('../../../db/index.js', () => ({
  db: vi.fn((t: string) => {
    const c: Record<string, any> = {}
    for (const m of ['where', 'orderBy', 'whereIn', 'whereNull']) c[m] = vi.fn(() => c)
    c.first = vi.fn(async () =>
      t === 'nivaro_export_presets'
        ? st.preset
        : t === 'nivaro_collections'
          ? { collection: 'x' }
          : undefined
    )
    c.select = vi.fn(async () =>
      t === 'nivaro_relations'
        ? [{ one_field: 'children', many_collection: 'kids', many_field: 'parent' }]
        : []
    )
    return c
  })
}))

import { contentExportRoutes } from '../../../routes/content-export.js'
import { exportPresetRoutes } from '../../../routes/export-presets.js'
import { itemsRoutes } from '../../../routes/items.js'

// ── The in-memory builders as they were ──────────────────────────────────────

function oldItemsCsv(rows: Record<string, unknown>[], fields: string[]): string {
  const escapeCsv = (v: unknown): string => {
    if (v == null) return ''
    const s = csvFormulaSafe(v)
    if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
      return `"${s.replace(/"/g, '""')}"`
    }
    return s
  }
  const header = fields.map(escapeCsv).join(',')
  const lines = rows.map((r) => fields.map((f) => escapeCsv(r[f])).join(','))
  return [header, ...lines].join('\r\n')
}
const unionKeys = (rows: Record<string, unknown>[]) => {
  const keys = new Set<string>()
  for (const r of rows) for (const k of Object.keys(r)) keys.add(k)
  return [...keys]
}

// Rows whose key set grows past the first page (a later page adds `extra`), with values the
// CSV must quote or neutralise, a Date, an object, null and a negative number.
function makeRows(n: number): Array<Record<string, unknown>> {
  return Array.from({ length: n }, (_, i) => {
    const r: Record<string, unknown> = {
      id: i + 1,
      name:
        i % 7 === 0 ? `=HYPERLINK("x",${i})` : i % 5 === 0 ? 'a "quoted", line\nbreak' : `Row ${i}`,
      amount: i % 3 === 0 ? -12.5 : i,
      when: new Date(Date.UTC(2026, 0, 1 + (i % 28))),
      meta: i % 11 === 0 ? { k: i } : null
    }
    if (i >= 1500) r.extra = `late ${i}`
    return r
  })
}

let work: string
beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'nvr-export-eq-'))
  process.env.EXPORT_WORK_DIR = work
  setStoredExportLimitsForTests({})
  st.rows = makeRows(2300)
  st.kids = []
  st.kidReads = []
})
afterEach(() => {
  delete process.env.EXPORT_WORK_DIR
})

async function noTempLeft() {
  for (let i = 0; i < 50 && (await readdir(work)).length > 0; i++)
    await new Promise((r) => setTimeout(r, 5))
  expect(await readdir(work)).toEqual([])
}

describe('GET /items/:collection/export — streamed', () => {
  async function get(url: string) {
    const app = Fastify()
    await app.register(itemsRoutes, { prefix: '/api/items' })
    const res = await app.inject({ url })
    await app.close()
    return res
  }

  it('CSV without fields: every row, columns = the union of all rows’ keys in first-seen order', async () => {
    const res = await get('/api/items/articles/export')
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe(oldItemsCsv(st.rows, unionKeys(st.rows)))
    expect(res.body.split('\r\n')[0]).toBe('id,name,amount,when,meta,extra')
    await noTempLeft()
  })

  it('CSV with fields and JSON match the in-memory build byte for byte', async () => {
    const csv = await get('/api/items/articles/export?fields=name,id,amount')
    expect(csv.body).toBe(oldItemsCsv(st.rows, ['name', 'id', 'amount']))
    const json = await get('/api/items/articles/export?format=json')
    expect(json.body).toBe(JSON.stringify({ data: st.rows }))
    expect(json.headers['content-type']).toContain('application/json')
    await noTempLeft()
  })

  it('an empty result is the header alone (fields) or an empty file (no fields)', async () => {
    st.rows = []
    expect((await get('/api/items/articles/export?fields=id,name')).body).toBe('id,name')
    expect((await get('/api/items/articles/export')).body).toBe('')
    expect((await get('/api/items/articles/export?format=json')).body).toBe('{"data":[]}')
  })
})

describe('POST /content-export/:collection — streamed', () => {
  async function post(payload: Record<string, unknown>) {
    const app = Fastify()
    await app.register(contentExportRoutes, { prefix: '/api/content-export' })
    const res = await app.inject({ method: 'POST', url: '/api/content-export/staff', payload })
    await app.close()
    return res
  }

  it('JSON is { data: rows }, xlsx keeps its JSON-with-note answer', async () => {
    expect((await post({ format: 'json' })).body).toBe(JSON.stringify({ data: st.rows }))
    expect((await post({ format: 'xlsx' })).body).toBe(
      JSON.stringify({
        data: st.rows,
        _note: 'XLSX export requires exceljs; JSON returned instead'
      })
    )
  })

  it('CSV: requested fields the reads returned, else the union of keys', async () => {
    expect((await post({ format: 'csv' })).body).toBe(oldItemsCsv(st.rows, unionKeys(st.rows)))
    const picked = await post({ format: 'csv', fields: ['extra', 'id', 'hidden'] })
    expect(picked.body).toBe(oldItemsCsv(st.rows, ['extra', 'id']))
    await noTempLeft()
  })
})

describe('GET /export-presets/:id/run — streamed', () => {
  async function run() {
    const app = Fastify()
    await app.register(exportPresetRoutes, { prefix: '/export-presets' })
    const res = await app.inject({ url: '/export-presets/5/run' })
    await app.close()
    return res
  }
  const columns = [
    { key: 'id' },
    { key: 'name', label: 'Name' },
    { key: 'amount' },
    { key: 'meta' }
  ]

  it('CSV matches the in-memory build (BOM, \\n lines, labels, formula guard)', async () => {
    st.preset = {
      collection: 'articles',
      name: 'Probe',
      is_shared: 1,
      created_by: 'U1',
      config: JSON.stringify({ format: 'csv', columns })
    }
    const res = await run()
    const esc = (v: unknown) => {
      const s = csvFormulaSafe(v)
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    const cell = (v: unknown) => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : v)
    const header = ['id', 'Name', 'amount', 'meta']
    const data = st.rows.map((r) => columns.map((c) => cell(r[c.key])))
    const expected = `﻿${[header, ...data].map((row) => row.map(esc).join(',')).join('\n')}`
    expect(res.body).toBe(expected)
    await noTempLeft()
  })

  it('XLSX holds the cells and widths the sheetjs build did', async () => {
    st.preset = {
      collection: 'articles',
      name: 'Probe',
      is_shared: 1,
      created_by: 'U1',
      config: JSON.stringify({ format: 'xlsx', columns, child_relations: ['children'] })
    }
    st.kids = [
      { id: 1, parent: 1, note: 'first' },
      { id: 2, parent: 2, note: null }
    ]
    const res = await run()
    expect(res.statusCode).toBe(200)
    const wb = XLSX.read(res.rawPayload, { cellStyles: true })
    // parseConfig keeps columns + format only, so `child_relations` (#180) never reaches the
    // builder — the in-memory build wrote no child sheet either.
    expect(wb.SheetNames).toEqual(['Export'])

    // The old build: aoa_to_sheet over every row, auto-fit widths, one child sheet.
    const cell = (v: unknown) => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : v)
    const header = ['id', 'Name', 'amount', 'meta']
    const data = st.rows.map((r) => columns.map((c) => cell(r[c.key])))
    const old = XLSX.utils.aoa_to_sheet([header, ...data])
    const asRows = (ws: XLSX.WorkSheet) => XLSX.utils.sheet_to_json(ws, { header: 1, raw: true })
    expect(asRows(wb.Sheets.Export)).toEqual(asRows(old))
    const wch = header.map((h, ci) =>
      Math.min(60, data.reduce((m, r) => Math.max(m, String(r[ci] ?? '').length), h.length) + 2)
    )
    const cols = wb.Sheets.Export['!cols'] as Array<{ width: number }>
    expect(cols.map((c) => c.width)).toEqual(wch.map((w) => w + 0.83203125))
    expect(st.kidReads).toHaveLength(0)
    await noTempLeft()
  })
})

import { mkdtemp, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setStoredExportLimitsForTests } from '../../../services/export-limits.js'

// Memory evidence for streaming exports (2026-11-18): build big exports through the real
// builders (rows generated page by page, never held by the test) and sample the heap after a GC
// at every page read. The heap stays flat however many rows go out; the in-memory build it
// replaced held every row. Run on purpose (slow):
//   EXPORT_MEMORY_PROBE=250000 EXPORT_MEMORY_PROBE_OUT=/tmp/probe.json NODE_OPTIONS=--expose-gc \
//     npx vitest run src/test/unit/routes/export-memory.probe.test.ts

const ROWS = Number(process.env.EXPORT_MEMORY_PROBE ?? 0)
const probe = ROWS > 0 ? describe : describe.skip

const st = vi.hoisted(() => ({ total: 0, samples: [] as number[] }))
const gc = (globalThis as { gc?: () => void }).gc
function sample() {
  gc?.()
  st.samples.push(process.memoryUsage().heapUsed)
}
function row(i: number): Record<string, unknown> {
  return {
    id: i + 1,
    code: `UNIT-${String(i).padStart(7, '0')}`,
    name: `Unit ${i} — building ${i % 97}, floor ${i % 12}`,
    status: i % 3 === 0 ? 'closed' : 'open',
    region: i % 2 === 0 ? 'east' : 'west',
    amount: (i * 13.37) % 100000,
    created_on: new Date(Date.UTC(2026, 0, 1 + (i % 300))).toISOString(),
    notes: i % 5 === 0 ? 'has, a comma and "quotes"' : null,
    owner: `user-${i % 500}@example.test`,
    active: i % 4 !== 0
  }
}

vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))
vi.mock('../../../services/permissions.js', () => ({
  can: vi.fn(async () => true),
  getAllowedFields: vi.fn(async () => ['*'])
}))
vi.mock('../../../services/items.js', async (orig) => ({
  ...(await orig<object>()),
  LIST_READ_MAX: 1000,
  getActualColumns: vi.fn(async () => new Set(['id'])),
  // A plain function, not vi.fn: a mock keeps every result it returned (every page).
  readItems: async (
    _u: unknown,
    _c: string,
    q: { limit?: number; offset?: number; filter?: { id?: { _gt?: number } } }
  ) => {
    // Keyset (`id > last`, ids are 1-based positions) or OFFSET.
    const from = (q.filter?.id?._gt ?? 0) + (q.offset ?? 0)
    if (from % 10_000 === 0) sample()
    const n = Math.max(0, Math.min(q.limit ?? 25, 1000, st.total - from))
    return { data: Array.from({ length: n }, (_, i) => row(from + i)), total: st.total }
  }
}))
vi.mock('../../../db/index.js', () => ({
  db: vi.fn(() => {
    const c: Record<string, any> = {}
    for (const m of ['where', 'orderBy']) c[m] = vi.fn(() => c)
    c.first = vi.fn(async () => ({
      collection: 'units',
      name: 'All units',
      is_shared: 1,
      created_by: 'U1',
      config: JSON.stringify({
        format: 'xlsx',
        columns: Object.keys(row(0)).map((key) => ({ key }))
      })
    }))
    return c
  })
}))

import { buildPresetExport } from '../../../routes/export-presets.js'
import { buildItemsExport } from '../../../routes/items.js'
import { removeExportTemp } from '../../../services/export-files.js'

const MB = (b: number) => Math.round((b / 1024 / 1024) * 10) / 10

beforeEach(async () => {
  process.env.EXPORT_WORK_DIR = await mkdtemp(join(tmpdir(), 'nvr-export-mem-'))
  setStoredExportLimitsForTests({})
  st.total = ROWS
  st.samples = []
})

probe('export memory stays flat', () => {
  it(
    'items CSV (no fields: the spool path) and a preset XLSX',
    async () => {
      const user = { id: 'U1' } as never
      // Also every 250 ms, after a GC (catches the XLSX pass that reads the spool back).
      let rawPeak = 0
      const ticker = setInterval(() => {
        gc?.()
        rawPeak = Math.max(rawPeak, process.memoryUsage().heapUsed)
      }, 250)
      sample()
      const base = st.samples[0]
      // Background limits (no limit by default): the probe exports every row.
      const csv = await buildItemsExport(user, 'units', {}, undefined, undefined, undefined, {
        limitKey: 'file_rows'
      })
      const csvPeak = Math.max(...st.samples) - base
      const csvBytes = (await stat(csv.path)).size
      await removeExportTemp(csv.path)

      st.samples = []
      sample()
      const base2 = st.samples[0]
      const xlsx = await buildPresetExport(user, true, '1', {}, undefined, undefined, undefined, {
        limitKey: 'preset_rows'
      })
      if ('error' in xlsx) throw new Error(xlsx.error)
      const xlsxPeak = Math.max(...st.samples) - base2
      const xlsxBytes = (await stat(xlsx.path)).size
      await removeExportTemp(xlsx.path)

      clearInterval(ticker)
      const rawPeakOverStart = MB(rawPeak - Math.min(base, base2))

      // What the in-memory builders held before streaming: every row at once.
      gc?.()
      const before = process.memoryUsage().heapUsed
      const held = Array.from({ length: ROWS }, (_, i) => row(i))
      gc?.()
      const heldMb = MB(process.memoryUsage().heapUsed - before)
      expect(held).toHaveLength(ROWS)

      const report = {
        rows: ROWS,
        gc: !!gc,
        items_csv: { file_mb: MB(csvBytes), heap_peak_over_start_mb: MB(csvPeak), rows: csv.rows },
        preset_xlsx: {
          file_mb: MB(xlsxBytes),
          heap_peak_over_start_mb: MB(xlsxPeak),
          rows: xlsx.rows
        },
        heap_peak_any_time_over_start_mb: rawPeakOverStart,
        rows_held_in_memory_mb: heldMb
      }
      // The numbers for the record (EXPORT_MEMORY_PROBE_OUT = a file to write them to).
      const out = process.env.EXPORT_MEMORY_PROBE_OUT
      if (out) await writeFile(out, `${JSON.stringify(report, null, 2)}\n`)
      expect(csv.rows).toBe(ROWS)
      expect(xlsx.rows).toBe(ROWS)
      if (gc) {
        expect(MB(csvPeak)).toBeLessThan(64)
        expect(MB(xlsxPeak)).toBeLessThan(64)
      }
    },
    15 * 60_000
  )
})

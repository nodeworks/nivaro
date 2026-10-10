import { gzipSync } from 'node:zlib'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Session replay index (#1374 / #1372): what the upload-time indexer pulls
 * out of real-shaped rrweb chunks — route patterns, record ids, data-field
 * NAMES (never values) and selectors — and how it carries the node map across
 * chunks, rebuilds it from stored chunks on a cache miss, and writes rows.
 */

// ── In-memory stand-in for the few knex shapes the indexer uses ─────────────
type Row = Record<string, unknown>
const tables = vi.hoisted(() => ({ data: {} as Record<string, Row[]>, nextId: 1 }))

vi.mock('../../../db/index.js', () => {
  function query(table: string) {
    const conds: Array<(r: Row) => boolean> = []
    let order: { col: string; dir: string } | null = null
    let lim = Number.POSITIVE_INFINITY
    let counting = false
    const rows = () => {
      let out = (tables.data[table] ?? []).filter((r) => conds.every((c) => c(r)))
      if (order) {
        const { col, dir } = order
        out = [...out].sort((a, b) => (Number(a[col]) - Number(b[col])) * (dir === 'desc' ? -1 : 1))
      }
      return out.slice(0, lim)
    }
    const chain: Record<string, unknown> = {
      where(a: unknown, b?: unknown, c?: unknown) {
        if (a && typeof a === 'object') {
          for (const [k, v] of Object.entries(a)) conds.push((r) => r[k] === v)
        } else if (c !== undefined) {
          const col = String(a)
          if (b === '<') conds.push((r) => Number(r[col]) < Number(c))
          else conds.push((r) => r[col] === c)
        } else {
          conds.push((r) => r[String(a)] === b)
        }
        return chain
      },
      whereIn(col: string, vals: unknown[]) {
        conds.push((r) => vals.includes(r[col]))
        return chain
      },
      orderBy(col: string, dir = 'asc') {
        order = { col, dir }
        return chain
      },
      limit(n: number) {
        lim = n
        return chain
      },
      count() {
        counting = true
        return chain
      },
      async select() {
        return rows()
      },
      async first() {
        if (counting) return { n: rows().length }
        return rows()[0]
      },
      async insert(v: Row | Row[]) {
        const list = Array.isArray(v) ? v : [v]
        tables.data[table] ??= []
        for (const r of list) {
          const dup = tables.data[table].some(
            (x) => x.recording === r.recording && x.kind === r.kind && x.key === r.key
          )
          if (table === 'nivaro_replay_index' && dup) throw new Error('unique')
        }
        for (const r of list) tables.data[table].push({ id: tables.nextId++, ...r })
        return [1]
      },
      async update(patch: Row) {
        for (const r of rows()) Object.assign(r, patch)
        return 1
      }
    }
    return chain
  }
  const db = vi.fn(query)
  ;(db as unknown as Record<string, unknown>).raw = vi.fn((sql: string) => ({ sql }))
  return { db }
})

import {
  applyEvents,
  type HookNode,
  indexChunk,
  indexUploadedChunk,
  nearestDataField,
  newIndexState,
  recordFromPath,
  replayIndexIdle,
  resetReplayIndexCache,
  routePattern,
  scheduleReplayIndex,
  searchCriteria,
  selectorFor
} from '../../../services/session-replay-index.js'

// ── rrweb fixtures (hand-built, rrweb 2.x shapes) ────────────────────────────
const T = 1_760_000_000_000
const REC = '6f1c2b3a-1234-4abc-9def-0123456789ab'

type SN = Record<string, unknown>
const el = (id: number, tagName: string, attributes: SN = {}, childNodes: SN[] = []): SN => ({
  type: 2,
  id,
  tagName,
  attributes,
  childNodes
})
const text = (id: number, textContent: string): SN => ({ type: 3, id, textContent })

/** A record form: a due-date field, a notes field, a quick-pick button, a bare button. */
function fullSnapshot(at: number) {
  return [
    {
      type: 4,
      timestamp: at,
      data: { href: 'https://admin.example.com/collections/orders/1042', width: 1280, height: 720 }
    },
    {
      type: 2,
      timestamp: at + 1,
      data: {
        node: {
          type: 0,
          id: 1,
          childNodes: [
            { type: 1, id: 2, name: 'html', publicId: '', systemId: '' },
            el(3, 'html', {}, [
              el(4, 'head'),
              el(5, 'body', { class: 'app' }, [
                el(6, 'div', { 'data-field': 'due_date', class: 'field-row' }, [
                  el(7, 'label', { for: 'f-due' }, [text(8, 'Due date')]),
                  el(9, 'input', { type: 'text', value: '*****', id: 'radix-:r4:' })
                ]),
                el(10, 'button', { 'data-cbv-quick-pick': '', class: 'btn' }, [text(11, 'Pick')]),
                el(12, 'button', { class: 'btn' }, [text(13, 'Save')]),
                el(14, 'div', { id: 'sidebar' }, [
                  el(15, 'a', { href: '/collections/customers/7' })
                ])
              ])
            ])
          ]
        },
        initialOffset: { left: 0, top: 0 }
      }
    }
  ]
}

const routeEv = (at: number, path: string) => ({
  type: 5,
  timestamp: at,
  data: { tag: 'route', payload: { path } }
})
const focus = (at: number, id: number) => ({
  type: 3,
  timestamp: at,
  data: { source: 2, type: 5, id, x: 10, y: 10 }
})
const click = (at: number, id: number) => ({
  type: 3,
  timestamp: at,
  data: { source: 2, type: 2, id, x: 10, y: 10 }
})
const input = (at: number, id: number) => ({
  type: 3,
  timestamp: at,
  data: { source: 5, id, text: '*****', isChecked: false }
})
const move = (at: number) => ({
  type: 3,
  timestamp: at,
  data: { source: 1, positions: [{ x: 1, y: 2, id: 5, timeOffset: 0 }] }
})

function byKind(entries: Array<{ kind: string; key: string; first: number; last: number }>) {
  const out: Record<string, Record<string, { first: number; last: number }>> = {}
  for (const e of entries) {
    out[e.kind] ??= {}
    out[e.kind][e.key] = { first: e.first, last: e.last }
  }
  return out
}

beforeEach(() => {
  tables.data = {}
  tables.nextId = 1
  resetReplayIndexCache()
})

describe('routes and records', () => {
  it('folds ids out of route patterns', () => {
    expect(routePattern('/collections/orders/1042?tab=history')).toBe('/collections/orders/:id')
    expect(routePattern('/collections/orders/ORD-77')).toBe('/collections/orders/:id')
    expect(routePattern('/users/6f1c2b3a-1234-4abc-9def-0123456789ab/edit')).toBe('/users/:id/edit')
    expect(routePattern('/people/jane@example.com')).toBe('/people/:id')
    expect(routePattern('/collections/orders')).toBe('/collections/orders')
    expect(routePattern('https://x')).toBeNull()
  })

  it('reads record ids from admin record routes only', () => {
    expect(recordFromPath('/collections/orders/1042')).toEqual({
      collection: 'orders',
      item: '1042'
    })
    expect(recordFromPath('/collections/orders/ORD%2D77?x=1')).toEqual({
      collection: 'orders',
      item: 'ORD-77'
    })
    // An id with whitespace is not a record route the admin makes.
    expect(recordFromPath('/collections/orders/ORD%2077')).toBeNull()
    expect(recordFromPath('/collections/orders/ORD-77/')).toEqual({
      collection: 'orders',
      item: 'ORD-77'
    })
    expect(recordFromPath('/collections/orders/classic')).toBeNull()
    expect(recordFromPath('/collections/orders/+')).toBeNull()
    expect(recordFromPath('/collections/orders')).toBeNull()
    expect(recordFromPath('/orders/1042')).toBeNull()
  })
})

describe('indexChunk', () => {
  it('indexes route, record, field names and selectors from one chunk', () => {
    const state = newIndexState()
    const entries = indexChunk(state, [
      ...fullSnapshot(T),
      routeEv(T + 5, '/collections/orders/1042'),
      move(T + 500),
      focus(T + 1000, 9),
      input(T + 1100, 9),
      click(T + 1200, 10),
      click(T + 1300, 12)
    ])
    const k = byKind(entries)
    expect(k.route['/collections/orders/:id']).toEqual({ first: T, last: T + 1300 })
    expect(k.record['orders/1042']).toEqual({ first: T, last: T + 1300 })
    expect(k.field.due_date).toEqual({ first: T + 1000, last: T + 1100 })
    expect(k.field['orders.due_date']).toEqual({ first: T + 1000, last: T + 1100 })
    expect(Object.keys(k.selector).sort()).toEqual([
      '[data-cbv-quick-pick]',
      '[data-field="due_date"] input[type="text"]'
    ])
  })

  it('never indexes values or text', () => {
    const entries = indexChunk(newIndexState(), [
      ...fullSnapshot(T),
      focus(T + 1000, 9),
      input(T + 1100, 9)
    ])
    const flat = JSON.stringify(entries)
    expect(flat).not.toContain('*****')
    expect(flat).not.toContain('Due date')
    expect(flat).not.toContain('radix')
  })

  it('carries the node map into the next chunk and follows mutations', () => {
    const state = newIndexState()
    indexChunk(state, fullSnapshot(T))
    const entries = indexChunk(state, [
      // A notes field appears, the quick-pick button gets a test id, the bare button goes.
      {
        type: 3,
        timestamp: T + 10_000,
        data: {
          source: 0,
          texts: [],
          removes: [{ parentId: 5, id: 12 }],
          adds: [
            {
              parentId: 5,
              nextId: null,
              node: el(20, 'div', { 'data-field': 'notes' }, [
                el(21, 'textarea', { name: 'notes' })
              ])
            }
          ],
          attributes: [{ id: 10, attributes: { 'data-testid': 'quick-pick' } }]
        }
      },
      focus(T + 11_000, 21),
      click(T + 12_000, 10),
      click(T + 13_000, 12)
    ])
    const k = byKind(entries)
    expect(k.field.notes).toEqual({ first: T + 11_000, last: T + 11_000 })
    expect(k.field['orders.notes']).toBeDefined()
    expect(k.selector['[data-field="notes"] textarea[name="notes"]']).toBeDefined()
    expect(k.selector['[data-testid="quick-pick"]']).toBeDefined()
    // The record span runs on to the end of the chunk: still on it.
    expect(k.record['orders/1042'].last).toBe(T + 13_000)
  })

  it('closes a record span when the person navigates away', () => {
    const state = newIndexState()
    const entries = indexChunk(state, [
      ...fullSnapshot(T),
      routeEv(T + 60_000, '/collections/customers/7'),
      move(T + 90_000)
    ])
    const k = byKind(entries)
    expect(k.record['orders/1042']).toEqual({ first: T, last: T + 60_000 })
    expect(k.record['customers/7']).toEqual({ first: T + 60_000, last: T + 90_000 })
    expect(k.route['/collections/customers/:id']).toBeDefined()
  })

  it('skips nodes it cannot resolve', () => {
    const entries = indexChunk(newIndexState(), [
      routeEv(T, '/collections/orders/1'),
      click(T + 1, 99)
    ])
    expect(entries.map((e) => e.kind).sort()).toEqual(['record', 'route'])
  })

  it('a rebuild (no collector) only replays state', () => {
    const state = newIndexState()
    applyEvents(state, fullSnapshot(T))
    expect(state.nodes.get(9)).toEqual({ p: 6, t: 'input', a: { type: 'text', id: 'radix-:r4:' } })
    expect(state.route?.record).toBe('orders/1042')
  })
})

describe('selectors (vectors shared with the player inspector)', () => {
  type V = { tag: string; attrs?: Record<string, string>; children?: V[]; target?: boolean }
  function hook(v: V, parent: HookNode | null): { node: HookNode; target: HookNode | null } {
    const node: HookNode = {
      tag: v.tag,
      attr: (n) => v.attrs?.[n] ?? null,
      attrNames: () => Object.keys(v.attrs ?? {}),
      parent: () => parent
    }
    let target: HookNode | null = v.target ? node : null
    for (const c of v.children ?? []) target = hook(c, node).target ?? target
    return { node, target }
  }
  // KEEP IN STEP with admin/src/components/replay-player/inspector-logic.test.ts
  const VECTORS: Array<{ tree: V; selector: string; anchored: boolean; field: string | null }> = [
    {
      tree: {
        tag: 'div',
        attrs: { 'data-field': 'due_date' },
        children: [{ tag: 'input', attrs: { type: 'text' }, target: true }]
      },
      selector: '[data-field="due_date"] input[type="text"]',
      anchored: true,
      field: 'due_date'
    },
    {
      tree: {
        tag: 'section',
        attrs: { 'data-testid': 'grid' },
        children: [{ tag: 'div', attrs: { 'data-field': 'status' }, target: true }]
      },
      selector: '[data-field="status"]',
      anchored: true,
      field: 'status'
    },
    {
      tree: {
        tag: 'div',
        attrs: { 'data-cbv-tree-node': '6f1c2b3a-1234-4abc-9def-0123456789ab' },
        children: [{ tag: 'button', attrs: { role: 'treeitem' }, target: true }]
      },
      selector: '[data-cbv-tree-node] button[role="treeitem"]',
      anchored: true,
      field: null
    },
    {
      tree: { tag: 'div', attrs: { 'data-cbv-view-toggle': 'map' }, target: true },
      selector: '[data-cbv-view-toggle="map"]',
      anchored: true,
      field: null
    },
    {
      tree: { tag: 'nav', attrs: { id: 'sidebar' }, children: [{ tag: 'a', target: true }] },
      selector: '#sidebar a',
      anchored: true,
      field: null
    },
    {
      tree: {
        tag: 'div',
        attrs: { id: 'radix-:r4:' },
        children: [{ tag: 'button', target: true }]
      },
      selector: 'button',
      anchored: false,
      field: null
    },
    {
      tree: {
        tag: 'form',
        attrs: { id: 'row-12345' },
        children: [{ tag: 'select', attrs: { name: 'priority' }, target: true }]
      },
      selector: 'select[name="priority"]',
      anchored: false,
      field: null
    },
    {
      tree: {
        tag: 'div',
        attrs: { 'data-testid': 'a "quoted" id' },
        children: [{ tag: 'span', target: true }]
      },
      selector: 'span',
      anchored: false,
      field: null
    }
  ]
  for (const v of VECTORS) {
    it(`builds ${v.selector}`, () => {
      const { target } = hook(v.tree, null)
      expect(target).not.toBeNull()
      expect(selectorFor(target!)).toEqual({ selector: v.selector, anchored: v.anchored })
      expect(nearestDataField(target!)).toBe(v.field)
    })
  }
})

describe('indexUploadedChunk (worker step)', () => {
  const gz = (events: unknown[]) =>
    `gz:${gzipSync(Buffer.from(JSON.stringify(events))).toString('base64')}`

  it('rebuilds the node map from stored chunks on a cache miss', async () => {
    // Stored: seq 0 = snapshot, seq 1 = a mutation. Indexing seq 2 cold.
    tables.data.nivaro_session_events = [
      { recording: REC, seq: 0, events: gz(fullSnapshot(T)) },
      {
        recording: REC,
        seq: 1,
        events: JSON.stringify([
          {
            type: 3,
            timestamp: T + 10_000,
            data: {
              source: 0,
              texts: [],
              removes: [],
              attributes: [],
              adds: [
                {
                  parentId: 5,
                  nextId: null,
                  node: el(30, 'div', { 'data-field': 'notes' }, [el(31, 'textarea')])
                }
              ]
            }
          }
        ])
      }
    ]
    const entries = await indexUploadedChunk({
      recording: REC,
      seq: 2,
      events: [input(T + 20_000, 31)]
    })
    const k = byKind(entries)
    expect(k.field.notes).toBeDefined()
    expect(k.field['orders.notes']).toBeDefined()
    expect(k.record['orders/1042']).toEqual({ first: T + 20_000, last: T + 20_000 })
    const rows = tables.data.nivaro_replay_index
    expect(rows.map((r) => `${r.kind}:${r.key}`).sort()).toEqual([
      'field:notes',
      'field:orders.notes',
      'record:orders/1042',
      'route:/collections/orders/:id',
      'selector:[data-field="notes"] textarea'
    ])
  })

  it('widens an existing row instead of adding a second one', async () => {
    await indexUploadedChunk({ recording: REC, seq: 0, events: fullSnapshot(T) })
    await indexUploadedChunk({ recording: REC, seq: 1, events: [move(T + 30_000)] })
    const rec = tables.data.nivaro_replay_index.filter((r) => r.kind === 'record')
    expect(rec).toHaveLength(1)
    expect(rec[0]).toMatchObject({ key: 'orders/1042', first_ms: T, last_ms: T + 30_000 })
  })

  it('scheduleReplayIndex queues work and never throws', async () => {
    expect(() => scheduleReplayIndex(REC, 0, fullSnapshot(T))).not.toThrow()
    expect(() => scheduleReplayIndex(REC, 1, null as unknown as unknown[])).not.toThrow()
    await replayIndexIdle()
    expect(tables.data.nivaro_replay_index?.length).toBeGreaterThan(0)
  })
})

describe('searchCriteria', () => {
  it('maps the query to index lookups', () => {
    expect(searchCriteria({ collection: 'orders', item: '1042' })).toEqual([
      { kind: 'record', key: 'orders/1042' }
    ])
    expect(searchCriteria({ collection: 'orders' })).toEqual([
      { kind: 'record', prefix: 'orders/' }
    ])
    expect(searchCriteria({ collection: 'orders', field: 'due_date' })).toEqual([
      { kind: 'field', key: 'orders.due_date' }
    ])
    expect(searchCriteria({ field: 'due_date', selector: '#x' })).toEqual([
      { kind: 'field', key: 'due_date' },
      { kind: 'selector', key: '#x' }
    ])
    expect(searchCriteria({})).toEqual([])
  })
})

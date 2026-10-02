import { describe, expect, it } from 'vitest'
import {
  bucketCounts,
  dependencyKeyOf,
  historyAnchorNote,
  historyHoursFor,
  mapWindowFor,
  p95Of,
  parseCallerKey,
  parseEntityRef,
  parsePageRef,
  partnerIdOf,
  rangeFor,
  relatedRefOf,
  safeBaseUrl,
  summarizeRequests,
  validDownId,
  validQuerySlug,
  validWidgetId,
  widgetConfigSummary
} from './entities-logic.js'

const UUID = '7a0411f3-c687-40e5-adf5-614157cf88ec'

describe('parseCallerKey', () => {
  it('reads API keys, people, buckets and background sources', () => {
    expect(parseCallerKey('k12')).toEqual({ kind: 'key', key: 'k12', apiKeyId: 12 })
    expect(parseCallerKey(`u${UUID}`)).toEqual({
      kind: 'person',
      key: `u${UUID.toUpperCase()}`,
      userId: UUID.toUpperCase()
    })
    expect(parseCallerKey('cron')).toEqual({ kind: 'cron', key: 'cron' })
    expect(parseCallerKey('anon')).toEqual({ kind: 'anon', key: 'anon' })
    expect(parseCallerKey('cron:ext:efp-ops:auto-create-mwf')).toEqual({
      kind: 'source',
      key: 'cron:ext:efp-ops:auto-create-mwf',
      source: 'cron',
      ref: 'ext:efp-ops:auto-create-mwf'
    })
    expect(parseCallerKey(`flow:${UUID}`)?.kind).toBe('source')
    expect(parseCallerKey('import:worker')?.kind).toBe('source')
    expect(parseCallerKey('socket:browsers')?.kind).toBe('source')
  })

  it('refuses anything else', () => {
    for (const bad of [
      '',
      'k',
      'k0',
      'k12a',
      'k1234567890',
      'u123',
      'unot-a-uuid',
      'cron:',
      ':x',
      'Cron:x',
      "cron:x'; drop table x",
      'cron:a b',
      `cron:${'x'.repeat(170)}`,
      'nvk_secret'
    ])
      expect(parseCallerKey(bad), bad).toBeNull()
  })

  it('maps to the partner-dependency caller key for keys and accounts only', () => {
    expect(dependencyKeyOf(parseCallerKey('k7') as never)).toBe('key:7')
    expect(dependencyKeyOf(parseCallerKey(`u${UUID}`) as never)).toBe(`user:${UUID.toUpperCase()}`)
    expect(dependencyKeyOf(parseCallerKey('cron') as never)).toBeNull()
    expect(dependencyKeyOf(parseCallerKey('cron:x') as never)).toBeNull()
  })
})

describe('parseEntityRef', () => {
  it('accepts `<lane>/<entity>` for known lanes', () => {
    expect(parseEntityRef('items/workflows')).toEqual({ lane: 'items', entity: 'workflows' })
    expect(parseEntityRef('queries/project-budgets')).toEqual({
      lane: 'queries',
      entity: 'project-budgets'
    })
    expect(parseEntityRef('socket/record.join')).toEqual({ lane: 'socket', entity: 'record.join' })
    expect(parseEntityRef('items/__other__')?.entity).toBe('__other__')
  })
  it('refuses unknown lanes and malformed entities', () => {
    for (const bad of [
      '',
      'items',
      '/workflows',
      'nope/workflows',
      'items/',
      'items/a b',
      'items/../x',
      'items/-x',
      `items/${'a'.repeat(121)}`,
      'items/x;drop'
    ])
      expect(parseEntityRef(bad), bad).toBeNull()
  })
  it('names the next level for queries and widgets', () => {
    expect(relatedRefOf('queries', 'project-budgets')).toEqual({
      kind: 'query',
      id: 'project-budgets'
    })
    expect(relatedRefOf('widgets', '5')).toEqual({ kind: 'widget', id: '5' })
    expect(relatedRefOf('widgets', '__other__')).toBeNull()
    expect(relatedRefOf('items', 'workflows')).toBeNull()
  })
})

describe('query / widget / down / page ids', () => {
  it('validates slugs and widget ids', () => {
    expect(validQuerySlug('project-budgets')).toBe(true)
    expect(validQuerySlug('12')).toBe(true)
    expect(validQuerySlug('a b')).toBe(false)
    expect(validQuerySlug("x'--")).toBe(false)
    expect(validWidgetId('5')).toBe(true)
    expect(validWidgetId('0')).toBe(false)
    expect(validWidgetId('05')).toBe(false)
    expect(validWidgetId('x')).toBe(false)
  })
  it('validates down node ids and picks out partners', () => {
    for (const ok of ['db', 'redis', 'store', 'mail', 'ai', 'ext:3', 'x:efp-ops.mdsi', 'webhook'])
      expect(validDownId(ok), ok).toBe(true)
    for (const bad of ['', 'DB', 'ext:', 'ext:x y', 'a/b', "x:'"])
      expect(validDownId(bad), bad).toBe(false)
    expect(partnerIdOf('ext:3')).toBe(3)
    expect(partnerIdOf('ext:abc')).toBeNull()
    expect(partnerIdOf('db')).toBeNull()
  })
  it('accepts only normalised page patterns', () => {
    expect(parsePageRef('/collections/workflows/:id')).toEqual({
      app: null,
      path: '/collections/workflows/:id'
    })
    expect(parsePageRef('admin /traffic-map')).toEqual({ app: 'admin', path: '/traffic-map' })
    expect(parsePageRef('/collections/workflows/123')).toBeNull() // a real id
    expect(parsePageRef('/users/jane@example.com')).toBeNull()
    expect(parsePageRef('admin')).toBeNull()
    expect(parsePageRef('Bad App /x')).toBeNull()
    expect(parsePageRef('/x?token=1')).toBeNull()
  })
})

describe('windows and ranges', () => {
  it('maps the inspect window onto the map ring and history windows', () => {
    expect(mapWindowFor(30)).toBe(60)
    expect(mapWindowFor(300)).toBe(300)
    expect(mapWindowFor(3600)).toBe(900)
    expect(historyHoursFor(300)).toBe(1)
    expect(historyHoursFor(7200)).toBe(6)
    expect(historyHoursFor(86_400)).toBe(24)
  })
  it('widens the history to reach an anchor, and says when 24 h cannot', () => {
    const now = 1_000_000_000_000
    const h = 3600_000
    expect(historyHoursFor(300, now - 10 * 60_000, now)).toBe(1)
    expect(historyHoursFor(300, now - 3 * h, now)).toBe(6)
    expect(historyHoursFor(300, now - h + 1000, now)).toBe(6) // window pushes it past 1 h
    expect(historyHoursFor(300, now - 20 * h, now)).toBe(24)
    expect(historyHoursFor(300, now - 48 * h, now)).toBe(24)
    expect(historyHoursFor(300, now + 60_000, now)).toBe(1) // an anchor in the future is "now"
    expect(historyAnchorNote(6, 300, now - 3 * h, now)).toBeNull()
    expect(historyAnchorNote(24, 300, null, now)).toBeNull()
    expect(historyAnchorNote(24, 300, now - 48 * h, now)).toMatch(/older than 24 h/)
  })
  it('looks around an anchor, never past now', () => {
    const now = 1_000_000_000
    expect(rangeFor(null, 60, now)).toEqual({ from: now - 60_000, to: now })
    expect(rangeFor(now - 10_000, 60, now)).toEqual({ from: now - 70_000, to: now })
    expect(rangeFor(now - 600_000, 60, now)).toEqual({ from: now - 660_000, to: now - 540_000 })
  })
})

describe('request summaries', () => {
  const row = (path: string, status: number, ms: number, t = 0) => ({
    method: 'get',
    path,
    status,
    latency_ms: ms,
    created_at: new Date(t)
  })
  it('groups by route template + status, with error rate and p95', () => {
    const s = summarizeRequests([
      row('/api/items/workflows/1', 200, 10),
      row('/api/items/workflows/2', 200, 30),
      row('/api/items/workflows/3', 404, 5),
      row('/api/items/vendors', 200, 100)
    ])
    expect(s.total).toBe(4)
    expect(s.errors).toBe(1)
    expect(s.error_rate).toBe(25)
    expect(s.routes[0]).toEqual({
      route: 'GET /api/items/workflows/:id',
      status: 200,
      n: 2,
      p95: 30
    })
    expect(s.routes).toHaveLength(3)
    expect(s.p95).toBe(100)
  })
  it('keeps the top N and handles an empty log', () => {
    const many = Array.from({ length: 30 }, (_, i) => row(`/api/r${i}`, 200, 1))
    expect(summarizeRequests(many, 20).routes).toHaveLength(20)
    expect(summarizeRequests([])).toEqual({
      total: 0,
      errors: 0,
      error_rate: 0,
      p95: 0,
      routes: []
    })
  })
  it('buckets timestamps and computes p95', () => {
    expect(bucketCounts([0, 4, 9, 10, 11], 0, 10, 2)).toEqual([2, 2])
    expect(p95Of([])).toBe(0)
    expect(p95Of([1, 2, 3, 4, 100])).toBe(100)
  })
})

describe('display helpers', () => {
  it('strips credentials and query from a base URL', () => {
    expect(safeBaseUrl('https://u:p@api.example.com/v1?key=secret')).toBe(
      'https://api.example.com/v1'
    )
    expect(safeBaseUrl('not a url')).toBeNull()
  })
  it('summarises a widget config', () => {
    const s = widgetConfigSummary({
      query_id: '3',
      param_bindings: [{ param: ':projects', input_key: 'project' }],
      table: { group_by: 'cat', columns: [{}, {}] },
      drilldown: { collection: 'projects' },
      width: 4
    })
    expect(s.query_id).toBe(3)
    expect(s.lines.map((l) => l.label)).toEqual([
      'Parameters',
      'Columns',
      'Grouped by',
      'Drills into',
      'Other settings'
    ])
    expect(widgetConfigSummary(null)).toEqual({ query_id: null, lines: [] })
  })
})

// Traffic Map drill-down Task 8: context compactor caps, Markdown / HAR builders, live-tail
// matcher, Explain answer parsing, and the cache-backed stack context builder.
import { describe, expect, it } from 'vitest'
import type { InspectRef } from '../../registry/inspectables'
import type { TrafficEventWire } from '../../types'
import { buildStackContext, cachedDetail, type DetailCache, exportLevels } from './context'
import {
  buildChatSummary,
  buildHar,
  buildMarkdown,
  CONTEXT_CAP,
  type ContextLevelInput,
  citeParts,
  compactStackContext,
  exportFileName,
  keyFacts,
  parseExplain,
  requestFacts,
  tailEvents,
  tailMatcher
} from './logic'

const RID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const AT = Date.UTC(2026, 9, 1, 14, 2, 31)

const ROW = {
  request_id: RID,
  method: 'POST',
  path: '/api/items/workflows',
  query: 'fields=id,name&limit=5',
  status: 500,
  latency_ms: 1234,
  created_at: new Date(AT).toISOString(),
  user_agent: 'Mozilla/5.0',
  request_body: '{"name":"x"}',
  error: '{"error":"boom"}',
  auth: 'session'
}

function lvl(ref: InspectRef, detail: unknown, current = false): ContextLevelInput {
  return { ref, title: `${ref.kind} ${ref.id.slice(0, 8)}`, current, detail }
}

describe('compactStackContext', () => {
  it('keeps everything when it fits', () => {
    const r = compactStackContext([lvl({ kind: 'request', id: RID, at: AT }, ROW, true)], {
      anchor: AT,
      windowSec: 300
    })
    expect(r.trimmed).toEqual([])
    expect(r.context.levels[0]).toMatchObject({ n: 1, kind: 'request', current: true })
    expect((r.context.levels[0].detail as typeof ROW).request_body).toBe('{"name":"x"}')
    expect(r.context.anchor).toBe(new Date(AT).toISOString())
  })
  it('drops bodies first when over the cap', () => {
    const big = { ...ROW, request_body: 'x'.repeat(30_000) }
    const r = compactStackContext([lvl({ kind: 'request', id: RID }, big, true)], {
      anchor: null,
      windowSec: 300
    })
    expect(r.trimmed[0]).toBe('bodies')
    expect(r.bytes).toBeLessThanOrEqual(CONTEXT_CAP)
    const d = r.context.levels[0].detail as Record<string, unknown>
    expect(String(d.request_body)).toMatch(/^\[request_body dropped: 30,0\d\d chars\]$/)
    expect(d.status).toBe(500)
  })
  it('drops older levels before the current one and never loses titles', () => {
    const huge = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`field_${i}`, 'value']))
    const levels = [
      lvl({ kind: 'entity', id: 'items/workflows' }, huge),
      lvl({ kind: 'caller', id: 'k12' }, huge),
      lvl({ kind: 'request', id: RID }, { ...ROW }, true)
    ]
    const r = compactStackContext(levels, { anchor: null, windowSec: 300, cap: 2000 })
    expect(r.bytes).toBeLessThanOrEqual(2000)
    expect(r.context.levels.map((l) => l.title)).toHaveLength(3)
    expect(r.context.levels[2].detail).not.toBeNull()
    expect(r.trimmed).toContain('older levels')
  })
  it('marks levels with nothing loaded', () => {
    const r = compactStackContext([lvl({ kind: 'trace', id: RID }, undefined, true)], {
      anchor: null,
      windowSec: 60
    })
    expect(r.context.levels[0]).toMatchObject({ detail: null, note: 'not loaded' })
  })
})

describe('cachedDetail / buildStackContext', () => {
  const cache: DetailCache = {
    getQueriesData: ({ queryKey }) => {
      const all: Array<[readonly unknown[], unknown]> = [
        [['tm-inspect', 'request', RID, AT, 300], ROW],
        [['tm-inspect', 'request', RID, null, 300], { other: true }],
        [['tm-inspect', 'caller', 'k12', null, 300], undefined]
      ]
      return all.filter(([k]) => queryKey.every((part, i) => k[i] === part))
    }
  }
  it('prefers the entry for the level time, skips unloaded ones', () => {
    expect(cachedDetail(cache, { kind: 'request', id: RID, at: AT }, null)).toBe(ROW)
    expect(cachedDetail(cache, { kind: 'request', id: RID }, 999)).toEqual({ other: true })
    expect(cachedDetail(cache, { kind: 'caller', id: 'k12' }, null)).toBeUndefined()
  })
  it('builds the stack context from the cache', () => {
    const r = buildStackContext(cache, {
      levels: [
        { kind: 'caller', id: 'k12' },
        { kind: 'request', id: RID, at: AT }
      ],
      index: 1,
      anchor: null,
      windowSec: 300
    })
    expect(r.context.levels[0].note).toBe('not loaded')
    expect(r.context.levels[1].current).toBe(true)
    expect((r.context.levels[1].detail as typeof ROW).status).toBe(500)
  })
  it('links each export level to the stack up to it', () => {
    const levels = exportLevels(
      cache,
      {
        levels: [
          { kind: 'caller', id: 'k12' },
          { kind: 'request', id: RID, at: AT }
        ],
        index: 1,
        anchor: null
      },
      'https://x.test'
    )
    expect(levels[0].url).toBe('https://x.test/traffic-map?inspect=caller%3Ak12')
    expect(decodeURIComponent(levels[1].url.split('inspect=')[1])).toBe(
      `caller:k12/request:${RID}@${AT}`
    )
  })
})

describe('Markdown', () => {
  const levels = [
    {
      ref: { kind: 'caller', id: 'k12' },
      title: 'API key *Partner*',
      detail: { label: 'Partner', kind: 'api_key', token: 'secret' },
      url: 'https://x.test/a'
    },
    {
      ref: { kind: 'request', id: RID, at: AT },
      title: 'POST /api/items',
      detail: ROW,
      url: 'https://x.test/b'
    },
    { ref: { kind: 'trace', id: RID }, title: 'Trace', detail: undefined, url: 'https://x.test/c' }
  ]
  it('lists every level with facts and links, escapes Markdown, skips secrets and bodies', () => {
    const md = buildMarkdown(levels, { anchor: AT, now: AT, notes: 'checked' })
    expect(md).toContain('# Investigation: API key \\*Partner\\*')
    expect(md).toContain('[Open the whole investigation](https://x.test/c)')
    expect(md).toContain('## Notes')
    expect(md).toContain('## 2. POST /api/items')
    expect(md).toContain('- **Status:** 500')
    expect(md).toContain('[open](https://x.test/b)')
    expect(md).toContain('_Not loaded when exported._')
    expect(md).not.toContain('secret')
    expect(md).not.toContain('{"name":"x"}')
    expect(md).toContain('14:02 UTC')
  })
  it('summarises for chat in a few lines', () => {
    const s = buildChatSummary(levels)
    expect(s.split('\n')[0]).toBe(
      'Traffic Map investigation: API key *Partner* › POST /api/items › Trace'
    )
    expect(s.trim().endsWith('https://x.test/c')).toBe(true)
  })
  it('keyFacts flattens one nested object', () => {
    expect(keyFacts({ row: { status: 404 }, kept: false })).toEqual([
      ['Kept', 'no'],
      ['Status', '404']
    ])
  })
})

describe('HAR', () => {
  it('reads an API log row, nested or not', () => {
    const f = requestFacts({ row: ROW, trace: { kept: false } })
    expect(f).toMatchObject({
      method: 'POST',
      path: '/api/items/workflows',
      status: 500,
      ms: 1234,
      at: AT,
      requestId: RID
    })
    expect(requestFacts({ unrelated: 1 })).toBeNull()
    expect(
      requestFacts({ status: 200 }, { kind: 'request', id: RID, label: 'GET /api/x' })
    ).toMatchObject({ method: 'GET', path: '/api/x' })
  })
  it('builds a HAR 1.2 log with what the log knows', () => {
    const f = requestFacts(ROW)
    if (!f) throw new Error('no facts')
    const har = buildHar([f], 'https://x.test') as {
      log: { version: string; entries: Array<Record<string, any>> }
    }
    expect(har.log.version).toBe('1.2')
    const e = har.log.entries[0]
    expect(e.request.url).toBe('https://x.test/api/items/workflows?fields=id,name&limit=5')
    expect(e.request.queryString).toEqual([
      { name: 'fields', value: 'id,name' },
      { name: 'limit', value: '5' }
    ])
    expect(e.request.postData).toEqual({ mimeType: 'application/json', text: '{"name":"x"}' })
    expect(e.request.headers).toContainEqual({ name: 'x-nivaro-request-id', value: RID })
    expect(e.response.status).toBe(500)
    expect(e.response.content.text).toBe('{"error":"boom"}')
    expect(e.timings).toEqual({ send: 0, wait: 1234, receive: 0 })
    expect(e.startedDateTime).toBe(new Date(AT).toISOString())
  })
  it('names the file by date', () => {
    expect(exportFileName('har', AT)).toBe('investigation-2026-10-01.har')
  })
})

describe('live tail', () => {
  const ev = (over: Partial<TrafficEventWire>): TrafficEventWire => ({
    t: AT,
    lane: 'items',
    entity: 'workflows',
    kind: 'read',
    caller: 'k12',
    route: 'GET /api/items/workflows',
    ...over
  })
  it('matches an entity, a caller (or its background run) and a request route', () => {
    const e = tailMatcher({ kind: 'entity', id: 'items/workflows' })
    expect(e?.match(ev({}))).toBe(true)
    expect(e?.match(ev({ entity: 'regions' }))).toBe(false)
    const c = tailMatcher({ kind: 'caller', id: 'cron:digest' })
    expect(c?.match(ev({ run: 'cron:digest' }))).toBe(true)
    expect(c?.match(ev({}))).toBe(false)
    const r = tailMatcher({ kind: 'request', id: RID, label: 'GET /api/items/workflows' })
    expect(r?.match(ev({}))).toBe(true)
    expect(tailMatcher({ kind: 'request', id: RID }, { route: 'POST /api/x' })?.label).toBe(
      'POST /api/x'
    )
    expect(tailMatcher({ kind: 'request', id: RID })).toBeNull()
    expect(tailMatcher({ kind: 'trace', id: RID })).toBeNull()
  })
  it('keeps the newest 50', () => {
    const list = Array.from({ length: 80 }, (_, i) => ev({ t: AT - i }))
    const m = tailMatcher({ kind: 'caller', id: 'k12' })
    if (!m) throw new Error('no matcher')
    const out = tailEvents(list, m)
    expect(out).toHaveLength(50)
    expect(out[0].t).toBe(AT)
  })
})

describe('Explain answer', () => {
  it('splits sections and citations', () => {
    const parts = parseExplain(
      'What happened: a 500 on save [L2].\nLikely cause: a slow query\n continuing [L3].\nWhere to look next: the trace.'
    )
    expect(parts.map((p) => p.title)).toEqual([
      'What happened',
      'Likely cause',
      'Where to look next'
    ])
    expect(parts[1].body).toBe('a slow query continuing [L3].')
    expect(citeParts(parts[0].body)).toEqual([
      { text: 'a 500 on save ' },
      { level: 2 },
      { text: '.' }
    ])
  })
  it('keeps an answer that ignored the titles', () => {
    expect(parseExplain('Nothing stands out.')).toEqual([
      { title: null, body: 'Nothing stands out.' }
    ])
  })
})

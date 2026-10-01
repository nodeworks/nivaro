// api/src/test/unit/services/traffic-map-request-lenses.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../services/request-trace.js', () => ({
  currentTraceCaller: vi.fn(() => null),
  currentTraceMeta: vi.fn(() => null)
}))
vi.mock('../../../services/settings-overrides.js', () => ({ instanceKey: () => 'test-node' }))

import { currentTraceCaller, currentTraceMeta } from '../../../services/request-trace.js'
import {
  advanceTo,
  buildFrame,
  buildSnapshot,
  drainEvents,
  noteRequest,
  noteWrite,
  resetTrafficMap
} from '../../../services/traffic-map.js'
import { AUTH_MIX_TAP, authSlot } from '../../../services/traffic-taps/auth-mix.js'
import { AUTH_REJECTIONS_TAP } from '../../../services/traffic-taps/auth-rejections.js'
import { CACHE_RATIO_TAP } from '../../../services/traffic-taps/cache-ratio.js'
import { CONFLICTS_TAP, classifyConflict } from '../../../services/traffic-taps/conflicts.js'
import { DUPLICATES_TAP, requestHash } from '../../../services/traffic-taps/duplicates.js'
import {
  CALLERS_PER_ENTITY,
  ENTITY_CALLERS_TAP
} from '../../../services/traffic-taps/entity-callers.js'
import { MASQUERADE_TAP } from '../../../services/traffic-taps/masquerade.js'
import {
  maskIp,
  notePublicHit,
  PUBLIC_CLIENTS_TAP,
  publicRouteOf,
  uaFamily
} from '../../../services/traffic-taps/public-clients.js'
import { REHEARSAL_TAP, rehearsalReason } from '../../../services/traffic-taps/rehearsal.js'
import { RESPONSE_BYTES_TAP } from '../../../services/traffic-taps/response-bytes.js'
import { RETRY_STORMS_TAP, STORM_PER_MIN } from '../../../services/traffic-taps/retry-storms.js'
import { WORKSPACES_TAP } from '../../../services/traffic-taps/workspaces.js'
import { trafficTaps } from '../../../services/traffic-taps.js'

const T0 = 1_800_000_000
type ReqArg = Parameters<typeof noteRequest>[0]
const req = (over: Partial<ReqArg> = {}) =>
  noteRequest({
    method: 'GET',
    path: '/api/items/workflows',
    status: 200,
    latencyMs: 100,
    authMethod: 'session',
    apiKeyId: null,
    userId: 'aaaa',
    graphqlOperation: null,
    graphqlKind: null,
    cacheHit: false,
    at: T0 * 1000,
    ...over
  })
const snap = (w: 60 | 300 | 900 = 60) =>
  buildSnapshot(w, { sockets: 0, users: 0, journalSeq: null })
const ent = (key: string) => snap().entities.find((e) => e.key === key)

beforeEach(() => {
  resetTrafficMap()
  advanceTo(T0)
  vi.mocked(currentTraceCaller).mockReturnValue(null)
  vi.mocked(currentTraceMeta).mockReturnValue(null)
})

describe('registration', () => {
  it('every B1 tap is registered', () => {
    const ids = trafficTaps().map((t) => t.id)
    for (const id of [
      ENTITY_CALLERS_TAP,
      AUTH_REJECTIONS_TAP,
      RESPONSE_BYTES_TAP,
      CACHE_RATIO_TAP,
      DUPLICATES_TAP,
      RETRY_STORMS_TAP,
      CONFLICTS_TAP,
      AUTH_MIX_TAP,
      MASQUERADE_TAP,
      REHEARSAL_TAP,
      PUBLIC_CLIENTS_TAP,
      WORKSPACES_TAP
    ])
      expect(ids).toContain(id)
  })
})

describe('#1095 entity × caller', () => {
  it('counts each caller apart, in the map slot order, with writes by trace caller', () => {
    req()
    req({ userId: 'bbbb', status: 500 })
    req({ method: 'POST', path: '/api/items/workflows', userId: 'bbbb' })
    vi.mocked(currentTraceCaller).mockReturnValue({ auth: 'session', apiKeyId: null })
    vi.mocked(currentTraceMeta).mockReturnValue({
      id: 't',
      urlHint: '/api/items/workflows',
      userId: 'bbbb'
    })
    noteWrite({
      collection: 'workflows',
      item: 1,
      action: 'create',
      changedFields: [],
      at: T0 * 1000
    })
    const e = ent('items/workflows')
    const by = e?.ext?.[ENTITY_CALLERS_TAP] as Record<string, number[]>
    expect(by.uAAAA.slice(0, 6)).toEqual([1, 1, 0, 0, 0, 0])
    expect(by.uBBBB.slice(0, 6)).toEqual([2, 0, 1, 0, 0, 1])
    const frame = buildFrame(T0, { sockets: 0, journalSeq: null })
    const fx = frame.ext?.[ENTITY_CALLERS_TAP] as Record<string, Record<string, number[]>>
    expect(fx['items/workflows'].uAAAA.slice(0, 6)).toEqual([1, 1, 0, 0, 0, 0])
    // drained: the next second carries nothing
    advanceTo(T0 + 1)
    expect(buildFrame(T0 + 1, { sockets: 0, journalSeq: null }).ext?.[ENTITY_CALLERS_TAP]).toBe(
      undefined
    )
  })

  it('caps callers per entity, folding the rest into __other__', () => {
    for (let i = 0; i < CALLERS_PER_ENTITY + 5; i++) req({ userId: `user${i}` })
    const by = ent('items/workflows')?.ext?.[ENTITY_CALLERS_TAP] as Record<string, number[]>
    // the cap's own callers plus the __other__ row
    expect(Object.keys(by).length).toBe(CALLERS_PER_ENTITY + 1)
    expect(by.__other__[0]).toBe(5)
  })

  it('entityDetail gives sums, latency and a series per caller', async () => {
    req({ latencyMs: 50 })
    req({ latencyMs: 150 })
    const tap = trafficTaps().find((t) => t.id === ENTITY_CALLERS_TAP)
    const d = (await tap?.entityDetail?.('items/workflows', 60, T0)) as {
      callers: Array<{ key: string; sums: number[]; p95: number; series: number[] }>
    }
    expect(d.callers[0].key).toBe('uAAAA')
    expect(d.callers[0].sums[0]).toBe(2)
    expect(d.callers[0].p95).toBe(150)
    expect(d.callers[0].series.reduce((a, b) => a + b, 0)).toBe(2)
  })
})

describe('#1099 rejections', () => {
  it('groups 401/403/429 by caller and code and tags the event', () => {
    req({ status: 403, authMethod: 'api_key', apiKeyId: 7, errorCode: 'API_KEY_SCOPE_MISSING' })
    req({ status: 403, authMethod: 'api_key', apiKeyId: 7, errorCode: 'API_KEY_SCOPE_MISSING' })
    req({ status: 429, authMethod: 'api_key', apiKeyId: 7 })
    req({ status: 404 })
    const s = snap().ext?.[AUTH_REJECTIONS_TAP] as {
      callers: Array<{ key: string; n: number; codes: Array<{ status: number; code: string }> }>
    }
    expect(s.callers).toHaveLength(1)
    expect(s.callers[0]).toMatchObject({ key: 'k7', n: 3 })
    expect(s.callers[0].codes[0]).toMatchObject({ status: 403, code: 'API_KEY_SCOPE_MISSING' })
    expect(s.callers[0].codes[1]).toMatchObject({ status: 429, code: 'RATE_LIMITED' })
    const tagged = drainEvents().filter((e) => e.tags?.includes('rejected'))
    expect(tagged).toHaveLength(3)
  })
})

describe('#1110 response bytes', () => {
  it('keeps p50 / p95 / max per entity and skips streams', () => {
    for (const b of [100, 200, 300, 400, 10_000]) req({ responseBytes: b })
    req({ responseBytes: null })
    expect(ent('items/workflows')?.ext?.[RESPONSE_BYTES_TAP]).toEqual({
      p50: 300,
      p95: 10000,
      max: 10000,
      n: 5
    })
    const f = buildFrame(T0, { sockets: 0, journalSeq: null })
    expect((f.ext?.[RESPONSE_BYTES_TAP] as Record<string, number[]>)['items/workflows']).toEqual([
      300, 10000
    ])
  })
})

describe('#1111 cache ratio', () => {
  it('counts hits and misses on query nodes and the time a hit saves', () => {
    const q = { method: 'POST', path: '/api/custom-queries/totals/execute' }
    req({ ...q, cacheHit: true, latencyMs: 10 })
    req({ ...q, cacheHit: true, latencyMs: 12 })
    req({ ...q, cacheHit: false, latencyMs: 400 })
    req() // items: not a cached lane
    const c = ent('queries/totals')?.ext?.[CACHE_RATIO_TAP] as Record<string, number>
    expect(c).toMatchObject({ hits: 2, misses: 1, saved_ms: 388 })
    expect(c.ratio).toBeCloseTo(2 / 3)
    expect(ent('items/workflows')?.ext?.[CACHE_RATIO_TAP]).toBeUndefined()
  })
})

describe('#1117 duplicates', () => {
  it('flags an identical GET from the same caller within 500 ms, query order ignored', () => {
    const r = (url: string, at: number, userId = 'aaaa') =>
      req({ at, userId, req: { raw: { url } } })
    r('/api/items/workflows?a=1&b=2', T0 * 1000)
    r('/api/items/workflows?b=2&a=1', T0 * 1000 + 200) // duplicate
    r('/api/items/workflows?a=1&b=3', T0 * 1000 + 300) // different query
    r('/api/items/workflows?a=1&b=2', T0 * 1000 + 250, 'bbbb') // other caller
    r('/api/items/workflows?a=1&b=2', T0 * 1000 + 900) // too late (700 ms after the last)
    const d = ent('items/workflows')?.ext?.[DUPLICATES_TAP] as {
      n: number
      pairs: Array<{ gap_ms: number; route: string }>
    }
    expect(d.n).toBe(1)
    expect(d.pairs[0].gap_ms).toBe(200)
    expect(d.pairs[0].route).toBe('GET /api/items/workflows')
    expect(JSON.stringify(d)).not.toContain('a=1')
    expect(requestHash('GET', '/x', 'b=1&a=2')).toBe(requestHash('GET', '/x', 'a=2&b=1'))
  })
})

describe('#1118 retry storms', () => {
  it('raises one ticker event when a caller repeats a failure past the threshold', () => {
    for (let i = 0; i <= STORM_PER_MIN; i++)
      req({ status: 400, authMethod: 'api_key', apiKeyId: 3, errorCode: 'VALIDATION_FAILED' })
    const events = drainEvents()
    const storm = events.filter((e) => e.extra?.storm === true)
    expect(storm).toHaveLength(1)
    expect(storm[0]).toMatchObject({ caller: 'k3', kind: 'error', tags: ['retry storm'] })
    const s = snap().ext?.[RETRY_STORMS_TAP] as { storms: Array<{ caller: string; n: number }> }
    expect(s.storms[0]).toMatchObject({ caller: 'k3', n: STORM_PER_MIN + 1 })
    // still storming: no second summary event inside the minute
    req({ status: 400, authMethod: 'api_key', apiKeyId: 3, errorCode: 'VALIDATION_FAILED' })
    expect(drainEvents().filter((e) => e.extra?.storm === true)).toHaveLength(0)
  })

  it('stays quiet under the threshold', () => {
    for (let i = 0; i < STORM_PER_MIN; i++) req({ status: 400, userId: 'cccc' })
    expect(snap().ext?.[RETRY_STORMS_TAP]).toBeUndefined()
  })
})

describe('#1120 conflicts', () => {
  it('counts conflict codes and maps a lock 409 to the collection', () => {
    req({
      method: 'PATCH',
      path: '/api/items/workflows/4',
      status: 409,
      errorCode: 'MIDAIR_COLLISION'
    })
    req({ method: 'POST', path: '/api/item-locks/workflows/4/lock', status: 409, errorCode: null })
    req({ method: 'PATCH', path: '/api/items/workflows/4', status: 422, errorCode: 'NOPE_NOPE' })
    const c = ent('items/workflows')?.ext?.[CONFLICTS_TAP] as {
      n: number
      codes: Array<{ code: string; n: number }>
    }
    expect(c.n).toBe(2)
    expect(c.codes.map((x) => x.code).sort()).toEqual(['ITEM_LOCKED', 'MIDAIR_COLLISION'])
    expect(
      classifyConflict({
        status: 409,
        code: null,
        path: '/api/item-locks/nivaro_users/1/lock',
        entityKey: 'other/x'
      })
    ).toEqual({ code: 'ITEM_LOCKED', entityKey: 'system/nivaro_users' })
  })
})

describe('#1137 auth mix', () => {
  it('splits by auth method per lane and entity', () => {
    req()
    req({ authMethod: 'token' })
    req({ authMethod: 'token' })
    req({ authMethod: null, userId: null })
    const s = snap().ext?.[AUTH_MIX_TAP] as { lanes: Record<string, number[]>; total: number[] }
    expect(s.lanes.items[authSlot('session')]).toBe(1)
    expect(s.lanes.items[authSlot('token')]).toBe(2)
    expect(s.lanes.items[authSlot('none')]).toBe(1)
    expect(ent('items/workflows')?.ext?.[AUTH_MIX_TAP]).toEqual([1, 2, 0, 0, 0, 1])
  })
})

describe('#1138 masquerade', () => {
  it('tags the event, records the edge and the admin acting as the person', () => {
    req({ authMethod: 'masquerade', userId: 'beth', req: { masqueradeAdminId: 'rob' } })
    req({ authMethod: 'session', userId: 'beth', path: '/api/items/regions' })
    const ev = drainEvents()
    expect(ev[0].tags).toContain('masquerade')
    expect(ev[0].extra?.as_admin).toBe('uROB')
    expect(ev[1].tags).toBeUndefined()
    const s = snap().ext?.[MASQUERADE_TAP] as {
      edges: Record<string, number>
      sessions: Array<{ admin: string; caller: string; n: number }>
    }
    expect(s.edges['uBETH>items']).toBe(1)
    expect(s.sessions[0]).toMatchObject({ admin: 'uROB', caller: 'uBETH', n: 1 })
  })
})

describe('#1139 rehearsal', () => {
  it('a dry-run write raises a tagged event; a real write and a GET do not', () => {
    req({
      method: 'POST',
      path: '/api/items/workflows',
      req: { raw: { url: '/api/items/workflows?dry_run=1' } }
    })
    req({ method: 'POST', path: '/api/items/workflows' })
    req({ req: { raw: { url: '/api/items/workflows?dry_run=1' } } })
    const ev = drainEvents().filter((e) => e.tags?.includes('rehearsal'))
    expect(ev).toHaveLength(1)
    expect(ev[0]).toMatchObject({ kind: 'create', extra: { rehearsal: 'dry_run' } })
    const s = snap()
    expect((s.ext?.[REHEARSAL_TAP] as { n: number }).n).toBe(1)
    expect(s.totals.create).toBe(0) // never a write
  })

  it('knows GraphQL dry runs, sandbox keys and flow tests', () => {
    const base = { path: '/api/x', lane: 'other', kind: 'update', graphqlOperation: null }
    expect(
      rehearsalReason({
        ...base,
        method: 'POST',
        lane: 'graphql',
        graphqlOperation: 'create_workflows_dry_run',
        req: null
      })
    ).toBe('graphql_dry_run')
    expect(
      rehearsalReason({
        ...base,
        method: 'POST',
        lane: 'graphql',
        req: { body: { query: 'mutation { create_workflows_dry_run(data: {}) }' } }
      })
    ).toBe('graphql_dry_run')
    expect(
      rehearsalReason({ ...base, method: 'PATCH', req: { user: { api_key_sandbox: true } } })
    ).toBe('sandbox_key')
    expect(
      rehearsalReason({ ...base, method: 'POST', path: '/api/flows/f1/test', req: { body: {} } })
    ).toBe('flow_test')
    expect(
      rehearsalReason({
        ...base,
        method: 'POST',
        path: '/api/flows/f1/test',
        req: { body: { dry_run: false } }
      })
    ).toBeNull()
  })
})

describe('#1152 public clients', () => {
  it('knows the public routes, masks IPs and names clients', () => {
    expect(publicRouteOf('GET', '/share/abc123')).toBe('share')
    expect(publicRouteOf('POST', '/api/submission-forms/public/tok')).toBe('form-submit')
    expect(publicRouteOf('GET', '/api/items/x')).toBeNull()
    expect(maskIp('203.0.113.77')).toBe('203.0.113.x')
    expect(maskIp('::ffff:10.1.2.3')).toBe('10.1.2.x')
    expect(uaFamily('curl/8.4.0')).toEqual({ family: 'curl', known: false })
    expect(uaFamily(null).known).toBe(false)
    expect(uaFamily('Mozilla/5.0 (Macintosh) Chrome/120.0 Safari/537').family).toBe('Chrome')
  })

  it('flags a script and a first-seen IP once, never a signed-in viewer', () => {
    const hit = (over: Partial<Parameters<typeof notePublicHit>[0]> = {}) =>
      notePublicHit({
        method: 'GET',
        path: '/share/tok123',
        status: 200,
        latencyMs: 20,
        at: T0 * 1000,
        ip: '198.51.100.9',
        userAgent: 'python-requests/2.31',
        signedIn: false,
        ...over
      })
    hit()
    hit() // same IP, same script: throttled
    hit({ ip: '198.51.100.10', signedIn: true })
    const ev = drainEvents()
    expect(ev).toHaveLength(1)
    expect(ev[0].tags).toEqual(['public', 'unknown client', 'new IP'])
    expect(JSON.stringify(ev)).not.toContain('198.51.100.9')
    const s = snap().ext?.[PUBLIC_CLIENTS_TAP] as {
      routes: Array<{ n: number; unknown: number; new_ips: number }>
    }
    expect(s.routes[0]).toMatchObject({ n: 3, unknown: 2, new_ips: 1 })
  })
})

describe('#1154 workspaces', () => {
  it('splits requests by workspace', () => {
    req({ req: { workspaceId: 'ws-a' } })
    req({ req: { workspaceId: 'ws-a' }, status: 500 })
    req({ req: { workspaceId: 'ws-b' } })
    const s = snap().ext?.[WORKSPACES_TAP] as {
      workspaces: Array<{ id: string; req: number; error: number }>
    }
    expect(s.workspaces.map((w) => [w.id, w.req, w.error])).toEqual([
      ['WS-A', 2, 1],
      ['WS-B', 1, 0]
    ])
    expect(ent('items/workflows')?.ext?.[WORKSPACES_TAP]).toEqual({ 'WS-A': 2, 'WS-B': 1 })
  })
})

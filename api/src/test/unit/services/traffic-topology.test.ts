// api/src/test/unit/services/traffic-topology.test.ts
// Traffic Map group C: sources (cron / flow / import / socket), topology taps and down history.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../services/request-trace.js', () => ({
  currentTraceCaller: vi.fn(() => null),
  currentTraceMeta: vi.fn(() => null)
}))
vi.mock('../../../services/settings-overrides.js', () => ({ instanceKey: () => 'test-node' }))
vi.mock('../../../services/pool-attribution.js', () => ({
  poolPressure: vi.fn(() => ({
    window_s: 300,
    acquires: 80,
    wait_p50_ms: 20,
    wait_p95_ms: 640,
    wait_max_ms: 900,
    saturated_pct: 10,
    peak_used: 25,
    peak_pending: 4,
    max: 25
  }))
}))

import { currentTraceMeta } from '../../../services/request-trace.js'
import { summarizeDownRows } from '../../../services/traffic-down-history.js'
import {
  advanceTo,
  buildFrame,
  buildSnapshot,
  drainEvents,
  noteOutbound,
  noteSocket,
  noteWrite,
  resetTrafficMap,
  SOCKET_SOURCE,
  socketEntity
} from '../../../services/traffic-map.js'
import { noteAiCall, noteAiFallback } from '../../../services/traffic-taps/ai.js'
import { noteChannel, noteChannelRedirect } from '../../../services/traffic-taps/channels.js'
import '../../../services/traffic-taps/index.js'
import { runAsTrafficSource, withTrafficSource } from '../../../services/traffic-source.js'
import {
  clearTrafficNodes,
  registerTrafficNode,
  resolveTrafficNode
} from '../../../services/traffic-taps/nodes.js'
import {
  dominantClass,
  latencyBucket,
  partnerErrorClass
} from '../../../services/traffic-taps/partners.js'
import { poolLevel } from '../../../services/traffic-taps/pool.js'
import { instrumentRedis, redisFamily } from '../../../services/traffic-taps/redis.js'
import { flowTriggerKey, noteImportRun } from '../../../services/traffic-taps/sources.js'
import { MinuteTotals } from '../../../services/traffic-taps/util.js'
import { noteWebhookDelivery, webhookLabel } from '../../../services/traffic-taps/webhooks.js'

const T0 = 1_800_000_000
const snapOpts = { sockets: 0, users: 0, journalSeq: null }
const snap = () => buildSnapshot(60, snapOpts)
const ext = (id: string) => snap().ext?.[id] as Record<string, unknown> | undefined
const write = (collection = 'workflows') =>
  noteWrite({ collection, item: 1, action: 'update', changedFields: ['state'], at: T0 * 1000 })
const outbound = (over: Partial<Parameters<typeof noteOutbound>[0]> = {}) =>
  noteOutbound({
    apiId: 7,
    apiName: 'MDSi',
    status: 200,
    durationMs: 300,
    at: T0 * 1000,
    method: 'POST',
    path: '/api/deploymentRequests',
    ...over
  })
const CRON = { id: 'cron:nightly-sync', label: 'nightly-sync', kind: 'cron' as const }

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0 * 1000)
  resetTrafficMap()
  advanceTo(T0)
  vi.mocked(currentTraceMeta).mockReturnValue(null)
})
afterEach(() => {
  clearTrafficNodes('efp-ops')
  vi.useRealTimers()
})

describe('source attribution (#1105 / #1106 / #1143)', () => {
  it('a write inside a cron run lands on the job, not the generic cron caller', () => {
    withTrafficSource(CRON, () => write())
    const s = snap()
    expect(s.sources).toEqual([
      { id: 'cron:nightly-sync', label: 'nightly-sync', kind: 'cron', req: 1, error: 0 }
    ])
    expect(s.callers.map((c) => c.key)).toEqual(['cron:nightly-sync'])
    const wf = s.entities.find((e) => e.key === 'items/workflows')
    expect(wf?.callers).toEqual([{ key: 'cron:nightly-sync', n: 1 }])
    const ev = drainEvents()[0]
    expect(ev).toMatchObject({ caller: 'cron:nightly-sync', via: 'cron' })
  })

  it('a flow inside a request wins over the request caller', () => {
    vi.mocked(currentTraceMeta).mockReturnValue({
      id: 'r1',
      urlHint: '/api/items/workflows/1',
      userId: 'U1'
    })
    withTrafficSource({ id: 'flow:abc', label: 'Notify', kind: 'flow' }, () => write('forecasts'))
    const frame = buildFrame(T0, { sockets: 0, journalSeq: null })
    expect(frame.edges_in).toEqual({ 'flow:abc>items': 1 })
  })

  it('a partner call from a job counts on the job (and its source → down edge), never on cron', () => {
    withTrafficSource(CRON, () => outbound({ status: 500 }))
    const s = snap()
    expect(s.callers).toEqual([{ key: 'cron:nightly-sync', req: 1, error: 1 }])
    const sources = ext('sources') as { sd: Record<string, number> }
    expect(sources.sd).toEqual({ 'cron:nightly-sync>ext:7': 1 })
  })

  it('records run outcomes and the import run in progress', async () => {
    await runAsTrafficSource(CRON, async () => undefined)
    await expect(
      runAsTrafficSource(CRON, async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    noteImportRun('start', { run_id: 42, key: 'purchase_orders', label: 'Purchase orders' })
    noteImportRun('rows', { run_id: 42, key: 'purchase_orders', rows: 500 })
    const sources = ext('sources') as {
      sources: Record<string, { runs: number; errors: number; last: { ok: boolean } }>
      import: { current: { run_id: number; rows: number } }
    }
    expect(sources.sources['cron:nightly-sync']).toMatchObject({ runs: 2, errors: 1 })
    expect(sources.sources['cron:nightly-sync'].last.ok).toBe(false)
    expect(sources.import.current).toMatchObject({ run_id: 42, rows: 500 })
  })

  it('names a flow trigger by job, collection, request lane, then trigger kind', () => {
    expect(withTrafficSource(CRON, () => flowTriggerKey('schedule', {}))).toBe('cron:nightly-sync')
    expect(flowTriggerKey('event', { collection: 'workflows' })).toBe('items/workflows')
    expect(flowTriggerKey('event', { collection: 'nivaro_users' })).toBe('system/nivaro_users')
    expect(flowTriggerKey('shadow:webhook', {})).toBe('trigger:webhook')
    vi.mocked(currentTraceMeta).mockReturnValue({
      id: 'r',
      urlHint: '/api/widgets-internal/12/render',
      userId: null
    })
    expect(flowTriggerKey('manual', {})).toBe('widgets/12')
  })
})

describe('socket lane (#1104)', () => {
  it('counts events per entity on the socket lane, attributed to the browsers source', () => {
    noteSocket('record:join')
    noteSocket('record:join')
    noteSocket('nvr:pong')
    const s = snap()
    const rec = s.entities.find((e) => e.key === 'socket/record.join')
    expect(rec).toMatchObject({ lane: 'socket', req: 2, read: 2 })
    expect(s.sources?.[0]).toMatchObject({ id: SOCKET_SOURCE, kind: 'socket', req: 3 })
    expect(drainEvents()).toEqual([]) // never a ticker row
  })

  it('folds a malformed event name into `other`', () => {
    expect(socketEntity('chat:message')).toBe('chat.message')
    expect(socketEntity('bad name!')).toBe('other')
    expect(socketEntity('')).toBe('other')
  })
})

describe('extension-declared nodes (#1114)', () => {
  it('routes a matching partner call to the declared node, first match wins', () => {
    registerTrafficNode('efp-ops', {
      id: 'mdsi-orders',
      label: 'MDSi deployment requests',
      match: { api: 'mdsi', path: '/api/deploymentRequests' }
    })
    registerTrafficNode('efp-ops', { id: 'mdsi', label: 'MDSi', match: { api: ['MDSi'] } })
    outbound()
    outbound({ path: '/api/shipmentNotificationInquiries' })
    outbound({ apiId: 9, apiName: 'Fusion IIP', path: '/x' })
    const down = snap().down
    expect(down.find((d) => d.id === 'x:efp-ops.mdsi-orders')).toMatchObject({
      label: 'MDSi deployment requests',
      kind: 'partner',
      req: 1
    })
    expect(down.find((d) => d.id === 'x:efp-ops.mdsi')).toMatchObject({ req: 1 })
    expect(down.find((d) => d.id === 'ext:9')).toMatchObject({ kind: 'partner', req: 1 })
  })

  it('refuses a malformed id and never matches an empty spec', () => {
    expect(() => registerTrafficNode('efp-ops', { id: 'bad id', label: 'x', match: {} })).toThrow()
    registerTrafficNode('efp-ops', { id: 'none', label: 'None', match: {} })
    expect(
      resolveTrafficNode({ apiId: 1, apiName: 'A', status: 200, durationMs: 1, at: 0 })
    ).toBeNull()
  })
})

describe('partner error classes (#1112)', () => {
  it('classifies with the applySendOutcome vocabulary', () => {
    expect(partnerErrorClass(200, null)).toBeNull()
    expect(partnerErrorClass(429, null)).toBe('rate_limited')
    expect(partnerErrorClass(401, null)).toBe('auth')
    expect(partnerErrorClass(404, null)).toBe('not_found')
    expect(partnerErrorClass(503, null)).toBe('transient')
    expect(partnerErrorClass(422, null)).toBe('validation')
    expect(partnerErrorClass(null, 'connect ECONNREFUSED')).toBe('transient')
    expect(dominantClass({ auth: 2, transient: 2, validation: 1 })).toBe('transient')
    expect(dominantClass({})).toBeNull()
    expect(latencyBucket(50)).toBe(0)
    expect(latencyBucket(20000)).toBe(7)
  })

  it('keeps classes + a latency histogram per partner node in the snapshot and frame', () => {
    outbound({ status: 429, durationMs: 120 })
    outbound({ status: 429, durationMs: 130 })
    outbound({ status: 200, durationMs: 3000 })
    const p = ext('partners') as { downs: Record<string, { classes: object; hist: number[] }> }
    expect(p.downs['ext:7'].classes).toEqual({ rate_limited: 2 })
    expect(p.downs['ext:7'].hist).toEqual([0, 2, 0, 0, 0, 1, 0, 0])
    const frame = buildFrame(T0, { sockets: 0, journalSeq: null })
    expect(frame.ext?.partners).toEqual({ classes: { 'ext:7': { rate_limited: 2 } } })
  })
})

describe('pool pressure (#1109)', () => {
  it('uses the pool-monitor thresholds (amber) and twice them (red)', () => {
    expect(poolLevel({ acquires: 80, wait_p95_ms: 100, saturated_pct: 0 })).toBe('ok')
    expect(poolLevel({ acquires: 80, wait_p95_ms: 640, saturated_pct: 0 })).toBe('warn')
    expect(poolLevel({ acquires: 10, wait_p95_ms: 5000, saturated_pct: 0 })).toBe('ok')
    expect(poolLevel({ acquires: 0, wait_p95_ms: 0, saturated_pct: 30 })).toBe('warn')
    expect(poolLevel({ acquires: 80, wait_p95_ms: 1200, saturated_pct: 0 })).toBe('error')
    expect(poolLevel({ acquires: 0, wait_p95_ms: 0, saturated_pct: 60 })).toBe('error')
    expect(ext('pool')).toMatchObject({ wait_p95_ms: 640, level: 'warn' })
  })
})

describe('redis detail (#1148)', () => {
  it('maps keys to families without keeping the key', () => {
    expect(redisFamily('sess:abc')).toBe('sessions')
    expect(redisFamily('sess:revoked:abc')).toBe('session revocations')
    expect(redisFamily('cq:slug:{}')).toBe('query cache')
    expect(redisFamily('nvr:idem:u1:x')).toBe('idempotency keys')
    expect(redisFamily('nvr:transition:1:2')).toBe('transition guard')
    expect(redisFamily(Buffer.from('nvr:cron:leader'))).toBe('scheduler lease')
    expect(redisFamily('foo:bar:baz')).toBe('foo:bar:*')
    expect(redisFamily(undefined)).toBe('no key')
  })

  it('counts commands from a wrapped client, once', () => {
    const sent: unknown[] = []
    const client = {
      sendCommand(cmd: unknown) {
        sent.push(cmd)
        return 'OK'
      }
    }
    instrumentRedis(client)
    instrumentRedis(client) // second wrap is a no-op
    client.sendCommand({ name: 'get', args: ['sess:1'] })
    client.sendCommand({ name: 'set', args: ['cq:a', '1'] })
    expect(sent).toHaveLength(2)
    const r = ext('redis') as { commands: number; families: Array<{ family: string; n: number }> }
    expect(r.commands).toBe(2)
    expect(r.families.map((f) => f.family).sort()).toEqual(['query cache', 'sessions'])
    expect(buildFrame(T0, { sockets: 0, journalSeq: null }).ext?.redis).toEqual({ cps: 2 })
  })
})

describe('channels, AI, webhooks (#1140 / #1141 / #1144)', () => {
  it('channel sends are calls into the channel node; redirects are counted', () => {
    noteChannel('mail', 'sent', { ms: 40 })
    noteChannel('mail', 'failed', { ms: 900 })
    noteChannel('mail', 'deferred')
    noteChannelRedirect('mail', 2)
    const s = snap()
    expect(s.down.find((d) => d.id === 'mail')).toMatchObject({
      label: 'Email',
      kind: 'channel',
      req: 3,
      error: 1
    })
    expect((ext('channels') as Record<string, object>).mail).toEqual({
      sent: 1,
      failed: 1,
      dropped: 0,
      deferred: 1,
      redirected: 2
    })
  })

  it('AI calls carry tokens, cost and fallbacks per provider', () => {
    noteAiCall({
      provider: 'gateway-openai',
      model: 'claude-4-6-sonnet',
      ok: true,
      ms: 1800,
      input: 4000,
      output: 300,
      cached: 3500,
      cost: 0.0123
    })
    noteAiCall({ provider: 'gateway-openai', model: 'claude-x', ok: false, ms: 200 })
    noteAiFallback('claude-x', 'claude-4-6-sonnet')
    const s = snap()
    expect(s.down.find((d) => d.id === 'ai:gateway-openai')).toMatchObject({
      kind: 'ai',
      req: 2,
      error: 1
    })
    const ai = ext('ai') as {
      providers: Record<string, Record<string, unknown>>
      fallbacks: Array<{ from: string; to: string; n: number }>
    }
    expect(ai.providers['ai:gateway-openai']).toMatchObject({
      calls: 2,
      errors: 1,
      in: 4000,
      out: 300,
      cached: 3500,
      cost: 0.0123
    })
    expect(ai.fallbacks).toEqual([{ from: 'claude-x', to: 'claude-4-6-sonnet', n: 1 }])
  })

  it('webhook deliveries are a node per webhook, labelled by name or host only', () => {
    expect(webhookLabel({ id: 3, url: 'https://hooks.example.com/x?token=secret' })).toBe(
      'Webhook · hooks.example.com'
    )
    expect(webhookLabel({ id: 3, url: 'x', name: 'Order sync' })).toBe('Webhook · Order sync')
    noteWebhookDelivery({
      webhook: { id: 3, url: 'https://a.example' },
      status: 500,
      ms: 6000,
      success: false
    })
    noteWebhookDelivery({
      webhook: { id: 3, url: 'https://a.example' },
      status: 200,
      ms: 50,
      success: true
    })
    expect(snap().down.find((d) => d.id === 'webhook:3')).toMatchObject({
      kind: 'webhook',
      req: 2,
      error: 1
    })
    expect(ext('webhooks')).toEqual({
      slow_ms: 5000,
      webhooks: { 'webhook:3': { failed: 1, slow: 1, codes: { '500': 1, '200': 1 } } }
    })
  })
})

describe('down history + helpers', () => {
  it('buckets rows like the partner history', () => {
    const now = new Date(T0 * 1000)
    const body = summarizeDownRows(
      'mail',
      1,
      [
        { at: new Date((T0 - 30) * 1000), ok: true, code: 'sent', path: 'notice' },
        { at: new Date((T0 - 30) * 1000), ok: false, code: 'failed', ms: 400, path: 'notice' },
        { at: new Date((T0 - 7200) * 1000), ok: true, code: 'sent' }
      ],
      now
    )
    expect(body.totals).toEqual({ req: 2, error: 1 })
    expect(body.status_codes).toEqual({ sent: 1, failed: 1 })
    expect(body.top_paths).toEqual([{ path: 'notice', n: 2 }])
    expect(body.series).toHaveLength(60)
    expect(body.series[59]).toMatchObject({ req: 2, error: 1, p95: 400 })
  })

  it('MinuteTotals sums floats past the Uint16 ceiling and caps keys', () => {
    const t = new MinuteTotals(2)
    t.add('a', T0, 100_000)
    t.add('a', T0, 0.5)
    t.add('b', T0, 1)
    t.add('c', T0, 1) // over the cap: folds into __other__
    expect(t.sum('a', 60, T0)).toBe(100_000.5)
    expect(t.entries(60, T0).map(([k]) => k)).toEqual(['a', 'b', '__other__'])
  })
})

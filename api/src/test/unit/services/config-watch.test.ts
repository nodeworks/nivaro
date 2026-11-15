import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const emitted: Array<{ room: string; event: string; payload: Record<string, unknown> }> = []
vi.mock('../../../services/io-holder.js', () => ({
  getIo: () => ({
    to: (room: string) => ({
      emit: (event: string, payload: Record<string, unknown>) =>
        emitted.push({ room, event, payload })
    })
  })
}))

const {
  _resetConfigWatchForTests,
  configTargetOf,
  configTopic,
  mergePokes,
  parseConfigTopic,
  pokeConfig,
  staleConfigRefusal
} = await import('../../../services/config-watch.js')
const { opsTopicGate } = await import('../../../services/ops-live.js')

const U = '3f2a1c4e-1111-4222-8333-444455556666'

describe('configTargetOf (rt4 #14/#18)', () => {
  it('names the object of direct writes', () => {
    expect(configTargetOf('PATCH', `/api/flows/${U}`)).toEqual({
      kind: 'flow',
      id: U,
      part: 'settings'
    })
    expect(configTargetOf('POST', `/api/flows/${U}/operations`)).toEqual({
      kind: 'flow',
      id: U,
      part: 'step'
    })
    expect(configTargetOf('PATCH', '/api/rules/12')).toEqual({
      kind: 'rule',
      id: '12',
      part: 'settings'
    })
    expect(configTargetOf('PATCH', '/api/external-apis/7')).toEqual({
      kind: 'external-api',
      id: '7',
      part: 'settings'
    })
    expect(configTargetOf('PUT', '/api/payload-templates/order-create/draft')).toEqual({
      kind: 'payload',
      id: 'order-create',
      part: 'draft'
    })
    expect(configTargetOf('POST', `/api/pipelines/${U}/states`)).toEqual({
      kind: 'pipeline',
      id: U,
      part: 'state'
    })
    expect(configTargetOf('POST', `/api/dashboards/${U}/widgets`)).toEqual({
      kind: 'dashboard',
      id: U,
      part: 'widget'
    })
    expect(configTargetOf('PUT', `/api/report-studio/${U}/widgets`)).toEqual({
      kind: 'report',
      id: U,
      part: 'widget'
    })
  })

  it('looks child rows up to their pipeline / API / dashboard', () => {
    expect(configTargetOf('PATCH', `/api/pipelines/states/${U}`)).toMatchObject({
      kind: 'pipeline',
      part: 'state',
      lookup: { table: 'nivaro_workflow_states', column: 'template', key: U }
    })
    expect(configTargetOf('DELETE', `/api/pipelines/transitions/${U}`)).toMatchObject({
      part: 'transition',
      lookup: { table: 'nivaro_workflow_transitions' }
    })
    expect(configTargetOf('POST', `/api/pipelines/owner-groups/${U}/users`)).toMatchObject({
      part: 'owners',
      lookup: { table: 'nivaro_pipeline_owner_groups', column: 'template' }
    })
    expect(configTargetOf('DELETE', '/api/pipelines/dimensions/4')).toMatchObject({
      part: 'owners',
      lookup2: { table: 'nivaro_pipeline_owner_dimensions', parent: 'nivaro_workflow_bindings' }
    })
    expect(configTargetOf('PATCH', '/api/external-apis/endpoints/9')).toMatchObject({
      kind: 'external-api',
      lookup: { table: 'nivaro_external_api_endpoints', column: 'api_id', key: '9' }
    })
    expect(configTargetOf('PATCH', `/api/dashboards/widgets/${U}`)).toMatchObject({
      kind: 'dashboard',
      lookup: { table: 'nivaro_dashboard_widgets', column: 'dashboard' }
    })
  })

  it('skips reads, runs, record-level writes and new objects', () => {
    expect(configTargetOf('GET', `/api/flows/${U}`)).toBeNull()
    expect(configTargetOf('POST', `/api/flows/${U}/test`)).toBeNull()
    expect(configTargetOf('POST', `/api/flows/${U}/trigger`)).toBeNull()
    expect(configTargetOf('POST', '/api/flows/webhook/abc')).toBeNull()
    expect(configTargetOf('POST', '/api/payload-templates/order-create/preview')).toBeNull()
    expect(configTargetOf('POST', `/api/pipelines/${U}/simulate-impact`)).toBeNull()
    expect(configTargetOf('POST', `/api/pipelines/${U}/start-missing`)).toBeNull()
    expect(configTargetOf('POST', '/api/pipelines/instance/workflows/12/start')).toBeNull()
    expect(configTargetOf('DELETE', `/api/pipelines/instance-owners/${U}`)).toBeNull()
    expect(configTargetOf('POST', `/api/dashboards/widgets/${U}/drill`)).toBeNull()
    expect(configTargetOf('POST', '/api/dashboards/ai-build')).toBeNull()
    expect(configTargetOf('POST', `/api/report-studio/${U}/email`)).toBeNull()
    expect(configTargetOf('POST', '/api/flows')).toBeNull()
    expect(configTargetOf('PATCH', '/api/items/workflows/12')).toBeNull()
  })
})

describe('topics and gates', () => {
  it('parses and gates cfg topics', () => {
    expect(configTopic('flow', U)).toBe(`cfg-flow:${U}`)
    expect(parseConfigTopic(`cfg-dashboard:${U}`)).toEqual({ kind: 'dashboard', id: U })
    expect(parseConfigTopic('cfg-flow:../x')).toBeNull()
    expect(opsTopicGate(`cfg-flow:${U}`)).toEqual({ topic: `cfg-flow:${U}`, gate: 'admin' })
    expect(opsTopicGate(`cfg-dashboard:${U}`)).toEqual({
      topic: `cfg-dashboard:${U}`,
      gate: 'dashboard'
    })
    expect(opsTopicGate('cfg-report:9')).toEqual({ topic: 'cfg-report:9', gate: 'report' })
    expect(opsTopicGate('cfg-users:9')).toBeNull()
    expect(opsTopicGate('cfg-flow:a b')).toBeNull()
    // the older topics are unchanged
    expect(opsTopicGate('layout:42')).toEqual({ topic: 'layout:42', gate: 'admin' })
    expect(opsTopicGate('layout:abc')).toBeNull()
  })
})

describe('pokes', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    emitted.length = 0
    _resetConfigWatchForTests()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('coalesces a burst into one poke and names who only on admin topics', () => {
    const beth = { id: 'b-1', name: 'Beth' }
    pokeConfig('pipeline', U, { part: 'state', by: beth }, '')
    pokeConfig('pipeline', U, { part: 'state', by: beth }, '')
    pokeConfig('pipeline', U, { part: 'owners', by: beth }, '')
    vi.advanceTimersByTime(350)
    expect(emitted).toHaveLength(1)
    expect(emitted[0].event).toBe('ops:changed')
    expect(emitted[0].room).toBe(`ops:cfg-pipeline:${U}`)
    expect(emitted[0].payload).toMatchObject({
      topic: `cfg-pipeline:${U}`,
      part: 'several',
      by: beth
    })

    pokeConfig('dashboard', U, { part: 'widget', by: beth }, '')
    vi.advanceTimersByTime(350)
    const dash = emitted[emitted.length - 1]
    expect(dash.payload.topic).toBe(`cfg-dashboard:${U}`)
    expect(dash.payload.by).toBeUndefined()
  })

  it('a write during the cooldown pokes once more at its end', () => {
    pokeConfig('flow', U, { part: 'step', by: null }, '')
    vi.advanceTimersByTime(350)
    pokeConfig('flow', U, { part: 'step', by: null }, '')
    expect(emitted).toHaveLength(1)
    vi.advanceTimersByTime(1100)
    expect(emitted).toHaveLength(2)
    vi.advanceTimersByTime(2000)
    expect(emitted).toHaveLength(2)
  })

  it('mergePokes keeps the same part and person, else several / the latest', () => {
    const a = { part: 'state', by: { id: '1', name: 'A' } }
    expect(mergePokes(null, a)).toEqual(a)
    expect(mergePokes(a, { part: 'state', by: { id: '1', name: 'A' } }).part).toBe('state')
    expect(mergePokes(a, { part: 'step', by: { id: '2', name: 'B' } })).toEqual({
      part: 'several',
      by: { id: '2', name: 'B' }
    })
  })
})

describe('staleConfigRefusal (no silent overwrite)', () => {
  const at = new Date('2026-11-14T10:00:00.123Z')
  it('passes without a header, or when the loaded copy is current', () => {
    expect(staleConfigRefusal({ headers: {} }, at)).toBeNull()
    expect(staleConfigRefusal({ headers: { 'x-nivaro-base-rev': 'nonsense' } }, at)).toBeNull()
    expect(
      staleConfigRefusal({ headers: { 'x-nivaro-base-rev': '2026-11-14T10:00:00.123Z' } }, at)
    ).toBeNull()
    // SQL Server datetime rounding
    expect(
      staleConfigRefusal({ headers: { 'x-nivaro-base-rev': '2026-11-14T10:00:00.121Z' } }, at)
    ).toBeNull()
  })
  it('refuses a save made from an older copy', () => {
    const r = staleConfigRefusal(
      { headers: { 'x-nivaro-base-rev': '2026-11-14T09:59:00.000Z' } },
      at
    )
    expect(r).toMatchObject({ code: 'CONFIG_STALE', updated_at: '2026-11-14T10:00:00.123Z' })
  })
})

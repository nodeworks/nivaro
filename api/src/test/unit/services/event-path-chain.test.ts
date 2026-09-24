import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PathStep } from '../../../services/event-path/types.js'

vi.mock('../../../services/event-path/exact.js', () => ({ loadChainSteps: vi.fn() }))
vi.mock('../../../services/event-path/inferred.js', () => ({ inferSteps: vi.fn() }))
vi.mock('../../../services/chain-roots.js', () => ({
  replayLinks: vi.fn(async () => ({ replay_of: 'aaaa', replayed_as: ['bbbb'] }))
}))
vi.mock('../../../services/integration-event-sources.js', () => ({ getEvent: vi.fn() }))
vi.mock('../../../services/queues.js', () => ({ getLabels: vi.fn(async () => ({})) }))

import { replayLinks } from '../../../services/chain-roots.js'
import { loadChainSteps } from '../../../services/event-path/exact.js'
import { buildChainPath, chainRootStep } from '../../../services/event-path/index.js'
import { getEvent } from '../../../services/integration-event-sources.js'

const T0 = '2026-09-24T10:00:00.000Z'
const at = (ms: number) => new Date(Date.parse(T0) + ms).toISOString()
const CHAIN = '8b6213be-eae8-4cb2-b027-2f0ab216282b'

const cronSteps: PathStep[] = [
  { key: 'activity:1', parent: 'cron:nightly', kind: 'write', at: at(200), summary: 'w' },
  {
    key: 'submission:2',
    parent: 'activity:1',
    kind: 'push',
    at: at(900),
    summary: 'Push to MWF · failed',
    failed: true
  }
]

beforeEach(() => vi.clearAllMocks())

describe('buildChainPath', () => {
  it('is null when the chain left no rows', async () => {
    vi.mocked(loadChainSteps).mockResolvedValueOnce({ steps: [], rootStep: null, warnings: [] })
    expect(await buildChainPath(CHAIN, { isAdmin: true })).toBeNull()
    expect(replayLinks).not.toHaveBeenCalled()
  })

  it('roots a chain with no request log at the key its top steps point at', async () => {
    vi.mocked(loadChainSteps).mockResolvedValueOnce({
      steps: cronSteps,
      rootStep: null,
      warnings: ['one table unread']
    })
    const path = await buildChainPath(CHAIN, { isAdmin: true })
    expect(path).not.toBeNull()
    expect(path?.mode).toBe('exact')
    expect(path?.root.key).toBe('cron:nightly')
    expect(path?.root.kind).toBe('cron')
    expect(path?.root.children[0].key).toBe('activity:1')
    expect(path?.first_failure).toBe('submission:2')
    expect(path?.replay_of).toBe('aaaa')
    expect(path?.replayed_as).toEqual(['bbbb'])
    expect(path?.warnings).toEqual(['one table unread'])
    expect(vi.mocked(loadChainSteps).mock.calls[0]).toEqual([CHAIN, { withBodies: true }])
    expect(getEvent).not.toHaveBeenCalled()
  })

  it('uses the chain request log as the root when there is one', async () => {
    const root: PathStep = {
      key: `request:${CHAIN}`,
      parent: null,
      kind: 'request',
      at: T0,
      summary: 'POST /graphql · 200'
    }
    vi.mocked(loadChainSteps).mockResolvedValueOnce({
      steps: [{ key: 'activity:5', parent: root.key, kind: 'write', at: at(50), summary: 'w' }],
      rootStep: root,
      warnings: []
    })
    const path = await buildChainPath(CHAIN, { isAdmin: false })
    expect(path?.root.key).toBe(root.key)
    expect(path?.root.children.map((c) => c.key)).toEqual(['activity:5'])
    expect(vi.mocked(loadChainSteps).mock.calls[0][1]).toEqual({ withBodies: false })
  })

  it('drops steps on records the viewer cannot read and counts them', async () => {
    vi.mocked(loadChainSteps).mockResolvedValueOnce({
      steps: [
        {
          key: 'activity:1',
          parent: 'cron:nightly',
          kind: 'write',
          at: at(10),
          summary: 'w',
          record: { collection: 'workflows', item: '1' }
        }
      ],
      rootStep: null,
      warnings: []
    })
    const path = await buildChainPath(CHAIN, {
      isAdmin: false,
      canReadRecords: async () => new Set<string>()
    })
    expect(path?.root.children).toEqual([])
    expect(path?.hidden_steps).toBe(1)
  })
})

describe('chainRootStep', () => {
  it('names import and fallback roots and dates them by the earliest step', () => {
    const imp = chainRootStep(CHAIN, [
      { key: 'activity:1', parent: 'import_run:12', kind: 'write', at: at(500), summary: 'a' },
      { key: 'activity:2', parent: 'import_run:12', kind: 'write', at: at(100), summary: 'b' }
    ])
    expect(imp).toMatchObject({ key: 'import_run:12', kind: 'import', summary: 'Import run 12' })
    expect(imp.at).toBe(at(100))
    const bare = chainRootStep(CHAIN, [
      { key: 'activity:1', parent: 'auto', kind: 'write', at: T0, summary: 'a' }
    ])
    expect(bare.key).toBe(`root:${CHAIN}`)
    expect(bare.kind).toBe('feed')
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'

// Command Center security pass: caches, nudge allowance, log masking, labels as the caller,
// the manager's "usual", and the credential-minting route patterns.

vi.mock('../../db/index.js', () => ({
  db: vi.fn(() => {
    throw new Error('no database in tests')
  })
}))
vi.mock('../../lib/column-probe.js', () => ({ hasColumn: async () => false }))

const labelsAsUser = vi.hoisted(() => vi.fn())
const legacyLabels = vi.hoisted(() => vi.fn(async () => ({})))
vi.mock('../ai-link-labels.js', () => ({ linkLabelsAsUser: labelsAsUser }))
vi.mock('../queues.js', () => ({ getLabels: legacyLabels }))
vi.mock('./open-work.js', () => ({
  liveOpenWork: async () => undefined,
  openWorkFor: async () => ({ index: undefined, liveOnly: false })
}))

import { delegatedWriteRefusal } from '../../middleware/authenticate.js'
import type { User } from '../../types.js'
import { logRouteError } from '../error-log-level.js'
import { oauthAudienceRefusal } from '../mcp-config.js'
import { maskUrlPath, maskUrlQuery } from '../secret-mask.js'
import { computeAttention } from './attention.js'
import {
  memoryNudgeStore,
  NUDGE_MAX_OWNERS,
  NUDGE_SENDER_PER_HOUR,
  type NudgeDeps,
  runNudge
} from './nudge.js'
import type { OpenWorkIndex } from './open-work.js'
import { computeSnapshotRisk } from './risk.js'
import { memoSizes, resetTenantMemos, tenantMemo, Viewer } from './work-access.js'
import { assembleWorkload } from './workload.js'

const user = { id: 'U-1', first_name: 'Pat', last_name: 'Lee', email: 'pat@x' } as unknown as User

beforeEach(() => {
  resetTenantMemos()
  labelsAsUser.mockReset()
  legacyLabels.mockClear()
})

describe('the memo keeps shared entries when request-keyed ones churn', () => {
  it('600 request-keyed entries do not evict cc:open-work', async () => {
    const build = vi.fn(async () => 'index')
    await tenantMemo('cc:open-work', 60_000, build)
    for (let i = 0; i < 600; i++) await tenantMemo(`cc:flow:user${i}`, 60_000, async () => i)
    await tenantMemo('cc:open-work', 60_000, build)
    expect(build).toHaveBeenCalledTimes(1)
    const sizes = memoSizes()
    expect(sizes.pinned).toBe(1)
    expect(sizes.requests).toBeLessThanOrEqual(500)
  })

  it('request-keyed entries are an LRU: a recently used one survives', async () => {
    const build = vi.fn(async () => 'hot')
    await tenantMemo('cc:flow:hot', 60_000, build)
    for (let i = 0; i < 499; i++) await tenantMemo(`cc:flow:cold${i}`, 60_000, async () => i)
    await tenantMemo('cc:flow:hot', 60_000, build) // touch
    for (let i = 0; i < 10; i++) await tenantMemo(`cc:flow:more${i}`, 60_000, async () => i)
    await tenantMemo('cc:flow:hot', 60_000, build)
    expect(build).toHaveBeenCalledTimes(1)
  })
})

describe('nudge allowance', () => {
  const deps = (owners = 2): NudgeDeps & { sent: string[] } => {
    const sent: string[] = []
    return {
      sent,
      store: memoryNudgeStore(),
      canSee: async () => true,
      owners: async () =>
        Array.from({ length: owners }, (_, i) => ({ id: `O-${i}`, name: `Owner ${i}` })),
      label: async () => 'WO-42',
      notify: async (id) => {
        sent.push(id)
      },
      log: async () => undefined
    }
  }

  it('stops one person after 20 nudges an hour, whatever the records', async () => {
    const d = deps()
    for (let i = 0; i < NUDGE_SENDER_PER_HOUR; i++) {
      const r = await runNudge(user, false, { collection: 'wo', item: String(i) }, d)
      expect(r.status, String(i)).toBe(200)
    }
    const over = await runNudge(user, false, { collection: 'wo', item: '99' }, d)
    expect(over.status).toBe(429)
    expect('error' in over.body && over.body.error).toMatch(/20 nudges/)
  })

  it('another person has their own allowance', async () => {
    const d = deps()
    for (let i = 0; i < NUDGE_SENDER_PER_HOUR; i++)
      await runNudge(user, false, { collection: 'wo', item: String(i) }, d)
    const other = { ...user, id: 'U-2' } as User
    expect((await runNudge(other, false, { collection: 'wo', item: '500' }, d)).status).toBe(200)
  })

  it('notifies at most 25 owners per nudge', async () => {
    const d = deps(60)
    const r = await runNudge(user, false, { collection: 'wo', item: '1' }, d)
    expect(r.status).toBe(200)
    expect(d.sent).toHaveLength(NUDGE_MAX_OWNERS)
  })
})

describe('logs never carry the wallboard token', () => {
  const T = 'ab'.repeat(24)
  it('masks the token in the page path and the query', () => {
    expect(maskUrlPath(`/command/kiosk/${T}`)).toBe('/command/kiosk/••••••')
    expect(maskUrlQuery(`/command/kiosk/${T}?x=1`)).toBe('/command/kiosk/••••••?x=1')
    expect(maskUrlQuery(`/api/command-center/snapshot?kiosk=${T}&region=7`)).toBe(
      '/api/command-center/snapshot?kiosk=••••••&region=7'
    )
    expect(maskUrlQuery('/api/items/orders?limit=5')).toBe('/api/items/orders?limit=5')
    expect(maskUrlQuery('/command/kiosk')).toBe('/command/kiosk')
  })

  it('the route error log line is masked', () => {
    const info = vi.fn()
    logRouteError(
      { error: vi.fn(), info },
      new Error('nope'),
      404,
      `/command/kiosk/${T}?kiosk=${T}`
    )
    expect(JSON.stringify(info.mock.calls)).not.toContain(T)
  })
})

describe('credential-minting route patterns', () => {
  it('a View-as token cannot write kiosk links', () => {
    const req = { method: 'POST', url: '/api/command-center/kiosk-links' } as never
    expect(delegatedWriteRefusal(req)).not.toBeNull()
    expect(
      delegatedWriteRefusal({ method: 'GET', url: '/api/command-center/kiosk-links' } as never)
    ).toBeNull()
  })

  it('a connected app cannot write kiosk links', () => {
    const r = oauthAudienceRefusal({
      method: 'POST',
      url: '/api/command-center/kiosk-links',
      mcpInner: true
    } as never)
    expect(r).not.toBeNull()
  })
})

describe('attention titles are labelled as the caller', () => {
  it('uses linkLabelsAsUser (not the system label read)', async () => {
    labelsAsUser.mockResolvedValue({ 'wo:1': 'Pump failure' })
    const index: OpenWorkIndex = {
      as_of: Date.now(),
      live: true,
      truncated: false,
      bindings: [{ collection: 'wo', template: 'T1', template_name: 'Work orders' }],
      states: new Map([
        [
          'S1',
          {
            id: 'S1',
            template: 'T1',
            key: 'new',
            label: 'New',
            color: null,
            sort: 1,
            is_terminal: false
          }
        ]
      ]),
      open: [
        {
          instance_id: 'I1',
          collection: 'wo',
          template: 'T1',
          item: '1',
          state_id: 'S1',
          started_at: Date.now() - 1000,
          entered_at: Date.now() - 1000,
          sla: 'breached',
          sla_remaining_h: -2
        }
      ],
      recent: []
    }
    const viewer = new Viewer(user, true, null)
    const items = await computeAttention({
      user,
      viewer,
      index,
      stuckDays: 3,
      isAdmin: false,
      userId: 'U-1',
      collectionLabel: new Map([['wo', 'Work orders']])
    })
    expect(labelsAsUser).toHaveBeenCalledTimes(1)
    expect(labelsAsUser.mock.calls[0][0]).toBe(user)
    expect(legacyLabels).not.toHaveBeenCalled()
    expect(items.find((i) => i.kind === 'sla_breached')?.title).toBe('Pump failure')
  })

  it('falls back to #id for a record the caller cannot read', async () => {
    labelsAsUser.mockResolvedValue({})
    const index: OpenWorkIndex = {
      as_of: Date.now(),
      live: true,
      truncated: false,
      bindings: [{ collection: 'wo', template: 'T1', template_name: 'W' }],
      states: new Map(),
      open: [
        {
          instance_id: 'I1',
          collection: 'wo',
          template: 'T1',
          item: '7',
          state_id: 'S1',
          started_at: 1,
          entered_at: 1,
          sla: 'breached',
          sla_remaining_h: -2
        }
      ],
      recent: []
    }
    const items = await computeAttention({
      user,
      viewer: new Viewer(user, true, null),
      index,
      stuckDays: 3,
      isAdmin: false,
      userId: 'U-1',
      collectionLabel: new Map()
    })
    expect(items.find((i) => i.kind === 'sla_breached')?.title).toBe('#7')
  })
})

describe('a manager’s usual is never scaled from records they cannot open', () => {
  it('uses the median of the visible counts, ignoring hidden totals and history', () => {
    // As workloadForRequest builds a manager's people: fullOpen = open, no history.
    const rows = assembleWorkload([
      { id: 'a', name: 'A', open: 2, fullOpen: 2, out: false, history: [] },
      { id: 'b', name: 'B', open: 4, fullOpen: 4, out: false, history: [] },
      { id: 'c', name: 'C', open: 6, fullOpen: 6, out: false, history: [] }
    ])
    expect(rows.map((r) => r.usual)).toEqual([4, 4, 4])
    expect(rows.every((r) => r.usual_source === 'team')).toBe(true)
  })
})

describe('the instance-wide open issues count is for administrators', () => {
  it('is null for anyone else', async () => {
    expect((await computeSnapshotRisk(new Viewer(user, false, null))).open_issues).toBeNull()
  })
})

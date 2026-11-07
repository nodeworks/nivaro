import { beforeEach, describe, expect, it, vi } from 'vitest'

// Army 5 b02-N2 / b02-N4 / b06-N1 / b13-N1: an IR in Engineering Review with
// nobody to approve it waited in silence.

const env = vi.hoisted(() => ({
  transitions: [] as Array<Record<string, unknown>>,
  existing: undefined as unknown,
  record: { id: '37777', user_created: 'AAAAAAAA-0000-0000-0000-00000000C0DE' } as Record<
    string,
    unknown
  >,
  notified: [] as Array<{ uid: string; subject: string; ack?: boolean }>
}))

vi.mock('../../../db/index.js', () => ({
  db: (table: string) => {
    const q: any = {
      join: () => q,
      where: () => q,
      whereNot: () => q,
      orderBy: () => q,
      select: async () =>
        table === 'nivaro_workflow_transitions'
          ? env.transitions
          : table.startsWith('nivaro_pipeline_owner_dimensions')
            ? []
            : [],
      first: async () =>
        table === 'nivaro_notifications'
          ? env.existing
          : table === 'inventory_request'
            ? env.record
            : undefined
    }
    return q
  }
}))
vi.mock('../../../services/support-tickets.js', () => ({
  supportAudience: async () => ['U-ADMIN1', 'U-ADMIN2']
}))
vi.mock('../../../services/notification-channels.js', () => ({
  notifyUser: vi.fn(
    async (_app: unknown, uid: string, o: { subject: string; ack_required?: boolean }) => {
      env.notified.push({ uid, subject: o.subject, ack: o.ack_required })
      return { id: 1 }
    }
  )
}))
vi.mock('../../../services/io-holder.js', () => ({ getApp: () => ({}), getIo: () => null }))
vi.mock('../../../services/pipeline-engine.js', () => ({
  resolveFilterValues: async () => new Map()
}))

import {
  creatorActsIn,
  creatorOfRow,
  gapMessage,
  isStaleGapSubject,
  isStallProne,
  noticeOwnerGap
} from '../../../services/owner-gap-notice.js'

const ER = {
  id: 'S-ER',
  template: 'T',
  key: 'engineering_review',
  label: 'Engineering Review',
  is_initial: false,
  is_terminal: false,
  owners_not_required: false
}

describe('isStallProne', () => {
  it('a step only owners may move stalls; one the creator may move does not', () => {
    const t = [
      { from_state: 'S-ER', allow_creator: false, auto_trigger: false },
      { from_state: 'S-WS', allow_creator: true, auto_trigger: false },
      { from_state: null, allow_creator: true, auto_trigger: false }
    ]
    expect(isStallProne(ER, t)).toBe(true)
    expect(isStallProne({ ...ER, id: 'S-WS' }, t)).toBe(false)
  })
  it('initial, terminal and owners-not-required steps never stall', () => {
    expect(isStallProne({ ...ER, is_initial: true }, [])).toBe(false)
    expect(isStallProne({ ...ER, is_terminal: 1 }, [])).toBe(false)
    expect(isStallProne({ ...ER, owners_not_required: true }, [])).toBe(false)
  })
})

describe('gapMessage', () => {
  it('names the record, the step and the dimensions', () => {
    expect(gapMessage('CM26INV-37394', 'Engineering Review', 'Zone 3 / PNR / Commercial')).toMatch(
      /^CM26INV-37394 is waiting in Engineering Review and nobody owns that step for Zone 3 \/ PNR \/ Commercial\./
    )
  })
})

describe('noticeOwnerGap', () => {
  beforeEach(() => {
    env.notified.length = 0
    env.existing = undefined
    env.transitions = [{ from_state: 'S-ER', allow_creator: false, auto_trigger: false }]
  })
  const args = {
    state: ER,
    actingOwners: [] as Array<{ id: string }>,
    friendlyId: 'CM26INV-37394',
    subjectCollection: 'inventory_request',
    subjectItem: '37777'
  }

  it('tells every administrator (Needs you) and the creator', async () => {
    const r = await noticeOwnerGap(args)
    expect(r).toEqual({ told: 2 })
    expect(env.notified.map((n) => n.uid)).toEqual([
      'U-ADMIN1',
      'U-ADMIN2',
      'AAAAAAAA-0000-0000-0000-00000000C0DE'
    ])
    expect(env.notified[0]).toMatchObject({
      subject: 'No approver: CM26INV-37394 in Engineering Review',
      ack: true
    })
    expect(env.notified[2].subject).toBe('No approver yet: CM26INV-37394 in Engineering Review')
  })

  it('once per record and step', async () => {
    env.existing = { id: 9 }
    expect(await noticeOwnerGap(args)).toEqual({ told: 0 })
    expect(env.notified).toEqual([])
  })

  it('nothing when someone can act, or the creator may move it on', async () => {
    expect(await noticeOwnerGap({ ...args, actingOwners: [{ id: 'U-NATHAN' }] })).toBeNull()
    env.transitions = [{ from_state: 'S-ER', allow_creator: true, auto_trigger: false }]
    expect(await noticeOwnerGap(args)).toBeNull()
    expect(env.notified).toEqual([])
  })
})

describe('creatorActsIn (army 6 M44)', () => {
  const t = [
    { from_state: 'S-ER', allow_creator: false, auto_trigger: false },
    { from_state: 'S-WS', allow_creator: true, auto_trigger: false },
    { from_state: 'S-OS', allow_creator: true, auto_trigger: true }
  ]
  it("a step whose manual way out the creator may take is the requester's move", () => {
    expect(creatorActsIn({ ...ER, id: 's-ws' }, t)).toBe(true)
    expect(creatorActsIn(ER, t)).toBe(false)
    // an automatic creator route is not a move a person makes
    expect(creatorActsIn({ ...ER, id: 'S-OS' }, t)).toBe(false)
  })
  it('never the start or a finished state', () => {
    expect(creatorActsIn({ ...ER, id: 'S-WS', is_initial: true }, t)).toBe(false)
    expect(creatorActsIn({ ...ER, id: 'S-WS', is_terminal: 1 }, t)).toBe(false)
  })
})

describe('creatorOfRow', () => {
  it('reads creator (workflows) or user_created (IRs) and the created date', () => {
    expect(
      creatorOfRow({
        user_created: 'AAAAAAAA-0000-0000-0000-00000000C0DE',
        date_created: '2026-11-07T15:00:00Z'
      })
    ).toEqual({
      id: 'AAAAAAAA-0000-0000-0000-00000000C0DE',
      created_at: '2026-11-07T15:00:00.000Z'
    })
    expect(
      creatorOfRow({ creator: 'BBBBBBBB-0000-0000-0000-00000000C0DE', created: null })
    ).toEqual({ id: 'BBBBBBBB-0000-0000-0000-00000000C0DE', created_at: null })
    expect(creatorOfRow({ creator: 7 })).toBeNull()
    expect(creatorOfRow(undefined)).toBeNull()
  })
})

describe('isStaleGapSubject (army 6 L31)', () => {
  it('a notice about a step the record has left is stale; the current one is not', () => {
    const fid = 'CM26INV-37423'
    expect(
      isStaleGapSubject(
        'No approver: CM26INV-37423 in Engineering Review',
        fid,
        'Warehouse Submission'
      )
    ).toBe(true)
    expect(
      isStaleGapSubject(
        'No approver yet: CM26INV-37423 in Engineering Review',
        fid,
        'Warehouse Submission'
      )
    ).toBe(true)
    expect(
      isStaleGapSubject(
        'No approver: CM26INV-37423 in Engineering Review',
        fid,
        'Engineering Review'
      )
    ).toBe(false)
    // another record, another kind of row
    expect(isStaleGapSubject('No approver: CM26INV-374230 in X', fid, null)).toBe(false)
    expect(isStaleGapSubject('Waiting on you: CM26INV-37423', fid, null)).toBe(false)
  })
})

describe('noticeOwnerGap dedupe', () => {
  it('an archived notice does not stop a new one (the record came back)', async () => {
    env.notified.length = 0
    env.existing = undefined // the query only finds OPEN notices
    env.transitions = [{ from_state: 'S-ER', allow_creator: false, auto_trigger: false }]
    const r = await noticeOwnerGap({
      state: ER,
      actingOwners: [],
      friendlyId: 'CM26INV-37423',
      subjectCollection: 'inventory_request',
      subjectItem: '37806'
    })
    expect(r?.told).toBe(2)
  })
})

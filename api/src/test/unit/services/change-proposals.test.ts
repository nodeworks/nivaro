import { beforeEach, describe, expect, it, vi } from 'vitest'

// Idea 6 — propose a change on a record locked after approval. The proposer is
// judged as if the record were open; the accepter writes as themselves with
// only the admin-only tier skipped. Permission edges: a field the proposer
// could not write is refused; an accepter who cannot write a field is refused.

type Row = Record<string, unknown>
const state = vi.hoisted(() => ({
  proposals: [] as Row[],
  record: { id: 'R1', title: 'Old title', amount: 100, secret: 's' } as Row,
  // who is who
  writable: new Map<string, string[] | null>(),
  readable: new Map<string, string[] | null>(),
  admins: new Set<string>(),
  owners: [] as string[],
  locked: true,
  switchOn: true,
  canUpdateItem: true,
  updates: [] as Array<{ user: string; payload: Row; opts: Row }>,
  updateError: null as null | Error,
  notified: [] as Array<{ to: string; subject: string; category?: string }>,
  runKey: 'approved',
  adminOnlyState: true,
  encrypted: [] as string[]
}))

// ── a tiny in-memory knex: enough for where/orWhere/whereIn/update/insert ──
vi.mock('../../../db/index.js', () => {
  type Pred = (r: Row) => boolean
  const cmp = (a: unknown, op: string, b: unknown) => {
    const x = a instanceof Date ? a.getTime() : a
    const y = b instanceof Date ? b.getTime() : b
    if (op === '<') return (x as number) < (y as number)
    if (op === '>') return (x as number) > (y as number)
    return String(x) === String(y)
  }
  class Q {
    clauses: Array<{ or: boolean; p: Pred }> = []
    pred(a: unknown, b?: unknown, c?: unknown): Pred {
      if (typeof a === 'function') {
        const sub = new Q()
        ;(a as (q: Q) => void)(sub)
        return (r) => sub.test(r)
      }
      if (a && typeof a === 'object')
        return (r) => Object.entries(a as Row).every(([k, v]) => cmp(r[k], '=', v))
      if (c === undefined) return (r) => cmp(r[a as string], '=', b)
      return (r) => r[a as string] != null && cmp(r[a as string], b as string, c)
    }
    where(a: unknown, b?: unknown, c?: unknown) {
      this.clauses.push({ or: false, p: this.pred(a, b, c) })
      return this
    }
    orWhere(a: unknown, b?: unknown, c?: unknown) {
      this.clauses.push({ or: true, p: this.pred(a, b, c) })
      return this
    }
    whereIn(col: string, vals: unknown[]) {
      this.clauses.push({ or: false, p: (r) => vals.map(String).includes(String(r[col])) })
      return this
    }
    test(r: Row) {
      let v = true
      for (const [i, c] of this.clauses.entries())
        v = i === 0 ? c.p(r) : c.or ? v || c.p(r) : v && c.p(r)
      return v
    }
  }
  const table = (name: string) => {
    const q = new Q()
    let lim = Infinity
    const rows = () => {
      if (name === 'nivaro_change_proposals') return state.proposals.filter((r) => q.test(r))
      if (name === 'nivaro_users')
        return [{ id: 'U-PROP', first_name: 'Pat', last_name: 'Proposer', role: 'R-USER' }]
      return []
    }
    const b: Record<string, unknown> = {
      where: (...a: unknown[]) => {
        q.where(a[0], a[1], a[2])
        return b
      },
      orWhere: (...a: unknown[]) => {
        q.orWhere(a[0], a[1], a[2])
        return b
      },
      whereIn: (c: string, v: unknown[]) => {
        q.whereIn(c, v)
        return b
      },
      orderBy: () => b,
      select: () => b,
      limit: (n: number) => {
        lim = n
        return b
      },
      first: async () => rows()[0],
      update: async (patch: Row) => {
        const hit = rows()
        for (const r of hit) Object.assign(r, patch)
        return hit.length
      },
      insert: async (row: Row) => {
        const id = state.proposals.length + 1
        state.proposals.push({ id, ...row })
        return [{ id }]
      },
      catch: () => b,
      // biome-ignore lint/suspicious/noThenProperty: knex builders are awaitable
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(rows().slice(0, lim)).then(res, rej)
    }
    return b
  }
  const db = Object.assign((t: string) => table(t), {
    schema: { hasTable: async () => true }
  })
  return { db }
})
vi.mock('../../../db/tenant-context.js', () => ({ getTenantId: () => null }))
vi.mock('../../../services/collections.js', () => ({
  getCollection: async () => ({
    summary_mode_rules: JSON.stringify({
      default: 'edit',
      rules: [],
      ...(state.switchOn ? { change_proposals: true } : {})
    })
  }),
  getFields: async () => [
    { field: 'id', type: 'integer', interface: 'input' },
    { field: 'title', type: 'string', interface: 'input' },
    { field: 'amount', type: 'decimal', interface: 'input' },
    { field: 'secret', type: 'string', interface: 'input' }
  ],
  getRelations: async () => []
}))
vi.mock('../../../services/permissions.js', () => ({
  getAllowedFields: async (u: { id: string }, action: string) =>
    (action === 'update' ? state.writable : state.readable).get(u.id) ?? null,
  isAdminRole: async (u: { id: string }) => state.admins.has(u.id),
  can: async () => true
}))
vi.mock('../../../services/edit-lock.js', () => ({
  parseEditLock: () => null,
  adminOnlyStateOf: async () =>
    state.adminOnlyState ? { key: state.runKey, label: 'Approved' } : null,
  adminOnlyLockOf: async () => ({
    states: ['approved'],
    transitions: [],
    open_fields: [],
    open_children: []
  }),
  editLockVerdictFor: async () =>
    state.locked
      ? { locked: true, allowed: false, message: 'locked', tier: 'admin_only', open_fields: [] }
      : { locked: false, allowed: true, message: '' },
  latestRecordRun: async () => ({
    id: 'I1',
    current_state: 'S-APPROVED',
    key: state.runKey,
    label: 'Approved',
    completed_at: null
  })
}))
vi.mock('../../../services/encryption.js', () => ({
  getEncryptedFields: async () => state.encrypted
}))
vi.mock('../../../services/pipeline-engine.js', () => ({
  resolveStateOwnersBatch: async (reqs: Array<{ key: string }>) =>
    new Map(reqs.map((r) => [r.key, state.owners.map((id) => ({ id }))]))
}))
vi.mock('../../../services/record-access.js', () => ({
  ownsStep: (owners: Array<{ id: string }>, me: string) => owners.some((o) => o.id === me)
}))
vi.mock('../../../services/support-tickets.js', () => ({
  supportAudience: async () => ['U-ADMIN', 'U-PROP']
}))
vi.mock('../../../services/workflow-transitions.js', () => ({
  resolveFriendlyIds: async (_c: string, ids: string[]) => new Map(ids.map((i) => [i, `REC-${i}`]))
}))
vi.mock('../../../services/notification-channels.js', () => ({
  notifyUser: vi.fn(
    async (_app: unknown, to: string, o: { subject: string; category?: string }) => {
      state.notified.push({ to, subject: o.subject, category: o.category })
    }
  )
}))
vi.mock('../../../services/items.js', () => ({
  readOne: async (u: { id: string }, _c: string, _i: string, _w: unknown, fields: string[]) => {
    const readable = state.readable.get(u.id)
    const out: Row = {}
    for (const f of fields)
      if (!readable || readable.includes(f) || f === 'id') out[f] = state.record[f]
    return out
  },
  canUpdateItem: async () => state.canUpdateItem,
  updateOne: async (
    u: { id: string },
    _c: string,
    _i: string,
    payload: Row,
    _r: unknown,
    _w: unknown,
    opts: Row
  ) => {
    state.updates.push({ user: u.id, payload: { ...payload }, opts })
    if (state.updateError) throw state.updateError
    if (!opts.dryRun)
      for (const [k, v] of Object.entries(payload)) if (!k.startsWith('_')) state.record[k] = v
    return opts.dryRun ? { changes: [] } : { id: 'R1' }
  }
}))

const svc = await import('../../../services/change-proposals.js')

const reqAs = (id: string) =>
  ({ user: { id, role: 'R' }, isAdmin: state.admins.has(id), workspaceId: null }) as never
const app = {} as never

beforeEach(() => {
  state.proposals = []
  state.record = { id: 'R1', title: 'Old title', amount: 100, secret: 's' }
  state.writable = new Map([
    ['U-PROP', ['title', 'amount']],
    ['U-OWNER', ['title', 'amount', 'secret']],
    ['U-OWNER2', ['title']]
  ])
  state.readable = new Map()
  state.admins = new Set(['U-ADMIN'])
  state.owners = ['U-OWNER', 'U-OWNER2']
  state.locked = true
  state.switchOn = true
  state.canUpdateItem = true
  state.updates = []
  state.updateError = null
  state.notified = []
  state.runKey = 'approved'
  state.adminOnlyState = true
  state.encrypted = []
})

const propose = (values: Row, who = 'U-PROP') =>
  svc.createProposal(reqAs(who), 'orders', 'R1', { values, reason: 'Vendor quoted again' })

describe('createProposal', () => {
  it('stores old → new and rehearses the write as the proposer, admin-only tier skipped', async () => {
    const out = await propose({ title: 'New title', amount: '120' })
    expect(out.fields).toEqual(['title', 'amount'])
    const row = state.proposals[0]
    expect(row.status).toBe('pending')
    expect(JSON.parse(String(row.changes))).toEqual([
      { field: 'title', from: 'Old title', to: 'New title' },
      { field: 'amount', from: 100, to: 120 }
    ])
    expect(state.updates).toHaveLength(1)
    expect(state.updates[0].user).toBe('U-PROP')
    expect(state.updates[0].opts).toMatchObject({ dryRun: true, skipAdminOnlyLock: true })
    expect(state.record.title).toBe('Old title')
  })

  it('refuses a field the proposer could not write, and stores nothing', async () => {
    await expect(propose({ secret: 'x' })).rejects.toMatchObject({
      statusCode: 403,
      code: 'FIELD_NOT_PROPOSABLE'
    })
    expect(state.proposals).toHaveLength(0)
    expect(state.updates).toHaveLength(0)
  })

  it('refuses when the switch is off, when the record is not locked, or nothing changes', async () => {
    state.switchOn = false
    await expect(propose({ title: 'x' })).rejects.toMatchObject({ statusCode: 404 })
    state.switchOn = true
    state.locked = false
    await expect(propose({ title: 'x' })).rejects.toMatchObject({ code: 'NOT_LOCKED' })
    state.locked = true
    await expect(propose({ title: 'Old title' })).rejects.toMatchObject({ code: 'NO_CHANGE' })
  })

  it('refuses a person who could not change the record were it open', async () => {
    state.canUpdateItem = false
    await expect(propose({ title: 'x' })).rejects.toMatchObject({ statusCode: 403 })
  })

  it('refuses a value the record would refuse (the rehearsal)', async () => {
    state.updateError = Object.assign(new Error('Amount must be under 1000'), { statusCode: 422 })
    await expect(propose({ amount: 5000 })).rejects.toMatchObject({
      statusCode: 422,
      message: 'Amount must be under 1000'
    })
    expect(state.proposals).toHaveLength(0)
  })

  it('one waiting proposal per person per record', async () => {
    await propose({ title: 'A' })
    await expect(propose({ title: 'B' })).rejects.toMatchObject({ code: 'PROPOSAL_PENDING' })
  })
})

describe('acceptProposal', () => {
  beforeEach(async () => {
    await propose({ title: 'New title', amount: 120 })
    state.updates = []
  })

  it('a step owner accepts: written as them, admin-only tier skipped, proposer told', async () => {
    const out = await svc.acceptProposal(app, reqAs('U-OWNER'), 1)
    expect(out.fields).toEqual(['title', 'amount'])
    expect(state.updates).toHaveLength(1)
    const u = state.updates[0]
    expect(u.user).toBe('U-OWNER')
    expect(u.opts).toMatchObject({ skipAdminOnlyLock: true, callerPayload: true })
    expect(u.opts.dryRun).toBeUndefined()
    expect(u.payload).toMatchObject({ title: 'New title', amount: 120 })
    expect(String(u.payload._change_reason)).toContain(
      'Accepted change proposal #1 from Pat Proposer'
    )
    expect(state.proposals[0]).toMatchObject({ status: 'accepted', decided_by: 'U-OWNER' })
    expect(state.notified).toEqual([
      {
        to: 'U-PROP',
        subject: 'Your proposed change to REC-R1 was accepted',
        category: 'proposals'
      }
    ])
  })

  it('refuses an accepter who cannot write one of the fields — nothing is written', async () => {
    await expect(svc.acceptProposal(app, reqAs('U-OWNER2'), 1)).rejects.toMatchObject({
      statusCode: 403,
      code: 'ACCEPTER_CANNOT_WRITE'
    })
    expect(state.updates).toHaveLength(0)
    expect(state.proposals[0].status).toBe('pending')
  })

  it('refuses someone who does not own the step, and the proposer themselves', async () => {
    await expect(svc.acceptProposal(app, reqAs('U-NOBODY'), 1)).rejects.toMatchObject({
      statusCode: 403
    })
    state.owners.push('U-PROP')
    await expect(svc.acceptProposal(app, reqAs('U-PROP'), 1)).rejects.toMatchObject({
      statusCode: 403
    })
    expect(state.updates).toHaveLength(0)
  })

  it('an administrator may accept', async () => {
    await svc.acceptProposal(app, reqAs('U-ADMIN'), 1)
    expect(state.proposals[0].status).toBe('accepted')
  })

  it('refuses when a proposed field changed since the proposal', async () => {
    state.record.amount = 110
    await expect(svc.acceptProposal(app, reqAs('U-OWNER'), 1)).rejects.toMatchObject({
      statusCode: 409,
      code: 'PROPOSAL_STALE'
    })
    expect(state.updates).toHaveLength(0)
    expect(state.proposals[0].status).toBe('pending')
  })

  it('a write the record refuses leaves the proposal waiting', async () => {
    state.updateError = Object.assign(new Error('Title is required'), { statusCode: 422 })
    await expect(svc.acceptProposal(app, reqAs('U-OWNER'), 1)).rejects.toMatchObject({
      statusCode: 422
    })
    expect(state.proposals[0].status).toBe('pending')
  })

  it('a decided proposal cannot be decided again', async () => {
    await svc.acceptProposal(app, reqAs('U-OWNER'), 1)
    await expect(svc.acceptProposal(app, reqAs('U-ADMIN'), 1)).rejects.toMatchObject({
      statusCode: 409,
      code: 'DECIDED'
    })
  })
})

describe('declineProposal / withdrawProposal', () => {
  beforeEach(async () => {
    await propose({ title: 'New title' })
  })

  it('declining needs a note and tells the proposer', async () => {
    await expect(svc.declineProposal(app, reqAs('U-OWNER'), 1, '')).rejects.toMatchObject({
      code: 'NOTE_REQUIRED'
    })
    await svc.declineProposal(app, reqAs('U-OWNER'), 1, 'Quote expired')
    expect(state.proposals[0]).toMatchObject({ status: 'declined', decision_note: 'Quote expired' })
    expect(state.notified[0]).toMatchObject({ to: 'U-PROP', category: 'proposals' })
    expect(state.record.title).toBe('Old title')
  })

  it('only the proposer withdraws', async () => {
    await expect(svc.withdrawProposal(reqAs('U-OWNER'), 1)).rejects.toMatchObject({
      statusCode: 404
    })
    await svc.withdrawProposal(reqAs('U-PROP'), 1)
    expect(state.proposals[0].status).toBe('withdrawn')
  })
})

describe('proposalsForRecord', () => {
  it('shows a viewer only the fields they can read, and who may decide', async () => {
    await propose({ title: 'New title', amount: 120 })
    state.readable.set('U-OWNER2', ['id', 'title'])
    const [p] = await svc.proposalsForRecord(
      { id: 'U-OWNER2', role: 'R' } as never,
      false,
      'orders',
      'R1'
    )
    expect(p.changes.map((c) => c.field)).toEqual(['title'])
    expect(p.hidden_fields).toBe(1)
    expect(p.can_decide).toBe(true)
    const [mine] = await svc.proposalsForRecord(
      { id: 'U-PROP', role: 'R' } as never,
      false,
      'orders',
      'R1'
    )
    expect(mine.can_decide).toBe(false)
    expect(mine.can_withdraw).toBe(true)
  })

  it('flags a change whose field moved since', async () => {
    await propose({ amount: 120 })
    state.record.amount = 105
    const [p] = await svc.proposalsForRecord(
      { id: 'U-OWNER', role: 'R' } as never,
      false,
      'orders',
      'R1'
    )
    expect(p.changes[0].stale).toBe(true)
  })
})

describe('decidableProposalsFor (My Work)', () => {
  it('owners of the step see it, the proposer does not, admins see all', async () => {
    await propose({ title: 'New title' })
    const owner = await svc.decidableProposalsFor({ id: 'U-OWNER', role: 'R' } as never, false)
    expect(owner.map((p) => p.item_label)).toEqual(['REC-R1'])
    state.owners.push('U-PROP')
    expect(await svc.decidableProposalsFor({ id: 'U-PROP', role: 'R' } as never, false)).toEqual([])
    expect(await svc.decidableProposalsFor({ id: 'U-NOBODY', role: 'R' } as never, false)).toEqual(
      []
    )
    expect(
      await svc.decidableProposalsFor({ id: 'U-ADMIN', role: 'R' } as never, true)
    ).toHaveLength(1)
  })
})

describe('security review: accept re-checks, encrypted fields', () => {
  beforeEach(async () => {
    await propose({ title: 'New title' })
    state.updates = []
  })

  it('turning the switch off expires waiting proposals: no accept, not in My Work', async () => {
    state.switchOn = false
    await expect(svc.acceptProposal(app, reqAs('U-OWNER'), 1)).rejects.toMatchObject({
      statusCode: 409,
      code: 'PROPOSALS_OFF'
    })
    expect(await svc.decidableProposalsFor({ id: 'U-ADMIN', role: 'R' } as never, true)).toEqual([])
    expect(state.updates).toHaveLength(0)
    expect(state.proposals[0].status).toBe('pending')
  })

  it('a record no longer under the post-approval lock is edited directly, not accepted', async () => {
    state.adminOnlyState = false
    await expect(svc.acceptProposal(app, reqAs('U-ADMIN'), 1)).rejects.toMatchObject({
      statusCode: 409,
      code: 'NOT_LOCKED'
    })
    expect(state.updates).toHaveLength(0)
  })

  it('a record that moved to another step refuses the proposal', async () => {
    state.runKey = 'closed'
    await expect(svc.acceptProposal(app, reqAs('U-OWNER'), 1)).rejects.toMatchObject({
      statusCode: 409,
      code: 'PROPOSAL_STEP_CHANGED',
      message: 'The record moved on since this was proposed; ask for a new proposal.'
    })
    expect(state.updates).toHaveLength(0)
    expect(state.proposals[0].status).toBe('pending')
  })

  it('encrypted fields are never proposable, so never stored in a proposal', async () => {
    state.encrypted = ['amount']
    const fields = await svc.proposableFields({ id: 'U-PROP', role: 'R' } as never, 'orders', {
      isAdmin: false
    })
    expect(fields.map((f) => f.field)).not.toContain('amount')
    state.proposals = []
    await expect(propose({ amount: 5 })).rejects.toMatchObject({ code: 'FIELD_NOT_PROPOSABLE' })
    expect(state.proposals).toHaveLength(0)
  })

  it('an encrypted field in an older proposal is never shown', async () => {
    state.proposals = []
    await propose({ title: 'T2', amount: 130 })
    state.encrypted = ['amount']
    const [p] = await svc.proposalsForRecord(
      { id: 'U-OWNER', role: 'R' } as never,
      false,
      'orders',
      'R1'
    )
    expect(p.changes.map((c) => c.field)).toEqual(['title'])
  })
})

describe('reviewers are told (category Change proposals)', () => {
  const appStub = {} as never
  it('the step owners hear of a new proposal, never the proposer', async () => {
    state.owners = ['U-OWNER', 'U-PROP']
    await svc.createProposal(
      reqAs('U-PROP'),
      'orders',
      'R1',
      { values: { title: 'X' }, reason: 'Needed for the audit' },
      appStub
    )
    expect(state.notified).toEqual([
      {
        to: 'U-OWNER',
        subject: 'Change proposed on REC-R1 — review it',
        category: 'proposals'
      }
    ])
  })

  it('a step nobody owns goes to the administrators', async () => {
    state.owners = []
    expect(
      await svc.proposalReviewers('orders', 'R1', 'U-PROP', { id: 'I1', current_state: 'S' })
    ).toEqual(['U-ADMIN'])
  })
})

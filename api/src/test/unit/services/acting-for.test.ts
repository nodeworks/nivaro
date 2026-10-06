import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/pipeline-engine.js', () => ({
  resolveStateOwnersBatch: vi.fn(async () => new Map([['step', [{ id: 'BETH' }]]]))
}))

import { db } from '../../../db/index.js'
import { actingForLabel, pickOnBehalfOf, resolveOnBehalfOf } from '../../../services/acting-for.js'
import { buildActionWriter } from '../../../services/action-writes.js'
import { originForWrite } from '../../../services/note-authorship.js'
import { resolveStateOwnersBatch } from '../../../services/pipeline-engine.js'

afterEach(() => vi.clearAllMocks())

describe('pickOnBehalfOf (#645)', () => {
  it('names the out-of-office owner the delegate stands in for', () => {
    expect(pickOnBehalfOf('KIM', ['BETH'], ['BETH', 'ANA'])).toBe('BETH')
  })
  it('is null when the actor owns the step in their own right', () => {
    expect(pickOnBehalfOf('KIM', ['BETH'], ['BETH', 'kim'])).toBeNull()
  })
  it('is null when none of the people they cover owns this step', () => {
    expect(pickOnBehalfOf('KIM', ['BETH'], ['ANA'])).toBeNull()
  })
  it('is null with no actor or no principals', () => {
    expect(pickOnBehalfOf(null, ['BETH'], ['BETH'])).toBeNull()
    expect(pickOnBehalfOf('KIM', [], ['BETH'])).toBeNull()
  })
  it('compares ids case-insensitively (MSSQL hands uuids back upper-cased)', () => {
    expect(pickOnBehalfOf('kim', ['beth'], ['BETH'])).toBe('beth')
  })
})

describe('resolveOnBehalfOf', () => {
  function principals(rows: Array<{ id: string }>) {
    const b: Record<string, unknown> = {}
    for (const m of ['where', 'orderBy', 'limit']) b[m] = vi.fn(() => b)
    b.select = vi.fn(async () => rows)
    vi.mocked(db).mockImplementation((() => b) as never)
  }

  it('reads the raw (pre-delegation) owners of the step being left', async () => {
    principals([{ id: 'BETH' }])
    const who = await resolveOnBehalfOf({
      actorId: 'KIM',
      stateId: 'S1',
      instanceId: 'I1',
      collection: 'workflows',
      item: '7'
    })
    expect(who).toBe('BETH')
    expect(resolveStateOwnersBatch).toHaveBeenCalledWith(
      [expect.objectContaining({ stateId: 'S1', instanceId: 'I1', itemId: '7' })],
      expect.anything(),
      { skipDelegation: true }
    )
  })

  it('skips the owner lookup when nobody delegated to the actor', async () => {
    principals([])
    expect(
      await resolveOnBehalfOf({
        actorId: 'KIM',
        stateId: 'S1',
        instanceId: 'I1',
        collection: 'workflows',
        item: '7'
      })
    ).toBeNull()
    expect(resolveStateOwnersBatch).not.toHaveBeenCalled()
  })

  it('never throws — a failure reads as acting for nobody', async () => {
    vi.mocked(db).mockImplementation((() => {
      throw new Error('db down')
    }) as never)
    expect(
      await resolveOnBehalfOf({
        actorId: 'KIM',
        stateId: 'S1',
        instanceId: 'I1',
        collection: 'workflows',
        item: '7'
      })
    ).toBeNull()
  })
})

describe('actingForLabel', () => {
  it('joins actor and principal', () => {
    expect(actingForLabel('Kim Lee', 'Beth Ross')).toBe('Kim Lee, for Beth Ross')
    expect(actingForLabel('Kim Lee', null)).toBe('Kim Lee')
    expect(actingForLabel(null, null)).toBeNull()
  })
})

describe('action writer identity (#818)', () => {
  it('keeps the person but takes the admin role and drops API-key narrowing', () => {
    const w = buildActionWriter(
      { id: 'KIM', role: 'APPROVER', api_key_scopes: [{ collection: 'x', actions: ['read'] }] },
      'ADMIN'
    ) as unknown as Record<string, unknown>
    expect(w.id).toBe('KIM')
    expect(w.role).toBe('ADMIN')
    expect(w.api_key_scopes).toBeUndefined()
  })
  it('an automatic transition writes as the system: no id, origin machine', () => {
    const w = buildActionWriter(null, 'ADMIN')
    expect(w.id).toBeUndefined()
    expect(originForWrite(w, null)).toBe('machine')
  })
  it('a transition-action reason is a machine write even under a person', () => {
    expect(originForWrite({ id: 'KIM' } as never, 'transition-action: Approve')).toBe('machine')
    expect(originForWrite({ id: 'KIM' } as never, 'fixed a typo')).toBe('person')
  })
})

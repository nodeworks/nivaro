import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import {
  type CoverDeps,
  coveredRecords,
  coverFor,
  type DelegatorRow,
  delegationInForce
} from '../../../services/delegate-cover.js'
import type { OwnerResolutionTrace } from '../../../services/pipeline-engine.js'

const ME = 'aaaaaaaa-0000-0000-0000-000000000001'
const JANE = 'bbbbbbbb-0000-0000-0000-000000000002'
const OMAR = 'cccccccc-0000-0000-0000-000000000003'
const NOW = new Date('2026-11-14T15:00:00Z')

const person = (id: string) => ({ id, email: `${id}@x`, first_name: null, last_name: null })
const row = (over: Partial<DelegatorRow>): DelegatorRow => ({
  id: JANE,
  first_name: 'Jane',
  last_name: 'Smith',
  email: 'jane@x',
  is_out_of_office: 1,
  delegate_id: ME,
  delegate_expires_at: null,
  ...over
})
const trace = (
  over: Partial<
    Pick<OwnerResolutionTrace, 'groupOwners' | 'instanceOwners' | 'standIn' | 'substitutions'>
  >
) => ({ groupOwners: [], instanceOwners: [], standIn: [], substitutions: [], ...over })

describe('delegate cover (rt5 #15)', () => {
  it("follows the resolver's rule: out of office, delegate set, not expired", () => {
    expect(delegationInForce(row({}), NOW)).toBe(true)
    expect(delegationInForce(row({ is_out_of_office: 0 }), NOW)).toBe(false)
    expect(delegationInForce(row({ delegate_id: null }), NOW)).toBe(false)
    expect(delegationInForce(row({ delegate_expires_at: '2026-11-14T14:59:00Z' }), NOW)).toBe(false)
    expect(delegationInForce(row({ delegate_expires_at: '2026-11-15T00:00:00Z' }), NOW)).toBe(true)
  })

  it('counts only records that reach me through the cover — not ones I own myself', () => {
    const traces = new Map([
      // Jane's seat, swapped to me.
      [
        'workflows:1',
        trace({
          groupOwners: [person(JANE)],
          substitutions: [{ from: person(JANE), to: person(ME.toUpperCase()) }]
        })
      ],
      // Jane's seat, but I sit in the group too: it needs me anyway.
      [
        'workflows:2',
        trace({
          groupOwners: [person(JANE), person(ME)],
          substitutions: [{ from: person(JANE), to: person(ME) }]
        })
      ],
      // Omar's seat swapped to me, but I am not covering Omar here.
      ['workflows:3', trace({ substitutions: [{ from: person(OMAR), to: person(ME) }] })],
      // Jane's seat swapped to someone else.
      ['workflows:4', trace({ substitutions: [{ from: person(JANE), to: person(OMAR) }] })]
    ])
    const out = coveredRecords(traces, ME, [JANE])
    expect(out.get(JANE.toUpperCase())).toEqual(['workflows:1'])
    expect(out.size).toBe(1)
  })

  function deps(over: Partial<CoverDeps> = {}): CoverDeps & { calls: string[] } {
    const calls: string[] = []
    return {
      calls,
      delegators: async () => {
        calls.push('delegators')
        return [row({})]
      },
      owned: async () => {
        calls.push('owned')
        return [
          { collection: 'workflows', item: '1' },
          { collection: 'workflows', item: '2' }
        ]
      },
      instances: async (owned) =>
        owned.map((o, i) => ({ instance_id: `i${i}`, current_state: 's1', ...o })),
      traces: async (requests) =>
        new Map(
          requests.map((r) => [
            r.key,
            trace(
              r.itemId === '1'
                ? { substitutions: [{ from: person(JANE), to: person(ME) }] }
                : { groupOwners: [person(ME)] }
            ) as OwnerResolutionTrace
          ])
        ),
      now: () => NOW,
      ...over
    }
  }

  it('one cheap read when nobody is out with me as their delegate', async () => {
    const d = deps({
      delegators: async () => {
        d.calls.push('delegators')
        return [row({ is_out_of_office: 0 })]
      }
    })
    expect(await coverFor(ME, d)).toEqual([])
    expect(d.calls).toEqual(['delegators'])
  })

  it('says who I cover, until when, and which of their records need me', async () => {
    const d = deps({
      delegators: async () => [row({ delegate_expires_at: '2026-11-20T00:00:00Z' })]
    })
    const out = await coverFor(ME, d)
    expect(out).toEqual([
      {
        user_id: JANE,
        name: 'Jane Smith',
        first_name: 'Jane',
        ends_at: '2026-11-20T00:00:00.000Z',
        records: 1,
        keys: ['workflows:1']
      }
    ])
  })

  it('a cover with nothing of theirs waiting still shows (0 records)', async () => {
    const d = deps({ owned: async () => [] })
    const out = await coverFor(ME, d)
    expect(out).toHaveLength(1)
    expect(out[0].records).toBe(0)
  })

  it('ignores a row naming someone else as delegate (defensive) and an expired cover', async () => {
    const d = deps({
      delegators: async () => [
        row({ delegate_id: OMAR }),
        row({ id: OMAR, delegate_expires_at: '2026-11-01T00:00:00Z' })
      ]
    })
    expect(await coverFor(ME, d)).toEqual([])
  })
})

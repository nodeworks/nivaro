import { describe, expect, it } from 'vitest'
import {
  fmtDuration,
  followKey,
  requestFactsOf,
  splitRecordRef,
  stepRefFor,
  stepRefLabel
} from './logic'

const RID = '8ba289a0-81fd-4d13-b56f-567cdb2d2a56'
const AT = '2026-10-01T12:00:00.000Z'

describe('stepRefFor', () => {
  it('opens the chain request only when its request id is known', () => {
    const node = { key: `request:${RID}`, kind: 'request', at: AT, summary: 'POST /x · 200' }
    expect(stepRefFor(node, RID)).toEqual({
      kind: 'request',
      id: RID,
      at: Date.parse(AT),
      label: 'POST /x · 200'
    })
    expect(stepRefFor(node, null)).toBeNull()
  })

  it('maps writes, flow runs, pushes and transitions', () => {
    expect(stepRefFor({ key: 'activity:11690481', kind: 'write', at: AT }, null)).toMatchObject({
      kind: 'write',
      id: '11690481'
    })
    expect(stepRefFor({ key: 'flow_run:42', kind: 'flow' }, null)).toEqual({
      kind: 'flow',
      id: '42',
      at: undefined
    })
    expect(stepRefFor({ key: 'submission:72', kind: 'push' }, null)?.kind).toBe('submission')
    expect(
      stepRefFor(
        {
          key: 'history:9',
          kind: 'transition',
          record: { collection: 'workflows', item: '371367', label: 'CM26-79811' }
        },
        null
      )
    ).toMatchObject({ kind: 'record', id: 'workflows:371367', label: 'CM26-79811' })
  })

  it('an inferred write opens its record; groups, calls and mail open nothing', () => {
    expect(
      stepRefFor(
        {
          key: 'activity:inferred:1790000000000',
          kind: 'write',
          record: { collection: 'regions', item: '4' }
        },
        null
      )
    ).toMatchObject({ kind: 'record', id: 'regions:4' })
    expect(stepRefFor({ key: 'group:root:regions', kind: 'group' }, RID)).toBeNull()
    expect(stepRefFor({ key: 'call:6461', kind: 'partner_call' }, RID)).toBeNull()
    expect(stepRefFor({ key: 'mail:3', kind: 'mail' }, RID)).toBeNull()
    expect(stepRefFor({ key: 'history:9', kind: 'transition' }, RID)).toBeNull()
  })

  it('labels the link by kind', () => {
    expect(stepRefLabel({ kind: 'submission', id: '1' })).toBe('Push')
    expect(stepRefLabel({ kind: 'record', id: 'a:1' })).toBe('Record')
  })
})

describe('requestFactsOf', () => {
  const U = '7A0411F3-C687-40E5-ADF5-614157CF88EC'
  // The `request` detail shape (services/traffic-inspect/request.ts): the log row under `row`.
  it('reads the person and time from the request detail’s row', () => {
    expect(
      requestFactsOf({ rid: 'x', pending: false, row: { user: U, created_at: AT, status: 500 } })
    ).toEqual({ user: U, at: Date.parse(AT) })
  })
  it('names nobody for key and anonymous callers, or a pending/missing request', () => {
    expect(requestFactsOf({ row: { user: null, api_key_id: 12, created_at: AT } })).toEqual({
      user: null,
      at: Date.parse(AT)
    })
    expect(requestFactsOf({ row: { user: 'k12', created_at: AT } }).user).toBeNull()
    expect(requestFactsOf({ pending: true, row: null })).toEqual({ user: null, at: null })
    expect(requestFactsOf({ user: U, created_at: AT })).toEqual({ user: null, at: null })
    expect(requestFactsOf(null)).toEqual({ user: null, at: null })
  })
})

describe('small helpers', () => {
  it('formats durations', () => {
    expect(fmtDuration(12_400)).toBe('12 s')
    expect(fmtDuration(3 * 60_000)).toBe('3 min')
    expect(fmtDuration(64 * 60_000)).toBe('1 h 4 min')
    expect(fmtDuration(null)).toBe('—')
  })
  it('splits record refs and builds follow keys', () => {
    expect(splitRecordRef('workflows:12')).toEqual({ collection: 'workflows', item: '12' })
    expect(splitRecordRef('workflows')).toBeNull()
    expect(followKey('7a0411f3-c687-40e5-adf5-614157cf88ec')).toBe(
      'u7A0411F3-C687-40E5-ADF5-614157CF88EC'
    )
  })
})

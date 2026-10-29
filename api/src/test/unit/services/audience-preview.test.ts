import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import {
  addsAudience,
  confirmFlag,
  normalizeAudienceSettings
} from '../../../services/audience-gate.js'
import {
  broadcastIsEveryone,
  extractRecipientSpec,
  needsAudienceConfirm,
  SAMPLE_SIZE,
  summarizeAudience
} from '../../../services/audience-preview.js'

const U1 = '11111111-1111-1111-1111-111111111111'
const U2 = '22222222-2222-2222-2222-222222222222'

function people(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `u-${String(i).padStart(3, '0')}`,
    name: `Person ${String(i).padStart(3, '0')}`
  }))
}

describe('needsAudienceConfirm (#3080 threshold)', () => {
  it('asks only above the threshold', () => {
    const base = { roles: 0, everyone: false, threshold: 10, active: true }
    expect(needsAudienceConfirm({ ...base, count: 10 })).toEqual({
      over_threshold: false,
      confirm_required: false
    })
    expect(needsAudienceConfirm({ ...base, count: 11 })).toEqual({
      over_threshold: true,
      confirm_required: true
    })
  })

  it('a whole role or everyone always asks, whatever the count', () => {
    expect(
      needsAudienceConfirm({ count: 2, roles: 1, everyone: false, threshold: 10, active: true })
        .confirm_required
    ).toBe(true)
    expect(
      needsAudienceConfirm({ count: 0, roles: 0, everyone: true, threshold: 10, active: true })
        .confirm_required
    ).toBe(true)
  })

  it('a config that is off reaches nobody and never asks', () => {
    expect(
      needsAudienceConfirm({ count: 500, roles: 2, everyone: false, threshold: 10, active: false })
        .confirm_required
    ).toBe(false)
  })

  it('threshold 0 asks for any audience at all', () => {
    const r = needsAudienceConfirm({
      count: 1,
      roles: 0,
      everyone: false,
      threshold: 0,
      active: true
    })
    expect(r.confirm_required).toBe(true)
  })
})

describe('summarizeAudience', () => {
  it('dedupes people, sorts by name and keeps the first 20 names', () => {
    const list = people(30).reverse()
    list.push({ id: 'U-000', name: 'Person 000' }) // same person, other case
    const p = summarizeAudience({
      kind: 'alert',
      people: list,
      roles: [],
      everyone: false,
      external: 0,
      threshold: 10,
      active: true,
      notes: []
    })
    expect(p.count).toBe(30)
    expect(p.sample).toHaveLength(SAMPLE_SIZE)
    expect(p.sample[0].name).toBe('Person 000')
    expect(p.over_threshold).toBe(true)
    expect(p.confirm_required).toBe(true)
  })

  it('reports included roles and asks even under the threshold', () => {
    const p = summarizeAudience({
      kind: 'broadcast',
      people: people(3),
      roles: [{ id: 'r1', name: 'Managers', members: 3 }],
      everyone: false,
      external: 0,
      threshold: 10,
      active: true,
      notes: []
    })
    expect(p.includes_roles).toEqual([{ id: 'r1', name: 'Managers', members: 3 }])
    expect(p.over_threshold).toBe(false)
    expect(p.confirm_required).toBe(true)
  })

  it('counts outside addresses toward the total', () => {
    const p = summarizeAudience({
      kind: 'flow_operation',
      people: people(8),
      roles: [],
      everyone: false,
      external: 3,
      threshold: 10,
      active: true,
      notes: []
    })
    expect(p.count).toBe(11)
    expect(p.confirm_required).toBe(true)
  })
})

describe('extractRecipientSpec', () => {
  it('rule: task assignees, teams and roles count; owners and templates become notes', () => {
    const spec = extractRecipientSpec('rule', {
      enabled: true,
      actions: JSON.stringify([
        { type: 'create_task', title: 't', assignee: U1, team_id: '4' },
        { type: 'create_task', title: 't', assign_to_owners: true },
        { type: 'notify', message: 'hi', roles: ['Managers'], recipient: '{{creator}}' },
        { type: 'set_field', field: 'x', value: 1 }
      ])
    })
    expect(spec.user_ids).toEqual([U1])
    expect(spec.teams).toEqual([4])
    expect(spec.roles).toEqual(['Managers'])
    expect(spec.dynamic.some((d) => /owners/.test(d))).toBe(true)
    expect(spec.dynamic.some((d) => /\{\{creator\}\}/.test(d))).toBe(true)
  })

  it('rule: a disabled rule is inactive', () => {
    expect(extractRecipientSpec('rule', { enabled: false, actions: [] }).active).toBe(false)
  })

  it('flow: mail to + notification recipient of each sending step; status decides active', () => {
    const spec = extractRecipientSpec('flow', {
      status: 'active',
      operations: [
        { type: 'mail', name: 'Mail', options: JSON.stringify({ to: 'A@x.com, b@x.com' }) },
        { type: 'notification', options: { recipient: U2 } },
        { type: 'webhook', options: { url: 'https://x' } }
      ]
    })
    expect(spec.active).toBe(true)
    expect(spec.emails).toEqual(['a@x.com', 'b@x.com'])
    expect(spec.user_ids).toEqual([U2])
    expect(extractRecipientSpec('flow', { status: 'inactive', operations: [] }).active).toBe(false)
  })

  it('flow_operation: the step on an inactive flow reaches nobody', () => {
    const spec = extractRecipientSpec('flow_operation', {
      type: 'mail',
      options: { to: 'a@x.com' },
      flow_status: 'inactive'
    })
    expect(spec.active).toBe(false)
    expect(spec.emails).toEqual(['a@x.com'])
  })

  it('alert / field watch: subscribers of the stored row, active flag honoured', () => {
    expect(extractRecipientSpec('alert', { id: 5, is_active: 1 }).subscribers_of).toEqual({
      table: 'alert',
      id: 5
    })
    expect(extractRecipientSpec('field_watch', { id: 9, is_active: false }).active).toBe(false)
    expect(extractRecipientSpec('alert', { is_active: true }).subscribers_of).toBeNull()
  })

  it('broadcast: roles named and the empty audience means everyone', () => {
    const spec = extractRecipientSpec('broadcast', { audience: { roles: ['r1'] } })
    expect(spec.roles).toEqual(['r1'])
    expect(broadcastIsEveryone({})).toBe(true)
    expect(broadcastIsEveryone({ roles: ['r1'] })).toBe(false)
    expect(broadcastIsEveryone({ dimension: 'region', values: [2] })).toBe(false)
  })
})

describe('gate helpers', () => {
  const preview = (over: Partial<ReturnType<typeof summarizeAudience>> = {}) => ({
    ...summarizeAudience({
      kind: 'alert',
      people: [],
      roles: [],
      everyone: false,
      external: 0,
      threshold: 10,
      active: true,
      notes: []
    }),
    ...over
  })

  it('addsAudience: create / turning on always adds; same people again does not', () => {
    const after = { preview: preview(), ids: ['a', 'b'] }
    expect(addsAudience(null, after)).toBe(true)
    expect(addsAudience({ preview: preview({ active: false }), ids: ['a', 'b'] }, after)).toBe(true)
    expect(addsAudience({ preview: preview(), ids: ['A', 'b'] }, after)).toBe(false)
    expect(addsAudience({ preview: preview(), ids: ['a'] }, after)).toBe(true)
  })

  it('addsAudience: a newly included role is new reach', () => {
    const before = { preview: preview(), ids: [] }
    const after = {
      preview: preview({ includes_roles: [{ id: 'r', name: 'R', members: 0 }] }),
      ids: []
    }
    expect(addsAudience(before, after)).toBe(true)
  })

  it('confirmFlag + settings normalizer', () => {
    expect(confirmFlag({ confirm_audience: true })).toBe(true)
    expect(confirmFlag({ confirm_audience: 'yes' })).toBe(false)
    expect(confirmFlag(null)).toBe(false)
    expect(normalizeAudienceSettings(undefined)).toEqual({ threshold: 10 })
    expect(normalizeAudienceSettings({ threshold: 25 })).toEqual({ threshold: 25 })
    expect(normalizeAudienceSettings({ threshold: -1 })).toEqual({ threshold: 10 })
  })
})

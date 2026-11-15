import { describe, expect, it } from 'vitest'
import { outLine, type TeamMember, teamRows, teamStatus, teamSummary } from './QueueTeamStrip'

const m = (id: string, over: Partial<TeamMember> = {}): TeamMember => ({
  id,
  name: `Person ${id}`,
  out_of_office: false,
  ooo_end: null,
  covered_by: null,
  ...over
})

describe('team strip', () => {
  it('out of office beats presence; idle reads as away; unknown is not online', () => {
    expect(teamStatus(m('a', { out_of_office: true }), 'online')).toBe('out')
    expect(teamStatus(m('a'), 'idle')).toBe('away')
    expect(teamStatus(m('a'), 'online')).toBe('online')
    expect(teamStatus(m('a'), undefined)).toBe('offline')
  })

  it('orders most present first and summarises only the kinds that exist', () => {
    const states = new Map([
      ['B', 'online' as const],
      ['C', 'idle' as const]
    ])
    const rows = teamRows([m('A'), m('B'), m('C'), m('D', { out_of_office: true })], states)
    expect(rows.map((r) => r.member.id)).toEqual(['B', 'C', 'D', 'A'])
    expect(teamSummary(rows)).toBe('1 online · 1 away · 1 out')
    expect(teamSummary(teamRows([m('A')], new Map()))).toBe('No one online')
  })

  it('says who covers', () => {
    expect(outLine(m('a', { out_of_office: true, covered_by: { id: 'z', name: 'Zed Z' } }))).toBe(
      'Out of office · Zed Z covers'
    )
  })
})

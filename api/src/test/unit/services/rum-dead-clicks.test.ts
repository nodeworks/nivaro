import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: () => ({}) }))

import { splitTarget, summarizeDeadClicks } from '../../../services/rum-dead-clicks.js'

const row = (route: string, kind: string, user: string | null, at: string) => ({
  route,
  kind,
  user,
  created_at: at
})

describe('splitTarget', () => {
  it('splits the route from the element label', () => {
    expect(splitTarget("/collections/:c :: button 'Save'")).toEqual({
      route: '/collections/:c',
      element: "button 'Save'"
    })
  })
  it('keeps a label-less row readable', () => {
    expect(splitTarget('/x').element).toBe('(unlabelled)')
  })
})

describe('summarizeDeadClicks', () => {
  const rows = [
    row("/a :: button 'Save'", 'dead', 'u1', '2026-10-20T10:00:00Z'),
    row("/a :: button 'Save'", 'dead', 'u2', '2026-10-20T11:00:00Z'),
    row("/a :: button 'Save'", 'rage', 'u1', '2026-10-20T09:00:00Z'),
    row("/a :: a 'Help'", 'dead', null, '2026-10-20T12:00:00Z'),
    row("/b :: button 'Go'", 'dead', 'u3', '2026-10-20T08:00:00Z'),
    row('/b :: button Go', 'load', 'u3', '2026-10-20T08:00:00Z')
  ]
  it('counts per element, ranks routes and elements, ignores other kinds', () => {
    const out = summarizeDeadClicks(rows)
    expect(out.map((r) => r.route)).toEqual(['/a', '/b'])
    expect(out[0].total).toBe(4)
    const save = out[0].elements[0]
    expect(save).toMatchObject({ element: "button 'Save'", dead: 2, rage: 1, total: 3, people: 2 })
    expect(save.sample_user).toBe('u2')
    expect(save.sample_at).toBe('2026-10-20T11:00:00.000Z')
  })
  it('an element without a person has no sample', () => {
    const help = summarizeDeadClicks(rows)[0].elements[1]
    expect(help.sample_user).toBeNull()
    expect(help.people).toBe(0)
  })
  it('caps elements per route', () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      row(`/r :: b${i}`, 'dead', 'u', '2026-10-20T10:00:00Z')
    )
    expect(summarizeDeadClicks(many, 3)[0].elements).toHaveLength(3)
  })
})

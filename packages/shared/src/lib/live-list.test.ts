import { describe, expect, it, vi } from 'vitest'
import {
  agoLabel,
  changeTitle,
  conditionFields,
  lockLabel,
  mayAffectMatch,
  viewerMatches
} from './live-list'

describe('changeTitle', () => {
  const now = 1_000_000
  it('names the writer once known', () => {
    expect(changeTitle({ at: now - 2000, by: 'U1', kind: 'update' }, 'Beth', now)).toBe(
      'Changed by Beth just now'
    )
  })
  it('says someone when only an id is known and nothing when nobody is', () => {
    expect(changeTitle({ at: now - 30_000, by: 'U1', kind: 'update' }, null, now)).toBe(
      'Changed by someone 30s ago'
    )
    expect(changeTitle({ at: now - 120_000, by: null, kind: 'update' }, null, now)).toBe(
      'Changed 2 min ago'
    )
  })
  it('marks a created row as new', () => {
    expect(changeTitle({ at: now, by: 'U1', kind: 'create' }, 'Beth', now)).toBe(
      'New — added by Beth just now'
    )
  })
  it('agoLabel buckets', () => {
    expect(agoLabel(0, 5000)).toBe('just now')
    expect(agoLabel(0, 59_000)).toBe('59s ago')
  })
})

describe('conditionFields / mayAffectMatch', () => {
  const conds = JSON.stringify([
    { path: ['status'], op: '_eq', value: 'open' },
    {
      or: [
        { path: ['owner', 'name'], op: '_eq', value: 'x' },
        { path: ['zone'], op: '_null', value: true }
      ]
    }
  ])
  it('collects the top-level fields a filter reads, through or/and', () => {
    expect([...conditionFields(conds)].sort()).toEqual(['owner', 'status', 'zone'])
    expect(conditionFields(undefined).size).toBe(0)
    expect(conditionFields('not json').size).toBe(0)
  })
  it('an update only matters when it touched a filtered field', () => {
    const f = conditionFields(conds)
    expect(mayAffectMatch({ action: 'update', changed_fields: ['title'] }, f)).toBe(false)
    expect(mayAffectMatch({ action: 'update', changed_fields: ['title', 'zone'] }, f)).toBe(true)
    expect(mayAffectMatch({ action: 'update' }, f)).toBe(true)
    expect(mayAffectMatch({ action: 'create' }, f)).toBe(true)
    expect(mayAffectMatch({ changed_fields: ['$state'] }, f)).toBe(false)
  })
})

describe('viewerMatches', () => {
  it('asks the items route with the list conditions plus id _in, as one read', async () => {
    const request = vi.fn(async () => ({ data: [{ id: 2, title: 'b' }] }))
    const out = await viewerMatches(
      { request } as never,
      'articles',
      ['1', '2', '2', '*'],
      JSON.stringify([{ path: ['status'], op: '_eq', value: 'open' }]),
      'abc'
    )
    expect([...out.keys()]).toEqual(['2'])
    expect(request).toHaveBeenCalledTimes(1)
    const cmd = (request.mock.calls[0] as unknown[])[0] as {
      _path: string
      _params?: Record<string, unknown>
    }
    expect(JSON.stringify(cmd)).toContain('/items/articles')
    expect(JSON.stringify(cmd)).toContain('status')
    expect(JSON.stringify(cmd)).toContain('_in')
    expect(JSON.stringify(cmd)).toContain('abc')
  })
  it('asks nothing for a bulk-only batch', async () => {
    const request = vi.fn()
    expect((await viewerMatches({ request } as never, 'a', ['*'], undefined)).size).toBe(0)
    expect(request).not.toHaveBeenCalled()
  })
})

describe('lockLabel', () => {
  it('names the editor, or you', () => {
    expect(lockLabel({ locked_by: 'U1', locked_by_name: 'Beth', is_mine: false })).toBe(
      'Beth is editing this'
    )
    expect(lockLabel({ locked_by: 'U1', locked_by_name: null, is_mine: true })).toBe(
      'You are editing this'
    )
  })
})

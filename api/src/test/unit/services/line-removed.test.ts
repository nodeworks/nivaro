import { describe, expect, it } from 'vitest'
import {
  type LineRemovedDeps,
  lineRemovedAnswer,
  revisionData
} from '../../../services/line-removed.js'

const beth = {
  at: '2026-11-15T10:00:00.000Z',
  who: 'Beth Ames',
  user_id: 'B',
  via: 'user' as const
}
const proc = {
  at: '2026-11-15T10:00:00.000Z',
  who: 'procedure x',
  user_id: null,
  via: 'procedure' as const
}

function deps(over: Partial<LineRemovedDeps> = {}): LineRemovedDeps {
  return {
    parentVisible: async () => true,
    mayReadLinkField: async () => true,
    currentLine: async () => null,
    lastRevisionData: async () => ({ id: 7, request: '42' }),
    deleteActivity: async () => beth,
    rawSource: async () => proc,
    ...over
  }
}

describe('o2m-removed fails closed (rt7 #6)', () => {
  it('names who removed a line proven to belong to the parent', async () => {
    expect(await lineRemovedAnswer(deps(), 'request', '42')).toEqual({ status: 200, data: beth })
  })

  it('a caller who cannot read the parent gets 404 and nothing else is read', async () => {
    let read = false
    const d = deps({
      parentVisible: async () => false,
      lastRevisionData: async () => {
        read = true
        return { request: '42' }
      }
    })
    expect(await lineRemovedAnswer(d, 'request', '42')).toEqual({ status: 404 })
    expect(read).toBe(false)
  })

  it('a line from another parent says nothing', async () => {
    const d = deps({ lastRevisionData: async () => ({ request: '99' }) })
    expect(await lineRemovedAnswer(d, 'request', '42')).toEqual({ status: 200, data: null })
  })

  it('no revision = no membership proof, even with a delete activity', async () => {
    const d = deps({ lastRevisionData: async () => null })
    expect(await lineRemovedAnswer(d, 'request', '42')).toEqual({ status: 200, data: null })
  })

  it('the raw-write fallback answers only after the membership proof', async () => {
    const proven = deps({ deleteActivity: async () => null })
    expect(await lineRemovedAnswer(proven, 'request', '42')).toEqual({ status: 200, data: proc })
    const unproven = deps({ deleteActivity: async () => null, lastRevisionData: async () => null })
    expect(await lineRemovedAnswer(unproven, 'request', '42')).toEqual({ status: 200, data: null })
  })

  it('a line still there, or a link field the caller may not read, says nothing', async () => {
    expect(
      await lineRemovedAnswer(
        deps({ currentLine: async () => ({ request: '99' }) }),
        'request',
        '42'
      )
    ).toEqual({ status: 200, data: null })
    expect(
      await lineRemovedAnswer(deps({ mayReadLinkField: async () => false }), 'request', '42')
    ).toEqual({ status: 200, data: null })
  })

  it('parses revision snapshots', () => {
    expect(revisionData('{"request":"42"}')).toEqual({ request: '42' })
    expect(revisionData({ a: 1 })).toEqual({ a: 1 })
    expect(revisionData('nope')).toBeNull()
    expect(revisionData(null)).toBeNull()
  })
})

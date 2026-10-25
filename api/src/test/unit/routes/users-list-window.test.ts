import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import { isUserIdParam, listWindow } from '../../../routes/users.js'

describe('GET /users list window', () => {
  it('defaults to 25 from the start', () => {
    expect(listWindow({}, 1000)).toEqual({ limit: 25, offset: 0 })
  })

  it('treats limit=-1 (and 0) as everything up to the cap, never a negative TOP', () => {
    expect(listWindow({ limit: '-1' }, 1000)).toEqual({ limit: 1000, offset: 0 })
    expect(listWindow({ limit: '0' }, 500)).toEqual({ limit: 500, offset: 0 })
  })

  it('caps a large limit', () => {
    expect(listWindow({ limit: '5000' }, 1000).limit).toBe(1000)
  })

  it('pages by page (1-based), which wins over offset', () => {
    expect(listWindow({ limit: '1000', page: '2' }, 1000)).toEqual({ limit: 1000, offset: 1000 })
    expect(listWindow({ limit: '10', page: '3', offset: '7' }, 1000)).toEqual({
      limit: 10,
      offset: 20
    })
  })

  it('ignores a negative or garbage offset and page', () => {
    expect(listWindow({ offset: '-5' }, 1000).offset).toBe(0)
    expect(listWindow({ offset: 'x', page: '-1' }, 1000).offset).toBe(0)
    expect(listWindow({ offset: '30' }, 1000).offset).toBe(30)
  })
})

describe('isUserIdParam', () => {
  it('takes a uuid or me, nothing else', () => {
    expect(isUserIdParam('087389AF-2013-4A66-8C29-7F0E2E1047E5')).toBe(true)
    expect(isUserIdParam('me')).toBe(true)
    expect(isUserIdParam('abc')).toBe(false)
    expect(isUserIdParam('087389AF-2013-4A66-8C29')).toBe(false)
  })
})

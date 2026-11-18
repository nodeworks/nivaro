import { beforeEach, describe, expect, it, vi } from 'vitest'

const sync = vi.hoisted(() => ({ scheduled: [] as string[] }))
vi.mock('./outbound-sync.js', () => ({
  scheduleCommentOut: (id: string) => sync.scheduled.push(id)
}))

import { commentWritten } from './comment-out-hook.js'

beforeEach(() => {
  sync.scheduled = []
})

describe('commentWritten (every comment writer calls it after its insert)', () => {
  it('hands a whole-issue comment to GitLab sync', async () => {
    await commentWritten('c1', 'nivaro_issues', null)
    await commentWritten('c2', 'nivaro_issues')
    expect(sync.scheduled).toEqual(['c1', 'c2'])
  })

  it('a comment on another collection or on one field is not scheduled', async () => {
    await commentWritten('c3', 'orders', null)
    await commentWritten('c4', 'nivaro_issues', 'title')
    expect(sync.scheduled).toEqual([])
  })
})

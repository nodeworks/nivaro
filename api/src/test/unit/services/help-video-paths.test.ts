import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/help-video-render.js', () => ({ queueRender: vi.fn() }))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn() }))
vi.mock('../../../services/io-holder.js', () => ({ getApp: vi.fn() }))

import {
  isNewAccount,
  type MyLearningPathDto,
  NEW_ACCOUNT_WINDOW_MS,
  nextVideoId,
  parsePathDetails,
  parsePathRoles,
  parseVideoIds,
  pathProgress,
  sortMyPaths,
  splitRequired
} from '../../../services/help-video-paths.js'
import { requiredNotice } from '../../../services/help-videos.js'

const V1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const V2 = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const R1 = '11111111-1111-1111-1111-111111111111'
const R2 = '22222222-2222-2222-2222-222222222222'

const code = (fn: () => unknown) => {
  try {
    fn()
  } catch (e) {
    return (e as { statusCode: number; code: string }).code
  }
  return null
}

describe('parsePathDetails', () => {
  it('fills every default at create and needs a title', () => {
    expect(parsePathDetails({ title: '  Getting started ' }, 'create')).toEqual({
      title: 'Getting started',
      description: null,
      status: 'draft',
      new_user: false
    })
    expect(code(() => parsePathDetails({}, 'create'))).toBe('HELP_VIDEO_PATH_INVALID')
    expect(code(() => parsePathDetails({ title: 'x'.repeat(201) }, 'create'))).toBe(
      'HELP_VIDEO_PATH_INVALID'
    )
  })
  it('a patch changes only the keys given', () => {
    expect(parsePathDetails({ status: 'published' }, 'patch')).toEqual({ status: 'published' })
    expect(parsePathDetails({ description: '  ' }, 'patch')).toEqual({ description: null })
    expect(parsePathDetails({ new_user: true }, 'patch')).toEqual({ new_user: true })
    expect(code(() => parsePathDetails({ status: 'archived' }, 'patch'))).toBe(
      'HELP_VIDEO_PATH_INVALID'
    )
    expect(code(() => parsePathDetails({ new_user: 'yes' }, 'patch'))).toBe(
      'HELP_VIDEO_PATH_INVALID'
    )
  })
})

describe('parseVideoIds / parsePathRoles', () => {
  it('keeps exact uuids once, in order, upper-cased', () => {
    expect(parseVideoIds([V2, 'junk', `${V1}/../x`, V1, V2.toUpperCase()])).toEqual([
      V2.toUpperCase(),
      V1.toUpperCase()
    ])
    expect(code(() => parseVideoIds('nope'))).toBe('HELP_VIDEO_PATH_INVALID')
    expect(code(() => parseVideoIds(Array.from({ length: 101 }, () => V1)))).toBeNull()
  })
  it('reads roles as objects or bare ids; the first mention wins', () => {
    expect(
      parsePathRoles([{ role_id: R1, required: true }, R2, { role_id: R1, required: false }, 'x'])
    ).toEqual([
      { role_id: R1.toUpperCase(), required: true },
      { role_id: R2.toUpperCase(), required: false }
    ])
    expect(parsePathRoles([{ role_id: R1, required: 'yes' }])).toEqual([
      { role_id: R1.toUpperCase(), required: false }
    ])
  })
})

describe('pathProgress / nextVideoId', () => {
  it('counts the videos given and is finished only when all are completed', () => {
    expect(pathProgress([])).toEqual({ total: 0, completed: 0, percent: 0, finished: false })
    expect(pathProgress([{ completed: true }, { completed: false }, { completed: false }])).toEqual(
      { total: 3, completed: 1, percent: 33, finished: false }
    )
    expect(pathProgress([{ completed: true }, { completed: true }])).toEqual({
      total: 2,
      completed: 2,
      percent: 100,
      finished: true
    })
  })
  it('the next video is the first unfinished one in order', () => {
    expect(
      nextVideoId([
        { id: 'a', completed: true },
        { id: 'b', completed: false },
        { id: 'c', completed: false }
      ])
    ).toBe('b')
    expect(nextVideoId([{ id: 'a', completed: true }])).toBeNull()
  })
})

describe('isNewAccount', () => {
  const now = Date.UTC(2026, 9, 10)
  it('the provisional new-user role counts, whatever the age', () => {
    expect(
      isNewAccount(
        { role: R1, created_at: new Date(now - 400 * 86_400_000) },
        R1.toUpperCase(),
        now
      )
    ).toBe(true)
  })
  it('an account made in the last seven days counts', () => {
    expect(isNewAccount({ role: R2, created_at: new Date(now - 6 * 86_400_000) }, R1, now)).toBe(
      true
    )
    expect(
      isNewAccount({ role: R2, created_at: new Date(now - NEW_ACCOUNT_WINDOW_MS - 1) }, R1, now)
    ).toBe(false)
    expect(isNewAccount({ role: R2, created_at: null }, null, now)).toBe(false)
  })
})

const path = (p: Partial<MyLearningPathDto> & { id: string }): MyLearningPathDto => ({
  title: p.id,
  description: null,
  required: false,
  new_user: false,
  videos: [],
  progress: { total: 0, completed: 0, percent: 0, finished: false },
  next_video_id: null,
  ...p
})
const vid = (id: string) => ({ id }) as unknown as MyLearningPathDto['videos'][number]

describe('splitRequired', () => {
  it('lists a required unfinished path once and drops its videos from the singles', () => {
    const p = path({
      id: 'p1',
      required: true,
      videos: [vid(V1), vid(V2)],
      progress: { total: 2, completed: 1, percent: 50, finished: false },
      next_video_id: V2
    })
    const out = splitRequired([{ id: V1 }, { id: 'cccccccc-cccc-cccc-cccc-cccccccccccc' }], [p])
    expect(out.paths).toEqual([p])
    expect(out.data.map((v) => v.id)).toEqual(['cccccccc-cccc-cccc-cccc-cccccccccccc'])
  })
  it('a finished or optional path takes nothing away', () => {
    const done = path({
      id: 'p1',
      required: true,
      videos: [vid(V1)],
      progress: { total: 1, completed: 1, percent: 100, finished: true }
    })
    const optional = path({ id: 'p2', videos: [vid(V2)] })
    const out = splitRequired([{ id: V1 }, { id: V2 }], [done, optional])
    expect(out.paths).toEqual([])
    expect(out.data.map((v) => v.id)).toEqual([V1, V2])
  })
})

describe('sortMyPaths', () => {
  it('unfinished first, required before optional, then by title', () => {
    const a = path({ id: 'a', title: 'Zed' })
    const b = path({ id: 'b', title: 'Apple', required: true })
    const c = path({
      id: 'c',
      title: 'Done',
      progress: { total: 1, completed: 1, percent: 100, finished: true }
    })
    const d = path({ id: 'd', title: 'Bee' })
    expect(sortMyPaths([a, c, d, b]).map((p) => p.id)).toEqual(['b', 'd', 'a', 'c'])
  })
})

describe('requiredNotice for a path', () => {
  it('asks to complete the path and says where it is', () =>
    expect(requiredNotice('Getting started', { path: true })).toEqual({
      subject: 'Please complete: Getting started',
      message:
        'A learning path of short videos your role is asked to complete. It is on your dashboard under Required videos.',
      why: 'This learning path is required for your role.'
    }))
})

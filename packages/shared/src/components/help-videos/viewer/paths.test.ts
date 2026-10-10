import { describe, expect, it } from 'vitest'
import type { HelpVideoDto, MyLearningPathDto } from '../types'
import { continueVideo, moveItem, pathProgressLabel, pathsHeading } from './paths'

const vid = (id: string) => ({ id, title: id }) as unknown as HelpVideoDto
const path = (p: Partial<MyLearningPathDto>): MyLearningPathDto => ({
  id: 'p',
  title: 'P',
  description: null,
  required: false,
  new_user: false,
  videos: [],
  progress: { total: 0, completed: 0, percent: 0, finished: false },
  next_video_id: null,
  ...p
})

describe('pathProgressLabel', () => {
  it('says how far, finished, or that there is nothing yet', () => {
    expect(pathProgressLabel(path({}))).toBe('Nothing to watch yet')
    expect(
      pathProgressLabel(
        path({ progress: { total: 5, completed: 3, percent: 60, finished: false } })
      )
    ).toBe('3 of 5 watched')
    expect(
      pathProgressLabel(
        path({ progress: { total: 2, completed: 2, percent: 100, finished: true } })
      )
    ).toBe('Finished')
  })
})

describe('continueVideo', () => {
  it('is the next unfinished video, else the first, else null', () => {
    const p = path({ videos: [vid('a'), vid('b')], next_video_id: 'b' })
    expect(continueVideo(p)?.id).toBe('b')
    expect(continueVideo(path({ videos: [vid('a')], next_video_id: 'zzz' }))?.id).toBe('a')
    expect(continueVideo(path({ videos: [vid('a')], next_video_id: null }))?.id).toBe('a')
    expect(continueVideo(path({}))).toBeNull()
  })
})

describe('pathsHeading', () => {
  it('counts what is left to finish', () => {
    expect(pathsHeading([path({})])).toBe('Your learning path')
    expect(pathsHeading([path({}), path({})])).toBe('Your learning paths · 2 to finish')
    expect(
      pathsHeading([
        path({ progress: { total: 1, completed: 1, percent: 100, finished: true } }),
        path({})
      ])
    ).toBe('Your learning paths')
  })
})

describe('moveItem', () => {
  it('moves an item and leaves a bad move alone', () => {
    expect(moveItem(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a'])
    expect(moveItem(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b'])
    const same = ['a', 'b']
    expect(moveItem(same, 1, 1)).toBe(same)
    expect(moveItem(same, 0, 5)).toBe(same)
    expect(moveItem(same, -1, 0)).toBe(same)
  })
})

import { describe, expect, it, vi } from 'vitest'
import type { VideoEdits } from '../types'
import {
  blindRequiredRoles,
  describeMissing,
  joinNames,
  missingForPublish,
  renderLabel,
  viewersWaitForRender,
  whenSaved
} from './publish'

describe('missingForPublish', () => {
  it('needs a title and a place to show', () => {
    expect(missingForPublish({ title: '', contexts: [] })).toEqual(['title', 'where'])
    expect(missingForPublish({ title: 'Approve', contexts: [{}] })).toEqual([])
  })
  it('reads naturally', () => {
    expect(describeMissing(['title', 'where'])).toBe('Add a title and choose where it shows')
    expect(describeMissing(['where'])).toBe('Choose where it shows')
  })
})

describe('renderLabel', () => {
  const v = (s: string, current = false, progress: number | null = null) =>
    ({
      render_status: s,
      rendered_current: current,
      render_progress: progress,
      render_error: 'boom'
    }) as never
  it('describes each render state', () => {
    expect(renderLabel(null)).toEqual({ text: 'Not published', tone: 'neutral' })
    expect(renderLabel(v('rendering', false, 40))).toEqual({ text: 'Rendering 40%', tone: 'busy' })
    expect(renderLabel(v('queued'))).toEqual({ text: 'Waiting to render', tone: 'busy' })
    expect(renderLabel(v('ready', true))).toEqual({ text: 'Ready', tone: 'good' })
    expect(renderLabel(v('ready', false))).toEqual({
      text: 'Older render — re-render to include the latest edits',
      tone: 'neutral'
    })
    expect(renderLabel(v('failed'))).toEqual({ text: 'Render failed: boom', tone: 'bad' })
    expect(renderLabel(v('unavailable'))).toEqual({
      text: 'Plays with live edits (no renderer on this server)',
      tone: 'neutral'
    })
  })
})

describe('whenSaved', () => {
  it('runs the action once the save landed', async () => {
    const action = vi.fn(async () => 7)
    expect(await whenSaved(async () => true, action)).toEqual({ ok: true, value: 7 })
    expect(action).toHaveBeenCalledTimes(1)
  })
  it('never runs the action when the save failed', async () => {
    const publish = vi.fn(async () => 7)
    expect(await whenSaved(async () => false, publish)).toEqual({ ok: false })
    expect(publish).not.toHaveBeenCalled()
  })
  it('lets the action fail', async () => {
    await expect(
      whenSaved(
        async () => true,
        async () => {
          throw new Error('nope')
        }
      )
    ).rejects.toThrow('nope')
  })
})

describe('blindRequiredRoles', () => {
  it('names required roles the video is hidden from', () => {
    expect(blindRequiredRoles({ mode: 'roles', role_ids: ['aa'] }, ['AA', 'bb'])).toEqual(['bb'])
  })
  it('is quiet when everyone can watch', () => {
    expect(blindRequiredRoles({ mode: 'everyone', role_ids: [] }, ['bb'])).toEqual([])
    expect(blindRequiredRoles({ mode: 'roles', role_ids: [] }, ['bb'])).toEqual([])
  })
})

describe('joinNames', () => {
  it('joins in plain words', () => {
    expect(joinNames(['A'])).toBe('A')
    expect(joinNames(['A', 'B'])).toBe('A and B')
    expect(joinNames(['A', 'B', 'C'])).toBe('A, B and C')
  })
})

describe('viewersWaitForRender (mirror of the server rule)', () => {
  const base: VideoEdits = {
    v: 1,
    segments: [{ start_ms: 0, end_ms: 10_000, speed: 1 }],
    poster_ms: 0,
    chapters: [],
    annotations: [],
    zooms: [],
    blurs: [],
    captions: []
  }
  const ann = (type: string) => ({ ...base, annotations: [{ type } as never] })
  it('nothing hidden or cut: viewers play the recording at once', () => {
    expect(viewersWaitForRender(base, 10_000)).toBe(false)
    expect(viewersWaitForRender(ann('arrow'), 10_000)).toBe(false)
    expect(viewersWaitForRender(ann('ripple'), 10_000)).toBe(false)
    expect(viewersWaitForRender({ ...base, zooms: [{ id: 'z' } as never] }, 10_000)).toBe(false)
  })
  it('a blur, a box, a trim, a cut or an unknown length means waiting', () => {
    expect(viewersWaitForRender({ ...base, blurs: [{ id: 'b' } as never] }, 10_000)).toBe(true)
    expect(viewersWaitForRender(ann('box'), 10_000)).toBe(true)
    const seg = (a: number, b: number) => ({ start_ms: a, end_ms: b, speed: 1 as const })
    expect(viewersWaitForRender({ ...base, segments: [seg(500, 10_000)] }, 10_000)).toBe(true)
    expect(viewersWaitForRender({ ...base, segments: [seg(0, 9_000)] }, 10_000)).toBe(true)
    expect(
      viewersWaitForRender({ ...base, segments: [seg(0, 4_000), seg(5_000, 10_000)] }, 10_000)
    ).toBe(true)
    expect(viewersWaitForRender(base, null)).toBe(true)
  })
})

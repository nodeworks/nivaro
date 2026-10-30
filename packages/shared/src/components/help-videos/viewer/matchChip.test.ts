import { describe, expect, it } from 'vitest'
import type { HelpVideoDto } from '../types'
import {
  CHIP_DISMISSED_KEY,
  chipAllowedOn,
  chipLabel,
  chipVideo,
  readDismissed,
  rememberDismissed
} from './matchChip'

const video = (id: string, over: Partial<HelpVideoDto> = {}) =>
  ({
    id,
    title: 'How to submit an IR',
    duration_ms: 130_000,
    my_progress: null,
    published: { playable: true },
    ...over
  }) as unknown as HelpVideoDto

function memoryStore() {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    raw: m
  }
}

describe('help-video match chip (#18)', () => {
  it('offers the server best match unless dismissed, finished or not ready', () => {
    const list = [video('A'), video('B')]
    expect(chipVideo(list, 'b', new Set())?.id).toBe('B')
    expect(chipVideo(list, 'B', new Set(['b']))).toBeNull()
    expect(
      chipVideo([video('B', { my_progress: { completed: true } as never })], 'B', new Set())
    ).toBeNull()
    expect(
      chipVideo([video('B', { published: { playable: false } as never })], 'B', new Set())
    ).toBeNull()
    expect(chipVideo(list, null, new Set())).toBeNull()
  })

  it('labels the chip with the title and length', () => {
    expect(chipLabel(video('A'))).toBe('Watch: How to submit an IR (2:10)')
    expect(chipLabel(video('A', { duration_ms: null }))).toBe('Watch: How to submit an IR')
  })

  it('remembers dismissals per video', () => {
    const store = memoryStore()
    rememberDismissed('ABC', store)
    rememberDismissed('def', store)
    expect([...readDismissed(store)]).toEqual(['abc', 'def'])
    store.setItem(CHIP_DISMISSED_KEY, 'not json')
    expect(readDismissed(store).size).toBe(0)
  })

  it('never shows on the video library itself', () => {
    expect(chipAllowedOn('/help-videos')).toBe(false)
    expect(chipAllowedOn('/help/videos/x')).toBe(false)
    expect(chipAllowedOn('/collections/inventory_request')).toBe(true)
  })
})

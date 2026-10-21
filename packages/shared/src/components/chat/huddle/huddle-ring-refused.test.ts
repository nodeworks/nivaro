import { describe, expect, it, vi } from 'vitest'

const toast = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast }))

import { ringRefusedText, waitWords, watchRingRefused } from './huddle-ring-refused'
import type { HuddleTransport } from './huddle-store'

describe('ring refused (security review finding 1)', () => {
  it('words the wait', () => {
    expect(waitWords(25)).toBe('25 s')
    expect(waitWords(0)).toBe('1 s')
    expect(waitWords(61)).toBe('2 min')
    expect(waitWords(600)).toBe('10 min')
  })

  it('names who cannot be called yet and the longest wait', () => {
    expect(
      ringRefusedText({
        room: 'ch:a',
        users: [{ id: 'U2', name: 'Ana', reason: 'cooldown', retry_in: 25 }]
      })
    ).toEqual({
      title: 'You can call Ana again in 25 s',
      description: 'They just declined or missed a call from you.'
    })
    expect(
      ringRefusedText({
        room: 'ch:a',
        users: [
          { id: 'U2', name: 'Ana', reason: 'cooldown', retry_in: 25 },
          { id: 'U3', name: null, reason: 'limit', retry_in: 400 }
        ]
      })?.title
    ).toBe('You can call Ana and Someone again in 7 min')
  })

  it('the per-minute cap reads as a call cap; an empty refusal says nothing', () => {
    expect(ringRefusedText({ room: 'ch:a', reason: 'rate', retry_in: 40, users: [] })?.title).toBe(
      'You can start another call in 40 s'
    )
    expect(ringRefusedText({ room: 'ch:a', users: [] })).toBeNull()
  })

  it('a refusal from the server becomes one toast per room', () => {
    let handler: ((p: unknown) => void) | undefined
    const t: HuddleTransport = {
      on: (event, cb) => {
        if (event === 'huddle:ring-refused') handler = cb
        return () => {}
      },
      emit: () => {}
    }
    watchRingRefused(t)
    handler?.({ room: 'dm:x', users: [{ id: 'U2', name: 'Ana', reason: 'cooldown', retry_in: 9 }] })
    expect(toast).toHaveBeenCalledWith('You can call Ana again in 9 s', {
      id: 'huddle-ring-refused-dm:x',
      description: 'They just declined or missed a call from you.'
    })
  })
})

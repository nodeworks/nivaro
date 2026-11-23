import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/pool-context.js', () => ({ runInBackgroundPool: (fn: () => unknown) => fn() }))

import {
  _resetCommentListeners,
  _setCommentListenersEnabledCheck,
  commentCreated,
  commentListenerCount,
  registerCommentListener,
  unregisterCommentListeners
} from '../../../services/comment-listeners.js'

// Record comments are not an items collection, so hooks.after never fires for them; extensions
// hear them through ctx.comments.onCreated (prod 2026-11-23: EFP's MWF message push watched
// `notes` while people wrote comments, so nothing reached MWF).

const event = {
  id: 'c-1',
  collection: 'workflows',
  item: '42',
  field: null,
  text: 'hello',
  author: 'u-1',
  writtenBy: 'u-1',
  source: 'comment' as const
}

afterEach(() => {
  _resetCommentListeners()
  _setCommentListenersEnabledCheck(async () => true)
})

describe('comment listeners', () => {
  it('every listener of an enabled extension hears the comment', async () => {
    _setCommentListenersEnabledCheck(async () => true)
    const a = vi.fn()
    const b = vi.fn()
    expect(registerCommentListener('ext-a', a)).toBe(true)
    registerCommentListener('ext-b', b)
    await commentCreated(event)
    expect(a).toHaveBeenCalledWith(event)
    expect(b).toHaveBeenCalledTimes(1)
  })

  it('a throwing listener never stops the others or the caller', async () => {
    _setCommentListenersEnabledCheck(async () => true)
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const after = vi.fn()
    registerCommentListener('ext-a', () => {
      throw new Error('boom')
    })
    registerCommentListener('ext-a', after)
    await expect(commentCreated(event)).resolves.toBeUndefined()
    expect(after).toHaveBeenCalledTimes(1)
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })

  it('a disabled extension hears nothing; an unloaded one is forgotten', async () => {
    _setCommentListenersEnabledCheck(async (ext) => ext !== 'off')
    const off = vi.fn()
    const gone = vi.fn()
    registerCommentListener('off', off)
    registerCommentListener('gone', gone)
    unregisterCommentListeners('gone')
    expect(commentListenerCount('gone')).toBe(0)
    await commentCreated(event)
    expect(off).not.toHaveBeenCalled()
    expect(gone).not.toHaveBeenCalled()
  })

  it('a listener cannot change the event others see', async () => {
    _setCommentListenersEnabledCheck(async () => true)
    const seen: string[] = []
    registerCommentListener('ext-a', (e) => {
      try {
        ;(e as { text: string }).text = 'changed'
      } catch {
        /* frozen */
      }
    })
    registerCommentListener('ext-b', (e) => {
      seen.push(e.text)
    })
    await commentCreated(event)
    expect(seen).toEqual(['hello'])
  })

  it('refuses a handler that is not a function', () => {
    expect(registerCommentListener('ext-a', 'nope' as never)).toBe(false)
    expect(commentListenerCount('ext-a')).toBe(0)
  })
})

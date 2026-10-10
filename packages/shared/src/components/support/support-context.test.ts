// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { prepareReplayClip, registerReplayCapture } from '../../lib/replay-capture'
import {
  formatReplayTail,
  getReplayTail,
  noteTailEvent,
  resetReplayTail,
  TAIL_CONSOLE,
  TAIL_REQUESTS
} from '../../lib/replay-tail'
import { collectSupportContext, supportContextFile } from './support-context'

const AT = Date.parse('2026-10-10T14:03:11Z')
let undo: (() => void) | null = null
beforeEach(() => resetReplayTail())
afterEach(() => {
  undo?.()
  undo = null
})

describe('the console + request tail', () => {
  it('keeps the last 30 console lines and the last 20 requests', () => {
    for (let i = 0; i < 50; i++) {
      noteTailEvent('console', { level: 'error', msg: `boom ${i}` }, AT + i)
      noteTailEvent(
        'request',
        { method: 'GET', route: `/api/items/:id`, status: 200, duration_ms: i },
        AT + i
      )
    }
    const tail = getReplayTail()
    expect(tail.console).toHaveLength(TAIL_CONSOLE)
    expect(tail.console[0].msg).toBe('boom 20')
    expect(tail.requests).toHaveLength(TAIL_REQUESTS)
    expect(tail.requests.at(-1)).toEqual({
      at: AT + 49,
      method: 'GET',
      route: '/api/items/:id',
      status: 200,
      ms: 49
    })
  })

  it('formats route, status and ms per request', () => {
    noteTailEvent('console', { level: 'warn', msg: 'slow' }, AT)
    noteTailEvent(
      'request',
      { method: 'PATCH', route: '/api/items/claims/:id', status: 0, duration_ms: 1234 },
      AT
    )
    const text = formatReplayTail(getReplayTail(), { route: '/claims/7', when: new Date(AT) })
    expect(text).toContain('Page: /claims/7')
    expect(text).toContain('14:03:11 [warn] slow')
    expect(text).toMatch(/PATCH\s+ERR\s+1234ms {2}\/api\/items\/claims\/:id/)
  })
})

describe('prepareReplayClip', () => {
  it('takes the moment at prepare time and uploads only on commit', async () => {
    const upload = vi.fn(async () => ({ recording_id: 'clip-9', offset_ms: 41_000 }))
    const snap = vi.fn(() => upload)
    undo = registerReplayCapture(async () => null, snap)
    const prepared = prepareReplayClip('support')
    expect(snap).toHaveBeenCalledWith('support')
    expect(upload).not.toHaveBeenCalled()
    expect(await prepared.commit()).toEqual({ recording_id: 'clip-9', offset_ms: 41_000 })
  })

  it('resolves null with no recorder', async () => {
    expect(await prepareReplayClip('support').commit()).toBeNull()
  })
})

describe('collectSupportContext', () => {
  it('assembles the attachment and the replay link', async () => {
    noteTailEvent(
      'request',
      { method: 'POST', route: '/api/support/tickets', status: 500, duration_ms: 88 },
      AT
    )
    const uploaded: File[] = []
    const ctx = await collectSupportContext({
      clip: { commit: async () => ({ recording_id: 'r1', offset_ms: 30_000 }) },
      route: '/claims/7',
      upload: async (f) => {
        uploaded.push(f)
        return { id: 'file-1' }
      },
      when: new Date(AT)
    })
    expect(ctx.fileId).toBe('file-1')
    expect(ctx.replay).toEqual({ recording_id: 'r1', offset_ms: 30_000 })
    expect(uploaded[0].name).toBe('what-they-saw-2026-10-10T14-03-11.txt')
    expect(uploaded[0].size).toBe(ctx.text.length)
    expect(ctx.text).toContain('/api/support/tickets')
  })

  it('never fails the request when the clip or the upload fails', async () => {
    const ctx = await collectSupportContext({
      clip: { commit: async () => Promise.reject(new Error('x')) },
      route: '/',
      upload: async () => {
        throw new Error('offline')
      }
    })
    expect(ctx).toMatchObject({ fileId: null, replay: null })
  })

  it('names the file by time', () => {
    expect(supportContextFile('x', new Date(AT)).type).toBe('text/plain')
  })
})

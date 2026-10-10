import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildClientCrashBody, reportClientCrash } from './client-crash'
import { captureReplayClip, registerReplayCapture, replayHref } from './replay-capture'

let undo: (() => void) | null = null
afterEach(() => {
  undo?.()
  undo = null
  vi.useRealTimers()
})

describe('captureReplayClip', () => {
  it('resolves null when no recorder registered', async () => {
    expect(await captureReplayClip()).toBeNull()
  })

  it('passes the kind to the registered recorder', async () => {
    const fn = vi.fn(async () => ({ recording_id: 'r1', offset_ms: null }))
    undo = registerReplayCapture(fn)
    expect(await captureReplayClip('support')).toEqual({ recording_id: 'r1', offset_ms: null })
    expect(fn).toHaveBeenCalledWith('support')
  })

  it('gives up after the timeout and swallows errors', async () => {
    undo = registerReplayCapture(() => new Promise(() => {}))
    expect(await captureReplayClip('error', 10)).toBeNull()
    undo()
    undo = registerReplayCapture(async () => {
      throw new Error('boom')
    })
    expect(await captureReplayClip()).toBeNull()
  })

  it('builds the replay deep link', () => {
    expect(replayHref({ recording_id: 'abc', offset_ms: 4200.7 })).toBe(
      '/session-replays?recording=abc&t=4200'
    )
    expect(replayHref({ recording_id: 'abc', offset_ms: null }, 'https://cms.x/')).toBe(
      'https://cms.x/session-replays?recording=abc'
    )
  })
})

describe('reportClientCrash', () => {
  it('assembles message, stack and component stack, capped', () => {
    const err = new Error('kaput')
    err.stack = 'Error: kaput\n at x'
    const body = buildClientCrashBody(err, { componentStack: '\n in Page' }, '/claims', null)
    expect(body).toEqual({
      message: 'kaput',
      stack: 'Error: kaput\n at x\n---\n\n in Page',
      url: '/claims'
    })
    const long = buildClientCrashBody('x'.repeat(10), null, '/a'.repeat(400), null)
    expect(long.url.length).toBe(300)
    expect(long.message).toBe('xxxxxxxxxx')
  })

  it('attaches the clip the recorder hands back', async () => {
    undo = registerReplayCapture(async (kind) =>
      kind === 'error' ? { recording_id: 'clip-1', offset_ms: null } : null
    )
    const request = vi.fn(async () => undefined)
    await reportClientCrash({ request } as never, new Error('bad'), null, { url: '/home' })
    const cmd = (request.mock.calls[0] as unknown[])[0] as { _path: string; _body: unknown }
    expect(cmd._path).toBe('/issues/client')
    expect(cmd._body).toMatchObject({
      message: 'bad',
      url: '/home',
      recording_id: 'clip-1',
      recording_offset_ms: null
    })
  })

  it('never throws when the post fails', async () => {
    const request = vi.fn(async () => {
      throw new Error('offline')
    })
    await expect(reportClientCrash({ request } as never, new Error('x'))).resolves.toBeUndefined()
  })
})

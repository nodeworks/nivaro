// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emitReplayTap, setReplayRecorderMode } from './replay-capture'
import { buildReplayMaskingOptions, normalizeReplayMasking } from './replay-masking'
import {
  __resetScreenShare,
  createFrameAssembler,
  FLUSH_MS,
  foldShareHistory,
  packBatch,
  type ScreenShareInfo,
  type ScreenShareTransport,
  screenEvents,
  screenShareRunning,
  screenShareStatus,
  startScreenShare,
  stopScreenShare
} from './screen-share'

const SHARE: ScreenShareInfo = {
  id: 'a'.repeat(32),
  ticket: 7,
  sharer_name: 'Rita',
  to: { kind: 'user', name: 'Beth' },
  started_at: 0,
  expires_at: 30 * 60_000,
  max_ms: 30 * 60_000
}

function fakeTransport() {
  const handlers = new Map<string, Set<(p: any) => void>>()
  const emitted: Array<{ event: string; payload: any }> = []
  const stops: unknown[][] = []
  const t: ScreenShareTransport = {
    emit: (event, payload) => emitted.push({ event, payload }),
    on: (event, cb) => {
      const set = handlers.get(event) ?? new Set()
      set.add(cb)
      handlers.set(event, set)
      return () => set.delete(cb)
    },
    stop: (...a) => {
      stops.push(a)
    }
  }
  const fire = (event: string, payload: unknown) => {
    for (const cb of handlers.get(event) ?? []) cb(payload)
  }
  return { t, emitted, stops, fire }
}

function fakeRecord() {
  const calls: Array<Record<string, any>> = []
  let emit: ((e: unknown) => void) | null = null
  const record = Object.assign(
    (opts: Record<string, any>) => {
      calls.push(opts)
      emit = opts.emit
      emit?.({ type: 4, timestamp: 1, data: { width: 800, height: 600 } })
      emit?.({ type: 2, timestamp: 2, data: {} })
      return () => {
        emit = null
      }
    },
    { takeFullSnapshot: vi.fn() }
  )
  return { record, calls, emit: (e: unknown) => emit?.(e) }
}

const frames = (emitted: Array<{ event: string; payload: any }>) =>
  emitted.filter((e) => e.event === 'screenshare:frame').map((e) => e.payload)

function decode(fs: any[]): any[] {
  const asm = createFrameAssembler()
  const out: any[] = []
  for (const f of fs) out.push(...asm.push(f).events)
  return out
}

beforeEach(() => {
  vi.useFakeTimers()
  setReplayRecorderMode(null)
})
afterEach(() => {
  __resetScreenShare()
  setReplayRecorderMode(null)
  vi.useRealTimers()
})

describe('masking reuse', () => {
  it('its own record() gets exactly session replay masking for the instance rules', async () => {
    const tr = fakeTransport()
    const rec = fakeRecord()
    const masking = {
      allow_fields: ['orders.status'],
      mask_rich_text: true,
      mask_file_names: false
    }
    const ok = await startScreenShare({
      share: SHARE,
      masking,
      transport: tr.t,
      runtime: { loadRecord: async () => rec.record as never, loadReplayer: async () => null },
      win: null
    })
    expect(ok).toBe(true)
    tr.fire('screenshare:snapshot', { ticket: 7, share: SHARE.id })
    await vi.advanceTimersByTimeAsync(0)
    expect(rec.calls).toHaveLength(1)
    const want = buildReplayMaskingOptions(normalizeReplayMasking(masking))
    const got = rec.calls[0]
    for (const k of ['maskAllInputs', 'blockClass', 'blockSelector', 'maskTextSelector'] as const)
      expect(got[k]).toEqual(want[k])
    // Same decisions as replay: a password never shows, an allowed field does.
    document.body.innerHTML = `
      <div data-collection="orders"><div data-field="status"><input id="a" value="x"></div>
      <div data-field="amount"><input id="b" value="y"></div></div><input id="p" type="password">`
    const el = (id: string) => document.getElementById(id) as HTMLElement
    expect(got.maskInputFn('Open', el('a'))).toBe(want.maskInputFn('Open', el('a')))
    expect(got.maskInputFn('Open', el('a'))).toBe('Open')
    expect(got.maskInputFn('500', el('b'))).toBe('***')
    expect(got.maskInputFn('hunter2', el('p'))).toBe('*******')
  })

  it('no rules from the server = the strict defaults (never looser)', async () => {
    const tr = fakeTransport()
    const rec = fakeRecord()
    await startScreenShare({
      share: SHARE,
      transport: tr.t,
      runtime: { loadRecord: async () => rec.record as never, loadReplayer: async () => null },
      win: null
    })
    tr.fire('screenshare:snapshot', { ticket: 7, share: SHARE.id })
    await vi.advanceTimersByTimeAsync(0)
    expect(rec.calls[0].maskAllInputs).toBe(true)
    expect(rec.calls[0].blockSelector).toContain('[data-file-thumb]')
  })

  it('rides a running recorder (one rrweb stream per page) instead of a second record()', async () => {
    setReplayRecorderMode('clip')
    const tr = fakeTransport()
    const rec = fakeRecord()
    await startScreenShare({
      share: SHARE,
      transport: tr.t,
      runtime: { loadRecord: async () => rec.record as never, loadReplayer: async () => null },
      win: null
    })
    tr.fire('screenshare:snapshot', { ticket: 7, share: SHARE.id })
    await vi.advanceTimersByTimeAsync(0)
    expect(rec.calls).toHaveLength(0)
    expect(rec.record.takeFullSnapshot).toHaveBeenCalled()
    emitReplayTap({ type: 2, timestamp: 5, data: {} })
    emitReplayTap({ type: 5, timestamp: 6, data: { tag: 'console', payload: 'secret' } })
    await vi.advanceTimersByTimeAsync(FLUSH_MS + 50)
    expect(decode(frames(tr.emitted)).map((e) => e.type)).toEqual([2])
  })
})

describe('what travels', () => {
  it('only screen events; nothing until someone watches; stops when nobody does', async () => {
    const tr = fakeTransport()
    const rec = fakeRecord()
    await startScreenShare({
      share: SHARE,
      transport: tr.t,
      runtime: { loadRecord: async () => rec.record as never, loadReplayer: async () => null },
      win: null
    })
    await vi.advanceTimersByTimeAsync(FLUSH_MS * 3)
    expect(frames(tr.emitted)).toHaveLength(0)
    tr.fire('screenshare:snapshot', { ticket: 7, share: SHARE.id })
    await vi.advanceTimersByTimeAsync(0)
    rec.emit({ type: 3, timestamp: 3, data: {} })
    rec.emit({ type: 5, timestamp: 4, data: { tag: 'request' } })
    rec.emit({ type: 6, timestamp: 4, data: {} })
    await vi.advanceTimersByTimeAsync(FLUSH_MS + 50)
    expect(decode(frames(tr.emitted)).map((e) => e.type)).toEqual([4, 2, 3])
    tr.fire('screenshare:watching', { ticket: 7, share: SHARE.id, names: [] })
    const before = frames(tr.emitted).length
    rec.emit({ type: 3, timestamp: 9, data: {} })
    await vi.advanceTimersByTimeAsync(FLUSH_MS * 3)
    expect(frames(tr.emitted)).toHaveLength(before)
  })

  it('ignores another share’s requests', async () => {
    const tr = fakeTransport()
    const rec = fakeRecord()
    await startScreenShare({
      share: SHARE,
      transport: tr.t,
      runtime: { loadRecord: async () => rec.record as never, loadReplayer: async () => null },
      win: null
    })
    tr.fire('screenshare:snapshot', { ticket: 7, share: 'b'.repeat(32) })
    await vi.advanceTimersByTimeAsync(0)
    expect(rec.calls).toHaveLength(0)
  })
})

describe('stopping', () => {
  it('Stop tells the server; a server end does not call back; one share per page', async () => {
    const tr = fakeTransport()
    const rec = fakeRecord()
    const rt = { loadRecord: async () => rec.record as never, loadReplayer: async () => null }
    await startScreenShare({ share: SHARE, transport: tr.t, runtime: rt, win: null })
    expect(screenShareRunning()).toBe(true)
    expect(await startScreenShare({ share: SHARE, transport: tr.t, runtime: rt, win: null })).toBe(
      false
    )
    stopScreenShare()
    expect(tr.stops).toEqual([[7, SHARE.id, undefined]])
    expect(screenShareStatus()?.ended).toBe('You stopped sharing')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(screenShareStatus()).toBeNull()

    await startScreenShare({ share: SHARE, transport: tr.t, runtime: rt, win: null })
    tr.fire('screenshare:ended', { ticket: 7, share: SHARE.id, reason: 'moved' })
    expect(tr.stops).toHaveLength(1)
    expect(screenShareStatus()?.ended).toMatch(/moved/)
  })

  it('stops by itself at the time limit and when the page closes', async () => {
    const tr = fakeTransport()
    const rec = fakeRecord()
    const rt = { loadRecord: async () => rec.record as never, loadReplayer: async () => null }
    await startScreenShare({ share: SHARE, transport: tr.t, runtime: rt, win: null, now: () => 0 })
    await vi.advanceTimersByTimeAsync(30 * 60_000)
    expect(screenShareRunning()).toBe(false)
    expect(tr.stops).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(5_000)

    await startScreenShare({ share: SHARE, transport: tr.t, runtime: rt, win: window })
    window.dispatchEvent(new Event('pagehide'))
    expect(screenShareRunning()).toBe(false)
    expect(tr.stops.at(-1)).toEqual([7, SHARE.id, 'page'])
  })
})

describe('frames on the wire', () => {
  it('splits a big batch into parts and puts it back together', () => {
    const big = [{ type: 2, timestamp: 1, data: { text: 'x'.repeat(150_000) } }]
    const parts = packBatch(0, big, 60_000)
    expect(parts.length).toBe(3)
    expect(parts.every((p) => p.data.length <= 60_000)).toBe(true)
    expect(decode(parts)).toEqual(big)
  })

  it('a lost batch is a gap: incremental events wait for the next full snapshot', () => {
    const asm = createFrameAssembler()
    const first = asm.push(packBatch(0, [{ type: 4 }, { type: 2 }])[0])
    expect(first).toMatchObject({ snapshot: true, gap: false })
    expect(first.events.map((e: any) => e.type)).toEqual([4, 2])
    const lost = asm.push(packBatch(2, [{ type: 3 }])[0])
    expect(lost).toEqual({ events: [], gap: true, snapshot: false })
    const back = asm.push(packBatch(3, [{ type: 3 }, { type: 4 }, { type: 2 }, { type: 3 }])[0])
    expect(back.snapshot).toBe(true)
    expect(back.events.map((e: any) => e.type)).toEqual([4, 2, 3])
  })

  it('screenEvents keeps Meta / FullSnapshot / IncrementalSnapshot only', () => {
    expect(
      screenEvents([{ type: 0 }, { type: 1 }, { type: 2 }, { type: 3 }, { type: 4 }, { type: 5 }])
    ).toEqual([{ type: 2 }, { type: 3 }, { type: 4 }])
  })
})

describe('ticket history', () => {
  const row = (
    id: number,
    action: string | null,
    text: string,
    user_name: string | null = 'Rita'
  ) => ({
    id,
    action,
    text,
    user_name,
    at: `2026-11-15T06:0${id}:00Z`
  })

  it('folds one share into one line and keeps every other row', () => {
    const out = foldShareHistory([
      row(1, 'update', 'Picked up by Beth · In progress', 'Beth'),
      row(2, 'screen-share-start', 'Started sharing their screen with Beth'),
      row(3, 'support-traffic-view', 'Viewed the requester traffic', 'Beth'),
      row(4, 'screen-share-watch', "Watched Rita's shared screen", 'Beth'),
      row(
        5,
        'screen-share-stop',
        'Screen share ended: sharing stopped when the page closed (4 min)',
        null
      ),
      row(6, 'screen-share-start', 'Started sharing their screen with Beth'),
      row(7, 'screen-share-stop', 'Stopped sharing their screen (1 min)')
    ])
    expect(out.map((r) => r.text)).toEqual([
      'Picked up by Beth · In progress',
      'Shared their screen with Beth · 4 min · watched · page closed',
      'Viewed the requester traffic',
      'Shared their screen with Beth · 1 min · not watched'
    ])
    expect(out[1].user_name).toBe('Rita')
  })

  it('names a watcher who is not the shared-with person; a live unwatched share = not opened yet', () => {
    const out = foldShareHistory([
      row(1, 'screen-share-start', 'Started sharing their screen with the Desk team'),
      row(2, 'screen-share-watch', "Watched Rita's shared screen", 'Tom'),
      row(3, 'screen-share-stop', 'Stopped sharing their screen (2 min)'),
      row(4, 'screen-share-start', 'Started sharing their screen with Beth')
    ])
    expect(out.map((r) => r.text)).toEqual([
      'Shared their screen with the Desk team · 2 min · watched by Tom',
      'Sharing their screen with Beth now · not opened yet'
    ])
  })

  it('a share still running reads as now', () => {
    const out = foldShareHistory([
      row(1, 'screen-share-start', 'Started sharing their screen with Beth'),
      row(2, 'screen-share-watch', "Watched Rita's shared screen", 'Beth')
    ])
    expect(out.map((r) => r.text)).toEqual(['Sharing their screen with Beth now · watching now'])
  })
})

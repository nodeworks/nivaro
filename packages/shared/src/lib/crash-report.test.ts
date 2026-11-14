import { describe, expect, it, vi } from 'vitest'
import {
  buildCrashBody,
  type CrashBody,
  createCrashReporter,
  isCrashWorthy,
  scrubCrashText
} from './crash-report'

const flush = () => new Promise((r) => setTimeout(r, 0))

function setup(over: { now?: () => number; maxPerMinute?: number; maxPerTab?: number } = {}) {
  const sent: CrashBody[] = []
  const reporter = createCrashReporter({
    app: 'admin',
    release: '0.3.157',
    screen: () => '/collections/workflows/85607',
    send: async (b) => {
      sent.push(b)
    },
    ...over
  })
  return { sent, reporter }
}

describe('createCrashReporter', () => {
  it('sends one report with app, screen pattern, release, kind and name', async () => {
    const { sent, reporter } = setup()
    expect(
      reporter.report(new TypeError('nn.find is not a function'), 'render', '  at Lines')
    ).toBe(true)
    await flush()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      message: 'nn.find is not a function',
      name: 'TypeError',
      kind: 'render',
      app: 'admin',
      screen: '/collections/workflows/:id',
      url: '/collections/workflows/:id',
      release: '0.3.157'
    })
    expect(sent[0].stack).toContain('---\n  at Lines')
  })

  it('dedupes the same error inside five minutes, then counts it again', async () => {
    let t = 1_000_000
    const { sent, reporter } = setup({ now: () => t })
    const err = new TypeError("Cannot read properties of null (reading 'id')")
    expect(reporter.report(err, 'error')).toBe(true)
    expect(reporter.report(err, 'error')).toBe(false)
    t += 5 * 60_000
    expect(reporter.report(err, 'error')).toBe(true)
    await flush()
    expect(sent).toHaveLength(2)
  })

  it('rate-limits per minute and per tab', () => {
    let t = 0
    const { reporter } = setup({ now: () => t, maxPerMinute: 3, maxPerTab: 5 })
    let taken = 0
    for (let i = 0; i < 10; i++) if (reporter.report(new RangeError(`bad ${i}`), 'error')) taken++
    expect(taken).toBe(3)
    t += 60_000
    for (let i = 10; i < 20; i++) if (reporter.report(new RangeError(`bad ${i}`), 'error')) taken++
    expect(taken).toBe(5)
    expect(reporter.sent).toBe(5)
  })

  it('leaves the network, server answers, aborts and non-errors alone outside a render', () => {
    const { reporter } = setup()
    expect(reporter.report(new TypeError('Failed to fetch'), 'rejection')).toBe(false)
    expect(
      reporter.report(Object.assign(new Error('Forbidden'), { status: 403 }), 'rejection')
    ).toBe(false)
    const abort = new Error('The user aborted a request.')
    abort.name = 'AbortError'
    expect(reporter.report(abort, 'rejection')).toBe(false)
    expect(reporter.report('boom', 'rejection')).toBe(false)
    expect(reporter.report(null, 'error')).toBe(false)
    // A render that throws anything still crashed.
    expect(reporter.report('boom', 'render')).toBe(true)
  })

  it('ignores a browser extension failing in its own script', () => {
    const err = new TypeError('x is undefined')
    err.stack = 'TypeError: x is undefined\n    at chrome-extension://abc/content.js:1:1'
    expect(isCrashWorthy(err)).toBe(false)
    expect(setup().reporter.report(err, 'error')).toBe(false)
  })

  it('listens to window errors and unhandled rejections and stops when uninstalled', async () => {
    const { sent, reporter } = setup()
    const target = new EventTarget() as unknown as Window
    const off = reporter.install(target)
    const ev = new Event('error') as Event & { error?: unknown }
    ev.error = new ReferenceError('x is not defined')
    target.dispatchEvent(ev)
    const rej = new Event('unhandledrejection') as Event & { reason?: unknown }
    rej.reason = new TypeError('y is not iterable')
    target.dispatchEvent(rej)
    // A cross-origin "Script error." carries no Error.
    target.dispatchEvent(new Event('error'))
    await flush()
    expect(sent.map((b) => b.kind)).toEqual(['error', 'rejection'])
    off()
    const again = new Event('error') as Event & { error?: unknown }
    again.error = new ReferenceError('z is not defined')
    target.dispatchEvent(again)
    await flush()
    expect(sent).toHaveLength(2)
  })

  it('never throws when the send or the replay fails', async () => {
    const reporter = createCrashReporter({
      app: 'admin',
      send: vi.fn(async () => {
        throw new Error('offline')
      }),
      captureReplay: async () => {
        throw new Error('no recorder')
      }
    })
    expect(reporter.report(new TypeError('a'), 'error')).toBe(true)
    await flush()
  })

  it('carries the replay link', async () => {
    const sent: CrashBody[] = []
    const reporter = createCrashReporter({
      app: 'efp-new',
      screen: () => '/',
      send: async (b) => void sent.push(b),
      captureReplay: async () => ({ recording_id: 'r-1', offset_ms: 4200 })
    })
    reporter.report(new TypeError('a'), 'render')
    await flush()
    await flush()
    expect(sent[0]).toMatchObject({ recording_id: 'r-1', recording_offset_ms: 4200 })
  })
})

describe('scrubCrashText — no secrets, no typed values', () => {
  it('removes tokens, passwords, emails, opaque strings and query strings', () => {
    const s = scrubCrashText(
      'Bearer abc.def.ghi1234 nvo_A1b2C3d4E5f6 password=hunter2 token: "s3cr3t" mail jane@example.com ' +
        'key 9f8e7d6c5b4a39281706f5e4d3c2b1a0ffeeddcc https://x.test/assets/a.js?token=zz#frag:1:2'
    )
    expect(s).not.toMatch(/hunter2|s3cr3t|jane@example|nvo_A1b2|9f8e7d6c5b|token=zz|abc\.def/)
    expect(s).toContain('https://x.test/assets/a.js:1:2')
  })

  it('keeps identifiers in quotes and blanks typed values', () => {
    expect(scrubCrashText("Cannot read properties of undefined (reading 'find')")).toBe(
      "Cannot read properties of undefined (reading 'find')"
    )
    expect(scrubCrashText('Invalid amount "Jane Smith 4,000"')).toBe('Invalid amount "…"')
  })

  it('keeps a long component name', () => {
    expect(scrubCrashText('at CollectionBrowserInlineEditCellRenderer')).toContain(
      'CollectionBrowserInlineEditCellRenderer'
    )
  })

  it('the body scrubs message and stack and never carries the raw path', () => {
    const err = new TypeError('bad value "4111 1111 1111 1111"')
    err.stack = 'TypeError: bad\n  at f (https://h/assets/a.js?session=abcdef1234:1:1)'
    const b = buildCrashBody(err, 'error', { app: 'admin', screen: '/users/jane@example.com/edit' })
    expect(b.message).toBe('bad value "…"')
    expect(b.stack).not.toContain('session=')
    expect(b.screen).toBe('/users/:id/edit')
  })
})

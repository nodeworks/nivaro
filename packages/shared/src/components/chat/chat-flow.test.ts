// Chat outbox (#2782), long-room window (#2783) and request id detection (#2762).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  __chatOutboxForTests,
  __resetChatOutboxForTests,
  bindChatOutbox,
  discardOutbox,
  editOutbox,
  enqueueChatOutbox,
  flushChatOutbox,
  holdOutbox,
  isStaleOutboxItem,
  nextToSend,
  type OutboxItem,
  retryOutbox
} from './chat-outbox'
import { spanFor, WINDOW_FROM, windowFor } from './chat-window'
import { extractRequestIds, shortRequestId } from './RequestIdCard'

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))

function item(over: Partial<OutboxItem>): OutboxItem {
  return {
    client_id: 'c',
    room: 'ch:a',
    text: 'hi',
    mentions: [],
    attachments: [],
    parent_id: null,
    quote_id: null,
    urgent: false,
    status: 'queued',
    error: null,
    created_at: new Date().toISOString(),
    sender: 'u1',
    sender_name: null,
    ...over
  }
}

interface Sent {
  client_id: string
  message: string
}

/** A client whose network can be switched off; it records every POST body. */
function fakeClient() {
  const sent: Sent[] = []
  const state = { offline: false, refuse: false }
  return {
    sent,
    state,
    request: async <T = unknown>(cmd: unknown): Promise<T> => {
      const c = cmd as { _body?: Record<string, unknown> }
      if (state.offline) throw new TypeError('Failed to fetch')
      if (state.refuse) {
        const e = new Error('refused') as Error & { response: unknown; status: number }
        e.status = 403
        e.response = { error: 'That conversation is not available to you' }
        throw e
      }
      sent.push({ client_id: String(c._body?.client_id), message: String(c._body?.message) })
      return { data: { id: sent.length } } as T
    }
  }
}

const qc = { setQueryData: () => undefined, invalidateQueries: async () => undefined } as never

function send(id: string, text: string, room = 'ch:a') {
  enqueueChatOutbox({
    client_id: id,
    room,
    text,
    mentions: [],
    attachments: [],
    parent_id: null,
    quote_id: null,
    urgent: false,
    created_at: new Date().toISOString(),
    sender: 'u1',
    sender_name: null
  })
}

describe('chat outbox (#2782)', () => {
  beforeEach(() => __resetChatOutboxForTests())
  afterEach(() => __resetChatOutboxForTests())

  it('picks the earliest unsent message per room; a held or failed one is skipped', () => {
    const t = Date.now()
    const at = (s: number) => new Date(t + s * 1000).toISOString()
    const a1 = item({ client_id: 'a1', created_at: at(1) })
    const a2 = item({ client_id: 'a2', created_at: at(2) })
    const b1 = item({ client_id: 'b1', room: 'ch:b', created_at: at(3) })
    expect(nextToSend([a2, b1, a1])?.client_id).toBe('a1')
    // Being edited: room a waits (a2 never overtakes it), room b goes.
    expect(nextToSend([{ ...a1, held: true }, a2, b1])?.client_id).toBe('b1')
    // Failed: it waits for its writer; the rest of the room carries on.
    expect(nextToSend([{ ...a1, status: 'failed' }, a2])?.client_id).toBe('a2')
  })

  it('does not send a message that waited more than a day on its own', () => {
    const old = item({ created_at: new Date(Date.now() - 25 * 3600_000).toISOString() })
    expect(isStaleOutboxItem(old)).toBe(true)
    expect(nextToSend([old])).toBeNull()
  })

  it('queues while offline and sends in order with the same client ids on reconnect', async () => {
    const c = fakeClient()
    bindChatOutbox(c, qc, 'u1')
    await tick(5)
    c.state.offline = true
    send('m1', 'first')
    send('m2', 'second')
    await tick(5)
    expect(c.sent).toEqual([])
    expect(__chatOutboxForTests().map((o) => o.status)).toEqual(['queued', 'queued'])
    c.state.offline = false
    await flushChatOutbox()
    expect(c.sent).toEqual([
      { client_id: 'm1', message: 'first' },
      { client_id: 'm2', message: 'second' }
    ])
    expect(__chatOutboxForTests()).toEqual([])
  })

  it('a waiting message can be edited (its room waits meanwhile) or cancelled', async () => {
    const c = fakeClient()
    bindChatOutbox(c, qc, 'u1')
    await tick(5)
    c.state.offline = true
    send('m1', 'helo')
    send('m2', 'world')
    send('m3', 'oops')
    await tick(5)
    expect(holdOutbox('m1', true)).toBe(true)
    await tick(5)
    c.state.offline = false
    await flushChatOutbox()
    // m1 is being edited: nothing in the room overtakes it.
    expect(c.sent).toEqual([])
    discardOutbox('m3')
    editOutbox('m1', 'hello')
    await tick(20)
    await flushChatOutbox()
    expect(c.sent).toEqual([
      { client_id: 'm1', message: 'hello' },
      { client_id: 'm2', message: 'world' }
    ])
  })

  it('a refusal marks the message failed; Retry sends it again with its client id', async () => {
    const c = fakeClient()
    bindChatOutbox(c, qc, 'u1')
    await tick(5)
    c.state.refuse = true
    send('m1', 'hi')
    await tick(20)
    const [o] = __chatOutboxForTests()
    expect(o.status).toBe('failed')
    expect(o.error).toBe('That conversation is not available to you')
    c.state.refuse = false
    retryOutbox('m1')
    await tick(20)
    expect(c.sent).toEqual([{ client_id: 'm1', message: 'hi' }])
  })
})

describe('long-room window (#2783)', () => {
  const ids = Array.from({ length: 400 }, (_, i) => i + 1)
  const h = () => 50

  it('mounts the rows around the screen plus an overscan', () => {
    // Screen at 10 000 px (row 200), 500 px tall, 1000 px overscan either side.
    const r = windowFor(ids, h, 10_000, 500, 1000)
    expect(r).toEqual({ from: 181, to: 231, toEnd: false })
    const end = windowFor(ids, h, 400 * 50 - 500, 500, 1000)
    expect(end?.toEnd).toBe(true)
  })

  it('pads the unmounted rows with their heights', () => {
    const index = new Map(ids.map((id, i) => [id, i]))
    const s = spanFor(ids, index, { from: 181, to: 231, toEnd: false }, h, true, null)
    expect(s).toEqual({ start: 180, end: 231, padTop: 180 * 50, padBottom: 169 * 50 })
    // A window that runs to the end takes in messages that arrive later.
    const grown = [...ids, 401, 402]
    const gi = new Map(grown.map((id, i) => [id, i]))
    expect(spanFor(grown, gi, { from: 350, to: 400, toEnd: true }, h, true, null).end).toBe(402)
  })

  it('renders everything below the threshold, and around the anchor before a range exists', () => {
    const few = ids.slice(0, WINDOW_FROM)
    const fi = new Map(few.map((id, i) => [id, i]))
    expect(spanFor(few, fi, null, h, false, null)).toEqual({
      start: 0,
      end: WINDOW_FROM,
      padTop: 0,
      padBottom: 0
    })
    const index = new Map(ids.map((id, i) => [id, i]))
    const s = spanFor(ids, index, null, h, true, 100)
    expect(s.start).toBeLessThanOrEqual(99)
    expect(s.end).toBeGreaterThan(99)
  })
})

describe('request ids in messages (#2762)', () => {
  it('finds request and trace ids, never ones inside a link, once per request', () => {
    const rid = '4f3a2b1c-0000-4000-8000-00000000c21e'
    const text = `It failed: ${rid} (trace ${rid.replace(/-/g, '')}) see https://x.test/r/${rid}`
    expect(extractRequestIds(text)).toEqual([rid])
    expect(extractRequestIds(`https://x.test/${rid}`)).toEqual([])
    expect(extractRequestIds('no ids here AB26-12345')).toEqual([])
    expect(shortRequestId(rid)).toBe('4f3a2b1c…c21e')
  })
})

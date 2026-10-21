import { describe, expect, it } from 'vitest'
import { notifyJournalListeners } from '../../../services/journal-listeners.js'
import {
  addSubscription,
  endSession,
  findSession,
  isInitializeBody,
  listSubscriptions,
  MAX_SUBSCRIPTIONS,
  McpLiveStream,
  mcpStreamCount,
  openSession,
  recordKeyOf,
  removeSubscription,
  wantsLiveMode
} from '../../../services/mcp-sessions.js'

// Memory store (no Redis): the same rules the Redis store follows.

const change = (over: Record<string, unknown> = {}) => ({
  seq: 1,
  room: 'collection:articles',
  event: 'collection:update',
  payload: { collection: 'articles', item: '7', action: 'update', changed_fields: ['title'] },
  at: Date.now(),
  ...over
})

function streamFor(session: Awaited<ReturnType<typeof openSession>>, over = {}) {
  const frames: string[] = []
  let ended = false
  const stream = new McpLiveStream({
    redis: null,
    session,
    write: (t) => {
      frames.push(t)
      return true
    },
    end: () => {
      ended = true
    },
    credentialOk: async () => true,
    canRead: async () => true,
    timers: false,
    ...over
  })
  const messages = () =>
    frames
      .filter((f) => f.includes('data: '))
      .map((f) => JSON.parse(f.slice(f.indexOf('data: ') + 6)))
  return { stream, frames, messages, ended: () => ended }
}

describe('live mode switches', () => {
  it('reads ?live=1 and initialize bodies', () => {
    expect(wantsLiveMode('/api/mcp?live=1')).toBe(true)
    expect(wantsLiveMode('/api/mcp?live=on&x=1')).toBe(true)
    expect(wantsLiveMode('/api/mcp')).toBe(false)
    expect(wantsLiveMode('/api/mcp?live=0')).toBe(false)
    expect(isInitializeBody({ jsonrpc: '2.0', id: 1, method: 'initialize' })).toBe(true)
    expect(isInitializeBody([{ method: 'tools/list' }, { method: 'initialize' }])).toBe(true)
    expect(isInitializeBody({ method: 'tools/list' })).toBe(false)
  })

  it('keys record URIs case-insensitively on the id', () => {
    expect(recordKeyOf('nivaro://record/articles/AbC')?.key).toBe('articles\u0000abc')
    expect(recordKeyOf('nivaro://collections')).toBeNull()
  })
})

describe('sessions', () => {
  it('are found only in their own tenant and capped at MAX_SUBSCRIPTIONS', async () => {
    const s = await openSession(null, { user: 'U1', tenant: '' })
    expect(await findSession(null, s.id, '')).toMatchObject({ user: 'U1' })
    expect(await findSession(null, s.id, 'other')).toBeNull()
    expect(await findSession(null, 'short', '')).toBeNull()
    for (let i = 0; i < MAX_SUBSCRIPTIONS; i++)
      expect(await addSubscription(null, s, `nivaro://record/articles/${i}`)).toBe('ok')
    expect(await addSubscription(null, s, 'nivaro://record/articles/extra')).toBe('limit')
    // Re-subscribing to one already followed is not a new subscription.
    expect(await addSubscription(null, s, 'nivaro://record/articles/3')).toBe('ok')
    await removeSubscription(null, s, 'nivaro://record/articles/3')
    expect(await listSubscriptions(null, s)).toHaveLength(MAX_SUBSCRIPTIONS - 1)
    await endSession(null, s)
    expect(await findSession(null, s.id, '')).toBeNull()
  })
})

describe('event stream', () => {
  it('sends ids and field names for a followed record only, coalesced', async () => {
    const s = await openSession(null, { user: 'U1', tenant: '' })
    await addSubscription(null, s, 'nivaro://record/articles/7')
    const { stream, messages } = streamFor(s)
    await stream.start()

    notifyJournalListeners(change())
    notifyJournalListeners(
      change({
        payload: { collection: 'articles', item: '7', action: 'update', changed_fields: ['status'] }
      })
    )
    notifyJournalListeners(
      change({
        payload: { collection: 'articles', item: '8', action: 'update', changed_fields: ['x'] }
      })
    )
    notifyJournalListeners(change({ room: 't:acme:collection:articles' }))
    stream.flush()

    const sent = messages()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toEqual({
      jsonrpc: '2.0',
      method: 'notifications/resources/updated',
      params: {
        uri: 'nivaro://record/articles/7',
        _meta: { 'nivaro.dev/changed_fields': ['title', 'status'], 'nivaro.dev/action': 'update' }
      }
    })
    stream.close('test')
  })

  it('hears a bulk write on the collection and record aspects', async () => {
    const s = await openSession(null, { user: 'U1', tenant: '' })
    await addSubscription(null, s, 'nivaro://record/articles/7')
    const { stream, messages } = streamFor(s)
    await stream.start()
    notifyJournalListeners(
      change({ payload: { collection: 'articles', item: '*', action: null, changed_fields: null } })
    )
    stream.flush()
    notifyJournalListeners(
      change({ payload: { collection: 'articles', item: '7', changed_fields: ['$state'] } })
    )
    stream.flush()
    expect(messages().map((m) => m.params._meta)).toEqual([
      { 'nivaro.dev/changed_fields': [], 'nivaro.dev/action': null },
      { 'nivaro.dev/changed_fields': ['$state'], 'nivaro.dev/action': null }
    ])
    stream.close('test')
  })

  it('picks up a subscription made after the stream opened', async () => {
    const s = await openSession(null, { user: 'U1', tenant: '' })
    const { stream, messages } = streamFor(s)
    await stream.start()
    await addSubscription(null, s, 'nivaro://record/articles/7')
    await stream.refresh()
    notifyJournalListeners(change())
    stream.flush()
    expect(messages()).toHaveLength(1)
    stream.close('test')
  })

  it('drops a record the user lost sight of, with a last notice', async () => {
    const s = await openSession(null, { user: 'U1', tenant: '' })
    await addSubscription(null, s, 'nivaro://record/articles/7')
    await addSubscription(null, s, 'nivaro://record/articles/8')
    const { stream, messages } = streamFor(s, {
      canRead: async (_c: string, id: string) => id !== '7'
    })
    await stream.start()
    await stream.recheck()
    expect(await listSubscriptions(null, s)).toEqual(['nivaro://record/articles/8'])
    expect(messages()[0].params).toEqual({
      uri: 'nivaro://record/articles/7',
      _meta: { 'nivaro.dev/subscription': 'ended', 'nivaro.dev/reason': 'no_access' }
    })
    stream.close('test')
  })

  it('closes when the sign-in ends, the session ends or another stream takes over', async () => {
    const a = await openSession(null, { user: 'U1', tenant: '' })
    const signedOut = streamFor(a, { credentialOk: async () => false })
    await signedOut.stream.start()
    await signedOut.stream.recheck()
    expect(signedOut.ended()).toBe(true)

    const b = await openSession(null, { user: 'U1', tenant: '' })
    const first = streamFor(b)
    await first.stream.start()
    const second = streamFor(b)
    await second.stream.start()
    expect(first.ended()).toBe(true)
    await endSession(null, b)
    expect(second.ended()).toBe(true)
    expect(mcpStreamCount()).toBe(0)
  })
})

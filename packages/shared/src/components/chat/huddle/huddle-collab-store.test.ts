import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type FollowNavigator,
  HuddleFollowStore,
  HuddleNoteStore,
  NOTE_DEBOUNCE_MS,
  NOTE_MAX_BYTES
} from './huddle-collab-store'
import { registerRecordSurface, resetFollowBusForTests } from './huddle-follow-bus'

function fakeTransport() {
  const sent: Array<{ event: string; payload: any }> = []
  return {
    sent,
    on: () => () => {},
    emit: (event: string, payload?: unknown) => {
      sent.push({ event, payload })
    }
  }
}

describe('HuddleNoteStore (#2854)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('debounces typing into one send carrying the known rev', () => {
    const t = fakeTransport()
    const notes = new HuddleNoteStore(
      () => t,
      () => 'S1'
    )
    notes.reset('ch:ops')
    notes.setText('A')
    notes.setText('Ag')
    notes.setText('Agenda')
    expect(t.sent).toEqual([])
    vi.advanceTimersByTime(NOTE_DEBOUNCE_MS)
    expect(t.sent).toEqual([
      { event: 'huddle:note', payload: { room: 'ch:ops', text: 'Agenda', rev: 0 } }
    ])
    expect(notes.getSnapshot().pending).toBe(false)
  })

  it('takes a newer copy from someone else, keeps mine while an edit waits, drops old revs', () => {
    const t = fakeTransport()
    const notes = new HuddleNoteStore(
      () => t,
      () => 'S1'
    )
    notes.reset('ch:ops')
    notes.onNote({
      room: 'ch:ops',
      text: 'From Amy',
      rev: 3,
      by: { id: 'A', name: 'Amy' },
      from: 'S2'
    })
    expect(notes.getSnapshot()).toMatchObject({ text: 'From Amy', rev: 3, unseen: true })
    notes.onNote({ room: 'ch:ops', text: 'stale', rev: 2, by: null, from: 'S2' })
    expect(notes.getSnapshot().text).toBe('From Amy')

    notes.setText('Mine')
    notes.onNote({ room: 'ch:ops', text: 'Amy again', rev: 4, by: null, from: 'S2' })
    expect(notes.getSnapshot()).toMatchObject({ text: 'Mine', rev: 4, pending: true })
    vi.advanceTimersByTime(NOTE_DEBOUNCE_MS)
    expect(t.sent.at(-1)?.payload).toEqual({ room: 'ch:ops', text: 'Mine', rev: 4 })

    // My own echo moves the rev but never rewrites what I typed since.
    notes.setText('Mine, more')
    notes.onNote({ room: 'ch:ops', text: 'Mine', rev: 5, by: null, from: 'S1' })
    expect(notes.getSnapshot()).toMatchObject({ text: 'Mine, more', rev: 5 })
  })

  it('flush sends a waiting edit at once (Leave); over 20 KB never sends', () => {
    const t = fakeTransport()
    const notes = new HuddleNoteStore(
      () => t,
      () => 'S1'
    )
    notes.reset('ch:ops')
    notes.setText('last words')
    notes.flush()
    expect(t.sent).toHaveLength(1)
    notes.setText('x'.repeat(NOTE_MAX_BYTES + 1))
    vi.advanceTimersByTime(NOTE_DEBOUNCE_MS)
    notes.flush()
    expect(t.sent).toHaveLength(1)
    expect(notes.getSnapshot().error).toMatch(/20 KB/)
  })

  it('a rate refusal resends shortly; another room is ignored; reset clears', () => {
    const t = fakeTransport()
    const notes = new HuddleNoteStore(
      () => t,
      () => 'S1'
    )
    notes.reset('ch:ops')
    notes.setText('hello')
    vi.advanceTimersByTime(NOTE_DEBOUNCE_MS)
    notes.onDenied({ room: 'ch:ops', reason: 'rate' })
    vi.advanceTimersByTime(1000)
    expect(t.sent).toHaveLength(2)
    notes.onNote({ room: 'ch:other', text: 'nope', rev: 9, by: null, from: 'S2' })
    expect(notes.getSnapshot().text).toBe('hello')
    notes.reset(null)
    expect(notes.getSnapshot()).toMatchObject({ room: null, text: '', rev: 0 })
  })
})

describe('HuddleNoteStore — server-owned rev and unposted notes', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('a bad-rev refusal takes the server rev and resends my text on top of it', () => {
    const t = fakeTransport()
    const notes = new HuddleNoteStore(
      () => t,
      () => 'S1'
    )
    notes.reset('ch:ops')
    notes.setText('mine')
    vi.advanceTimersByTime(NOTE_DEBOUNCE_MS)
    notes.onDenied({ room: 'ch:ops', reason: 'bad-rev', rev: 7 })
    vi.advanceTimersByTime(NOTE_DEBOUNCE_MS)
    expect(t.sent.at(-1)?.payload).toEqual({ room: 'ch:ops', text: 'mine', rev: 7 })
  })

  it('keeps the note of the huddle I left; an unposted end offers it, else fetches it', () => {
    const t = fakeTransport()
    const notes = new HuddleNoteStore(
      () => t,
      () => 'S1'
    )
    const told: string[] = []
    notes.onUnpostedNote((p) => told.push(p.reason))
    notes.reset('ch:news')
    notes.setText('Draft')
    notes.reset(null)
    notes.onUnposted({ room: 'ch:news', reason: 'only admins post here' })
    expect(told).toEqual(['only admins post here'])
    expect(notes.endedNote('ch:news')).toBe('Draft')
    expect(t.sent.some((s) => s.event === 'huddle:note:fetch')).toBe(false)

    notes.onUnposted({ room: 'ch:other', reason: 'x' })
    expect(t.sent.at(-1)).toEqual({ event: 'huddle:note:fetch', payload: { room: 'ch:other' } })
    notes.onKept({ room: 'ch:other', text: 'From the server' })
    expect(notes.endedNote('ch:other')).toBe('From the server')
  })
})

describe('HuddleFollowStore (#2855)', () => {
  let path = '/chat'
  let navigated: string[] = []
  const nav: FollowNavigator = {
    navigate: (p) => {
      navigated.push(p)
    },
    urlFor: (t) =>
      `/collections/${t.collection}/${t.itemId}${t.query?.step ? `?step=${t.query.step}` : ''}`
  }
  const presenter = { socket: 'S1', user: 'U-ROB', name: 'Rob Lee' }
  const room = 'ord:ORD-42'

  beforeEach(() => {
    vi.useFakeTimers()
    resetFollowBusForTests()
    path = '/chat'
    navigated = []
  })
  afterEach(() => vi.useRealTimers())

  function make(self = 'S2') {
    const t = fakeTransport()
    const f = new HuddleFollowStore(
      () => t,
      () => self,
      () => path
    )
    f.setNavigator(nav)
    f.reset(room)
    return { t, f }
  }

  it('a presentation pulls a follower onto the record through the host navigation', () => {
    const { f } = make()
    f.onFollow({ room, action: 'start', presenter, collection: 'orders', id: '42', step: 'lines' })
    expect(f.getSnapshot()).toMatchObject({ following: true, presenting: false })
    expect(navigated).toEqual(['/collections/orders/42?step=lines'])

    // The page comes up: following settles there.
    path = '/collections/orders/42'
    const steps: string[] = []
    const page = registerRecordSurface(
      { collection: 'orders', itemId: '42', step: 'lines' },
      (s) => {
        steps.push(s)
        page.update({ collection: 'orders', itemId: '42', step: s })
      }
    )
    // The presenter switches tab: my page switches too, without counting as my own click.
    vi.advanceTimersByTime(2000)
    f.onFollow({ room, action: 'move', presenter, collection: 'orders', id: '42', step: 'files' })
    expect(steps).toEqual(['files'])
    expect(f.getSnapshot().following).toBe(true)
    expect(navigated).toHaveLength(1)
    f.dispose()
  })

  it('my own navigation or tab click stops following; moves do not pull me back', () => {
    const { f } = make()
    path = '/collections/orders/42'
    const page = registerRecordSurface({ collection: 'orders', itemId: '42', step: 'a' }, () => {})
    f.onFollow({ room, action: 'start', presenter, collection: 'orders', id: '42', step: 'a' })
    expect(navigated).toEqual([])
    vi.advanceTimersByTime(2000)
    page.update({ collection: 'orders', itemId: '42', step: 'b' })
    expect(f.getSnapshot().following).toBe(false)
    f.onFollow({ room, action: 'move', presenter, collection: 'orders', id: '42', step: 'c' })
    expect(f.getSnapshot().following).toBe(false)

    f.resume()
    expect(f.getSnapshot().following).toBe(true)
    vi.advanceTimersByTime(1000)
    path = '/collections/orders'
    vi.advanceTimersByTime(1000)
    expect(f.getSnapshot().following).toBe(false)
    f.dispose()
  })

  it('never re-navigates on every move when the record page does not come up (no access)', () => {
    const { f } = make()
    f.onFollow({ room, action: 'start', presenter, collection: 'orders', id: '42' })
    f.onFollow({ room, action: 'move', presenter, collection: 'orders', id: '42', step: 'x' })
    f.onFollow({ room, action: 'move', presenter, collection: 'orders', id: '42', step: 'y' })
    expect(navigated).toEqual(['/collections/orders/42'])
    f.dispose()
  })

  it('presenter: start, ask/hand over, and stop', () => {
    const me = make('S1')
    me.f.start({ collection: 'orders', id: '42' })
    // Not on the record yet: I go there first.
    expect(navigated).toEqual(['/collections/orders/42'])
    expect(me.t.sent.at(-1)).toEqual({
      event: 'huddle:follow',
      payload: { room, action: 'start', step: null, section: null }
    })
    me.f.onFollow({ room, action: 'start', presenter, collection: 'orders', id: '42' })
    expect(me.f.getSnapshot()).toMatchObject({ presenting: true, following: false })

    me.f.onFollow({ room, action: 'request', from: { socket: 'S2', user: 'U-AMY', name: 'Amy' } })
    expect(me.f.getSnapshot().request?.name).toBe('Amy')
    me.f.handOver('S2')
    expect(me.t.sent.at(-1)?.payload).toEqual({ room, action: 'handover', to: 'S2' })
    me.f.onFollow({ room, action: 'stop', presenter })
    expect(me.f.getSnapshot()).toMatchObject({ presenting: false, presenter: null })
    me.f.dispose()
  })

  it('someone else presenting: Follow me asks instead; granted starts me', () => {
    const { t, f } = make('S2')
    f.onFollow({ room, action: 'state', presenter, collection: 'orders', id: '42' })
    f.start({ collection: 'orders', id: '42' })
    expect(t.sent.at(-1)?.payload).toEqual({ room, action: 'request' })
    expect(f.getSnapshot().asked).toBe('pending')
    f.onFollow({ room, action: 'declined', presenter })
    expect(f.getSnapshot().asked).toBe('declined')
    vi.advanceTimersByTime(5000)
    expect(f.getSnapshot().asked).toBeNull()

    f.onFollow({ room, action: 'stop', presenter })
    f.onFollow({ room, action: 'granted', presenter })
    expect(t.sent.at(-1)?.payload).toMatchObject({ room, action: 'start' })
    f.dispose()
  })
})

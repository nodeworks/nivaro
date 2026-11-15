import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../services/field-change-relay.js', () => ({
  // The keystroke relay's per-socket answer: only a session socket gets the value here.
  fieldChangeDelivery: vi.fn(async (viewers: Array<{ socket: string; kind?: string }>) => ({
    valueTo: viewers.filter((v) => v.kind === 'session').map((v) => v.socket),
    nameTo: viewers.filter((v) => v.kind !== 'session').map((v) => v.socket)
  }))
}))

import {
  COEDIT_MAX_SESSION_BYTES,
  COEDIT_MAX_STEP_BYTES,
  COEDIT_MAX_STEPS,
  cleanDoc,
  cleanSteps,
  cleanTarget,
  isStepShape,
  memoryCoeditStore
} from '../../../services/coedit.js'
import {
  type CoeditDeps,
  coeditGates,
  parseCoeditRoom,
  registerCoedit
} from '../../../services/coedit-socket.js'
import type { User } from '../../../types.js'

// ── Fakes: one io (rooms → sockets), sockets that record what they were sent ─────────────────

type Handler = (p: unknown) => unknown
interface FakeSocket {
  id: string
  rooms: Set<string>
  got: Array<{ event: string; payload: any }>
  handlers: Map<string, Handler>
  join(room: string): void
  leave(room: string): void
  emit(event: string, payload: unknown): void
  to(room: string): { emit(event: string, payload: unknown): void }
  on(event: string, h: Handler): void
  call(event: string, payload?: unknown): Promise<void>
}

function fakeIo() {
  const sockets: FakeSocket[] = []
  const io = {
    to(room: string) {
      return {
        emit(event: string, payload: unknown) {
          for (const s of sockets) if (s.rooms.has(room)) s.got.push({ event, payload })
        }
      }
    }
  }
  const socket = (id: string): FakeSocket => {
    const s: FakeSocket = {
      id,
      rooms: new Set([id]),
      got: [],
      handlers: new Map(),
      join: (room) => s.rooms.add(room),
      leave: (room) => s.rooms.delete(room),
      emit: (event, payload) => s.got.push({ event, payload }),
      to: (room) => ({
        emit(event, payload) {
          for (const o of sockets) if (o !== s && o.rooms.has(room)) o.got.push({ event, payload })
        }
      }),
      on: (event, h) => s.handlers.set(event, h),
      async call(event, payload) {
        await s.handlers.get(event)?.(payload)
      }
    }
    sockets.push(s)
    return s
  }
  return { io, socket }
}

const user = (id: string, name: string): User =>
  ({ id, first_name: name, last_name: '', email: `${name}@x.test`, role: 'r' }) as unknown as User

const target = { collection: 'orders', item: '7', field: 'notes' }
const doc = { type: 'doc', content: [{ type: 'paragraph' }] }
const insert = (pos: number, text: string) => ({
  stepType: 'replace',
  from: pos,
  to: pos,
  slice: { content: [{ type: 'text', text }] }
})

describe('coedit payload checks', () => {
  it('accepts plain targets and refuses system tables and odd names', () => {
    expect(cleanTarget(target)).toEqual(target)
    expect(cleanTarget({ ...target, item: 7 })).toEqual(target)
    expect(cleanTarget({ ...target, collection: 'nivaro_users' })).toBeNull()
    expect(cleanTarget({ ...target, field: 'a:b' })).toBeNull()
    expect(cleanTarget({ ...target, item: 'x:y' })).toBeNull()
  })
  it('steps must be ProseMirror step shapes; docs must name a type', () => {
    expect(cleanSteps([insert(1, 'a')])).toHaveLength(1)
    expect(cleanSteps([])).toBeNull()
    expect(cleanSteps(['nope'])).toBeNull()
    expect(cleanSteps([{ from: 1 }])).toBeNull()
    expect(isStepShape({ stepType: 'addMark', from: 1, to: 3, mark: { type: 'bold' } })).toBe(true)
    expect(isStepShape({ stepType: 'docAttr', attr: 'x', value: 1 })).toBe(true)
    // Unknown types, keys a step never has, odd positions, a mark without a type.
    expect(isStepShape({ stepType: 'evil', from: 1 })).toBe(false)
    expect(isStepShape({ ...insert(1, 'a'), extra: 'x'.repeat(10) })).toBe(false)
    expect(isStepShape({ ...insert(1, 'a'), from: -1 })).toBe(false)
    expect(isStepShape({ ...insert(1, 'a'), from: 1.5 })).toBe(false)
    expect(isStepShape({ ...insert(1, 'a'), slice: 'x' })).toBe(false)
    expect(isStepShape({ stepType: 'addMark', from: 1, to: 2, mark: {} })).toBe(false)
    // One step past the step cap.
    expect(cleanSteps([insert(1, 'x'.repeat(COEDIT_MAX_STEP_BYTES))])).toBeNull()
    expect(cleanDoc(doc)).toBe(JSON.stringify(doc))
    expect(cleanDoc({ content: [] })).toBeNull()
  })
  it('parses its room names', () => {
    expect(parseCoeditRoom('coedit:w:notes:orders:7')).toEqual({ write: true, ...target })
    expect(parseCoeditRoom('coedit:r:notes:orders:7')).toEqual({ write: false, ...target })
    expect(parseCoeditRoom('record:orders:7')).toBeNull()
  })
})

describe('memory store — the authority', () => {
  const T = Date.now()
  it('accepts a batch only at the newest version and orders every batch', async () => {
    const store = memoryCoeditStore()
    const { state } = await store.open('k', JSON.stringify(doc), 'a', T + 1)
    expect(state.version).toBe(0)
    const a = await store.append(
      'k',
      state.sid,
      0,
      [JSON.stringify(insert(1, 'a'))],
      'A',
      'a',
      T + 2
    )
    expect(a).toEqual({ ok: true, version: 1 })
    // B typed against version 0 too: behind, told the newest version.
    const b = await store.append(
      'k',
      state.sid,
      0,
      [JSON.stringify(insert(1, 'b'))],
      'B',
      'b',
      T + 3
    )
    expect(b).toEqual({ ok: false, reason: 'behind', version: 1 })
    const since = await store.since('k', 0)
    expect(since?.steps.map((s) => s.c)).toEqual(['A'])
    // Another session's id is not this one.
    expect(await store.append('k', 'other', 1, ['{"stepType":"x"}'], 'B', 'b', T + 4)).toEqual({
      ok: false,
      reason: 'gone'
    })
    // A version past the end is not inside the session.
    expect(await store.since('k', 9)).toBeNull()
  })
  it('a second open joins the running session; the last one out ends it', async () => {
    const store = memoryCoeditStore()
    const first = await store.open('k', JSON.stringify(doc), 'a', T + 1)
    const second = await store.open('k', '{"type":"doc","content":[]}', 'b', T + 2)
    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.state.sid).toBe(first.state.sid)
    expect(second.state.doc).toEqual(doc)
    expect(await store.leave('k', 'a', T + 3)).toBe(false)
    expect(await store.leave('k', 'b', T + 4)).toBe(true)
    expect(await store.read('k')).toBeNull()
    expect(store.size()).toBe(0)
  })
  it('a session holds at most COEDIT_MAX_SESSION_BYTES in all', async () => {
    const store = memoryCoeditStore()
    const { state } = await store.open('k', JSON.stringify(doc), 'a', T + 1)
    const big = JSON.stringify(insert(1, 'x'.repeat(60_000)))
    let v = 0
    let r: Awaited<ReturnType<typeof store.append>> = { ok: true, version: 0 }
    for (let i = 0; i < 100 && r.ok; i++) {
      r = await store.append('k', state.sid, v, [big], 'A', 'a', T + 2)
      if (r.ok) v = r.version
    }
    expect(r).toEqual({ ok: false, reason: 'full' })
    expect(v * big.length).toBeLessThanOrEqual(COEDIT_MAX_SESSION_BYTES)
    expect(v).toBeGreaterThan(20)
  })
  it('a session whose writers all went quiet is gone (nobody adopts a dead session)', async () => {
    const store = memoryCoeditStore()
    const old = Date.now() - 60_000
    const first = await store.open('k', JSON.stringify(doc), 'a', old)
    expect(await store.read('k')).toBeNull()
    const again = await store.open('k', '{"type":"doc","content":[]}', 'b', Date.now())
    expect(again.created).toBe(true)
    expect(again.state.sid).not.toBe(first.state.sid)
  })
  it('a full session refuses more steps', async () => {
    const store = memoryCoeditStore()
    const { state } = await store.open('k', JSON.stringify(doc), 'a', T + 1)
    const many = Array.from({ length: 200 }, () => JSON.stringify(insert(1, 'x')))
    let v = 0
    for (let i = 0; i < COEDIT_MAX_STEPS / 200; i++) {
      const r = await store.append('k', state.sid, v, many, 'A', 'a', T + 2)
      expect(r.ok).toBe(true)
      v += 200
    }
    expect(await store.append('k', state.sid, v, many, 'A', 'a', T + 3)).toEqual({
      ok: false,
      reason: 'full'
    })
  })
})

describe('coedit socket — who may join and type', () => {
  let deps: CoeditDeps
  let clock = Date.now()
  const readers = new Set(['ana', 'ben', 'cy'])
  const writers = new Set(['ana', 'ben'])
  beforeEach(() => {
    deps = {
      store: memoryCoeditStore(),
      fieldMayTravel: async (_c, f) => f === 'notes',
      canSeeRecord: async (u) => String(u.id) !== 'out',
      mayRead: async (u) => readers.has(String(u.id)),
      mayWrite: async (u) => writers.has(String(u.id)),
      writeRefused: async () => false,
      now: () => clock
    }
  })
  const scope = { scopedRoom: async (r: string) => r, tenantNow: () => '' }
  const connect = (io: ReturnType<typeof fakeIo>, id: string, u: User, kind = 'session') => {
    const s = io.socket(id)
    ;(s as unknown as { data: unknown }).data = { nvrBind: { kind } }
    registerCoedit(io.io as never, s as never, () => u, scope, deps)
    return s
  }

  it('people who may not read the field (or the record) join nothing and hear nothing', async () => {
    const io = fakeIo()
    const ana = connect(io, 's-ana', user('ana', 'Ana'))
    const dee = connect(io, 's-dee', user('dee', 'Dee')) // reads the record, not the field
    const out = connect(io, 's-out', user('out', 'Out')) // cannot open the record
    for (const s of [ana, dee, out]) await s.call('coedit:watch', target)
    expect(dee.rooms.size).toBe(1)
    expect(out.rooms.size).toBe(1)
    expect(dee.got).toEqual([])
    expect(out.got).toEqual([])
    await ana.call('coedit:open', { ...target, clientID: 'ana-ed-1', doc })
    expect(dee.got).toEqual([])
    expect(out.got).toEqual([])
  })

  it('asks the keystroke relay rule with the socket sign-in kind (never looser)', async () => {
    const io = fakeIo()
    const kinds: Array<string | undefined> = []
    const inner = deps.mayRead
    deps.mayRead = async (u, c, f, kind) => {
      kinds.push(kind)
      return inner(u, c, f, kind)
    }
    const ana = connect(io, 's-ana', user('ana', 'Ana'), 'masq')
    await ana.call('coedit:watch', target)
    expect(kinds).toEqual(['masq'])
    // The relay refusing the value (e.g. a to-many alias, encrypted field): nothing joined.
    deps.mayRead = async () => false
    const ben = connect(io, 's-ben', user('ben', 'Ben'))
    await ben.call('coedit:watch', target)
    expect(ben.rooms.size).toBe(1)
    expect(ben.got).toEqual([])
  })

  it('API keys and fields whose text never travels join nothing', async () => {
    const io = fakeIo()
    const key = connect(io, 's-key', user('ana', 'Ana'), 'apikey')
    const ana = connect(io, 's-ana', user('ana', 'Ana'))
    await key.call('coedit:watch', target)
    await ana.call('coedit:watch', { ...target, field: 'password' })
    expect(key.rooms.size).toBe(1)
    expect(ana.rooms.size).toBe(1)
    expect(key.got).toEqual([])
    expect(ana.got).toEqual([])
  })

  it('a reader watches the text but may not open or type, and gets no cursors', async () => {
    const io = fakeIo()
    const ana = connect(io, 's-ana', user('ana', 'Ana'))
    const cy = connect(io, 's-cy', user('cy', 'Cy'))
    await ana.call('coedit:watch', target)
    await cy.call('coedit:watch', target)
    expect([...cy.rooms]).toEqual(['s-cy', 'coedit:r:notes:orders:7'])
    expect(cy.got.at(-1)).toMatchObject({ event: 'coedit:state', payload: { write: false } })
    await ana.call('coedit:open', { ...target, clientID: 'ana-ed-1', doc })
    const active = cy.got.find((g) => g.event === 'coedit:active')
    expect(active?.payload.session.doc).toEqual(doc)
    const sid = active?.payload.session.sid
    await ana.call('coedit:steps', {
      ...target,
      clientID: 'ana-ed-1',
      sid,
      version: 0,
      steps: [insert(1, 'Hi')]
    })
    expect(cy.got.at(-1)).toMatchObject({ event: 'coedit:steps', payload: { version: 0 } })
    await ana.call('coedit:cursor', {
      ...target,
      clientID: 'ana-ed-1',
      version: 1,
      anchor: 3,
      head: 3
    })
    expect(cy.got.some((g) => g.event === 'coedit:cursor')).toBe(false)
    // Cy cannot start a session or type.
    const before = cy.got.length
    await cy.call('coedit:open', { ...target, clientID: 'cy-ed-1', doc })
    await cy.call('coedit:steps', {
      ...target,
      clientID: 'cy-ed-1',
      sid,
      version: 1,
      steps: [insert(1, 'x')]
    })
    expect(cy.got.slice(before).map((g) => g.event)).toEqual(['coedit:state'])
    expect((await deps.store.read('nvr:coedit:{-|orders|7|notes}'))?.version).toBe(1)
  })

  it('two writers: steps go to everyone, cursors to the other writer, behind gets the gap', async () => {
    const io = fakeIo()
    const ana = connect(io, 's-ana', user('ana', 'Ana'))
    const ben = connect(io, 's-ben', user('ben', 'Ben'))
    await ana.call('coedit:watch', target)
    await ben.call('coedit:watch', target)
    await ana.call('coedit:open', { ...target, clientID: 'ana-ed-1', doc })
    await ben.call('coedit:open', { ...target, clientID: 'ben-ed-1', doc })
    const sid = ben.got.find((g) => g.event === 'coedit:active')?.payload.session.sid
    expect(ben.got.at(-1)).toMatchObject({ event: 'coedit:state', payload: { write: true } })
    await ana.call('coedit:steps', {
      ...target,
      clientID: 'ana-ed-1',
      sid,
      version: 0,
      steps: [insert(1, 'A')]
    })
    // Ben typed against version 0 as well: he is sent Ana's step, nothing is stored for him.
    ben.got.length = 0
    await ben.call('coedit:steps', {
      ...target,
      clientID: 'ben-ed-1',
      sid,
      version: 0,
      steps: [insert(1, 'B')]
    })
    expect(ben.got).toEqual([
      {
        event: 'coedit:steps',
        payload: expect.objectContaining({ version: 0, clientIDs: ['ana-ed-1'] })
      }
    ])
    await ben.call('coedit:cursor', {
      ...target,
      clientID: 'ben-ed-1',
      version: 1,
      anchor: 2,
      head: 2
    })
    expect(ana.got.at(-1)).toMatchObject({
      event: 'coedit:cursor',
      payload: { clientID: 'ben-ed-1', anchor: 2, user: { id: 'ben', name: 'Ben' } }
    })
    // An editor that never opened may not type.
    await ben.call('coedit:steps', {
      ...target,
      clientID: 'ben-ed-2',
      sid,
      version: 1,
      steps: [insert(1, 'C')]
    })
    expect((await deps.store.read('nvr:coedit:{-|orders|7|notes}'))?.version).toBe(1)
  })

  it('someone else holding the edit lock watches read-only; the last writer out ends it', async () => {
    const io = fakeIo()
    const ana = connect(io, 's-ana', user('ana', 'Ana'))
    const ben = connect(io, 's-ben', user('ben', 'Ben'))
    await ana.call('coedit:watch', target)
    await ben.call('coedit:watch', target)
    await ana.call('coedit:open', { ...target, clientID: 'ana-ed-1', doc })
    deps.writeRefused = async (u) => String(u.id) === 'ben'
    await ben.call('coedit:open', { ...target, clientID: 'ben-ed-1', doc })
    expect(ben.got.at(-1)).toMatchObject({ event: 'coedit:state', payload: { write: false } })
    await ana.call('coedit:close', { ...target, clientID: 'ana-ed-1' })
    expect(ben.got.at(-1)).toMatchObject({ event: 'coedit:ended', payload: { reason: 'left' } })
    expect(await deps.store.read('nvr:coedit:{-|orders|7|notes}')).toBeNull()
  })

  it('a lock taken while typing stops the writer within seconds; they keep watching', async () => {
    const io = fakeIo()
    const ana = connect(io, 's-ana', user('ana', 'Ana'))
    const ben = connect(io, 's-ben', user('ben', 'Ben'))
    await ana.call('coedit:watch', target)
    await ben.call('coedit:watch', target)
    await ana.call('coedit:open', { ...target, clientID: 'ana-ed-1', doc })
    await ben.call('coedit:open', { ...target, clientID: 'ben-ed-1', doc })
    const sid = ana.got.find((g) => g.event === 'coedit:active')?.payload.session.sid
    const step = (v: number, t: string) => ({
      ...target,
      clientID: 'ben-ed-1',
      sid,
      version: v,
      steps: [insert(1, t)]
    })
    await ben.call('coedit:steps', step(0, 'a'))
    // Ana's form takes the record lock (or the record moves into a locked step).
    deps.writeRefused = async (u) => String(u.id) === 'ben'
    // Inside the recheck window the earlier answer still holds…
    await ben.call('coedit:steps', step(1, 'b'))
    expect((await deps.store.read('nvr:coedit:{-|orders|7|notes}'))?.version).toBe(2)
    // …past it, Ben is out of the session and the cursor room, told so, still reading.
    clock += 6_000
    ben.got.length = 0
    await ben.call('coedit:steps', step(2, 'c'))
    expect((await deps.store.read('nvr:coedit:{-|orders|7|notes}'))?.version).toBe(2)
    expect(ben.rooms.has('coedit:w:notes:orders:7')).toBe(false)
    expect(ben.rooms.has('coedit:r:notes:orders:7')).toBe(true)
    expect(ben.got.at(-1)).toMatchObject({ event: 'coedit:state', payload: { write: false } })
    // Ana's later steps still reach him, read-only.
    await ana.call('coedit:steps', {
      ...target,
      clientID: 'ana-ed-1',
      sid,
      version: 2,
      steps: [insert(1, 'A')]
    })
    expect(ben.got.at(-1)).toMatchObject({ event: 'coedit:steps', payload: { version: 2 } })
  })

  it('losing the field (room recheck) stops typing', async () => {
    const io = fakeIo()
    const ana = connect(io, 's-ana', user('ana', 'Ana'))
    await ana.call('coedit:watch', target)
    await ana.call('coedit:open', { ...target, clientID: 'ana-ed-1', doc })
    const sid = ana.got.find((g) => g.event === 'coedit:active')?.payload.session.sid
    ana.leave('coedit:w:notes:orders:7')
    await ana.call('coedit:steps', {
      ...target,
      clientID: 'ana-ed-1',
      sid,
      version: 0,
      steps: [insert(1, 'A')]
    })
    // Nothing stored; as the only writer, leaving ends the session; told it may no longer type.
    expect((await deps.store.read('nvr:coedit:{-|orders|7|notes}'))?.version ?? 0).toBe(0)
    expect(ana.got.at(-1)).toMatchObject({ event: 'coedit:state', payload: { write: false } })
  })
})

describe('coedit read gate = the keystroke relay answer (fix-keystroke)', () => {
  it('reads come from fieldChangeDelivery with the socket kind', async () => {
    const gates = coeditGates()
    const ana = user('ana', 'Ana')
    expect(await gates.mayRead(ana, 'orders', 'notes', 'session')).toBe(true)
    expect(await gates.mayRead(ana, 'orders', 'notes', 'apikey')).toBe(false)
    expect(await gates.mayRead(ana, 'orders', 'notes', undefined)).toBe(false)
  })
})

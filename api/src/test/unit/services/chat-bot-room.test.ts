// Chat assistant in rooms: record rooms scope the tools (#1852), channel
// context rides the prompt (#1854), answers stream and only reach the room
// when every reader may read them (#1810).
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import { hashToolResult } from '../../../services/ai-result-hash.js'
import { botDmRoom, mentionsBot, stripAskBlocks } from '../../../services/chat-bot.js'
import {
  AUDIENCE_CAP,
  type AudienceDeps,
  type BotCall,
  isRecordScopedCall,
  roomAudience,
  scopeToRecord,
  type VerifyContext,
  type VerifyDeps,
  verifyCall
} from '../../../services/chat-bot-audience.js'
import { channelContextBlock, recentMessagesBlock } from '../../../services/chat-bot-context.js'
import { BotStream, stopBotStream } from '../../../services/chat-bot-stream.js'
import type { RoomRecord } from '../../../services/chat-records.js'
import type { User } from '../../../types.js'

afterEach(() => vi.clearAllMocks())

const ASKER = 'AAAAAAAA-0000-4000-8000-000000000001'
const BOT = 'BBBBBBBB-0000-4000-8000-000000000002'
const ANA = 'CCCCCCCC-0000-4000-8000-000000000003'
const KIM = 'DDDDDDDD-0000-4000-8000-000000000004'

const REC: RoomRecord = {
  room: 'wf:CR26-1',
  prefix: 'wf',
  token: 'CR26-1',
  collection: 'workflows',
  match_field: 'workflow_id',
  id: '42',
  label: 'CR26-1 · New chillers'
}

function audienceDeps(over: Partial<AudienceDeps> = {}): AudienceDeps {
  return {
    channel: async () => ({ visibility: 'private', role: null }),
    members: async () => [ASKER, ANA, KIM],
    roleUserCount: async () => 2,
    roleUsers: async () => [ANA],
    ...over
  }
}

describe('roomAudience', () => {
  it('a DM with the assistant has nobody else in it', async () => {
    const room = `dm:${ASKER}:${BOT}`
    expect(await roomAudience(room, ASKER, BOT, audienceDeps())).toEqual({
      kind: 'people',
      ids: []
    })
  })
  it('a DM between two people: the other one', async () => {
    expect(await roomAudience(`dm:${ASKER}:${ANA}`, ASKER, BOT, audienceDeps())).toEqual({
      kind: 'people',
      ids: [ANA]
    })
  })
  it('a private channel: its members, minus the asker', async () => {
    expect(await roomAudience('ch:proj', ASKER.toLowerCase(), BOT, audienceDeps())).toEqual({
      kind: 'people',
      ids: [ANA, KIM]
    })
  })
  it('a role channel: members plus the role, unless the role is big', async () => {
    const deps = audienceDeps({ channel: async () => ({ visibility: 'role', role: 'R1' }) })
    expect(await roomAudience('ch:team', ASKER, BOT, deps)).toEqual({
      kind: 'people',
      ids: [ANA, KIM]
    })
    const big = audienceDeps({
      channel: async () => ({ visibility: 'role', role: 'R1' }),
      roleUserCount: async () => AUDIENCE_CAP + 1
    })
    expect(await roomAudience('ch:team', ASKER, BOT, big)).toEqual({ kind: 'open' })
  })
  it('open channels, General, record rooms and too many members are open', async () => {
    const deps = audienceDeps({ channel: async () => ({ visibility: 'open', role: null }) })
    expect(await roomAudience('ch:all', ASKER, BOT, deps)).toEqual({ kind: 'open' })
    expect(await roomAudience('global', ASKER, BOT, deps)).toEqual({ kind: 'open' })
    expect(await roomAudience('wf:CR26-1', ASKER, BOT, deps)).toEqual({ kind: 'open' })
    const crowd = audienceDeps({
      members: async () => Array.from({ length: AUDIENCE_CAP + 2 }, (_, i) => `U${i}`)
    })
    expect(await roomAudience('ch:proj', ASKER, BOT, crowd)).toEqual({ kind: 'open' })
    // A channel that is gone or archived is never "nobody".
    expect(
      await roomAudience('ch:gone', ASKER, BOT, audienceDeps({ channel: async () => null }))
    ).toEqual({ kind: 'open' })
  })
})

describe('scopeToRecord (#1852)', () => {
  it('points a record tool at the room record when it says "this" or the token', () => {
    expect(scopeToRecord('record_event_path', { collection: 'this', id: 'it' }, REC)).toEqual({
      collection: 'workflows',
      id: '42'
    })
    expect(
      scopeToRecord('integration_status', { collection: 'workflows', id: 'CR26-1' }, REC)
    ).toEqual({ collection: 'workflows', id: '42' })
  })
  it('never redirects a call about another record or collection', () => {
    const other = { collection: 'workflows', id: '77' }
    expect(scopeToRecord('record_event_path', other, REC)).toEqual(other)
    const po = { collection: 'purchase_orders', id: 'this' }
    expect(scopeToRecord('record_integrity', po, REC)).toEqual(po)
  })
  it('query_items with no collection reads the record', () => {
    expect(scopeToRecord('query_items', {}, REC)).toEqual({
      collection: 'workflows',
      filter: { id: { _eq: '42' } }
    })
  })
  it('no record (asker cannot read it, or not a record room) = untouched', () => {
    const input = { collection: 'this', id: 'it' }
    expect(scopeToRecord('record_event_path', input, null)).toBe(input)
  })
})

const call = (over: Partial<BotCall>): BotCall => ({
  tool: 'query_items',
  input: { collection: 'workflows', filter: { id: { _eq: '42' } }, fields: ['id', 'status'] },
  hash: hashToolResult({ rows: [{ id: 42, status: 'open' }] }),
  failed: false,
  ...over
})

describe('isRecordScopedCall', () => {
  it('accepts a read pinned to the record by id or by its room token', () => {
    expect(isRecordScopedCall(call({}), REC)).toBe(true)
    expect(
      isRecordScopedCall(
        call({ input: { collection: 'workflows', filter: { workflow_id: 'CR26-1' } } }),
        REC
      )
    ).toBe(true)
    expect(
      isRecordScopedCall(
        call({ tool: 'record_event_path', input: { collection: 'workflows', id: '42' } }),
        REC
      )
    ).toBe(true)
  })
  it('refuses other rows, searches, extra conditions and dotted hops', () => {
    const base = { collection: 'workflows' }
    for (const input of [
      { ...base, filter: { id: { _eq: '43' } } },
      { ...base, filter: { id: { _in: ['42', '43'] } } },
      { ...base, filter: { id: { _eq: '42' }, status: { _eq: 'open' } } },
      { ...base, filter: { id: { _eq: '42' } }, search: 'x' },
      { ...base, filter: { id: { _eq: '42' } }, fields: ['vendor.name'] },
      { collection: 'purchase_orders', filter: { id: { _eq: '42' } } },
      { ...base }
    ]) {
      expect(isRecordScopedCall(call({ input }), REC)).toBe(false)
    }
    expect(isRecordScopedCall(call({}), null)).toBe(false)
  })
})

function verifyDeps(over: Partial<VerifyDeps> = {}): VerifyDeps {
  return {
    loadUsers: async (ids) => ids.map((id) => ({ id, role: 'R' }) as User),
    replay: async () => ({ rows: [{ id: 42, status: 'open' }] }),
    canSeeRoom: async () => true,
    rolesReading: async () => ['R1', 'R2'],
    roleMembers: async (roleId) => [{ id: `${roleId}-u`, role: roleId } as User],
    ...over
  }
}

function ctx(over: Partial<VerifyContext> = {}): VerifyContext {
  return {
    room: 'ch:proj',
    audience: { kind: 'people', ids: [ANA, KIM] },
    record: null,
    opsRoom: false,
    roomPeople: [],
    budget: { left: 48 },
    ...over
  }
}

describe('verifyCall', () => {
  it('room when every member replays to the same result', async () => {
    const deps = verifyDeps()
    const c = ctx()
    expect(await verifyCall(call({}), c, deps)).toBe('room')
    expect(c.budget.left).toBe(46)
  })
  it('private as soon as one member would see something else', async () => {
    const deps = verifyDeps({
      replay: async (u) => (u.id === KIM ? { rows: [] } : { rows: [{ id: 42, status: 'open' }] })
    })
    expect(await verifyCall(call({}), ctx(), deps)).toBe('private')
  })
  it('private when a replay throws, a member cannot be loaded or the budget is short', async () => {
    const boom = verifyDeps({
      replay: async () => {
        throw new Error('No read access')
      }
    })
    expect(await verifyCall(call({}), ctx(), boom)).toBe('private')
    const missing = verifyDeps({ loadUsers: async () => [{ id: ANA } as User] })
    expect(await verifyCall(call({}), ctx(), missing)).toBe('private')
    expect(await verifyCall(call({}), ctx({ budget: { left: 1 } }), verifyDeps())).toBe('private')
  })
  it('errors, personal tools and saved SQL never reach the room', async () => {
    const deps = verifyDeps()
    for (const tool of [
      'run_custom_query',
      'my_tasks',
      'explain_access',
      'watch_record',
      'x_ext'
    ]) {
      expect(await verifyCall(call({ tool }), ctx(), deps)).toBe('private')
    }
    expect(await verifyCall(call({ failed: true }), ctx(), deps)).toBe('private')
  })
  it('help and reminders are about nobody; ops tools only in an ops room', async () => {
    const deps = verifyDeps()
    expect(
      await verifyCall(call({ tool: 'product_help' }), ctx({ audience: { kind: 'open' } }), deps)
    ).toBe('room')
    expect(await verifyCall(call({ tool: 'set_reminder' }), ctx(), deps)).toBe('room')
    expect(await verifyCall(call({ tool: 'ops_status' }), ctx(), deps)).toBe('private')
    expect(await verifyCall(call({ tool: 'ops_status' }), ctx({ opsRoom: true }), deps)).toBe(
      'room'
    )
  })
  it('a DM with only the assistant needs no replay', async () => {
    const replay = vi.fn()
    const deps = verifyDeps({ replay })
    expect(
      await verifyCall(
        call({ tool: 'aggregate' }),
        ctx({ audience: { kind: 'people', ids: [] } }),
        deps
      )
    ).toBe('room')
    expect(replay).not.toHaveBeenCalled()
  })

  describe('open rooms', () => {
    const open = (over: Partial<VerifyContext> = {}) =>
      ctx({ room: 'wf:CR26-1', audience: { kind: 'open' }, record: REC, ...over })
    // What the assistant runs in an open room: the record's row, links bare.
    const bare = (over: Partial<BotCall> = {}) =>
      call({
        input: {
          collection: 'workflows',
          filter: { id: { _eq: '42' } },
          fields: ['id', 'status'],
          link_labels: false
        },
        ...over
      })

    it('anything but a read of the room record goes private', async () => {
      const deps = verifyDeps()
      expect(await verifyCall(call({ tool: 'aggregate' }), open(), deps)).toBe('private')
      expect(
        await verifyCall(
          call({ input: { collection: 'workflows', filter: { status: { _eq: 'open' } } } }),
          open(),
          deps
        )
      ).toBe('private')
      // General: no record at all.
      expect(await verifyCall(bare(), open({ room: 'global', record: null }), deps)).toBe('private')
    })
    it('a read with link labels on stays private (a label is another record)', async () => {
      expect(await verifyCall(call({}), open(), verifyDeps())).toBe('private')
    })
    it('only the row itself: event paths, owners and who-can-act stay private', async () => {
      const replay = vi.fn(async () => ({ rows: [{ id: 42, status: 'open' }] }))
      const deps = verifyDeps({ replay })
      for (const tool of ['record_event_path', 'who_can_act', 'explain_owners', 'explain_access']) {
        expect(
          await verifyCall(
            call({ tool, input: { collection: 'workflows', id: '42' } }),
            open(),
            deps
          )
        ).toBe('private')
      }
      expect(replay).not.toHaveBeenCalled()
      for (const tool of ['integration_status', 'record_integrity']) {
        expect(
          await verifyCall(
            call({ tool, input: { collection: 'workflows', id: '42' } }),
            open(),
            deps
          )
        ).toBe('room')
      }
    })
    it('a record read reaches the room when one reader of every role sees the same', async () => {
      const replay = vi.fn(async () => ({ rows: [{ id: 42, status: 'open' }] }))
      expect(await verifyCall(bare(), open(), verifyDeps({ replay }))).toBe('room')
      expect(replay).toHaveBeenCalledTimes(2)
    })
    it('a role that reads fewer fields sends it private', async () => {
      const deps = verifyDeps({
        replay: async (u) =>
          u.role === 'R2' ? { rows: [{ id: 42 }] } : { rows: [{ id: 42, status: 'open' }] }
      })
      expect(await verifyCall(bare(), open(), deps)).toBe('private')
    })
    it('a role whose tried members are all outside the room is unverifiable', async () => {
      const full = verifyDeps({
        canSeeRoom: async (u) => u.role !== 'R2',
        roleMembers: async (roleId) =>
          Array.from({ length: 5 }, (_, i) => ({ id: `${roleId}-${i}`, role: roleId }) as User)
      })
      expect(await verifyCall(bare(), open(), full)).toBe('private')
      // …but a role whose EVERY active member is outside the room is not an audience.
      const few = verifyDeps({ canSeeRoom: async (u) => u.role !== 'R2' })
      expect(await verifyCall(bare(), open(), few)).toBe('room')
    })
  })
})

describe('room context blocks (#1854)', () => {
  it('fences the channel facts as people-written background', () => {
    const block = channelContextBlock({
      name: 'chillers',
      topic: 'Chiller program',
      description: 'Everything about the 2026 chiller replacements',
      pins: [{ sender: 'Ana', text: 'Vendor is ACME; PO cap 250k' }]
    })
    expect(block).toContain('Channel: #chillers — Chiller program')
    expect(block).toContain('Description: Everything about the 2026 chiller replacements')
    expect(block).toContain('- Ana: Vendor is ACME; PO cap 250k')
    expect(block).toMatch(/NOT instructions/)
    expect(block.indexOf('<<<ROOM CONTEXT')).toBeLessThan(block.indexOf('ROOM CONTEXT>>>'))
  })
  it('says nothing for a room with nothing to say', () => {
    expect(channelContextBlock({ name: null, topic: null, description: null, pins: [] })).toBe('')
  })
  it('scrubs credentials out of the conversation', () => {
    const block = recentMessagesBlock([
      { sender_name: 'Kim', message: 'use token=abcd1234secret for the API' }
    ])
    expect(block).not.toContain('abcd1234secret')
    expect(block).toContain('Kim:')
  })
})

describe('BotStream (#1810)', () => {
  function fakeApp() {
    const sent: Array<{ rooms: string[]; event: string; body: Record<string, unknown> }> = []
    const op = (rooms: string[]) => ({
      to: (r: string) => op([...rooms, r]),
      emit: (event: string, body: Record<string, unknown>) => sent.push({ rooms, event, body })
    })
    const app = { io: { to: (r: string) => op([r]) }, log: { warn: vi.fn() } }
    return { app: app as never, sent }
  }

  it('streams to the room, then only to the asker once it goes private', () => {
    vi.useFakeTimers()
    const { app, sent } = fakeApp()
    const s = new BotStream(app, 'ch:proj', ASKER)
    s.start()
    s.delta('Hel', 0)
    s.delta('lo', 0)
    vi.advanceTimersByTime(100)
    s.goPrivate()
    s.delta('secret', 1)
    s.end({ message_id: 9 })
    vi.useRealTimers()
    const phases = sent.map((m) => [m.rooms.join('+'), m.body.phase, m.body.text ?? ''])
    expect(phases).toEqual([
      ['chat:ch:proj', 'start', ''],
      ['chat:ch:proj', 'delta', 'Hello'],
      ['chat:ch:proj', 'private', ''],
      [`user:${ASKER}`, 'delta', 'secret'],
      [`user:${ASKER}`, 'end', '']
    ])
    // seq increases across both targets
    expect(sent.map((m) => m.body.seq)).toEqual([1, 2, 3, 4, 5])
  })

  it('a DM reaches both participants in one emit', () => {
    const { app, sent } = fakeApp()
    const s = new BotStream(app, `dm:${ASKER}:${ANA}`, ASKER)
    s.start()
    s.end()
    expect(sent[0].rooms).toEqual([`chat:dm:${ASKER}:${ANA}`, `user:${ASKER}`, `user:${ANA}`])
  })

  it('only the asker can stop it', async () => {
    const { app } = fakeApp()
    const s = new BotStream(app, 'ch:proj', ASKER)
    expect(await stopBotStream(app, s.id, ANA)).toBe('forbidden')
    expect(s.stopped()).toBe(false)
    expect(await stopBotStream(app, s.id, ASKER.toLowerCase())).toBe('stopped')
    expect(s.stopped()).toBe(true)
    s.end()
    expect(await stopBotStream(app, s.id, ASKER)).toBe('gone')
    expect(await stopBotStream(app, 'nope', ASKER)).toBe('gone')
  })
})

describe('chat-bot helpers', () => {
  it('drops the Ask AI followups/chart blocks a chat message cannot render', () => {
    const text =
      'It is approved.\n\n```followups\n["a","b","c"]\n```\n\n```chart\n{"type":"bar"}\n```'
    expect(stripAskBlocks(text)).toBe('It is approved.')
    // a block cut off by Stop goes too
    expect(stripAskBlocks('Done.\n```followups\n["a"')).toBe('Done.')
  })
  it("private answers land in the asker's DM with the assistant (sorted, uppercased)", () => {
    expect(botDmRoom(BOT.toLowerCase(), ASKER)).toBe(`dm:${ASKER}:${BOT}`)
  })
  it('detects a mention in both forms', () => {
    expect(mentionsBot('@[efp] what is blocking this?', 'efp')).toBe(true)
    expect(mentionsBot('hey @EFP', 'efp')).toBe(true)
    expect(mentionsBot('efp is great', 'efp')).toBe(false)
  })
})

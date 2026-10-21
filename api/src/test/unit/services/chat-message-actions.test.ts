import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetChatMessageActions,
  _setMessageActionsEnabledCheck,
  describeChatMessageActions,
  listChatMessageActions,
  messageMatches,
  normalizeWhen,
  registerChatMessageAction,
  roomKind,
  roomMatches,
  runChatMessageAction,
  unregisterChatMessageActions
} from '../../../services/chat-message-actions.js'

const ME = 'aaaaaaaa-0000-0000-0000-000000000001'
const msg = (over: Record<string, unknown> = {}) => ({
  id: 7,
  room: 'REQ:1234',
  message: 'Invoice 55 is late',
  sender: ME.toUpperCase(),
  sender_name: 'Alex',
  parent_id: null,
  attachments: [] as string[],
  date_created: '2026-10-21T10:00:00.000Z',
  ...over
})

let enabled = new Set(['crm'])
beforeEach(() => {
  _resetChatMessageActions()
  enabled = new Set(['crm'])
  _setMessageActionsEnabledCheck(async (e) => enabled.has(e))
})
afterEach(() => _resetChatMessageActions())

describe('normalizeWhen (#2763)', () => {
  it('keeps known keys and refuses unknown kinds or a broken pattern', () => {
    expect(normalizeWhen(undefined)).toEqual({})
    expect(
      normalizeWhen({ room_kinds: ['entity'], room_prefixes: ['req'], has_text: true, junk: 1 })
    ).toEqual({ room_kinds: ['entity'], room_prefixes: ['REQ'], has_text: true })
    expect(normalizeWhen({ room_kinds: ['lobby'] })).toBeNull()
    expect(normalizeWhen({ text_pattern: '(' })).toBeNull()
    expect(normalizeWhen('x')).toBeNull()
  })
})

describe('room and message matching', () => {
  it('reads room kinds the way parseRoom does', () => {
    expect(roomKind('global')).toEqual({ kind: 'general', prefix: null })
    expect(roomKind('dm:a:b').kind).toBe('dm')
    expect(roomKind('ch:ops').kind).toBe('channel')
    expect(roomKind('req:12')).toEqual({ kind: 'entity', prefix: 'REQ' })
    expect(roomKind('nothing').kind).toBe('unknown')
  })

  it('room_prefixes implies a record room', () => {
    expect(roomMatches({ room_prefixes: ['REQ'] }, 'REQ:1')).toBe(true)
    expect(roomMatches({ room_prefixes: ['REQ'] }, 'PO:1')).toBe(false)
    expect(roomMatches({ room_prefixes: ['REQ'] }, 'ch:ops')).toBe(false)
    expect(roomMatches({ room_kinds: ['channel', 'general'] }, 'global')).toBe(true)
    expect(roomMatches({ room_kinds: ['channel'] }, 'dm:a:b')).toBe(false)
    expect(roomMatches({}, 'weird')).toBe(false)
  })

  it('message shape: text, attachments, own messages (case-blind ids), pattern', () => {
    expect(messageMatches({ has_text: true }, msg({ message: '  ' }), ME)).toBe(false)
    expect(messageMatches({ has_attachments: true }, msg(), ME)).toBe(false)
    expect(messageMatches({ has_attachments: true }, msg({ attachments: ['f1'] }), ME)).toBe(true)
    expect(messageMatches({ own_messages: true }, msg(), ME)).toBe(true)
    expect(messageMatches({ own_messages: true }, msg({ sender: 'someone' }), ME)).toBe(false)
    expect(messageMatches({ text_pattern: 'invoice \\d+' }, msg(), ME)).toBe(true)
    expect(messageMatches({ text_pattern: '^PO' }, msg(), ME)).toBe(false)
  })
})

describe('register / list / run', () => {
  it('refuses a bad id, an empty label, a missing handler or a bad when', () => {
    const handler = () => ({})
    expect(registerChatMessageAction('crm', { id: 'X', label: 'a', handler })).toBe(false)
    expect(registerChatMessageAction('crm', { id: 'log', label: ' ', handler })).toBe(false)
    expect(registerChatMessageAction('crm', { id: 'log', label: 'Log', handler: 1 as never })).toBe(
      false
    )
    expect(
      registerChatMessageAction('crm', {
        id: 'log',
        label: 'Log',
        handler,
        when: { room_kinds: ['moon' as never] }
      })
    ).toBe(false)
    expect(registerChatMessageAction('crm', { id: 'log', label: 'Log', handler })).toBe(true)
    expect(describeChatMessageActions('crm')).toEqual([{ id: 'log', label: 'Log', when: {} }])
  })

  it('lists by room kind for enabled extensions; shape checks ride to the client', async () => {
    registerChatMessageAction('crm', {
      id: 'log-to-record',
      label: 'Log to record',
      when: { room_prefixes: ['REQ'], has_text: true },
      handler: () => ({})
    })
    registerChatMessageAction('crm', { id: 'anywhere', label: 'Anywhere', handler: () => ({}) })
    const inRecord = await listChatMessageActions('REQ:1')
    expect(inRecord.map((a) => a.key)).toEqual(['crm:anywhere', 'crm:log-to-record'])
    expect(inRecord[1].when).toEqual({ has_text: true })
    expect((await listChatMessageActions('ch:ops')).map((a) => a.key)).toEqual(['crm:anywhere'])
    enabled.clear()
    expect(await listChatMessageActions('REQ:1')).toEqual([])
  })

  it('runs as the clicker, re-checks when, caps output and drops unsafe links', async () => {
    const handler = vi.fn(async () => ({
      post: 'x'.repeat(9000),
      reply: 'Logged',
      open_url: 'javascript:alert(1)'
    }))
    registerChatMessageAction('crm', {
      id: 'log',
      label: 'Log',
      when: { text_pattern: 'invoice' },
      handler
    })
    const out = await runChatMessageAction('crm:log', msg(), ME)
    expect(handler).toHaveBeenCalledWith(msg(), { userId: ME, room: 'REQ:1234' })
    expect(out?.post).toHaveLength(8000)
    expect(out?.reply).toBe('Logged')
    expect(out?.open_url).toBeUndefined()
    // A message the action does not apply to = no such action.
    expect(await runChatMessageAction('crm:log', msg({ message: 'hello' }), ME)).toBeNull()
    expect(await runChatMessageAction('crm:nope', msg(), ME)).toBeNull()
  })

  it('keeps an http(s) link or an app path', async () => {
    registerChatMessageAction('crm', {
      id: 'open',
      label: 'Open',
      handler: () => ({ open_url: '/collections/req/1' })
    })
    expect((await runChatMessageAction('crm:open', msg(), ME))?.open_url).toBe('/collections/req/1')
    unregisterChatMessageActions('crm')
    expect(await runChatMessageAction('crm:open', msg(), ME)).toBeNull()
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'

// Army v3 round 2: a chat message may only attach files its sender can open
// (file-access.ts unreadableFileIds — admins and the uploader pass), so a
// stored attachment id never names someone else's file.

const FILE = '11111111-1111-4111-8111-111111111111'
const files = vi.hoisted(() => ({ unreadable: [] as string[], calls: [] as unknown[] }))

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../lib/column-probe.js', () => ({ hasColumn: vi.fn(async () => true) }))
vi.mock('../../../services/file-access.js', () => ({
  unreadableFileIds: vi.fn(async (ids: string[], caller: unknown) => {
    files.calls.push(caller)
    return ids.filter((i) => files.unreadable.includes(i))
  })
}))

import { db } from '../../../db/index.js'
import { ChatSendError, postChatMessage } from '../../../services/chat-send.js'

beforeEach(() => {
  files.unreadable = []
  files.calls = []
  vi.mocked(db).mockImplementation((() => {
    const b = Object.assign(Promise.resolve([]), {}) as Promise<unknown> & Record<string, unknown>
    for (const m of ['where', 'whereNull', 'orWhere', 'whereIn', 'join', 'orderBy', 'select'])
      b[m] = vi.fn(() => b)
    b.first = vi.fn(async () => undefined)
    return b
  }) as never)
})

const bob = { id: 'BOB', role: 'R' } as never
const send = (isAdmin = false) =>
  postChatMessage(
    {} as never,
    { user: bob, isAdmin, skipVisibility: true },
    { room: 'ch:ops', message: 'look', attachments: [FILE] }
  ).catch((e) => e)

describe('chat attachments', () => {
  it('a sender attaching a file they cannot open is refused (400)', async () => {
    files.unreadable = [FILE]
    const err = await send()
    expect(err).toBeInstanceOf(ChatSendError)
    expect(err.statusCode).toBe(400)
    expect(err.message).toMatch(/file you cannot open/)
  })

  it('a readable attachment (the uploader’s own) gets past the check; admins are judged as admins', async () => {
    const err = await send()
    expect(String(err?.message ?? '')).not.toMatch(/file you cannot open/)
    await send(true)
    expect(files.calls.at(-1)).toMatchObject({ isAdmin: true })
  })
})

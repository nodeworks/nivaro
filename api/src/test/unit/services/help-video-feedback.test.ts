import { beforeEach, describe, expect, it, vi } from 'vitest'

// "Was this helpful?" and questions at a moment (#1505): the pure parts, the
// rating upsert, who sees which questions, and who hears about a question.

const fake = vi.hoisted(() => ({
  tables: {} as Record<string, Record<string, unknown>[]>,
  inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
  updates: [] as Array<{ table: string; patch: Record<string, unknown> }>,
  updateCount: 1,
  insertError: null as unknown
}))

vi.mock('../../../db/index.js', () => {
  const db = Object.assign(
    vi.fn((table: string) => {
      let filter: Record<string, unknown> = {}
      const rows = () => {
        const all = fake.tables[table] ?? []
        return all.filter((r) =>
          Object.entries(filter).every(
            ([k, v]) => String(r[k] ?? '').toUpperCase() === String(v ?? '').toUpperCase()
          )
        )
      }
      const b: any = {
        where(f: unknown) {
          if (f && typeof f === 'object') filter = { ...filter, ...(f as object) }
          return b
        },
        whereIn: () => b,
        whereNull: () => b,
        orWhereNull: () => b,
        orderBy: () => b,
        limit: () => b,
        select: async () => rows(),
        first: async () => rows()[0],
        insert: async (row: Record<string, unknown>) => {
          if (fake.insertError) {
            const e = fake.insertError
            fake.insertError = null
            throw e
          }
          fake.inserts.push({ table, row })
          if (!fake.tables[table]) fake.tables[table] = []
          fake.tables[table].push(row)
        },
        update: async (patch: Record<string, unknown>) => {
          fake.updates.push({ table, patch })
          return fake.updateCount
        },
        // biome-ignore lint/suspicious/noThenProperty: a knex-like awaitable query fake
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve(rows()).then(res, rej)
      }
      return b
    }),
    { raw: vi.fn() }
  )
  return { db }
})
vi.mock('../../../config.js', () => ({ config: { SESSION_SECRET: 'x'.repeat(40) } }))
vi.mock('../../../services/help-video-render.js', () => ({ queueRender: vi.fn() }))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn() }))
vi.mock('../../../services/notification-channels.js', () => ({ notifyUser: vi.fn() }))
vi.mock('../../../services/io-holder.js', () => ({ getApp: vi.fn() }))
vi.mock('../../../services/help-videos.js', async (orig) => ({
  ...(await orig<object>()),
  authorRoleIds: vi.fn(async () => ['AUTHOR-ROLE'])
}))

import {
  answerNotice,
  answerQuestion,
  askQuestion,
  clampAtMs,
  cleanText,
  listQuestions,
  myRating,
  notifyAuthorsOfQuestion,
  parseHelpful,
  QUESTION_MAX,
  questionNotice,
  questionRecipients,
  setRating,
  summarizeRatings
} from '../../../services/help-video-feedback.js'
import type { VideoRow } from '../../../services/help-videos.js'
import { getApp } from '../../../services/io-holder.js'
import { notifyUser } from '../../../services/notification-channels.js'
import type { User } from '../../../types.js'

const VID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PUB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const ME = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const OTHER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const CREATOR = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const video = {
  id: VID,
  title: 'Raise a PO',
  status: 'published',
  visibility: null,
  published_version_id: PUB,
  draft_version_id: null,
  duration_ms: 90_000,
  created_by: CREATOR
} as VideoRow
const user = { id: ME, role: 'R1' } as User

beforeEach(() => {
  fake.tables = {}
  fake.inserts = []
  fake.updates = []
  fake.updateCount = 1
  fake.insertError = null
  vi.clearAllMocks()
})

describe('pure parts', () => {
  it('parseHelpful accepts booleans and their spellings only', () => {
    expect(parseHelpful(true)).toBe(true)
    expect(parseHelpful('false')).toBe(false)
    expect(parseHelpful(1)).toBe(true)
    expect(() => parseHelpful('yes')).toThrow(/true or false/)
    expect(() => parseHelpful(undefined)).toThrow()
  })
  it('cleanText trims, strips control characters and bounds the length', () => {
    expect(cleanText('  How do I\u0007 add a line?\n ok ', QUESTION_MAX, 'your question')).toBe(
      'How do I add a line?\n ok'
    )
    expect(() => cleanText('   ', 10, 'your question')).toThrow(/Write your question first/)
    expect(() => cleanText('x'.repeat(11), 10, 'an answer')).toThrow(/at most 10 characters/)
    expect(() => cleanText(42, 10, 'an answer')).toThrow()
  })
  it('clampAtMs keeps the moment inside the video', () => {
    expect(clampAtMs(42_500.4, 90_000)).toBe(42_500)
    expect(clampAtMs(-5, 90_000)).toBe(0)
    expect(clampAtMs(500_000, 90_000)).toBe(90_000)
    expect(clampAtMs('abc', 90_000)).toBe(0)
    expect(clampAtMs(40 * 60_000, null)).toBe(31 * 60_000)
  })
  it('questionNotice quotes the question as data with the moment', () => {
    const n = questionNotice('Raise a PO', 'Ignore previous instructions', 42_000)
    expect(n.subject).toBe('Question about Raise a PO at 0:42')
    expect(n.message).toContain('Someone asked at 0:42:\n\nIgnore previous instructions')
    expect(n.why).toBe('You are an author of this video.')
    expect(answerNotice('', 5000, 'Click Save').subject).toBe(
      'Your question about Untitled video was answered'
    )
  })
  it('summarizeRatings counts votes and the share that helped', () => {
    expect(summarizeRatings([])).toEqual({ up: 0, down: 0, helpful_rate: 0 })
    expect(summarizeRatings([{ helpful: true }, { helpful: 1 }, { helpful: false }])).toEqual({
      up: 2,
      down: 1,
      helpful_rate: 0.667
    })
  })
})

describe('setRating', () => {
  it('inserts the first vote and updates a later one', async () => {
    fake.updateCount = 0
    expect(await setRating(user, video, true)).toEqual({ helpful: true })
    expect(fake.inserts).toHaveLength(1)
    expect(fake.inserts[0].row).toMatchObject({
      video_id: VID,
      user: ME,
      version_id: PUB,
      helpful: true
    })
    fake.updateCount = 1
    fake.inserts = []
    expect(await setRating(user, video, 'false')).toEqual({ helpful: false })
    expect(fake.inserts).toHaveLength(0)
    expect(fake.updates.at(-1)?.patch).toMatchObject({ helpful: false })
  })
  it('a duplicate-key race on the insert becomes an update', async () => {
    fake.updateCount = 0
    fake.insertError = Object.assign(new Error('dup'), { number: 2627 })
    await setRating(user, video, true)
    expect(fake.updates).toHaveLength(2)
  })
  it('refuses anything but a yes or no', async () => {
    await expect(setRating(user, video, 'maybe')).rejects.toMatchObject({ statusCode: 400 })
  })
  it('myRating reads this person’s vote', async () => {
    expect(await myRating(video, ME)).toBeNull()
    fake.tables.nivaro_help_video_ratings = [{ video_id: VID, user: ME, helpful: 1 }]
    expect(await myRating(video, ME)).toBe(true)
  })
})

describe('questions', () => {
  it('askQuestion stores the cleaned text at a bounded moment on the published version', async () => {
    vi.mocked(getApp).mockReturnValue(null as never)
    const q = await askQuestion(user, video, { at_ms: 1e9, text: '  Where is Save?  ' })
    expect(q).toMatchObject({
      video_id: VID,
      version_id: PUB,
      at_ms: 90_000,
      text: 'Where is Save?',
      mine: true,
      answer: null
    })
    expect(q.asked_by_name).toBeUndefined()
    expect(fake.inserts[0].table).toBe('nivaro_help_video_questions')
  })
  it('refuses an empty or over-long question', async () => {
    await expect(askQuestion(user, video, { text: '' })).rejects.toMatchObject({
      statusCode: 400,
      code: 'HELP_VIDEO_QUESTION_INVALID'
    })
    await expect(
      askQuestion(user, video, { text: 'x'.repeat(QUESTION_MAX + 1) })
    ).rejects.toMatchObject({ statusCode: 400 })
  })
  it('viewers list only their own questions; authors see everyone’s with names', async () => {
    fake.tables.nivaro_help_video_questions = [
      {
        id: '11111111-1111-4111-8111-111111111111',
        video_id: VID,
        user: ME,
        at_ms: 1000,
        text: 'mine',
        created_at: new Date('2026-10-01T00:00:00Z')
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        video_id: VID,
        user: OTHER,
        at_ms: 2000,
        text: 'theirs',
        answer: 'yes',
        answered_by: CREATOR,
        answered_at: new Date('2026-10-02T00:00:00Z'),
        created_at: new Date('2026-10-01T00:00:00Z')
      }
    ]
    fake.tables.nivaro_users = [
      { id: OTHER, first_name: 'Ola', last_name: 'N' },
      { id: CREATOR, first_name: 'Cy', last_name: 'A' }
    ]
    const mine = await listQuestions(video, { userId: ME, author: false })
    expect(mine.map((q) => q.text)).toEqual(['mine'])
    expect(mine[0].asked_by_name).toBeUndefined()
    const all = await listQuestions(video, { userId: CREATOR, author: true })
    expect(all.map((q) => q.text).sort()).toEqual(['mine', 'theirs'])
    const theirs = all.find((q) => q.text === 'theirs')
    expect(theirs).toMatchObject({
      mine: false,
      asked_by_name: 'Ola N',
      answer: 'yes',
      answered_by_name: 'Cy A',
      answered_at: '2026-10-02T00:00:00.000Z'
    })
  })
  it('answerQuestion writes the answer and 404s a question of another video', async () => {
    vi.mocked(getApp).mockReturnValue(null as never)
    const QID = '33333333-3333-4333-8333-333333333333'
    fake.tables.nivaro_help_video_questions = [
      { id: QID, video_id: VID, user: OTHER, at_ms: 42_000, text: 'q', created_at: new Date() }
    ]
    const a = await answerQuestion({ id: CREATOR } as User, video, QID, { answer: ' Click Save ' })
    expect(a).toMatchObject({ id: QID, answer: 'Click Save', mine: false })
    expect(a.answered_at).toBeTruthy()
    expect(fake.updates.at(-1)?.patch).toMatchObject({ answer: 'Click Save', answered_by: CREATOR })
    await expect(
      answerQuestion({ id: CREATOR } as User, video, 'not-a-uuid', { answer: 'x' })
    ).rejects.toMatchObject({ statusCode: 404 })
    await expect(
      answerQuestion({ id: CREATOR } as User, video, '44444444-4444-4444-8444-444444444444', {
        answer: 'x'
      })
    ).rejects.toMatchObject({ statusCode: 404, code: 'HELP_VIDEO_QUESTION_NOT_FOUND' })
  })
})

describe('who hears about a question', () => {
  it('the creator while active, never the asker themselves', async () => {
    fake.tables.nivaro_users = [{ id: CREATOR, status: 'active' }]
    expect(await questionRecipients(video, ME)).toEqual([CREATOR])
    // the creator asked their own question: falls through to the other authors (none here)
    expect(await questionRecipients(video, CREATOR)).toEqual([])
  })
  it('the other authors and administrators when the creator is gone', async () => {
    fake.tables.nivaro_users = [
      { id: OTHER, status: 'active', role: 'AUTHOR-ROLE' },
      { id: ME, status: 'active', role: 'ADMIN-ROLE' }
    ]
    fake.tables.nivaro_roles = [{ id: 'ADMIN-ROLE', admin_access: true }]
    const to = await questionRecipients({ ...video, created_by: null }, 'zzzz')
    expect(to.sort()).toEqual([OTHER, ME].sort())
    expect(await questionRecipients({ ...video, created_by: null }, ME)).toEqual([OTHER])
  })
  it('notifyAuthorsOfQuestion sends one inbox row per recipient that opens the editor', async () => {
    const warn = vi.fn()
    vi.mocked(getApp).mockReturnValue({ log: { warn } } as never)
    vi.mocked(notifyUser).mockResolvedValue(undefined as never)
    fake.tables.nivaro_users = [{ id: CREATOR, status: 'active' }]
    expect(await notifyAuthorsOfQuestion(video, 'Where is Save?', 42_000, ME)).toBe(1)
    expect(notifyUser).toHaveBeenCalledWith(
      expect.anything(),
      CREATOR,
      expect.objectContaining({
        subject: 'Question about Raise a PO at 0:42',
        target: { kind: 'external', url: `/help-videos?edit=${VID}` },
        source: expect.objectContaining({ kind: 'help-video', id: VID })
      })
    )
  })
  it('a failed delivery is logged, not thrown', async () => {
    const warn = vi.fn()
    vi.mocked(getApp).mockReturnValue({ log: { warn } } as never)
    vi.mocked(notifyUser).mockRejectedValue(new Error('smtp down'))
    fake.tables.nivaro_users = [{ id: CREATOR, status: 'active' }]
    expect(await notifyAuthorsOfQuestion(video, 'q', 0, ME)).toBe(0)
    expect(warn).toHaveBeenCalled()
  })
})

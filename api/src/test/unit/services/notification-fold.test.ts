import { beforeEach, describe, expect, it, vi } from 'vitest'

// rt4-notify item 4: several updates on one record fold into one notification as they arrive.

const store = vi.hoisted(() => ({
  existing: undefined as unknown,
  updates: [] as Array<Record<string, unknown>>,
  updateResult: 1
}))

vi.mock('../../../db/index.js', () => ({
  db: () => {
    const q: any = {
      where: () => q,
      orderBy: () => q,
      first: async () => store.existing,
      update: async (patch: Record<string, unknown>) => {
        store.updates.push(patch)
        return store.updateResult
      }
    }
    return q
  }
}))

import {
  addToFold,
  canFold,
  FOLD_WINDOW_MS,
  type FoldCandidate,
  foldFamily,
  foldIntoRecent,
  foldKind,
  foldSubject,
  foldSummary
} from '../../../services/notification-fold.js'

const now = new Date('2026-11-14T15:42:00Z')
const minsAgo = (m: number) => new Date(now.getTime() - m * 60_000)

const row = (over: Partial<FoldCandidate> = {}): FoldCandidate => ({
  id: 7,
  subject: "CM26-79704 moved to PUB'd",
  message: "Beth moved it to PUB'd.",
  timestamp: minsAgo(3),
  sender: 'beth',
  category: 'workflow',
  lane: 'fyi',
  status: 'inbox',
  detail: JSON.stringify({ why: { kind: 'rules', text: 'x' } }),
  ...over
})

describe('foldFamily', () => {
  it('only FYI record updates fold', () => {
    const base = { category: 'workflow', lane: 'fyi', collection: 'workflows', item: 1 }
    expect(foldFamily(base)).toBe('activity')
    expect(foldFamily({ ...base, category: 'watch' })).toBe('activity')
    expect(foldFamily({ ...base, lane: 'needs_you' })).toBeNull()
    expect(foldFamily({ ...base, lane: 'critical' })).toBeNull()
    expect(foldFamily({ ...base, category: 'mentions' })).toBeNull()
    expect(foldFamily({ ...base, ackRequired: true })).toBeNull()
    expect(foldFamily({ ...base, resolveKey: 'task:1' })).toBeNull()
    expect(foldFamily({ ...base, collection: '__chat__' })).toBeNull()
    expect(foldFamily({ ...base, item: null })).toBeNull()
  })
})

describe('fold window', () => {
  it('folds inside the window into an unread row of the same family', () => {
    expect(canFold(row(), { family: 'activity', now })).toBe(true)
  })
  it('starts a new row once the window has passed, the row was read, or it asks something', () => {
    expect(
      canFold(row({ timestamp: new Date(now.getTime() - FOLD_WINDOW_MS - 1) }), {
        family: 'activity',
        now
      })
    ).toBe(false)
    expect(canFold(row({ status: 'read' }), { family: 'activity', now })).toBe(false)
    expect(canFold(row({ lane: 'needs_you' }), { family: 'activity', now })).toBe(false)
    expect(
      canFold(row({ detail: JSON.stringify({ resolve_key: 'step:w:1' }) }), {
        family: 'activity',
        now
      })
    ).toBe(false)
    expect(canFold(null, { family: 'activity', now })).toBe(false)
  })
})

describe('fold summary', () => {
  it('reads "moved to PUB\'d, 2 comments"', () => {
    const items = [
      {
        subject: 'New comment on CM26-79704',
        message: null,
        at: '',
        sender: null,
        category: 'watch'
      },
      { subject: 'Comment added', message: 'Al replied', at: '', sender: null, category: 'other' },
      {
        subject: "CM26-79704 moved to PUB'd by Beth",
        message: null,
        at: '',
        sender: null,
        category: 'workflow'
      }
    ]
    expect(foldSummary(items)).toBe("moved to PUB'd, 2 comments")
    expect(foldSubject('CM26-79704', { count: 3, items })).toBe(
      "3 updates on CM26-79704: moved to PUB'd, 2 comments"
    )
  })
  it('classifies each update', () => {
    expect(
      foldKind({ subject: 'Watching CM1: 3 changes by Al', message: null, category: 'watch' }).kind
    ).toBe('change')
    expect(foldKind({ subject: 'File uploaded', message: null, category: 'other' }).kind).toBe(
      'file'
    )
    expect(foldKind({ subject: 'Something', message: null, category: 'other' }).kind).toBe('update')
  })
  it('keeps the newest first and the first row as an item', () => {
    const fold = addToFold(row(), {
      subject: 'New comment',
      message: 'hi',
      at: now.toISOString(),
      sender: 'al',
      category: 'watch'
    })
    expect(fold.count).toBe(2)
    expect(fold.items.map((i) => i.subject)).toEqual(['New comment', "CM26-79704 moved to PUB'd"])
  })
})

describe('foldIntoRecent', () => {
  beforeEach(() => {
    store.existing = row()
    store.updates = []
    store.updateResult = 1
  })
  const incoming = {
    recipient: 'al',
    collection: 'workflows',
    item: '79704',
    category: 'watch',
    lane: 'fyi',
    subject: 'New comment on CM26-79704',
    message: 'Looks good',
    sender: 'cy',
    now,
    label: async () => 'CM26-79704'
  }

  it('rewrites the open row: one notification, newest on top', async () => {
    expect(await foldIntoRecent(incoming)).toBe(7)
    const patch = store.updates[0]
    expect(patch.subject).toBe("2 updates on CM26-79704: moved to PUB'd, 1 comment")
    expect(patch.timestamp).toEqual(now)
    expect(patch.sender).toBe('cy')
    const d = JSON.parse(String(patch.detail))
    expect(d.fold.count).toBe(2)
    expect(d.why).toEqual({ kind: 'rules', text: 'x' })
  })
  it('an ask never folds; nothing to fold into = its own row', async () => {
    expect(await foldIntoRecent({ ...incoming, lane: 'needs_you' })).toBeNull()
    store.existing = undefined
    expect(await foldIntoRecent(incoming)).toBeNull()
    expect(store.updates).toEqual([])
  })
  it('a row read in the meantime is left alone', async () => {
    store.updateResult = 0
    expect(await foldIntoRecent(incoming)).toBeNull()
  })
})

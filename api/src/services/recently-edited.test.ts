import { describe, expect, it, vi } from 'vitest'

vi.mock('../db/index.js', () => ({ db: () => ({}) }))

import type { User } from '../types.js'
import {
  deltaFields,
  didSummary,
  type EditRow,
  foldEdits,
  type RecentlyEditedDeps,
  recentlyEditedBy
} from './recently-edited.js'

const row = (
  id: number,
  action: string,
  collection: string,
  item: string,
  at: string,
  comment: string | null = null
): EditRow => ({ id, action, collection, item, timestamp: at, comment })

describe('foldEdits + didSummary', () => {
  it('one line per record, newest first, saying what they did last first', () => {
    const rows = [
      row(
        9,
        'pipeline-transition',
        'workflows',
        '7',
        '2026-11-13T10:00:00Z',
        'Draft → Approved via Approve'
      ),
      row(8, 'update', 'workflows', '7', '2026-11-13T09:00:00Z'),
      row(7, 'update', 'workflows', '7', '2026-11-13T08:00:00Z'),
      row(6, 'create', 'nivaro_comments', 'c1', '2026-11-13T07:30:00Z', 'units:44'),
      row(5, 'create', 'units', '44', '2026-11-13T07:00:00Z')
    ]
    const fieldsByActivity = new Map([
      [8, ['amount', 'vendor']],
      [7, ['amount', 'notes']]
    ])
    const out = foldEdits(rows, { fieldsByActivity })
    expect(out.map((s) => `${s.collection}:${s.item_id}`)).toEqual(['workflows:7', 'units:44'])
    expect(didSummary(out[0])).toBe('Moved to Approved · edited 3 fields')
    expect(didSummary(out[1])).toBe('Commented · created')
    expect(out[0].last_edited_at).toBe('2026-11-13T10:00:00Z')
  })

  it('a record whose newest own write is a delete is gone', () => {
    const out = foldEdits([
      row(3, 'delete', 'workflows', '1', '2026-11-13T10:00:00Z'),
      row(2, 'update', 'workflows', '1', '2026-11-13T09:00:00Z'),
      row(1, 'update', 'workflows', '2', '2026-11-13T08:00:00Z')
    ])
    expect(out.map((s) => s.item_id)).toEqual(['2'])
    expect(didSummary(out[0])).toBe('Edited')
  })

  it('link rows count as a field edit on the record they hang off; unknown ones drop', () => {
    const links = new Map([
      ['workflows_divisions:11', { collection: 'workflows', id: '7', field: 'divisions' }],
      ['workflows_divisions:12', null]
    ])
    const out = foldEdits(
      [
        row(3, 'create', 'workflows_divisions', '11', '2026-11-13T10:00:00Z'),
        row(2, 'create', 'workflows_divisions', '12', '2026-11-13T09:30:00Z'),
        row(1, 'update', 'workflows', '7', '2026-11-13T09:00:00Z')
      ],
      {
        links,
        isLinkTable: (c) => c === 'workflows_divisions',
        fieldsByActivity: new Map([[1, ['amount']]])
      }
    )
    expect(out).toHaveLength(1)
    expect(didSummary(out[0])).toBe('Edited 2 fields')
  })

  it('reads, system rows and comment edits never count', () => {
    const out = foldEdits([
      row(3, 'update', 'nivaro_comments', 'c1', '2026-11-13T10:00:00Z', 'resolved'),
      row(2, 'update', 'nivaro_settings', '1', '2026-11-13T09:00:00Z')
    ])
    expect(out).toEqual([])
  })

  it('several moves without a named target', () => {
    const out = foldEdits([
      row(2, 'transition', 'po', '1', '2026-11-13T10:00:00Z', 'auto-transition "Escalate"'),
      row(1, 'transition', 'po', '1', '2026-11-13T09:00:00Z', 'auto-transition "Escalate"')
    ])
    expect(didSummary(out[0])).toBe('Moved 2 times')
  })

  it('deltaFields drops meta columns and bad JSON', () => {
    expect(deltaFields('{"amount":1,"updated_at":"x","user_updated":"u"}')).toEqual(['amount'])
    expect(deltaFields('nope')).toEqual([])
    expect(deltaFields({ a: 1 })).toEqual(['a'])
  })
})

describe('recentlyEditedBy', () => {
  const user = { id: 'U1' } as User
  const base = (over: Partial<RecentlyEditedDeps> = {}): RecentlyEditedDeps => ({
    rows: vi.fn(async () => [
      row(4, 'update', 'workflows', '7', '2026-11-13T10:00:00Z'),
      row(3, 'update', 'workflows', '8', '2026-11-13T09:00:00Z'),
      row(2, 'create', 'workflows_divisions', '11', '2026-11-13T08:00:00Z'),
      row(1, 'create', 'nivaro_comments', 'c9', '2026-11-13T07:00:00Z', 'units:3')
    ]),
    deltas: vi.fn(async () => [{ activity: 4, delta: '{"amount":5}' }]),
    junctions: vi.fn(
      async () => new Map([['workflows_divisions', { parent: 'workflows', alias: 'divisions' }]])
    ),
    labels: vi.fn(async () => ({
      // workflows:8 left the caller's scope since: null → left out.
      records: { 'workflows:7': 'CM26-7', 'workflows:8': null, 'units:3': 'Unit 3' },
      collections: { workflows: { singular: 'Workflow', plural: 'Workflows' } },
      junctions: {
        'workflows_divisions:11': {
          parent_collection: 'workflows',
          parent_id: '7',
          noun: 'Division'
        }
      }
    })),
    states: vi.fn(async () => [
      { collection: 'workflows', item: '7', key: 'approved', label: 'Approved', color: '#0a0' }
    ]),
    ...over
  })

  it('judges every record as the caller and folds links + comments into their record', async () => {
    const deps = base()
    const out = await recentlyEditedBy(
      user,
      { limit: 10, isAdmin: false, now: new Date('2026-11-13T12:00:00Z') },
      deps
    )
    expect(out).toEqual([
      {
        collection: 'workflows',
        collection_label: 'Workflow',
        item_id: '7',
        label: 'CM26-7',
        did: 'Edited 2 fields',
        last_edited_at: '2026-11-13T10:00:00Z',
        kinds: ['edit'],
        state: { key: 'approved', label: 'Approved', color: '#0a0' }
      },
      {
        collection: 'units',
        collection_label: 'Units',
        item_id: '3',
        label: 'Unit 3',
        did: 'Commented',
        last_edited_at: '2026-11-13T07:00:00Z',
        kinds: ['comment'],
        state: null
      }
    ])
    // One labels read as the caller, with every record + the link row + the comment target.
    expect(deps.labels).toHaveBeenCalledTimes(1)
    expect((deps.labels as ReturnType<typeof vi.fn>).mock.calls[0][1]).toEqual([
      { collection: 'workflows', id: '7' },
      { collection: 'workflows', id: '8' },
      { collection: 'workflows_divisions', id: '11' },
      { collection: 'units', id: '3' }
    ])
    // Only plain updates ask for their delta.
    expect(deps.deltas).toHaveBeenCalledWith([4, 3])
  })

  it('widens the window only while too few records turned up', async () => {
    const rows = vi.fn(async () => [row(1, 'update', 'workflows', '7', '2026-11-13T10:00:00Z')])
    await recentlyEditedBy(
      user,
      { limit: 5, isAdmin: false, now: new Date('2026-11-13T12:00:00Z') },
      base({ rows })
    )
    expect(rows).toHaveBeenCalledTimes(3)
    const days = rows.mock.calls.map(
      (c) => (new Date('2026-11-13T12:00:00Z').getTime() - (c[1] as Date).getTime()) / 86_400_000
    )
    expect(days).toEqual([3, 30, 180])
  })

  it('nothing edited → empty, no labels read', async () => {
    const deps = base({ rows: vi.fn(async () => []) })
    expect(await recentlyEditedBy(user, { limit: 10, isAdmin: false }, deps)).toEqual([])
    expect(deps.labels).not.toHaveBeenCalled()
  })

  it('a failed state read still answers', async () => {
    const deps = base({
      states: vi.fn(async () => {
        throw new Error('down')
      })
    })
    const out = await recentlyEditedBy(user, { limit: 10, isAdmin: false }, deps)
    expect(out[0].state).toBeNull()
  })
})

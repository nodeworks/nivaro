import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import {
  activityLabelsFor,
  changesFromDelta,
  enrichActivityRow,
  type LabelDeps
} from '../../../services/activity-readable.js'
import {
  activityGroupKey,
  actorJson,
  markActivityBurst,
  resolveActivityStamp,
  withActivityScope
} from '../../../services/activity-scope.js'
import { renderActivitySentence } from '../../../services/activity-sentence.js'
import type { User } from '../../../types.js'

const API_TWIN = fileURLToPath(new URL('../../../services/activity-sentence.ts', import.meta.url))
const SHARED_TWIN = fileURLToPath(
  new URL('../../../../../packages/shared/src/lib/activity-sentence.ts', import.meta.url)
)

const PAT = 'AAAAAAAA-0000-0000-0000-000000000001'
const ROB = 'AAAAAAAA-0000-0000-0000-000000000002'
const reader = { id: PAT } as unknown as User

function deps(over: Partial<LabelDeps> = {}): LabelDeps {
  return {
    canRead: vi.fn(async (_u: User, c: string) => c !== 'secret_things'),
    // The reader sees invoice 1 only; 2 is hidden from them (User Scope / row filter).
    visibleIds: vi.fn(
      async (_u: User, _c: string, ids: string[]) => new Set(ids.filter((i) => i === '1'))
    ),
    recordLabels: vi.fn(async (_u: User, refs: Array<{ collection: string; id: string }>) =>
      Object.fromEntries(refs.map((r) => [`${r.collection}:${r.id}`, `INV-${r.id}`]))
    ),
    people: vi.fn(async (ids: string[]) =>
      ids.map((id) => ({
        id,
        first_name: id === ROB ? 'Rob' : 'Pat',
        last_name: 'Lee',
        is_redacted: 0
      }))
    ),
    collections: vi.fn(async () => [
      { collection: 'invoices', display_name: 'Invoices', singular: 'Invoice' }
    ]),
    fields: vi.fn(async () => [
      {
        collection: 'invoices',
        field: 'status',
        label: 'Status',
        options: JSON.stringify({ choices: [{ value: 'hold', text: '$t:on-hold' }] })
      }
    ]),
    links: vi.fn(async () => [
      { many_collection: 'invoices', many_field: 'vendor', one_collection: 'vendors' }
    ]),
    ...over
  }
}

describe('activity-sentence twin', () => {
  it('is byte-identical to the packages/shared twin', () => {
    expect(readFileSync(API_TWIN, 'utf8')).toBe(readFileSync(SHARED_TWIN, 'utf8'))
  })
})

describe('POST /activity/labels resolver', () => {
  it('labels what the reader can read and hides the rest', async () => {
    const d = deps()
    const labels = await activityLabelsFor(
      reader,
      {
        refs: [
          { collection: 'invoices', id: '1' },
          { collection: 'invoices', id: '2' },
          { collection: 'secret_things', id: '7' }
        ],
        users: [ROB],
        fields: [
          { collection: 'invoices', field: 'status' },
          { collection: 'invoices', field: 'vendor' }
        ]
      },
      {},
      d
    )
    expect(labels.records).toEqual({
      'invoices:1': 'INV-1',
      'invoices:2': null,
      'secret_things:7': null
    })
    // Hidden records are never sent for labelling.
    expect(d.recordLabels).toHaveBeenCalledWith(reader, [{ collection: 'invoices', id: '1' }])
    // A collection the reader cannot read is never queried for rows.
    expect(d.visibleIds).not.toHaveBeenCalledWith(reader, 'secret_things', expect.anything())
    expect(labels.users).toEqual({ [ROB]: 'Rob Lee' })
    expect(labels.fields?.['invoices.status']).toBe('Status')
    expect(labels.choices?.['invoices.status']).toEqual({ hold: 'On Hold' })
    expect(labels.links?.['invoices.vendor']).toBe('vendors')
    expect(
      renderActivitySentence(
        { action: 'delete', user: ROB, collection: 'invoices', item: '2' },
        labels
      )
    ).toBe("Rob Lee deleted a record you can't see")
    expect(
      renderActivitySentence(
        {
          action: 'update',
          user: ROB,
          collection: 'invoices',
          item: '1',
          changes: [{ field: 'status', value: 'hold' }]
        },
        labels
      )
    ).toBe('Rob Lee set Status to On Hold on Invoice INV-1')
  })

  it('an administrator sees a deleted record by its id', async () => {
    const labels = await activityLabelsFor(
      reader,
      { refs: [{ collection: 'invoices', id: '2' }] },
      { isAdmin: true },
      deps()
    )
    expect(labels.records?.['invoices:2']).toBe('2')
  })

  it('skips redacted people and refuses junk input', async () => {
    const labels = await activityLabelsFor(
      reader,
      {
        users: [PAT, 'not-a-uuid'],
        refs: [{ collection: 'bad name;', id: '1' }]
      },
      {},
      deps({
        people: vi.fn(async (ids: string[]) =>
          ids.map((id) => ({ id, first_name: 'Pat', last_name: 'Lee', is_redacted: 1 }))
        )
      })
    )
    expect(labels.users).toEqual({})
    expect(labels.records).toEqual({})
  })
})

describe('row enrichment', () => {
  it('summarises an update delta and drops secrets', () => {
    expect(
      changesFromDelta(JSON.stringify({ status: 'hold', updated_at: 'x', password: 'p', meta: {} }))
    ).toEqual([{ field: 'status', value: 'hold' }, { field: 'password' }, { field: 'meta' }])
  })

  it('derives the actor of an old row and splits the why', () => {
    const row = enrichActivityRow(
      {
        id: 5,
        action: 'pipeline-transition',
        user: PAT,
        comment: 'Draft → Approved via Approve — "fine"',
        auth_method: 'api_key',
        api_key_id: 3,
        api_key_name: 'Partner sync'
      },
      {}
    )
    expect(row.actor).toMatchObject({ kind: 'api_key', id: '3', name: 'Partner sync' })
    expect(row.why).toMatchObject({ note: 'fine', reason: null })
  })
})

describe('activity scope', () => {
  it('stamps the background scope and the request mark', async () => {
    const req = { requestId: 'req-1' } as never
    expect(markActivityBurst(req, 'bulk')).toBe('bulk:req-1')
    expect(resolveActivityStamp({ req, user: PAT }).group_key).toBe('bulk:req-1')
    const inFlow = withActivityScope(
      {
        group_key: activityGroupKey('flow_run', 'r9'),
        actor: { kind: 'flow', id: 'f', name: 'Notify' }
      },
      () => resolveActivityStamp({ user: PAT })
    )
    expect(inFlow).toEqual({
      group_key: 'flow_run:r9',
      actor: { kind: 'flow', id: 'f', name: 'Notify', on_behalf_of: PAT }
    })
    expect(resolveActivityStamp({ user: PAT })).toEqual({ group_key: null, actor: null })
  })

  it('names View-as and API keys from the request', () => {
    expect(
      resolveActivityStamp({ req: { masqueradeAdminId: ROB } as never, user: PAT }).actor
    ).toEqual({ kind: 'view_as', id: ROB, name: null, on_behalf_of: PAT })
    expect(
      resolveActivityStamp({
        req: { authMethod: 'api_key', apiKeyId: 3, apiKeyName: 'Sync' } as never,
        user: PAT
      }).actor
    ).toMatchObject({ kind: 'api_key', id: '3', name: 'Sync' })
  })

  it('keeps the actor JSON inside the column', () => {
    const s = actorJson({ kind: 'import', id: 'x', name: 'n'.repeat(1000), on_behalf_of: PAT })
    expect(s!.length).toBeLessThanOrEqual(400)
    expect(JSON.parse(s!).kind).toBe('import')
    expect(activityGroupKey('cron', 'y'.repeat(100)).length).toBe(64)
  })
})

// Rob 2026-11-13: "Approved Addendum 867F8CB1-…" and "Read notifications" with no names.
describe('addendum and notification labels', () => {
  const ADD = '867F8CB1-E71E-49FC-A995-D6AEBC97FCF8'
  const more = {
    addendums: vi.fn(async () => [
      { id: ADD, title: 'Scope change', parent_collection: 'invoices', parent_id: '1' },
      { id: 'b-hidden', title: 'Secret', parent_collection: 'invoices', parent_id: '2' }
    ]),
    notifications: vi.fn(async () => [
      { id: '10', subject: 'Workflow CM26-1 needs you', recipient: PAT },
      { id: '11', subject: 'Someone else', recipient: ROB }
    ])
  }
  const refs = [
    { collection: 'nivaro_addendums', id: ADD },
    { collection: 'nivaro_addendums', id: 'b-hidden' },
    { collection: 'nivaro_notifications', id: '10' },
    { collection: 'nivaro_notifications', id: '11' }
  ]

  it('an addendum reads as its title on the record it amends, only when that record is visible', async () => {
    const l = await activityLabelsFor(reader, { refs }, {}, deps(more))
    expect(l.records?.[`nivaro_addendums:${ADD}`]).toBe('“Scope change” on INV-1')
    expect(l.records?.['nivaro_addendums:b-hidden']).toBeNull()
  })

  it('a notification is named by its subject for its recipient and for administrators only', async () => {
    const mine = await activityLabelsFor(reader, { refs }, {}, deps(more))
    expect(mine.records?.['nivaro_notifications:10']).toBe('“Workflow CM26-1 needs you”')
    expect(mine.records?.['nivaro_notifications:11']).toBeNull()
    const admin = await activityLabelsFor(reader, { refs }, { isAdmin: true }, deps(more))
    expect(admin.records?.['nivaro_notifications:11']).toBe('“Someone else”')
    expect(admin.records?.['nivaro_addendums:b-hidden']).toBe('“Secret”')
  })
})

// Rob 2026-11-13: no activity line shows an internal id for a system record.
describe('system record labels', () => {
  const VIEW_MINE = '11111111-2222-3333-4444-555555555555'
  const VIEW_ROB = '11111111-2222-3333-4444-666666666666'
  const TASK_ON_ITEM = '22222222-2222-3333-4444-555555555555'
  const TASK_HIDDEN = '22222222-2222-3333-4444-666666666666'
  const FILE_OK = '33333333-2222-3333-4444-555555555555'
  const FILE_NO = '33333333-2222-3333-4444-666666666666'
  const tables: Record<string, Array<Record<string, unknown> & { id: unknown }>> = {
    nivaro_collection_layouts: [{ id: 5, name: 'Intake form' }],
    nivaro_roles: [{ id: 'ROLE-1', name: 'Approver' }],
    nivaro_policies: [{ id: 7, action: 'read', collection: 'invoices' }],
    nivaro_activity: [{ id: 99 }],
    nivaro_saved_views: [
      { id: VIEW_MINE, name: 'My open invoices', user: PAT },
      { id: VIEW_ROB, name: 'Rob only', user: ROB }
    ],
    nivaro_tasks: [
      {
        id: TASK_ON_ITEM,
        title: 'Check totals',
        assignee: ROB,
        created_by: ROB,
        collection: 'invoices',
        item: '1'
      },
      {
        id: TASK_HIDDEN,
        title: 'Hidden task',
        assignee: ROB,
        created_by: ROB,
        collection: 'invoices',
        item: '2'
      }
    ],
    nivaro_comments: [
      { id: 40, user: ROB, collection: 'invoices', item: '1' },
      { id: 41, user: ROB, collection: 'invoices', item: '2' },
      { id: 42, user: ROB, collection: 'nivaro_tasks', item: TASK_ON_ITEM }
    ]
  }
  const asked: string[][] = []
  const more = {
    systemRows: vi.fn(async (table: string, ids: string[], columns: string[]) => {
      asked.push(columns)
      return (tables[table] ?? [])
        .filter((r) => ids.some((i) => i.toLowerCase() === String(r.id).toLowerCase()))
        .map((r) => ({ ...r }))
    }),
    readableFiles: vi.fn(async (_u: User, isAdmin: boolean, ids: string[]) => {
      const all = new Map([
        [FILE_OK.toLowerCase(), 'quote.pdf'],
        [FILE_NO.toLowerCase(), 'payroll.xlsx']
      ])
      return new Map(
        ids
          .map((i) => i.toLowerCase())
          .filter((i) => all.has(i) && (isAdmin || i === FILE_OK.toLowerCase()))
          .map((i) => [i, all.get(i)!] as [string, string])
      )
    }),
    chatChannels: vi.fn(
      async (_u: User, keys: string[]) =>
        new Map(keys.filter((k) => k === 'ops').map((k) => [k, 'ops'] as [string, string]))
    )
  }

  it('configuration is named for administrators only; others read the generic phrase', async () => {
    const refs = [
      { collection: 'nivaro_collection_layouts', id: '5' },
      { collection: 'nivaro_roles', id: 'ROLE-1' },
      { collection: 'nivaro_policies', id: '7' },
      { collection: 'nivaro_activity', id: '99' }
    ]
    const d = deps(more)
    const admin = await activityLabelsFor(reader, { refs, users: [ROB] }, { isAdmin: true }, d)
    expect(admin.records?.['nivaro_collection_layouts:5']).toBe('“Intake form”')
    expect(admin.records?.['nivaro_roles:ROLE-1']).toBe('“Approver”')
    expect(admin.records?.['nivaro_policies:7']).toBe('“read on invoices”')
    expect(admin.records?.['nivaro_activity:99']).toBeNull()
    expect(
      renderActivitySentence(
        { action: 'update', user: ROB, collection: 'nivaro_collection_layouts', item: '5' },
        admin
      )
    ).toBe('Rob Lee updated Layout “Intake form”')
    // System rows are never read through the items service.
    expect(d.visibleIds).not.toHaveBeenCalled()
    // A credential column is never asked for.
    expect(asked.flat().some((c) => /secret|token|hash|password/i.test(c))).toBe(false)
    const pat = await activityLabelsFor(reader, { refs, users: [ROB] }, {}, deps(more))
    expect(pat.records?.['nivaro_collection_layouts:5']).toBeNull()
    expect(
      renderActivitySentence(
        { action: 'update', user: ROB, collection: 'nivaro_collection_layouts', item: '5' },
        pat
      )
    ).toBe('Rob Lee updated a layout')
    expect(
      renderActivitySentence(
        { action: 'delete', user: ROB, collection: 'nivaro_activity', item: '99' },
        pat
      )
    ).toBe('Rob Lee deleted an activity entry')
  })

  it('a personal row is named for its owner and administrators', async () => {
    const refs = [
      { collection: 'nivaro_saved_views', id: VIEW_MINE },
      { collection: 'nivaro_saved_views', id: VIEW_ROB }
    ]
    const pat = await activityLabelsFor(reader, { refs, users: [ROB] }, {}, deps(more))
    expect(pat.records?.[`nivaro_saved_views:${VIEW_MINE}`]).toBe('“My open invoices”')
    expect(pat.records?.[`nivaro_saved_views:${VIEW_ROB}`]).toBeNull()
    expect(
      renderActivitySentence(
        { action: 'delete', user: ROB, collection: 'nivaro_saved_views', item: VIEW_ROB },
        pat
      )
    ).toBe('Rob Lee deleted a saved view')
    const admin = await activityLabelsFor(
      reader,
      { refs, users: [ROB] },
      { isAdmin: true },
      deps(more)
    )
    expect(admin.records?.[`nivaro_saved_views:${VIEW_ROB}`]).toBe('“Rob only”')
  })

  it('a row on a record is only as visible as that record', async () => {
    const refs = [
      { collection: 'nivaro_tasks', id: TASK_ON_ITEM },
      { collection: 'nivaro_tasks', id: TASK_HIDDEN },
      { collection: 'nivaro_comments', id: '40' },
      { collection: 'nivaro_comments', id: '41' },
      { collection: 'nivaro_comments', id: '42' }
    ]
    const pat = await activityLabelsFor(reader, { refs, users: [ROB] }, {}, deps(more))
    expect(pat.records?.[`nivaro_tasks:${TASK_ON_ITEM}`]).toBe('“Check totals” on INV-1')
    expect(pat.records?.[`nivaro_tasks:${TASK_HIDDEN}`]).toBeNull()
    expect(pat.records?.['nivaro_comments:40']).toBe('on INV-1')
    expect(pat.records?.['nivaro_comments:41']).toBeNull()
    // A comment on a task follows the task, which follows its record.
    expect(pat.records?.['nivaro_comments:42']).toBe('on Task “Check totals” on INV-1')
    expect(
      renderActivitySentence(
        { action: 'create', user: ROB, collection: 'nivaro_comments', item: '40' },
        pat
      )
    ).toBe('Rob Lee created Comment on INV-1')
    expect(
      renderActivitySentence(
        { action: 'create', user: ROB, collection: 'nivaro_comments', item: '41' },
        pat
      )
    ).toBe('Rob Lee created a comment')
    const admin = await activityLabelsFor(
      reader,
      { refs, users: [ROB] },
      { isAdmin: true },
      deps(more)
    )
    expect(admin.records?.[`nivaro_tasks:${TASK_HIDDEN}`]).toBe('“Hidden task”')
  })

  it('files follow the file gate and channels follow canSeeRoom', async () => {
    const refs = [
      { collection: 'nivaro_files', id: FILE_OK },
      { collection: 'nivaro_files', id: FILE_NO },
      { collection: 'nivaro_chat_channels', id: 'ops' },
      { collection: 'nivaro_chat_channels', id: 'board' }
    ]
    const pat = await activityLabelsFor(reader, { refs, users: [ROB] }, {}, deps(more))
    expect(pat.records?.[`nivaro_files:${FILE_OK}`]).toBe('“quote.pdf”')
    expect(pat.records?.[`nivaro_files:${FILE_NO}`]).toBeNull()
    expect(pat.records?.['nivaro_chat_channels:ops']).toBe('#ops')
    expect(pat.records?.['nivaro_chat_channels:board']).toBeNull()
    expect(
      renderActivitySentence(
        { action: 'update', user: ROB, collection: 'nivaro_chat_channels', item: 'board' },
        pat
      )
    ).toBe('Rob Lee updated a channel')
  })

  it('never shows an id, whoever reads and whatever the labels say', async () => {
    const refs = [
      ...Object.entries(tables).flatMap(([c, rows]) =>
        rows.map((r) => ({ collection: c, id: String(r.id) }))
      ),
      { collection: 'nivaro_webhooks', id: '12' },
      { collection: 'nivaro_saved_views', id: '44444444-0000-0000-0000-000000000000' },
      { collection: 'nivaro_files', id: FILE_NO },
      { collection: 'nivaro_chat_channels', id: 'board' }
    ]
    const actions = ['create', 'update', 'delete', 'restore', 'api_key_created', 'share']
    for (const isAdmin of [false, true]) {
      const sets = [
        await activityLabelsFor(reader, { refs, users: [ROB] }, { isAdmin }, deps(more)),
        null,
        // A label that is the id itself (an older resolver) still never prints it.
        { records: Object.fromEntries(refs.map((r) => [`${r.collection}:${r.id}`, r.id])) }
      ]
      for (const labels of sets) {
        for (const r of refs) {
          for (const action of actions) {
            const s = renderActivitySentence(
              { action, user: ROB, collection: r.collection, item: r.id },
              labels
            )
            expect(s, s).not.toContain(r.id)
            expect(s, s).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i)
            expect(s, s).not.toMatch(/\ba [aeiou]/i)
          }
        }
      }
    }
  })
})

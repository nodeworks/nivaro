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

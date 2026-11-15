import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../db/tenant-context.js', () => ({ getTenantId: () => null }))

import {
  cleanSentView,
  describeForRecipient,
  loadSentView,
  newSentView,
  type RecipientDeps,
  resetSentViewMemory,
  saveSentView,
  sentViewLine,
  sentViewTarget
} from '../../../services/send-view.js'
import type { User } from '../../../types.js'

const ROB = { id: 'U-ROB', name: 'Rob Lee' }
const BETH = { id: 'U-BETH', role: 'R-USER', status: 'active' } as unknown as User

function deps(over: Partial<RecipientDeps> = {}): RecipientDeps {
  return {
    collectionName: async (c) => (c === 'workflows' ? 'Workflows' : c),
    // Like recordLabelsAsViewer: the collection's name when the reader cannot see the record.
    recordLabel: async (u, _c, id) => (u.id === 'U-BETH' && id === '7' ? 'CM26-7' : 'Workflows'),
    queue: async () => ({ name: 'Approvals', owner: 'U-ROB', is_shared: false, role_id: null }),
    isAdmin: async () => false,
    ...over
  }
}

describe('send my view', () => {
  beforeEach(() => resetSentViewMemory())

  it('keeps ids and view settings only — never record values', () => {
    const v = cleanSentView({
      kind: 'list',
      collection: 'workflows',
      lv: 'eyJ2IjoxfQ',
      summary: 'Region: NER,\n PUB\u0007d',
      // Anything else a client adds is not carried.
      rows: [{ id: 1, amount: 5000 }],
      values: { amount: 5000 }
    })
    expect(v).toEqual({
      kind: 'list',
      collection: 'workflows',
      item: null,
      queue: null,
      lv: 'eyJ2IjoxfQ',
      tab: null,
      summary: 'Region: NER, PUB d'
    })
    const row = newSentView(ROB, 'U-BETH', v as never, 'have a look')
    const json = JSON.stringify(row)
    expect(json).not.toContain('5000')
    expect(Object.keys(row).sort()).toEqual(
      ['at', 'delivered', 'from', 'id', 'note', 'to', 'view'].sort()
    )
  })

  it('refuses what is not a record, list or queue view', () => {
    expect(cleanSentView(null)).toBe('view is required')
    expect(cleanSentView({ kind: 'page', path: '/x' })).toBe('view.kind is not valid')
    expect(cleanSentView({ kind: 'list', collection: 'nivaro_users' })).toBe(
      'view.collection is not valid'
    )
    expect(cleanSentView({ kind: 'record', collection: 'workflows' })).toBe('view.item is required')
    expect(cleanSentView({ kind: 'list', collection: 'workflows', lv: 'a b' })).toBe(
      'view.lv is not valid'
    )
    expect(cleanSentView({ kind: 'queue' })).toBe('view.queue is required')
  })

  it('opens where the recipient goes, with the list settings', () => {
    expect(
      sentViewTarget({
        kind: 'queue',
        collection: null,
        item: null,
        queue: '9',
        lv: 'abc',
        tab: null,
        summary: null
      })
    ).toEqual({ kind: 'queue', id: '9', query: 'lv=abc', action: 'open' })
    expect(
      sentViewTarget({
        kind: 'record',
        collection: 'workflows',
        item: '7',
        queue: null,
        lv: null,
        tab: 'history',
        summary: null
      })
    ).toEqual({ kind: 'record', collection: 'workflows', id: '7', tab: 'history', action: 'open' })
  })

  it('describes the view as the RECIPIENT reads it', async () => {
    const view = cleanSentView({ kind: 'record', collection: 'workflows', item: '7' })
    const row = newSentView(ROB, 'U-BETH', view as never, null)
    const d = await describeForRecipient(row, BETH, deps())
    expect(d.title).toBe('Workflows — CM26-7')
    expect(d.target).toEqual({
      kind: 'record',
      collection: 'workflows',
      id: '7',
      tab: null,
      action: 'open'
    })
    expect(sentViewLine(d)).toBe('Rob sent you: Workflows — CM26-7')

    // A record the recipient cannot read: the collection's name only, no label, still opens
    // (their app shows the normal no-access page).
    const other = newSentView(ROB, 'U-ANA', view as never, null)
    const ana = { id: 'U-ANA', role: 'R-USER' } as unknown as User
    const hidden = await describeForRecipient(other, ana, deps())
    expect(hidden.title).toBe('Workflows record')
    expect(JSON.stringify(hidden)).not.toContain('CM26-7')
  })

  it('never names a queue the recipient cannot see', async () => {
    const view = cleanSentView({ kind: 'queue', queue: '9' })
    const row = newSentView(ROB, 'U-BETH', view as never, null)
    expect((await describeForRecipient(row, BETH, deps())).title).toBe('A queue')
    const shared = deps({
      queue: async () => ({ name: 'Approvals', owner: 'U-ROB', is_shared: true, role_id: null })
    })
    expect((await describeForRecipient(row, BETH, shared)).title).toBe('Approvals queue')
  })

  it('stores for a day and reads back by id only', async () => {
    const view = cleanSentView({ kind: 'list', collection: 'workflows' })
    const row = newSentView(ROB, 'U-BETH', view as never, null)
    await saveSentView(null, row)
    expect((await loadSentView(null, row.id))?.to).toBe('U-BETH')
    expect(await loadSentView(null, 'not-an-id')).toBeNull()
  })
})

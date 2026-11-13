import { describe, expect, it, vi } from 'vitest'
import {
  type JourneyLabelDeps,
  parseJourneyPath,
  queryMeaning,
  resolveJourneyLabels
} from '../../../services/journey-labels.js'

const VIEWER = { id: 'A1', role: 'R1' } as never

function deps(over: Partial<JourneyLabelDeps> = {}): JourneyLabelDeps {
  return {
    collections: vi.fn(async (names: string[]) => {
      const known: Record<string, { singular: string | null; plural: string | null }> = {
        workflows: { singular: null, plural: 'Workflows' },
        purchase_orders: { singular: 'Purchase order', plural: 'Purchase orders' }
      }
      return new Map(names.filter((n) => known[n]).map((n) => [n, known[n]]))
    }),
    recordLabels: vi.fn(async () => ({
      'workflows:365984': 'CM26-365984 · Roof replacement',
      'nivaro_users:0C1D2E3F-AAAA-4BBB-8CCC-1234567890AB': 'Jane Doe'
    })),
    queues: vi.fn(async () => [
      {
        id: '98f98b3a-f07a-4ef4-9016-0005ad2fc8c5',
        name: 'Pending approvals',
        owner: 'X',
        is_shared: 1,
        role_id: null
      },
      { id: '11111111-2222-3333-4444-555555555555', name: 'Private', owner: 'X', is_shared: 0 }
    ]),
    ...over
  }
}

const GUID = '867f8cb1-e71e-49fc-a995-d6aebc97fcf8'

describe('parseJourneyPath', () => {
  it('reads record, new-record, list, queue and person pages', () => {
    expect(parseJourneyPath('/records/workflows/365984')).toMatchObject({
      kind: 'record',
      collection: 'workflows',
      id: '365984'
    })
    expect(parseJourneyPath('/collections/workflows/365984')).toMatchObject({ kind: 'record' })
    expect(parseJourneyPath('/records/workflows/new')).toMatchObject({ kind: 'new-record' })
    expect(parseJourneyPath('/records/workflows')).toMatchObject({ kind: 'list' })
    expect(parseJourneyPath(`/queues/${GUID}`)).toMatchObject({ kind: 'queue', id: GUID })
    expect(parseJourneyPath(`/users/${GUID}`)).toMatchObject({ kind: 'person', id: GUID })
    expect(parseJourneyPath(`/profile/${GUID}`)).toMatchObject({ kind: 'person', id: GUID })
  })

  it('never keeps an id in a plain page title', () => {
    expect(parseJourneyPath(`/flows/${GUID}`)).toMatchObject({ kind: 'page', title: 'Flows' })
    expect(parseJourneyPath('/admin/data-integrity?tab=people')).toMatchObject({
      kind: 'page',
      section: 'Admin',
      title: 'Data integrity',
      details: ['People tab']
    })
    expect(parseJourneyPath('/invoice-approvals')).toMatchObject({
      title: 'Invoice approvals',
      section: null
    })
    expect(parseJourneyPath('/')).toMatchObject({ kind: 'page', title: 'Home' })
    expect(parseJourneyPath('/sla-rules')).toMatchObject({ title: 'SLA rules' })
  })
})

describe('queryMeaning', () => {
  it('reads known parameters as words and drops the rest', () => {
    expect(queryMeaning(`?addendum=${GUID}`)).toEqual(['Addendum open'])
    expect(queryMeaning('?focus=my-work')).toEqual(['My work'])
    expect(queryMeaning('?p=users&layout=12')).toEqual(['Users tab'])
    expect(queryMeaning(`?tab=${GUID}`)).toEqual([])
    expect(queryMeaning('?utm=x&owner=ABC')).toEqual([])
    expect(queryMeaning('')).toEqual([])
  })
})

describe('resolveJourneyLabels', () => {
  it('names a readable record "<singular> <label>" with the query read as meaning', async () => {
    const d = deps()
    const out = await resolveJourneyLabels(
      [`/records/workflows/365984?addendum=${GUID}`, '/records/workflows/365984'],
      VIEWER,
      true,
      { deps: d, cache: null }
    )
    const a = out.get(`/records/workflows/365984?addendum=${GUID}`)
    expect(a).toMatchObject({
      kind: 'record',
      title: 'Workflow CM26-365984 · Roof replacement',
      section: 'Workflows',
      detail: 'Addendum open',
      record: { collection: 'workflows', id: '365984' }
    })
    // Same place, same fold key, no detail — and the key does not carry the id.
    const b = out.get('/records/workflows/365984')
    expect(b).toMatchObject({ key: a?.key, detail: null })
    expect(a?.key).not.toContain('365984')
    // One label read for the collection, as the viewer.
    expect(d.recordLabels).toHaveBeenCalledTimes(1)
    const [viewer, byTarget] = (d.recordLabels as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(viewer).toBe(VIEWER)
    expect([...byTarget.get('workflows')]).toEqual(['365984'])
  })

  it('a record the viewer cannot read has no id and no link', async () => {
    const out = await resolveJourneyLabels(['/records/purchase_orders/88123'], VIEWER, false, {
      deps: deps(),
      cache: null
    })
    const l = out.get('/records/purchase_orders/88123')
    expect(l?.title).toBe('A purchase order record')
    expect(l?.record).toBeUndefined()
    expect(JSON.stringify(l)).not.toContain('88123')
  })

  it('an unregistered collection is never read and reads as a page', async () => {
    const d = deps()
    const out = await resolveJourneyLabels(['/records/secret_table/9'], VIEWER, true, {
      deps: d,
      cache: null
    })
    expect(out.get('/records/secret_table/9')).toMatchObject({
      kind: 'page',
      title: 'Secret table'
    })
    expect(d.recordLabels).not.toHaveBeenCalled()
  })

  it('names queues by name, and only queues the viewer may open', async () => {
    const out = await resolveJourneyLabels(
      [
        `/queues/98f98b3a-f07a-4ef4-9016-0005ad2fc8c5`,
        '/queues/11111111-2222-3333-4444-555555555555'
      ],
      VIEWER,
      false,
      { deps: deps(), cache: null }
    )
    expect(out.get('/queues/98f98b3a-f07a-4ef4-9016-0005ad2fc8c5')).toMatchObject({
      kind: 'queue',
      title: 'Pending approvals',
      queue_id: '98f98b3a-f07a-4ef4-9016-0005ad2fc8c5'
    })
    const priv = out.get('/queues/11111111-2222-3333-4444-555555555555')
    expect(priv?.title).toBe('A queue')
    expect(priv?.queue_id).toBeUndefined()
  })

  it('names a person page by the person', async () => {
    const p = '/profile/0c1d2e3f-aaaa-4bbb-8ccc-1234567890ab'
    const out = await resolveJourneyLabels([p], VIEWER, true, { deps: deps(), cache: null })
    expect(out.get(p)).toMatchObject({ kind: 'person', title: 'Jane Doe' })
  })

  it('an unknown path still reads as words, never raw ids', async () => {
    const out = await resolveJourneyLabels(
      ['/vendor-360/ABCDEF1234567890ABCDEF', '/weird/%E0%A4'],
      VIEWER,
      true,
      { deps: deps(), cache: null }
    )
    expect(out.get('/vendor-360/ABCDEF1234567890ABCDEF')?.title).toBe('Vendor 360')
    expect(out.get('/weird/%E0%A4')?.title).toBeTruthy()
  })

  it('caps the record lookups and answers the rest without ids', async () => {
    const paths = Array.from({ length: 260 }, (_, i) => `/records/workflows/${i + 1}`)
    const d = deps({ recordLabels: vi.fn(async () => ({})) })
    const out = await resolveJourneyLabels(paths, VIEWER, true, { deps: d, cache: null })
    const [, byTarget] = (d.recordLabels as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(byTarget.get('workflows').size).toBe(200)
    expect(out.get('/records/workflows/260')?.title).toBe('A workflow record')
  })

  it('serves a repeat ask from the short cache', async () => {
    const d = deps()
    const cache = new Map()
    await resolveJourneyLabels(['/records/workflows/365984'], VIEWER, true, { deps: d, cache })
    await resolveJourneyLabels(['/records/workflows/365984'], VIEWER, true, { deps: d, cache })
    expect(d.recordLabels).toHaveBeenCalledTimes(1)
  })

  it('a failing lookup falls back to plain words', async () => {
    const d = deps({
      recordLabels: vi.fn(async () => {
        throw new Error('boom')
      })
    })
    const out = await resolveJourneyLabels(['/records/workflows/365984'], VIEWER, true, {
      deps: d,
      cache: null
    })
    expect(out.get('/records/workflows/365984')?.title).toBe('A workflow record')
  })
})

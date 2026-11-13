import { describe, expect, it } from 'vitest'
import {
  buildJunctionMap,
  foldPersonLines,
  groupPersonDays,
  type PersonDidRow,
  personVerb
} from './person-did.js'

/** "What {person} did" — plain verbs, labels as the viewer, junction rows folded in. */

const rels = [
  // workflows ⇄ divisions (M2M through workflows_divisions)
  {
    many_collection: 'workflows_divisions',
    many_field: 'workflows_id',
    one_collection: 'workflows',
    one_field: 'divisions',
    junction_field: 'divisions_id'
  },
  {
    many_collection: 'workflows_divisions',
    many_field: 'divisions_id',
    one_collection: 'divisions',
    one_field: null,
    junction_field: 'workflows_id'
  },
  {
    many_collection: 'workflows_regions',
    many_field: 'workflows_id',
    one_collection: 'workflows',
    one_field: 'regions',
    junction_field: 'regions_id'
  },
  {
    many_collection: 'workflows_regions',
    many_field: 'regions_id',
    one_collection: 'regions',
    one_field: null,
    junction_field: 'workflows_id'
  },
  // a plain M2O — not a junction
  {
    many_collection: 'workflows',
    many_field: 'vendor',
    one_collection: 'vendors',
    one_field: null,
    junction_field: null
  }
]

const T = (hhmm: string) => `2026-11-12T${hhmm}:00.000Z`
let nextId = 100
const row = (over: Partial<PersonDidRow>): PersonDidRow => ({
  id: nextId++,
  action: 'read',
  timestamp: T('09:00'),
  collection: 'workflows',
  item: '372916',
  comment: null,
  ...over
})

describe('buildJunctionMap', () => {
  it('maps each junction to its parent collection, link column and alias field', () => {
    const m = buildJunctionMap(rels)
    expect(m.get('workflows_divisions')).toEqual({
      junction: 'workflows_divisions',
      parent: 'workflows',
      parentFk: 'workflows_id',
      alias: 'divisions',
      target: 'divisions',
      targetFk: 'divisions_id',
      discriminator: null
    })
    expect(m.has('workflows')).toBe(false)
  })
})

describe('personVerb', () => {
  it('speaks plain verbs, never action keys', () => {
    expect(personVerb(row({ action: 'read' })).verb).toBe('Opened')
    expect(personVerb(row({ action: 'update' })).verb).toBe('Edited')
    expect(personVerb(row({ action: 'access-request' })).verb).toBe('Requested access')
    expect(
      personVerb(
        row({
          action: 'pipeline-transition',
          comment: 'Waiting on Level 2 Approval → Waiting on Level 5 Approval via Approve'
        })
      ).verb
    ).toBe('Approved')
    expect(
      personVerb(row({ action: 'pipeline-transition', comment: 'A → B via Escalate' })).verb
    ).toBe('Moved')
    expect(personVerb(row({ action: 'login', collection: null, item: null })).verb).toBe(
      'Signed in'
    )
  })
})

describe('groupPersonDays', () => {
  it('folds link-table writes into the parent collection and counts reads per record', () => {
    const junctions = buildJunctionMap(rels)
    const rows = [
      row({ action: 'read', item: '1' }),
      row({ action: 'read', item: '1' }),
      row({ action: 'read', item: '2' }),
      row({ action: 'update', item: '1', timestamp: T('09:31') }),
      row({
        action: 'create',
        collection: 'workflows_divisions',
        item: '77',
        timestamp: T('09:31')
      }),
      row({ action: 'delete', collection: 'workflows_regions', item: '78', timestamp: T('09:31') }),
      row({ action: 'login', collection: null, item: null })
    ]
    const days = groupPersonDays(rows, 'UTC', junctions)
    expect(days).toHaveLength(1)
    const cols = days[0].collections
    expect(cols.map((c) => c.collection)).toEqual(['workflows', null])
    const wf = cols[0]
    expect(wf.count).toBe(6)
    // The link writes ride the same minute as the edit — one edit, not three.
    expect(wf.parts).toEqual([
      { verb: 'Edited', count: 1 },
      { verb: 'Opened', count: 2 }
    ])
    expect(cols[1].parts).toEqual([{ verb: 'Signed in', count: 1 }])
  })
})

describe('foldPersonLines', () => {
  const junctions = buildJunctionMap(rels)
  const labels = {
    records: {
      'workflows:372916': 'CM26-372916 · Fiber build',
      'workflows:365984': null
    },
    collections: { workflows: { singular: 'Workflow', plural: 'Workflows' } },
    fields: {
      'workflows.amount': 'Amount',
      'workflows.divisions': 'Divisions',
      'workflows.regions': 'Regions'
    },
    users: { 'BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB': 'Pat Kim' }
  }

  it('folds repeated reads of one record into one line', () => {
    const rows = [
      row({ action: 'read', timestamp: T('09:41') }),
      row({ action: 'read', timestamp: T('09:30') }),
      row({ action: 'read', timestamp: T('09:12') }),
      row({ action: 'read', timestamp: T('09:05') })
    ]
    const lines = foldPersonLines(rows, { junctions, labels })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({
      verb: 'Opened',
      count: 4,
      at: T('09:41'),
      first_at: T('09:05'),
      target: 'Workflow CM26-372916 · Fiber build',
      record: { collection: 'workflows', id: '372916' }
    })
  })

  it('folds link-table writes into the parent record’s edit', () => {
    const upd = row({ action: 'update', timestamp: T('09:31') })
    const rows = [
      row({
        action: 'create',
        collection: 'workflows_divisions',
        item: '77',
        timestamp: T('09:31')
      }),
      row({ action: 'delete', collection: 'workflows_regions', item: '78', timestamp: T('09:31') }),
      upd
    ]
    const lines = foldPersonLines(rows, {
      junctions,
      labels,
      parentOf: new Map([
        ['workflows_divisions:77', '372916'],
        ['workflows_regions:78', '372916']
      ]),
      fields: new Map([[upd.id, ['amount']]])
    })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({
      verb: 'Edited',
      target: 'Workflow CM26-372916 · Fiber build',
      detail: 'Changed Amount, Divisions and Regions'
    })
    expect(lines[0].ids).toHaveLength(3)
  })

  it('names an approval by its states and never shows the record id', () => {
    const lines = foldPersonLines(
      [
        row({
          action: 'pipeline-transition',
          comment: 'Waiting on Level 2 Approval → Waiting on Level 5 Approval via Approve'
        })
      ],
      { junctions, labels }
    )
    expect(lines[0]).toMatchObject({
      verb: 'Approved',
      target: 'Workflow CM26-372916 · Fiber build',
      detail: 'Waiting on Level 2 Approval → Waiting on Level 5 Approval'
    })
    expect(JSON.stringify(lines[0].target)).not.toContain('#')
  })

  it('says “a workflow record” for one the viewer cannot read, with no link and no id', () => {
    const lines = foldPersonLines(
      [row({ action: 'access-request', item: '365984' }), row({ action: 'read', item: '365984' })],
      { junctions, labels }
    )
    expect(lines.map((l) => [l.verb, l.target, l.record])).toEqual([
      ['Requested access to', 'a workflow record', null],
      ['Opened', 'a workflow record', null]
    ])
    expect(JSON.stringify(lines)).not.toContain('365984')
  })

  it('never prints a GUID for an unlabelled record', () => {
    const id = 'aaaaaaaa-1111-2222-3333-444444444444'
    const lines = foldPersonLines([row({ action: 'update', collection: 'vendors', item: id })], {
      junctions,
      labels: { ...labels, records: { [`vendors:${id}`]: id } }
    })
    expect(lines[0].target).toBe('a vendor record')
  })

  it('names who an administrator granted access to', () => {
    const lines = foldPersonLines(
      [
        row({
          action: 'access-request-grant',
          comment: 'for user bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb (Add CHI to their Region filter)'
        })
      ],
      { junctions, labels }
    )
    expect(lines[0]).toMatchObject({
      verb: 'Granted access to',
      target: 'Workflow CM26-372916 · Fiber build',
      detail: 'For Pat Kim · Added CHI to their Region filter'
    })
  })

  it('folds a day’s sign-ins into one line', () => {
    const lines = foldPersonLines(
      [
        row({ action: 'login', collection: null, item: null, timestamp: T('08:31') }),
        row({ action: 'login', collection: null, item: null, timestamp: T('07:58') })
      ],
      { junctions, labels }
    )
    expect(lines).toEqual([
      expect.objectContaining({ verb: 'Signed in', count: 2, target: '', at: T('08:31') })
    ])
  })
})

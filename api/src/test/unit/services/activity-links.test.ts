import { describe, expect, it, vi } from 'vitest'
import {
  activityLabelsFor,
  type LabelDeps,
  labelInChunks
} from '../../../services/activity-readable.js'
import { readableCsvRow } from '../../../services/activity-report-csv.js'
import {
  type ActivityEntryInput,
  type ActivityLabels,
  groupActivity,
  recordPhrase,
  recordTarget,
  renderActivityGroupSentence,
  renderActivitySentence
} from '../../../services/activity-sentence.js'
import { buildJunctionMap } from '../../../services/junction-map.js'
import type { User } from '../../../types.js'

/** Link-table (junction) writes in words, on every surface that renders activity. */

const ROB = 'AAAAAAAA-0000-0000-0000-000000000002'
const at = '2026-11-12T15:00:00.000Z'
const entry = (over: Partial<ActivityEntryInput>): ActivityEntryInput => ({
  id: 1,
  action: 'delete',
  user: ROB,
  first_name: 'Rob',
  last_name: 'Lee',
  collection: 'workflows_divisions',
  item: '472525',
  timestamp: at,
  ...over
})

const labels: ActivityLabels = {
  users: { [ROB]: 'Rob Lee' },
  records: { 'workflows:79704': 'CM26-79704' },
  collections: { workflows: { singular: 'Workflow', plural: 'Workflows' } },
  junctions: {
    'workflows_divisions:472525': {
      parent_collection: 'workflows',
      parent_id: '79704',
      noun: 'Division',
      value: 'Zone 1'
    },
    'workflows_divisions:472600': {
      parent_collection: 'workflows',
      parent_id: '79704',
      noun: 'Division',
      value: 'Zone 2'
    },
    'workflows_regions:582245': {
      parent_collection: 'workflows',
      parent_id: null,
      noun: 'Region',
      value: null
    },
    'workflows_regions:582300': {
      parent_collection: 'workflows',
      parent_id: '79704',
      noun: 'Region',
      value: 'BSO'
    },
    'workflows_files:489844': {
      parent_collection: 'workflows',
      parent_id: '79704',
      noun: 'file',
      value: 'Site plan.pdf',
      file: true
    }
  }
}

describe('link rows as sentences', () => {
  it('says what was removed from what — never the link row’s id', () => {
    const s = renderActivitySentence(entry({}), labels)
    expect(s).toBe('Rob Lee removed Division Zone 1 from Workflow CM26-79704')
    expect(
      renderActivitySentence(
        entry({ action: 'create', collection: 'workflows_regions', item: '582300' }),
        labels
      )
    ).toBe('Rob Lee added Region BSO to Workflow CM26-79704')
    expect(
      renderActivitySentence(
        entry({ action: 'update', collection: 'workflows_files', item: '489844' }),
        labels
      )
    ).toBe('Rob Lee updated file Site plan.pdf on Workflow CM26-79704')
  })

  it('says “a Division” and “a workflow record” when the value or parent is unknown or hidden', () => {
    expect(
      renderActivitySentence(entry({ collection: 'workflows_regions', item: '582245' }), labels)
    ).toBe('Rob Lee removed a Region from a workflow record')
    const hidden = { ...labels, records: { 'workflows:79704': null } }
    expect(renderActivitySentence(entry({}), hidden)).toBe(
      'Rob Lee removed Division Zone 1 from a workflow record'
    )
  })

  it('folds a removed + added pair of one write into a change', () => {
    const rows = [
      entry({ id: 2, action: 'create', item: '472600' }),
      entry({ id: 1, action: 'delete', item: '472525' })
    ]
    const groups = groupActivity(rows, { labels })
    expect(groups).toHaveLength(1)
    expect(renderActivityGroupSentence(groups[0].entries, labels)).toBe(
      'Rob Lee changed Division on Workflow CM26-79704: Zone 1 → Zone 2'
    )
    // Without labels nothing about links is known: no fold across actions.
    expect(groupActivity(rows)).toHaveLength(2)
  })

  it('reads a whole import write on one record as one line', () => {
    const rows = [
      entry({ id: 5, action: 'update', collection: 'workflows_files', item: '489844' }),
      entry({ id: 4, action: 'create', collection: 'workflows_regions', item: '582300' }),
      entry({ id: 3, action: 'delete', collection: 'workflows_regions', item: '582245' }),
      entry({ id: 2, action: 'create', item: '472600' }),
      entry({ id: 1, action: 'delete', item: '472525' })
    ]
    const groups = groupActivity(rows, { labels })
    expect(groups).toHaveLength(1)
    expect(renderActivityGroupSentence(groups[0].entries, labels)).toBe(
      'Rob Lee changed Workflow CM26-79704: Division Zone 1 → Zone 2; Region set to BSO; updated file Site plan.pdf'
    )
  })
})

describe('link labels, read as the reader', () => {
  const reader = { id: ROB } as unknown as User
  const junctions = buildJunctionMap([
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
    }
  ])
  const deps = (visible: string[]): LabelDeps => ({
    canRead: vi.fn(async () => true),
    visibleIds: vi.fn(
      async (_u: User, c: string, ids: string[]) =>
        new Set(ids.filter((i) => visible.includes(`${c}:${i}`)).map((i) => i.toLowerCase()))
    ),
    recordLabels: vi.fn(async (_u: User, refs: Array<{ collection: string; id: string }>) =>
      Object.fromEntries(
        refs.map((r) => [
          `${r.collection}:${r.id}`,
          r.collection === 'divisions' ? `Zone ${r.id}` : `CM26-${r.id}`
        ])
      )
    ),
    people: vi.fn(async () => []),
    collections: vi.fn(async () => [
      { collection: 'divisions', display_name: 'Divisions', singular: 'Division' },
      { collection: 'workflows', display_name: 'Workflows', singular: 'Workflow' }
    ]),
    fields: vi.fn(async () => []),
    links: vi.fn(async () => []),
    junctions: vi.fn(async () => junctions),
    // 472525 is gone: its parent + division come from the stored snapshot.
    junctionRows: vi.fn(
      async () =>
        new Map([
          [
            'workflows_divisions:472525',
            { parent: '79704', target: '1', target_collection: 'divisions' }
          ]
        ])
    ),
    fileNames: vi.fn(async () => new Map())
  })

  it('names the parent and the linked record when the reader may see both', async () => {
    const l = await activityLabelsFor(
      reader,
      { refs: [{ collection: 'workflows_divisions', id: '472525' }] },
      {},
      deps(['workflows:79704', 'divisions:1'])
    )
    expect(l.junctions?.['workflows_divisions:472525']).toEqual({
      parent_collection: 'workflows',
      parent_id: '79704',
      noun: 'Division',
      value: 'Zone 1',
      file: false
    })
    expect(l.records?.['workflows:79704']).toBe('CM26-79704')
  })

  it('hides what the reader may not see', async () => {
    const l = await activityLabelsFor(
      reader,
      { refs: [{ collection: 'workflows_divisions', id: '472525' }] },
      {},
      deps([])
    )
    expect(l.junctions?.['workflows_divisions:472525']?.value).toBeNull()
    expect(l.records?.['workflows:79704']).toBeNull()
    expect(
      renderActivitySentence(entry({ first_name: null, last_name: null }), {
        ...l,
        users: { [ROB]: 'Rob Lee' }
      })
    ).toBe('Rob Lee removed Division from a workflow record'.replace('Division', 'a Division'))
  })

  // Security review 2026-11-13: a link row's parent id is the very thing a reader who cannot
  // see that record must not learn (which workflow a division was taken off).
  it('never hands out the parent id of a record the reader may not see', async () => {
    const l = await activityLabelsFor(
      reader,
      { refs: [{ collection: 'workflows_divisions', id: '472525' }] },
      {},
      deps(['divisions:1'])
    )
    expect(l.junctions?.['workflows_divisions:472525']?.parent_id).toBeNull()
    expect(l.junctions?.['workflows_divisions:472525']?.value).toBeNull()
  })

  it('reads no link row of a link table the reader may not read', async () => {
    const d = deps(['workflows:79704', 'divisions:1'])
    d.canRead = vi.fn(async (_u: User, c: string) => c !== 'workflows_divisions')
    const l = await activityLabelsFor(
      reader,
      { refs: [{ collection: 'workflows_divisions', id: '472525' }] },
      {},
      d
    )
    expect(d.junctionRows).not.toHaveBeenCalled()
    expect(l.junctions?.['workflows_divisions:472525']).toBeUndefined()
  })

  it('an administrator still gets the parent id of a record gone from view', async () => {
    const l = await activityLabelsFor(
      reader,
      { refs: [{ collection: 'workflows_divisions', id: '472525' }] },
      { isAdmin: true },
      deps([])
    )
    expect(l.junctions?.['workflows_divisions:472525']?.parent_id).toBe('79704')
  })
})

// Rob 2026-11-19 (Overview → People active today): the Record column said "Workflows
// Division 482960". Every surface names a link row by what it links and opens its parent.
describe('link rows as a record', () => {
  it('names the link, not the link row', () => {
    expect(recordPhrase('workflows_divisions', '472525', labels)).toBe(
      'Division Zone 1 on Workflow CM26-79704'
    )
    expect(recordPhrase('workflows_files', '489844', labels)).toBe(
      'file Site plan.pdf on Workflow CM26-79704'
    )
  })

  it('value unknown: the parent and the kind; parent unknown or hidden: generic', () => {
    const noValue: ActivityLabels = {
      ...labels,
      junctions: {
        'workflows_regions:1': {
          parent_collection: 'workflows',
          parent_id: '79704',
          noun: 'Region',
          value: null
        }
      }
    }
    expect(recordPhrase('workflows_regions', '1', noValue)).toBe('Workflow CM26-79704 · Region')
    expect(recordPhrase('workflows_regions', '582245', labels)).toBe(
      'a Region on a workflow record'
    )
    const hidden = { ...noValue, records: { 'workflows:79704': null } }
    expect(recordPhrase('workflows_regions', '1', hidden)).toBe('a Region on a workflow record')
  })

  it('leads to the parent record, or nowhere when the parent is not the reader’s', () => {
    expect(recordTarget('workflows_divisions', '472525', labels)).toEqual({
      collection: 'workflows',
      item: '79704',
      link: true
    })
    expect(recordTarget('workflows_regions', '582245', labels)).toBeNull()
    expect(
      recordTarget('workflows_divisions', '472525', {
        ...labels,
        records: { 'workflows:79704': null }
      })
    ).toBeNull()
    expect(recordTarget('workflows', '79704', labels)).toEqual({
      collection: 'workflows',
      item: '79704',
      link: false
    })
  })

  it('the readable CSV names it the same way', () => {
    const row = readableCsvRow(entry({}), {
      ...labels,
      records: { ...labels.records, 'workflows_divisions:472525': '472525' }
    })
    expect(row.record_label).toBe('Division Zone 1 on Workflow CM26-79704')
    expect(row.sentence).toBe('Rob Lee removed Division Zone 1 from Workflow CM26-79704')
  })
})

describe('link rows are not labelled as records of their own', () => {
  it('asks no record label for the link row itself', async () => {
    const junctions = buildJunctionMap([
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
      }
    ])
    const recordLabels = vi.fn(async (_u: User, refs: Array<{ collection: string; id: string }>) =>
      Object.fromEntries(refs.map((r) => [`${r.collection}:${r.id}`, `L-${r.id}`]))
    )
    const l = await activityLabelsFor(
      { id: ROB } as unknown as User,
      { refs: [{ collection: 'workflows_divisions', id: '472525' }] },
      { isAdmin: true },
      {
        canRead: async () => true,
        visibleIds: async (_u, _c, ids) => new Set(ids.map((i) => i.toLowerCase())),
        recordLabels,
        people: async () => [],
        collections: async () => [
          { collection: 'workflows', display_name: 'Workflows', singular: 'Workflow' }
        ],
        fields: async () => [],
        links: async () => [],
        junctions: async () => junctions,
        junctionRows: async () =>
          new Map([
            [
              'workflows_divisions:472525',
              { parent: '79704', target: '1', target_collection: 'divisions' }
            ]
          ])
      }
    )
    const asked = recordLabels.mock.calls.flatMap((c) => c[1].map((r) => r.collection))
    expect(asked).not.toContain('workflows_divisions')
    expect(asked.sort()).toEqual(['divisions', 'workflows'])
    expect(recordPhrase('workflows_divisions', '472525', l)).toBe(
      'Division L-1 on Workflow L-79704'
    )
  })

  it('labels past one call’s cap in further calls, one collection kept together', async () => {
    const refs = [
      ...Array.from({ length: 150 }, (_, i) => ({ collection: 'workflows', id: String(i) })),
      { collection: 'divisions', id: '1' }
    ]
    const calls: number[] = []
    const out = await labelInChunks(refs, 100, async (part) => {
      calls.push(part.length)
      return Object.fromEntries(part.map((r) => [`${r.collection}:${r.id}`, 'x']))
    })
    expect(calls).toEqual([100, 51])
    expect(Object.keys(out)).toHaveLength(151)
  })
})

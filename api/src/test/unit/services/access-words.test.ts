import { describe, expect, it } from 'vitest'
import {
  compactCount,
  describeNarrowing,
  humanCollection,
  labelledValue,
  listPhrase,
  ownerGapSentence,
  ownerSourceSentence,
  personCannotSentence,
  personCollectionSentence,
  roleChangeSentence,
  singular
} from '../../../services/access-words.js'

describe('listPhrase', () => {
  it('joins with commas and a final conjunction', () => {
    expect(listPhrase([])).toBe('')
    expect(listPhrase(['A'])).toBe('A')
    expect(listPhrase(['A', 'B'])).toBe('A and B')
    expect(listPhrase(['A', 'B', 'C'], 'or')).toBe('A, B or C')
  })
  it('caps long lists with "and N more"', () => {
    expect(listPhrase(['a', 'b', 'c', 'd'], 'and', 2)).toBe('a, b and 2 more')
  })
})

describe('singular', () => {
  it('drops a plural ending for a count of one', () => {
    expect(singular('workflows')).toBe('workflow')
    expect(singular('categories')).toBe('category')
    expect(singular('addresses')).toBe('address')
    expect(singular('status')).toBe('status')
  })
})

describe('labelledValue', () => {
  it('does not repeat a label the value already carries', () => {
    expect(labelledValue('Zone', 'Zone 4')).toBe('Zone 4')
    expect(labelledValue('Region', 'North')).toBe('Region North')
  })
})

describe('humanCollection / compactCount', () => {
  it('lower-cases a display name but keeps acronyms', () => {
    expect(humanCollection('po_lines', 'PO Lines')).toBe('PO lines')
    expect(humanCollection('inventory_request_lines')).toBe('inventory request lines')
  })
  it('compacts big numbers', () => {
    expect(compactCount(2_700_000)).toBe('2.7M')
    expect(compactCount(4271)).toBe('4,271')
    expect(compactCount(250_000)).toBe('250k')
  })
})

describe('describeNarrowing (#1889)', () => {
  it('is null when nothing shaped the answer', () => {
    expect(describeNarrowing({ rowFilter: false, scopes: [], fieldsLimited: false })).toBeNull()
  })
  it("names the person's own filter values and row rule, never a hidden count", () => {
    const s = describeNarrowing({
      rowFilter: true,
      scopes: [{ label: 'Zone', values: ['Zone 1'] }],
      fieldsLimited: true
    })
    expect(s).toBe(
      'Limited by your access — your Zone filter (Zone 1) and a row rule on your role; some fields are hidden by your role'
    )
    expect(s).not.toMatch(/\d+ (rows|records)/)
  })
  it('says when a strict dimension hides a whole collection', () => {
    expect(
      describeNarrowing({ rowFilter: false, scopes: [], fieldsLimited: false, strict: 'Zone' })
    ).toMatch(/Zone filter hides this collection entirely/)
  })
})

describe('ownerSourceSentence (#1956)', () => {
  it('explains a matched owner group with the record values', () => {
    expect(
      ownerSourceSentence('Kim', {
        kind: 'group',
        group_name: 'Zone 1 Finance',
        matched: [{ label: 'Zone', wants: 'Zone 1', record_value: 'Zone 1' }],
        via_team: 'Finance team'
      })
    ).toBe(
      'Kim owns this step through the owner group "Zone 1 Finance" — it covers records whose Zone is Zone 1, and this record\'s Zone is Zone 1. Kim is in the team "Finance team", which sits in it.'
    )
  })
  it('explains delegation, manual adds, fallback and default groups', () => {
    expect(
      ownerSourceSentence('Ana', { kind: 'delegate', for_name: 'Kim', until: 'Oct 20, 2026' })
    ).toBe('Ana stands in for Kim, who is out of office until Oct 20, 2026.')
    expect(ownerSourceSentence('Ana', { kind: 'manual', added_by: 'Rob' })).toBe(
      'Ana was added to this record by hand by Rob.'
    )
    expect(ownerSourceSentence('Ana', { kind: 'fallback', field_label: 'Requester' })).toMatch(
      /its Requester/
    )
    expect(ownerSourceSentence('Ana', { kind: 'default_group', group_name: 'Catch-all' })).toMatch(
      /fallback group "Catch-all" applies/
    )
  })
})

describe('ownerGapSentence (#2012)', () => {
  it('names the uncovered value and the closest group', () => {
    expect(
      ownerGapSentence({
        count: 38,
        noun: 'CMTS requests',
        state_label: 'Finance Review',
        dims: [{ label: 'Zone', value: 'Zone 4' }],
        uncovered: [{ label: 'Zone', value: 'Zone 4' }],
        suggestion: { group_label: 'Zone 3 Finance', matched: [], missing: ['Zone 3'] }
      })
    ).toBe(
      '38 Zone 4 CMTS requests in Finance Review match no owner group because no group covers Zone 4. The closest group is "Zone 3 Finance": it wants Zone 3.'
    )
  })
  it('falls back to "this combination" when every value is named somewhere', () => {
    expect(
      ownerGapSentence({
        count: 1,
        state_label: 'Review',
        dims: [
          { label: 'Zone', value: 'Zone 1' },
          { label: 'Type', value: 'CMTS' }
        ],
        uncovered: [],
        suggestion: null
      })
    ).toBe(
      '1 Zone 1 CMTS record in Review matches no owner group because no group covers this combination of zone and type.'
    )
  })
})

describe('roleChangeSentence (#1958)', () => {
  it('summarises gains and losses with row counts and the people affected', () => {
    expect(
      roleChangeSentence(
        'Vendor',
        [
          { collection_label: 'invoices', action: 'read', grant: true, rows: 2_700_000 },
          {
            collection_label: 'inventory request lines',
            action: 'update',
            grant: false,
            rows: null
          }
        ],
        12
      )
    ).toBe(
      'Vendor would gain read on invoices (2.7M rows) and lose update on inventory request lines. This affects 12 people.'
    )
  })
  it('says when nothing would change', () => {
    expect(
      roleChangeSentence(
        'Vendor',
        [
          {
            collection_label: 'invoices',
            action: 'read',
            grant: true,
            rows: 10,
            no_effect: 'Vendor already has read on invoices.'
          }
        ],
        3
      )
    ).toBe('These changes would not alter what Vendor can do. Vendor already has read on invoices.')
  })
})

describe('personCollectionSentence (#1959)', () => {
  it('explains a narrowed count', () => {
    expect(
      personCollectionSentence('Beth', {
        collection_label: 'workflows',
        visible: 4271,
        total: 88000,
        can_update: true,
        scopes: [{ label: 'Zone', values: ['Zone 1'] }],
        row_filter: false
      })
    ).toBe(
      'Beth sees 4,271 of 88,000 workflows because their Zone filter is Zone 1 and their role reads workflows, and can edit them.'
    )
  })
  it('says "all" when nothing narrows it, and lists what they cannot edit', () => {
    expect(
      personCollectionSentence('Beth', {
        collection_label: 'invoices',
        visible: 10,
        total: 10,
        can_update: false,
        scopes: [],
        row_filter: false
      })
    ).toBe('Beth sees all 10 invoices but cannot edit them.')
    expect(personCannotSentence('Beth', ['invoices'])).toBe('Beth cannot edit invoices.')
    expect(personCannotSentence('Beth', [])).toBeNull()
  })
})

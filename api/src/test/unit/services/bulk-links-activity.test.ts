import { describe, expect, it } from 'vitest'
import {
  type ActivityEntryInput,
  type ActivityLabels,
  groupActivity,
  renderActivitySentence
} from '../../../services/activity-sentence.js'

// A bulk to-many update (2026-11-13) writes junction rows through createOne /
// deleteOne per record: each must read as "Added X to Y", never as the link
// row's table and id, and one record's rows stay apart from the next record's.

const ROB = 'AAAAAAAA-0000-0000-0000-000000000002'
const at = '2026-11-13T15:00:00.000Z'
const entry = (over: Partial<ActivityEntryInput>): ActivityEntryInput => ({
  id: 1,
  action: 'create',
  user: ROB,
  first_name: 'Rob',
  last_name: 'Lee',
  collection: 'locations_org_codes_1',
  item: '9001',
  timestamp: at,
  ...over
})

const labels: ActivityLabels = {
  users: { [ROB]: 'Rob Lee' },
  records: { 'locations:12': 'Atlanta Hub', 'locations:13': 'Macon Depot' },
  collections: { locations: { singular: 'Location', plural: 'Locations' } },
  junctions: {
    'locations_org_codes_1:9001': {
      parent_collection: 'locations',
      parent_id: '12',
      noun: 'Additional expenditure org',
      value: 'GA-210'
    },
    'locations_org_codes_1:9002': {
      parent_collection: 'locations',
      parent_id: '13',
      noun: 'Additional expenditure org',
      value: 'GA-210'
    },
    'locations_org_codes_1:8800': {
      parent_collection: 'locations',
      parent_id: '13',
      noun: 'Additional expenditure org',
      value: 'GA-114'
    }
  }
}

describe('bulk link writes in the activity log', () => {
  it('an Add reads as added X to Y on each record', () => {
    expect(renderActivitySentence(entry({}), labels)).toBe(
      'Rob Lee added Additional expenditure org GA-210 to Location Atlanta Hub'
    )
    const s = renderActivitySentence(entry({ id: 2, item: '9002' }), labels)
    expect(s).toBe('Rob Lee added Additional expenditure org GA-210 to Location Macon Depot')
    expect(s).not.toMatch(/locations_org_codes_1|#9002/)
  })

  it('a Replace on one record folds into one change; other records stay their own lines', () => {
    const rows = [
      entry({ id: 3, item: '9002' }),
      entry({ id: 2, action: 'delete', item: '8800' }),
      entry({ id: 1, item: '9001' })
    ]
    const groups = groupActivity(rows, { labels })
    expect(groups).toHaveLength(2)
  })
})

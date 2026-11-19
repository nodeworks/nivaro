import { describe, expect, it } from 'vitest'
import type { ActivityLabels } from '../../lib/activity-sentence'
import { personInitials, recordLinkTarget } from './parts'

describe('recordLinkTarget', () => {
  const labels: ActivityLabels = {
    records: { 'workflows:81556': 'CM27-81556', 'workflows:9': null },
    junctions: {
      'workflows_divisions:482960': {
        parent_collection: 'workflows',
        parent_id: '81556',
        noun: 'Division',
        value: 'Zone 1'
      },
      'workflows_divisions:7': {
        parent_collection: 'workflows',
        parent_id: '9',
        noun: 'Division',
        value: null
      }
    }
  }

  it('a link row opens the record it is on — even after the link was removed', () => {
    for (const action of ['create', 'delete'])
      expect(
        recordLinkTarget({ collection: 'workflows_divisions', item: '482960', action }, labels)
      ).toEqual({ collection: 'workflows', item: '81556' })
  })

  it('opens nothing for a hidden parent, a deleted record or a system row', () => {
    expect(
      recordLinkTarget({ collection: 'workflows_divisions', item: '7', action: 'create' }, labels)
    ).toBeNull()
    expect(
      recordLinkTarget({ collection: 'workflows', item: '81556', action: 'delete' }, labels)
    ).toBeNull()
    expect(
      recordLinkTarget({ collection: 'workflows', item: '9', action: 'update' }, labels)
    ).toBeNull()
    expect(
      recordLinkTarget({ collection: 'nivaro_views', item: '3', action: 'update' }, labels)
    ).toBeNull()
    expect(
      recordLinkTarget({ collection: 'workflows', item: '81556', action: 'update' }, labels)
    ).toEqual({ collection: 'workflows', item: '81556' })
  })
})

describe('personInitials', () => {
  it('reads the name, not the account note in brackets', () => {
    expect(personInitials('Pat Lee (deleted user)')).toBe('PL')
    expect(personInitials('Deleted user')).toBe('DU')
    expect(personInitials('Redacted person')).toBe('RP')
    expect(personInitials('')).toBe('?')
  })
})

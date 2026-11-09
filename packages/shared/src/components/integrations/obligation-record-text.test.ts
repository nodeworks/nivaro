import { describe, expect, it } from 'vitest'
import { obligationRecordText } from './IntegrationObligationsView'

describe('obligationRecordText', () => {
  it('shows the business id, never the internal row id', () => {
    expect(
      obligationRecordText({ collection: 'workflows', item: '372822', record_label: 'PW26-81102' })
    ).toBe('PW26-81102')
    expect(obligationRecordText({ collection: 'workflows', item: '372822' })).toBe('Workflow')
  })

  it('keeps an inbound bucket key (a path and hour, not an id)', () => {
    expect(
      obligationRecordText({ collection: 'nivaro_api_logs', item: '/graphql@2026-11-08T18' })
    ).toBe('/graphql@2026-11-08T18')
  })
})

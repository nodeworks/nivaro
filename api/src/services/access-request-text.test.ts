import { describe, expect, it, vi } from 'vitest'

vi.mock('../db/index.js', () => ({
  db: () => ({
    where: () => ({ first: async () => ({ singular: 'Workflow', display_name: 'Workflows' }) })
  })
}))

import {
  accessRequestSubject,
  accessTarget,
  collectionNoun,
  reasonAboutRequester
} from './access-request-text.js'

describe('access request words for administrators (army 11)', () => {
  it('names the record by kind and business id, never the table key or a row id', async () => {
    const noun = await collectionNoun('workflows')
    expect(noun).toBe('workflow')
    expect(accessRequestSubject('David Jarosz', accessTarget(noun, '372955', 'TP26-81395'))).toBe(
      'David Jarosz is asking for access to workflow TP26-81395'
    )
    expect(accessTarget(noun, '372955', null)).toBe('a workflow')
    expect(accessTarget(noun, '372955', '372955')).toBe('a workflow')
    expect(accessTarget(noun, null, null)).toBe('workflow records')
  })

  it('retells the refusal about the requester, not to "you"', () => {
    expect(
      reasonAboutRequester(
        'This record is not visible to you: your Zone filter limits you to Zone 3, Zone 1.'
      )
    ).toBe('This record is not visible to them: their Zone filter limits them to Zone 3, Zone 1.')
    expect(reasonAboutRequester("You can't read invoices.")).toBe("They can't read invoices.")
  })
})

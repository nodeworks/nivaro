import { describe, expect, it } from 'vitest'
import { adminAccessScopeNote, shortCategoryLabel } from './ReportView'

// Army 6 D8 / M36: an admin with a User Scope is told reports are scoped.
describe('adminAccessScopeNote', () => {
  it('names the scope for an admin who carries one', () => {
    expect(adminAccessScopeNote({ admin: true, access_scope_label: 'National' })).toBe(
      '(your access scope: National)'
    )
  })

  it('says nothing for an admin without a scope, a non-admin, or no answer', () => {
    expect(adminAccessScopeNote({ admin: true, access_scope_label: null })).toBeNull()
    expect(adminAccessScopeNote({ admin: false, access_scope_label: 'Zone 1' })).toBeNull()
    expect(adminAccessScopeNote(null)).toBeNull()
  })
})

// Army 6 L22: every category on a horizontal chart is labelled, long names shortened.
describe('shortCategoryLabel', () => {
  it('keeps short labels and shortens long ones', () => {
    expect(shortCategoryLabel('CMTS')).toBe('CMTS')
    expect(shortCategoryLabel('A very long project type name here')).toBe(
      'A very long project typ…'
    )
    expect(shortCategoryLabel(null)).toBe('')
  })
})

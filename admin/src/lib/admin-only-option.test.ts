import { describe, expect, it } from 'vitest'
import { adminOnlyEditSupported, withAdminOnlyEdit } from './admin-only-option'

describe('admin-only option storage', () => {
  it('object options keep the flag next to the other keys', () => {
    expect(JSON.parse(withAdminOnlyEdit('{"nullable":false}', true) as string)).toEqual({
      nullable: false,
      admin_only_edit: true
    })
    expect(withAdminOnlyEdit(null, true)).toBe('{"admin_only_edit":true}')
  })

  it('clearing removes the key, and empty options become null', () => {
    expect(withAdminOnlyEdit('{"admin_only_edit":true}', false)).toBeNull()
    expect(withAdminOnlyEdit('{"a":1,"admin_only_edit":true}', false)).toBe('{"a":1}')
  })

  it('array (choice) options report unsupported and are never changed', () => {
    const choices = '[{"text":"A","value":"a"}]'
    expect(adminOnlyEditSupported(choices)).toBe(false)
    expect(withAdminOnlyEdit(choices, true)).toBe(choices)
    expect(adminOnlyEditSupported(null)).toBe(true)
  })
})

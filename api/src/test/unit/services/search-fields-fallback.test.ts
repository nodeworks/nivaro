import { describe, expect, it } from 'vitest'
import { fallbackSearchColumns } from '../../../services/search-fields.js'

// nivaro_users has no field metadata, so a picker search reads the table's own
// text columns. "Robert Lee" used to match Glo Dendy through the base64 bytes
// of her avatar and the JSON of her manager's directory entry (2026-10-28).

const USER_TEXT_COLS = [
  'id',
  'first_name',
  'last_name',
  'email',
  'password',
  'static_token',
  'title',
  'department',
  'company',
  'avatar',
  'preferences',
  'last_page',
  'manager_directory',
  'directory_status',
  'entra_oid',
  'office_location',
  'city',
  'employee_id',
  'external_id',
  'totp_secret'
]

describe('fallbackSearchColumns', () => {
  it('searches a person by who they are only', () => {
    expect(fallbackSearchColumns('nivaro_users', USER_TEXT_COLS)).toEqual([
      'first_name',
      'last_name',
      'email',
      'title',
      'department',
      'company',
      'office_location',
      'city',
      'employee_id'
    ])
  })

  it('never reads a secret, an image or a JSON blob on other tables', () => {
    expect(
      fallbackSearchColumns('some_table', ['name', 'notes', 'avatar', 'api_token', 'payload_json'])
    ).toEqual(['name', 'notes'])
  })

  it('falls back to the safe text columns when none of the person columns exist', () => {
    expect(fallbackSearchColumns('nivaro_users', ['nickname', 'avatar'])).toEqual(['nickname'])
  })
})

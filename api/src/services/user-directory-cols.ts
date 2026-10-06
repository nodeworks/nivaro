import type { Knex } from 'knex'

/**
 * What a NON-ADMIN may see of another user. The assignee/mention pickers that
 * every record form renders need a person directory, but the full USER_COLS set
 * carries `preferences` (headless hosts store access-request notes there), phone, and
 * the manager/delegate graph — none of which belong in a picker payload.
 */
export const DIRECTORY_USER_COLS = [
  'id',
  'first_name',
  'last_name',
  'email',
  'title',
  'department',
  'company',
  // Office location is org-visible; employee_id/city stay admin-only.
  'office_location',
  'status',
  // OOO mention warnings (#221): pickers warn inline when the person being
  // mentioned/assigned is out — availability is org-visible information.
  'is_out_of_office',
  'ooo_end',
  'delegate_id'
] as const

/**
 * The person directory's listing rules (GET /users for a non-admin, listUsers
 * `directory`): people only (no integration or placeholder account), never a
 * suspended or redacted account, never an anonymised or legacy placeholder
 * row. Kept beside the projection so every reader of people applies both.
 */
export function applyDirectoryListingRules(qb: Knex.QueryBuilder): Knex.QueryBuilder {
  return qb
    .whereNull('account_kind')
    .where((inner) => {
      inner.where('status', '!=', 'suspended').orWhereNull('status')
    })
    .where('is_redacted', false)
    .whereRaw(`email not like 'legacy-%'`)
    .whereRaw(`email not like 'Redacted\\_%' escape '\\'`)
}

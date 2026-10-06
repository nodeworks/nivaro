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

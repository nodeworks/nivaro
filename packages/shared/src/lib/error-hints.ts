/**
 * Error answers that say what to do (comprehension item 3).
 *
 * Every 4xx/5xx JSON answer keeps its `error` / `message` / `code` exactly as
 * the route sent them (clients key on them) and gains, when it has none:
 *
 *   hint        one plain sentence: what to do next
 *   fields      which fields the refusal is about (keys, for the form to mark)
 *   request_id  the id the API log, the trace and "Copy details" share
 *
 * The hint comes from the refusal's `code`, else from its status.
 *
 * BYTE-IDENTICAL TWINS: api/src/lib/error-hints.ts (the server adds the hint)
 * and packages/shared/src/lib/error-hints.ts (the client falls back to it for
 * an older server, GraphQL extensions and answers with no body). Change both —
 * api/src/test/unit/lib/error-hints.test.ts fails when they drift. Hints never
 * name tables, columns, constraints or SQL.
 */

export const ERROR_HINTS: Readonly<Record<string, string>> = {
  // ── Signing in / access ────────────────────────────────────────────────────
  NOT_SIGNED_IN: 'Sign in again, then try once more.',
  UNAUTHENTICATED: 'Sign in again, then try once more.',
  SESSION_EXPIRED: 'Your session ended. Sign in again, then try once more.',
  SESSION_ENDED: 'Your session ended. Sign in again, then try once more.',
  SESSION_REQUIRED: 'Sign in with your own account (not an API key) to do this.',
  SIGN_IN_DISABLED: 'Ask an administrator to turn sign-in back on for your role.',
  TOO_MANY_ATTEMPTS: 'Wait a few minutes before trying to sign in again.',
  FORBIDDEN: 'Ask an administrator for access if you need it.',
  ADMIN_ONLY: 'Only administrators can do this. Ask one to do it for you.',
  FIELD_FORBIDDEN: 'Leave that field out, or ask an administrator for access to it.',
  FIELD_NOT_READABLE: 'Leave that field out, or ask an administrator for access to it.',
  FILE_NOT_READABLE: 'Ask the person who shared it to share it with you, or attach your own copy.',
  NOT_WHILE_MASQUERADING: 'Stop viewing as someone else first, then try again.',
  API_KEY_SCOPE_MISSING: 'Use a key that has this scope, or ask an administrator to add it.',
  API_KEY_EXPIRED: 'Create a new key under API keys and use it instead.',
  API_KEY_INVALID: 'Check the key, or create a new one under API keys.',
  SANDBOX_KEY_READ_ONLY: 'Use a regular key to store changes, or rehearse the write with dry_run.',
  SANDBOX_KEY_DRY_RUN_ONLY:
    'Use a regular key to store changes, or rehearse the write with dry_run.',
  OAUTH_TOKEN_AUDIENCE: 'Make this change in Nivaro itself. Connected apps cannot make it.',
  CREDENTIAL_MINT_REFUSED: 'Make this change in Nivaro itself. Connected apps cannot make it.',
  MCP_TOOL_NOT_ALLOWED: 'Ask an administrator to allow this tool for the connection.',
  MCP_SCOPE_LOCKED: 'Ask an administrator to change what this connection may do.',
  SYSTEM_COLLECTION: 'System tables change only through their own admin pages.',
  CLOUD_EXTENSIONS_LOCKED: 'Extensions are managed by your hosting plan.',

  // ── Records and forms ──────────────────────────────────────────────────────
  OUT_OF_SCOPE:
    'Pick a value inside your own scope, or ask someone who covers that one to create the record.',
  EDIT_LOCKED:
    'This record is locked at its current stage. Ask its owner or an administrator to change it.',
  RECORD_LOCKED: 'Someone else is editing this record. Wait until they finish, then reload.',
  ITEM_LOCKED: 'Someone else is editing this record. Wait until they finish, then reload.',
  MIDAIR_COLLISION:
    'Someone saved this record while you were editing. Reload to see their changes, then make yours again.',
  VALIDATION_RULE_FAILED: 'Correct the highlighted field, then save again.',
  VALIDATION_FAILED: 'Correct the highlighted fields, then save again.',
  REQUIRED_VALUE_MISSING: 'Fill in the highlighted field, then save again.',
  CHANGE_REASON_REQUIRED: 'Give a reason for the change, then save again.',
  REASON_REQUIRED: 'Give a reason, then try again.',
  CHANGE_NOTE_REQUIRED: 'Add a note that says what changed, then try again.',
  PICKER_RULE_VIOLATED: 'Pick one of the values the list offers for that field, then save again.',
  LINKED_RECORD_MISSING:
    'The linked record you picked no longer exists. Pick it again from the list, then save.',
  RECORD_IN_USE: 'Remove or re-link the records that point to this one first, then delete it.',
  DUPLICATE_RECORD: 'Change the value so it is unique, or open the existing record instead.',
  VALUE_TOO_LONG: 'Shorten the value, then save again.',
  VALUE_TYPE_MISMATCH: 'Check each value fits its field (a number, a date, yes or no), then save.',
  VALUE_OUT_OF_RANGE: 'Use a smaller number, then save again.',
  DELETE_GUARDED: 'This record is protected from deletion. Sort out what the message names first.',
  TRANSITION_DUPLICATE: 'This move was already made. Reload the record to see where it is now.',
  NESTED_ROW_REFUSED: 'Fix the line the message names, then save again.',
  NESTED_ROW_NOT_OWNED: 'That line belongs to another record. Reload, then try again.',
  NESTED_ROWS_LIMIT: 'Save fewer lines at once, then add the rest in another save.',
  UNKNOWN_FIELD: 'That field does not exist on this collection. Check its name.',
  NOT_EDITABLE: 'This value cannot be changed here.',
  NOT_A_SINGLETON: 'Open the collection as a list instead.',
  CLONE_SAME_KEY: 'Give the copy a different key.',
  STATE_IN_USE: 'Move the records out of this state first, then try again.',
  STATE_IN_HISTORY: 'Records have passed through this state. Hide it instead of deleting it.',
  SLA_OVERRIDE_FORBIDDEN: 'Ask an administrator to change the deadline.',
  DELEGATE_CANNOT_SEE: 'Pick a delegate who can see these records.',
  NUDGE_TOO_SOON: 'A reminder was just sent. Wait a while before sending another.',

  // ── Not found ──────────────────────────────────────────────────────────────
  NOT_FOUND: 'It may have been deleted or moved. Reload, or search for it again.',
  COLLECTION_NOT_FOUND: 'Check the collection name, or reload. It may have been renamed.',
  COLLECTION_TABLE_MISSING: 'Ask an administrator to check this collection in the data model.',
  USER_NOT_FOUND: 'Pick the person again from the list.',
  HELP_VIDEO_NOT_FOUND: 'The video may have been archived. Search the video library.',

  // ── Changed while you worked ───────────────────────────────────────────────
  STALE: 'This changed since you previewed it. Preview again, then apply.',
  PROC_STALE:
    'Someone changed this procedure after you opened it. Reload to see their version, then make your change again.',
  PROC_DRIFTED:
    'The database copy was changed outside Nivaro. Compare the two, then keep one of them.',
  PROC_EXISTS: 'Pick another name, or adopt the existing procedure.',
  APP_MANAGED: 'Change it on the Procedures page, which keeps its history.',
  MANAGED_PROCEDURE: 'Change it on the Procedures page, which keeps its history.',
  SQL_CHECK_FIX_STALE: 'The procedure changed since the preview. Propose the fix again.',
  TUNING_STALE: 'Prove the proposal again, then apply it.',
  HELP_VIDEO_EDITS_CONFLICT:
    'Someone else edited this video. Reload to see their edits, then make yours again.',
  IDEMPOTENCY_IN_PROGRESS:
    'The same request is still running. Wait a moment, then check the result.',
  IDEMPOTENCY_KEY_REUSED: 'Send a new Idempotency-Key with a different request.',
  DUPLICATE_REQUEST: 'It was already sent. There is no need to send it again.',

  // ── Limits ─────────────────────────────────────────────────────────────────
  RATE_LIMITED: 'Too many requests in a short time. Wait a minute, then try again.',
  API_KEY_RATE_LIMITED: 'This key sent too many requests. Wait a minute, then try again.',
  MCP_CONNECTION_RATE_LIMITED: 'This connection sent too many requests. Wait a minute.',
  AI_RATE_LIMITED: 'Too many AI requests in a short time. Wait a minute, then try again.',
  AI_DAILY_TOKENS:
    "You have used today's AI allowance. Try again tomorrow, or ask an administrator to raise it.",
  BATCH_LIMIT: 'Select fewer records, then run it again in smaller batches.',
  BULK_ROWS_LIMIT: 'Select fewer records, then run it again in smaller batches.',
  BATCH_READ_LIMIT: 'Ask for fewer records at once.',
  TOO_MANY_IDS: 'Ask for fewer records at once.',
  FST_ERR_CTP_BODY_TOO_LARGE: 'Send less at once: split the upload or the change into parts.',
  QUERY_TOO_COSTLY: 'Ask for fewer fields or fewer nested records at once.',
  LIST_TIMEOUT: 'Try again, or narrow the filters.',
  HUDDLE_SCHEDULE_OPEN_LIMIT: 'Cancel or finish a scheduled huddle first.',

  // ── Filters ────────────────────────────────────────────────────────────────
  FIELD_NOT_FILTERABLE: 'Filter on a different field, or remove that filter.',
  FILTER_VALUE_TYPE: 'Check the filter value fits the field (a number, a date, yes or no).',
  FILTER_OPERATOR_TYPE: 'Pick a comparison that works for this kind of field.',
  FILTER_VALUE_NOT_A_CHOICE: 'Pick one of the field’s own choices in the filter.',
  FILTER_VALUE_IS_LABEL: 'Filter on the choice itself, not its label.',
  FILTER_VALUE_SHAPE: 'Check the filter value, then try again.',
  FILTER_VALUE_EMPTY: 'Give the filter a value, or remove it.',
  FILTER_NOT_AN_OBJECT: 'Check the filter, then try again.',
  CURSOR_SORT_UNSUPPORTED: 'Sort by a different field, or page without a cursor.',

  // ── The platform ───────────────────────────────────────────────────────────
  MAINTENANCE: 'Wait until maintenance ends, then try again.',
  SERVER_BUSY: 'Try again in a few seconds.',
  DB_UNAVAILABLE: 'The database cannot be reached right now. Try again in a minute.',
  MIGRATION_PENDING: 'An update is still being applied. Try again in a few minutes.',
  NOT_CONFIGURED: 'Ask an administrator to set this up first.',
  NOT_READY: 'This is still being set up. Try again in a few minutes.',
  AI_NOT_CONFIGURED: 'Ask an administrator to set up AI under Settings → AI Features.',
  AI_UNAVAILABLE: 'The AI service is not answering. Try again in a minute.',
  AI_BUSY: 'The AI service is busy. Try again in a minute.',
  RENDER_UNAVAILABLE: 'Rendering is not available right now. Try again in a minute.',
  RENDER_BUSY: 'Rendering is busy. Try again in a minute.',
  HELP_VIDEO_PROCESSING: 'The video is still being prepared. Try again in a few minutes.',
  HELP_VIDEO_AUTHOR_ONLY: 'Only video authors can do this. Ask an administrator to add you.',
  CHAOS_GATE: 'Fault drills are turned off on this instance.'
}

/** A hint for an answer that carries no known code. */
export const STATUS_HINTS: Readonly<Record<number, string>> = {
  400: 'Check what was entered, then try again.',
  401: 'Sign in again, then try once more.',
  403: 'Ask an administrator for access if you need it.',
  404: 'It may have been deleted or moved. Reload, or search for it again.',
  409: 'Something changed while you were working. Reload, then try again.',
  413: 'Send less at once: split the upload or the change into parts.',
  422: 'Correct the highlighted values, then try again.',
  423: 'Someone else is working on this. Wait a moment, then reload.',
  429: 'Too many requests in a short time. Wait a minute, then try again.',
  500: 'Try again. If it keeps happening, copy the details and send them to your administrator.',
  502: 'The server could not reach a service it needs. Try again in a minute.',
  503: 'The server is busy or restarting. Try again in a minute.',
  504: 'The server took too long to answer. Try again in a minute.'
}

/** The hint for a code (first) or a status. */
export function hintFor(code: unknown, status: number): string | undefined {
  if (typeof code === 'string' && ERROR_HINTS[code]) return ERROR_HINTS[code]
  if (STATUS_HINTS[status]) return STATUS_HINTS[status]
  if (status >= 500) return STATUS_HINTS[500]
  if (status >= 400) return STATUS_HINTS[400]
  return undefined
}

const isFieldKey = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z_][\w.$]{0,199}$/.test(v)

/**
 * The fields an error body is about: its own `fields` when that is a list of
 * names, else `violations[].field`, `field`, `missing`. Nested `field[0]: …`
 * messages name their field too. Empty when nothing says.
 */
export function fieldsFromBody(body: Record<string, unknown>): string[] {
  const out = new Set<string>()
  const own = body.fields
  if (Array.isArray(own)) for (const f of own) if (isFieldKey(f)) out.add(f)
  if (Array.isArray(body.violations))
    for (const v of body.violations) {
      const f = (v as { field?: unknown } | null)?.field
      if (isFieldKey(f)) out.add(f)
    }
  if (isFieldKey(body.field)) out.add(body.field)
  if (Array.isArray(body.missing)) for (const f of body.missing) if (isFieldKey(f)) out.add(f)
  const text = typeof body.error === 'string' ? body.error : ''
  const nested = /^([A-Za-z_]\w{0,99})\[[^\]]{1,40}\]: /.exec(text)
  if (nested) out.add(nested[1])
  return [...out]
}

/**
 * The body with `hint`, `fields` and `request_id` filled where it has none.
 * Returns null when there is nothing to add (the payload is sent unchanged).
 * Never replaces a key the route set.
 */
export function enrichErrorBody(
  body: Record<string, unknown>,
  status: number,
  opts: { requestId?: string | null; hint?: string; fields?: string[]; message?: string } = {}
): Record<string, unknown> | null {
  const add: Record<string, unknown> = {}
  if (opts.message) {
    // A labelled database refusal: the sentence that names the field replaces
    // the generic one, wherever the route put it.
    // (the global handler sends {error: <status word>, message}; routes {error}).
    if (typeof body.message === 'string') add.message = opts.message
    else add.error = opts.message
  }
  if (body.hint === undefined) {
    const hint = opts.hint ?? hintFor(body.code, status)
    if (hint) add.hint = hint
  }
  if (body.fields === undefined) {
    const fields = opts.fields?.length ? opts.fields : fieldsFromBody(body)
    if (fields.length) add.fields = fields
  }
  if (body.request_id === undefined && opts.requestId) add.request_id = opts.requestId
  if (Object.keys(add).length === 0) return null
  return { ...body, ...add }
}

import { db } from '../../../db/index.js'

/**
 * The Hub's offboard sign-in block, judged for ONE account (leaf module: only the database, so
 * services/users.ts, routes/users.ts, routes/scim.ts and the Hub sign-in can all import it).
 *
 * A blocked offboard run (nivaro_hub_offboards.blocked) lists its proven identity in
 * nivaro_hub_offboard_ids (kind user | email | oid). An account is blocked when:
 *  - it IS the run's Hub account (kind user), or it carries a listed Microsoft id (kind oid);
 *  - it holds a listed email, UNLESS it is a proven different person: the run names its own
 *    Hub account (hub_user_id), this account is not that one, it existed before the run started,
 *    and it carries a Microsoft id of its own that is none of the run's ids (an oid match is
 *    a kind-oid hit above). A run with no Hub account blocks EVERY holder of the email; an
 *    account with no Microsoft id, made after the run, or of unknown age stays blocked.
 *
 * Fails CLOSED: a block table that cannot be read blocks (only an install without the tables,
 * before migration 570, answers false).
 */

const TABLE = 'nivaro_hub_offboards'
const IDS = 'nivaro_hub_offboard_ids'

export interface BlockSubject {
  id?: unknown
  email?: unknown
  /** undefined = read it from the account row (by id); null = the account has none. */
  entra_oid?: unknown
  /** undefined = read it from the account row (by id); null = unknown (blocks). */
  created_at?: unknown
}

export interface BlockDeps {
  /** Reads `created_at` / `entra_oid` of an account (tests). */
  account?: (userId: string) => Promise<{ created_at?: unknown; entra_oid?: unknown } | undefined>
}

const upperId = (v: unknown) => String(v ?? '').toUpperCase()
const clean = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : '')

const ms = (v: unknown) => {
  if (v == null || v === '') return Number.NaN
  const d = v instanceof Date ? v : new Date(typeof v === 'number' ? v : String(v))
  return d.getTime()
}

async function readAccount(id: string): Promise<{ created_at?: unknown; entra_oid?: unknown }> {
  const cols = ['created_at']
  try {
    if (await db.schema.hasColumn('nivaro_users', 'entra_oid')) cols.push('entra_oid')
  } catch {
    // no oid column: the account has none
  }
  const row = (await db('nivaro_users')
    .where({ id })
    .first(...cols)) as { created_at?: unknown; entra_oid?: unknown } | undefined
  return row ?? {}
}

/** Whether the offboard block covers this account (see the header). */
export async function offboardBlocks(user: BlockSubject, deps: BlockDeps = {}): Promise<boolean> {
  const id = user.id == null || user.id === '' ? '' : upperId(user.id)
  const email = clean(user.email)
  try {
    let oid = clean(user.entra_oid)
    let created = user.created_at
    if (id && (user.entra_oid === undefined || user.created_at === undefined)) {
      const row = await (deps.account
        ? deps.account(String(user.id))
        : readAccount(String(user.id)))
      if (user.entra_oid === undefined) oid = clean(row?.entra_oid)
      if (user.created_at === undefined) created = row?.created_at
    }
    const strong = await db(`${IDS} as i`)
      .join(`${TABLE} as o`, 'o.id', 'i.offboard_id')
      .where('o.blocked', true)
      .where((w) => {
        w.where((x) => x.where('i.kind', 'user').where('i.value', id || '\u0000'))
        if (oid) w.orWhere((x) => x.where('i.kind', 'oid').where('i.value', oid))
      })
      .first('i.id')
    if (strong) return true
    if (!email) return false
    const hits = (await db(`${IDS} as i`)
      .join(`${TABLE} as o`, 'o.id', 'i.offboard_id')
      .where('o.blocked', true)
      .where('i.kind', 'email')
      .where('i.value', email)
      .select('o.hub_user_id', 'o.started_at')) as Array<{
      hub_user_id: string | null
      started_at: unknown
    }>
    if (!hits.length) return false
    // Not a proven different person: no Microsoft id of its own (an oid of the run's list was a
    // hit above), or no account at all (a new one).
    if (!oid || !id) return true
    const born = ms(created)
    for (const h of hits) {
      // A run with no Hub account of its own blocks every holder of the email.
      if (!h.hub_user_id) return true
      // The run's own person under this email.
      if (upperId(h.hub_user_id) === id) return true
      const started = ms(h.started_at)
      // Made after the offboard started, or of unknown age.
      if (!Number.isFinite(born) || !Number.isFinite(started) || born >= started) return true
    }
    return false
  } catch {
    try {
      if (!(await db.schema.hasTable(IDS))) return false
    } catch {
      // cannot tell: fail closed below
    }
    return true
  }
}

/** The refusal an account create / activate answers (describeError words it). */
export const EMAIL_OFFBOARDED = {
  code: 'EMAIL_OFFBOARDED',
  error: 'This email belongs to a person offboarded from every app.',
  hint: 'Lift their block on the Hub’s People page first if they are coming back.'
} as const

export class EmailOffboardedError extends Error {
  readonly statusCode = 409
  readonly code = EMAIL_OFFBOARDED.code
  readonly hint = EMAIL_OFFBOARDED.hint
  constructor() {
    super(EMAIL_OFFBOARDED.error)
  }
}

/**
 * THE guard every path that leaves an account ACTIVE runs (create, activate, authorize, email
 * change, SCIM, first Microsoft / SAML sign-in): judged on the row as it will be AFTER the write
 * (its next email, its id, Microsoft id and age when it already exists). Hub mode only; throws
 * EmailOffboardedError (409 EMAIL_OFFBOARDED) while an offboard block covers the account, so
 * nobody re-creates or re-activates an offboarded person to get past it. Lifting the block on
 * the Hub's People page is the way back. api/src/test/unit/services/hub-active-user-writers.guard.test.ts
 * lists every `status: 'active'` writer.
 */
export async function assertEmailNotOffboarded(
  next: BlockSubject,
  deps: BlockDeps = {}
): Promise<void> {
  const { hubModeEnabled } = await import('../mode.js')
  if (!hubModeEnabled()) return
  if (await offboardBlocks(next, deps)) throw new EmailOffboardedError()
}

/** Same judgement as a yes/no (routes that answer their own error shape, e.g. SCIM). */
export async function emailOffboarded(next: BlockSubject, deps: BlockDeps = {}): Promise<boolean> {
  try {
    await assertEmailNotOffboarded(next, deps)
    return false
  } catch (err) {
    if (err instanceof EmailOffboardedError) return true
    throw err
  }
}

/**
 * Delivery analytics — the one definition of every dimension a number can be
 * split or drilled by (#delivery-analytics).
 *
 * Every figure on the page is `SUM(CASE WHEN <conditions> …)` over a source,
 * and every drill is `COUNT(*) … WHERE <the same conditions>`. A condition is
 * always "dimension IN (values)", and a dimension is ONE deterministic SQL
 * expression with no NULL outcome (COALESCEd to a named bucket). So the rows a
 * drill returns are exactly the rows the number counted — the GROUP BY key and
 * the WHERE filter are the same expression, never two hand-written twins.
 *
 * Each dimension also carries a JS twin (`js`) used by the in-memory executor
 * the tests run fixture rows through; the SQL is what production runs.
 *
 * Pure: no database, no app imports.
 */

export type Source = 'n' | 'm' | 'x'

export const SOURCE_LABELS: Record<Source, string> = {
  n: 'Notifications',
  m: 'Email log',
  x: 'Mutes'
}

/** One condition: the dimension's value is one of `values`. */
export type Cond = [dim: string, values: string[]]

export interface EvalCtx {
  /** The window's end: "now" for every figure (acted windows close against it). */
  asof: Date
  /** #1079 — an action within this many hours of the send counts as acted. */
  actedHours: number
}

export interface Frag {
  sql: string
  bindings: unknown[]
}

export type Join = 'ru' | 'su'

/** A raw source row the memory executor evaluates (column names as stored). */
export type MemRow = Record<string, unknown> & {
  /** Fixture only: actions the recipient took on the row's record (acted). */
  _actions?: Array<{ user: string; at: string }>
}

export interface DimDef {
  key: string
  source: Source
  label: string
  /** SQL over the source alias (n / m / x) and its optional joins. */
  sql: (ctx: EvalCtx) => Frag
  joins?: Join[]
  js: (row: MemRow, ctx: EvalCtx) => string
  /** Values have readable names the summary resolves (people, roles…). */
  labelled?: 'user' | 'role' | 'category' | 'reason' | 'channel_status' | 'mail_reason' | 'template'
  /** Can be offered as a "break down by" split in a drill. */
  split?: boolean
}

const lit =
  (sql: string): ((ctx: EvalCtx) => Frag) =>
  () => ({ sql, bindings: [] })

const str = (v: unknown): string => (v == null ? '' : String(v))
const nz = (v: unknown, fallback: string): string => {
  const s = str(v)
  return s === '' ? fallback : s
}
const isoOf = (v: unknown): string => {
  const d = v instanceof Date ? v : new Date(str(v))
  return Number.isNaN(d.getTime()) ? '' : d.toISOString()
}
const parseJson = (v: unknown): Record<string, unknown> | null => {
  if (v == null || v === '') return null
  if (typeof v === 'object') return v as Record<string, unknown>
  try {
    const p = JSON.parse(String(v))
    return p && typeof p === 'object' ? (p as Record<string, unknown>) : null
  } catch {
    return null
  }
}
const pathValue = (obj: Record<string, unknown> | null, path: string[]): string | null => {
  let cur: unknown = obj
  for (const p of path) {
    if (!cur || typeof cur !== 'object') return null
    cur = (cur as Record<string, unknown>)[p]
  }
  // JSON_VALUE answers scalars only.
  if (cur == null || typeof cur === 'object') return null
  return String(cur)
}

// ── Channels ───────────────────────────────────────────────────────────────

export const CHANNELS = ['inapp', 'push', 'email', 'sms', 'teams'] as const
export type Channel = (typeof CHANNELS)[number]

export const CHANNEL_LABELS: Record<Channel, string> = {
  inapp: 'In-app',
  push: 'Push (browser + phone)',
  email: 'Email',
  sms: 'SMS',
  teams: 'Teams'
}

/** What a channel outcome means, across channels. */
export const OUTCOMES = [
  'delivered',
  'deferred',
  'skipped',
  'failed',
  'dropped',
  'not_requested',
  'not_recorded',
  'other'
] as const
export type Outcome = (typeof OUTCOMES)[number]

export const OUTCOME_LABELS: Record<Outcome, string> = {
  delivered: 'Delivered',
  deferred: 'Held for summary',
  skipped: 'Skipped',
  failed: 'Failed',
  dropped: 'Dropped',
  not_requested: 'Not requested',
  not_recorded: 'Not recorded',
  other: 'Other'
}

export const NOT_RECORDED = '(not recorded)'

/** Every status a channel writes into `nivaro_notifications.delivery` (NotificationDelivery). */
export const CHANNEL_STATUSES: Record<
  Channel,
  Array<{ status: string; outcome: Outcome; label: string }>
> = {
  inapp: [
    { status: 'delivered', outcome: 'delivered', label: 'Delivered to the inbox' },
    { status: 'skipped', outcome: 'skipped', label: 'Skipped — in-app off in their rules' }
  ],
  push: [
    { status: 'sent', outcome: 'delivered', label: 'Sent' },
    { status: 'no_subscription', outcome: 'skipped', label: 'No browser or phone registered' },
    { status: 'skipped', outcome: 'skipped', label: 'Skipped — push off in their rules' },
    { status: 'failed', outcome: 'failed', label: 'Failed to send' }
  ],
  email: [
    { status: 'sent', outcome: 'delivered', label: 'Sent' },
    { status: 'deferred', outcome: 'deferred', label: 'Held for the daily summary' },
    { status: 'dropped', outcome: 'dropped', label: 'Dropped (test mode, bounced or inactive)' },
    { status: 'failed', outcome: 'failed', label: 'Failed to send' },
    { status: 'off', outcome: 'skipped', label: 'Skipped — email off in their rules' },
    { status: 'no_address', outcome: 'skipped', label: 'Skipped — no email address' },
    { status: 'unconfigured', outcome: 'skipped', label: 'Skipped — no mail relay set up' },
    { status: 'not_requested', outcome: 'not_requested', label: 'Not requested' }
  ],
  sms: [
    { status: 'sent', outcome: 'delivered', label: 'Sent' },
    { status: 'failed', outcome: 'failed', label: 'Failed to send' },
    { status: 'skipped', outcome: 'skipped', label: 'Skipped' },
    { status: 'not_requested', outcome: 'not_requested', label: 'Not requested' }
  ],
  teams: [
    { status: 'sent', outcome: 'delivered', label: 'Sent' },
    { status: 'not_connected', outcome: 'skipped', label: 'Skipped — Teams not connected' },
    { status: 'disabled', outcome: 'skipped', label: 'Skipped — Teams bot off' },
    { status: 'skipped', outcome: 'skipped', label: 'Skipped' },
    { status: 'failed', outcome: 'failed', label: 'Failed to send' }
  ]
}

export function channelStatusLabel(channel: Channel, status: string): string {
  if (status === NOT_RECORDED) return 'Not recorded (sent before tracking)'
  return (
    CHANNEL_STATUSES[channel].find((s) => s.status === status)?.label ?? status.replace(/_/g, ' ')
  )
}

export function channelOutcome(channel: Channel, status: string): Outcome {
  if (status === NOT_RECORDED) return 'not_recorded'
  return CHANNEL_STATUSES[channel].find((s) => s.status === status)?.outcome ?? 'other'
}

const deliveryJson = 'CASE WHEN ISJSON(n.delivery) = 1 THEN n.delivery END'
const channelSql = (c: Channel) =>
  `COALESCE(NULLIF(JSON_VALUE(${deliveryJson}, '$.${c}.status'), ''), '${NOT_RECORDED}')`
const channelJs = (row: MemRow, c: Channel): string => {
  const v = pathValue(parseJson(row.delivery), [c, 'status'])
  return v == null || v === '' ? NOT_RECORDED : v
}
const sqlQuote = (s: string) => `'${s.replace(/'/g, "''")}'`

// ── Email log reasons ──────────────────────────────────────────────────────

export type MailOutcome =
  | 'delivered'
  | 'deferred'
  | 'skipped'
  | 'suppressed'
  | 'test'
  | 'dropped'
  | 'failed'
  | 'other'

export const MAIL_OUTCOME_LABELS: Record<MailOutcome, string> = {
  delivered: 'Sent',
  deferred: 'Held for summary',
  skipped: 'Skipped',
  suppressed: 'Suppressed',
  test: 'Test mode',
  dropped: 'Dropped',
  failed: 'Failed',
  other: 'Other'
}

export const MAIL_OUTCOMES: MailOutcome[] = [
  'delivered',
  'deferred',
  'skipped',
  'suppressed',
  'test',
  'dropped',
  'failed',
  'other'
]

export interface MailReason {
  key: string
  outcome: MailOutcome
  label: string
  /** What the person reading the leaf should know or do. */
  hint: string
  /** The row's status. Absent = any status (the catch-all). */
  status?: string
  /** `error LIKE` patterns (case-insensitive), any of which matches. */
  like?: string[]
  /** Matches only rows with no error text. */
  noError?: boolean
}

/**
 * Ordered: the first match wins, in SQL (a CASE) and in JS. The `skipped: …`,
 * `suppressed: …` and `caught in …` prefixes are the mail sender's own
 * conventions (services/mail.ts logSkipped / suppression rows / sendCaught).
 */
export const MAIL_REASONS: MailReason[] = [
  {
    key: 'sent',
    outcome: 'delivered',
    status: 'sent',
    label: 'Sent',
    hint: 'Handed to the mail relay.'
  },
  {
    key: 'digest',
    outcome: 'deferred',
    status: 'deferred',
    label: 'Held for the daily summary',
    hint: 'Their rules put this category in the daily summary email.'
  },
  {
    key: 'machine_account',
    outcome: 'skipped',
    status: 'dropped',
    like: ['skipped: machine account%'],
    label: 'Machine account',
    hint: 'A service or integration account — never mailed.'
  },
  {
    key: 'inactive_account',
    outcome: 'skipped',
    status: 'dropped',
    like: ['skipped: account %'],
    label: 'Suspended or removed account',
    hint: 'The person can no longer sign in, so nothing is mailed to them.'
  },
  {
    key: 'opted_out',
    outcome: 'skipped',
    status: 'dropped',
    like: ['skipped: their notification rules%'],
    label: 'Their rules turn email off',
    hint: 'The person chose no email for this kind of notification.'
  },
  {
    key: 'skipped_other',
    outcome: 'skipped',
    status: 'dropped',
    like: ['skipped:%'],
    label: 'Skipped (other)',
    hint: 'Left out on purpose — the error text says why.'
  },
  {
    key: 'suppressed',
    outcome: 'suppressed',
    status: 'dropped',
    like: ['suppressed:%'],
    label: 'Address bounced before',
    hint: 'A hard bounce put the address on the suppression list. Remove it there to mail it again.'
  },
  {
    key: 'test_caught',
    outcome: 'test',
    status: 'dropped',
    like: ['caught in %'],
    label: 'Caught by test mode',
    hint: 'Mail test mode sent it to the catch-all inbox instead.'
  },
  {
    key: 'test_mode',
    outcome: 'test',
    status: 'dropped',
    noError: true,
    label: 'Test mode, no test recipient',
    hint: 'Mail test mode is on with nobody to redirect to, so it was dropped.'
  },
  {
    key: 'dropped_other',
    outcome: 'dropped',
    status: 'dropped',
    label: 'Dropped (other)',
    hint: 'Not sent — the error text says why.'
  },
  {
    key: 'no_recipients',
    outcome: 'failed',
    status: 'failed',
    like: ['%no recipients%'],
    label: 'No recipients',
    hint: 'The message named nobody the relay would accept.'
  },
  {
    key: 'relay_unreachable',
    outcome: 'failed',
    status: 'failed',
    like: [
      '%ECONNREFUSED%',
      '%ECONNRESET%',
      '%ETIMEDOUT%',
      '%ENOTFOUND%',
      '%EHOSTUNREACH%',
      '%ESOCKET%',
      '%Greeting never received%',
      '%Connection closed%',
      '%Connection timeout%',
      '%421 %'
    ],
    label: 'Mail relay unreachable',
    hint: 'The relay did not answer or hung up. Check the relay host and the network to it.'
  },
  {
    key: 'relay_auth',
    outcome: 'failed',
    status: 'failed',
    like: ['%535%', '%Invalid login%', '%authentication%'],
    label: 'Relay refused sign-in',
    hint: 'The relay rejected the configured user or password (Settings → Email).'
  },
  {
    key: 'address_rejected',
    outcome: 'failed',
    status: 'failed',
    like: [
      '%550%',
      '%551%',
      '%553%',
      '%5.1.1%',
      '%rejected%',
      '%unknown user%',
      '%mailbox unavailable%'
    ],
    label: 'Address rejected',
    hint: 'The receiving server refused the address. Check it is spelled right and still exists.'
  },
  {
    key: 'failed_other',
    outcome: 'failed',
    status: 'failed',
    label: 'Failed (other)',
    hint: 'The relay or the receiving server refused it — the error text says why.'
  },
  { key: 'other', outcome: 'other', label: 'Other status', hint: 'A status the log does not name.' }
]

export const mailReason = (key: string): MailReason | undefined =>
  MAIL_REASONS.find((r) => r.key === key)

function mailReasonSql(): string {
  const whens = MAIL_REASONS.map((r) => {
    const parts: string[] = []
    if (r.status) parts.push(`m.status = ${sqlQuote(r.status)}`)
    if (r.like?.length)
      parts.push(`(${r.like.map((p) => `m.error LIKE ${sqlQuote(p)}`).join(' OR ')})`)
    if (r.noError) parts.push(`(m.error IS NULL OR m.error = '')`)
    const cond = parts.length ? parts.join(' AND ') : '1 = 1'
    return `WHEN ${cond} THEN ${sqlQuote(r.key)}`
  })
  return `CASE ${whens.join(' ')} END`
}

const likeRegex = (pattern: string) =>
  new RegExp(
    `^${pattern
      .split('%')
      .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/_/g, '.'))
      .join('.*')}$`,
    'is'
  )

export function mailReasonOf(row: Record<string, unknown>): string {
  const status = row.status == null ? null : String(row.status)
  const error = row.error == null ? null : String(row.error)
  for (const r of MAIL_REASONS) {
    if (r.status && status !== r.status) continue
    if (r.like?.length && !(error != null && r.like.some((p) => likeRegex(p).test(error)))) continue
    if (r.noError && !(error == null || error === '')) continue
    return r.key
  }
  return 'other'
}

// ── Private chat mail ──────────────────────────────────────────────────────

/**
 * The pseudo-collection chat notifications and chat emails carry (mentions,
 * the unread-DM email). Their text can quote a DM or a private channel.
 */
export const CHAT_COLLECTION = '__chat__'

/**
 * An email-log row whose body can quote a private conversation. Digests count too: a daily
 * summary gathers deferred notifications, chat mentions among them, so its body is withheld the
 * same way (open only through the logged compliance view).
 */
export function isPrivateMail(row: { collection?: unknown; template?: unknown }): boolean {
  const template = String(row.template ?? '')
  return (
    String(row.collection ?? '') === CHAT_COLLECTION ||
    /^chat[_-]/i.test(template) ||
    /digest/i.test(template)
  )
}

// ── Reasons a notification was sent (delivery_reason.path.kind) ────────────

export const REASON_LABELS: Record<string, string> = {
  message: 'Sent to them directly',
  subscription: 'Their subscription',
  rules: 'Their notification rules',
  integration: 'Integration event',
  support: 'Support request',
  alert: 'Alert',
  api_changelog: 'Schema change (admins)',
  'inactive-people': 'Inactive people check',
  ai_quality: 'AI quality check',
  security_alert: 'Security alert',
  watch: 'Record watch',
  owner: 'Owns the record’s step',
  mention: 'Mentioned',
  task: 'Task',
  role_default: 'Role default',
  flow: 'Automation (flow)',
  'catalog-impact': 'Catalogue change',
  [NOT_RECORDED]: 'Not recorded (sent before tracking)'
}

export const reasonLabel = (k: string) => REASON_LABELS[k] ?? k.replace(/[-_]/g, ' ')

// ── Dimensions ─────────────────────────────────────────────────────────────

const RECORD_KINDS = ['record', 'sla', 'approval', 'access_request']

/** The notification points at a business record its recipient could act on. */
const ELIGIBLE_SQL =
  "n.recipient IS NOT NULL AND n.collection IS NOT NULL AND n.collection <> '' " +
  "AND n.item IS NOT NULL AND n.item <> '' " +
  "AND n.collection NOT LIKE 'nivaro[_]%' AND n.collection NOT LIKE 'directus[_]%' " +
  "AND n.collection NOT LIKE '[_][_]%' " +
  `AND (n.kind IS NULL OR n.kind IN (${RECORD_KINDS.map(sqlQuote).join(', ')}))`

/** The recipient transitioned / commented on / completed a task on the record within the window. */
const ACTED_EXISTS =
  '(EXISTS (SELECT 1 FROM nivaro_workflow_history ah ' +
  'JOIN nivaro_workflow_instances ai ON ai.id = ah.instance ' +
  'WHERE ai.collection = n.collection AND ai.item = n.item AND ah.[user] = n.recipient ' +
  'AND ah.[timestamp] >= n.[timestamp] AND ah.[timestamp] <= DATEADD(hour, ?, n.[timestamp]) ' +
  'AND NOT (ah.from_state IS NULL AND ah.[transition] IS NULL)) ' +
  'OR EXISTS (SELECT 1 FROM nivaro_comments ac WHERE ac.collection = n.collection ' +
  'AND ac.item = n.item AND ac.[user] = n.recipient AND ac.deleted_at IS NULL ' +
  'AND ac.created_at >= n.[timestamp] AND ac.created_at <= DATEADD(hour, ?, n.[timestamp])) ' +
  'OR EXISTS (SELECT 1 FROM nivaro_tasks atk WHERE atk.collection = n.collection ' +
  'AND atk.item = n.item AND atk.completed_by = n.recipient ' +
  'AND atk.completed_at >= n.[timestamp] AND atk.completed_at <= DATEADD(hour, ?, n.[timestamp])))'

export const ACTED_VALUES = {
  acted: 'Acted',
  read_no_action: 'Read, no action',
  unread_no_action: 'Unread, no action',
  window_open: 'Window still open',
  not_record: 'Not about a record'
} as const
/** The acted denominator: record notifications whose window has closed. */
export const ACTED_ELIGIBLE = ['acted', 'read_no_action', 'unread_no_action']

function actedJs(row: MemRow, ctx: EvalCtx): string {
  const collection = str(row.collection)
  const item = str(row.item)
  const kind = row.kind == null ? null : String(row.kind)
  const eligible =
    row.recipient != null &&
    collection !== '' &&
    item !== '' &&
    !/^nivaro_/i.test(collection) &&
    !/^directus_/i.test(collection) &&
    !collection.startsWith('__') &&
    (kind == null || RECORD_KINDS.includes(kind))
  if (!eligible) return 'not_record'
  const sent = new Date(isoOf(row.timestamp)).getTime()
  const end = sent + ctx.actedHours * 3_600_000
  if (end > ctx.asof.getTime()) return 'window_open'
  const who = str(row.recipient).toUpperCase()
  const acted = (row._actions ?? []).some((a) => {
    const t = new Date(a.at).getTime()
    return a.user.toUpperCase() === who && t >= sent && t <= end
  })
  if (acted) return 'acted'
  return readJs(row, ctx) === 'unread' ? 'unread_no_action' : 'read_no_action'
}

/**
 * Read as of `asof`: a row with a read time counts as read only when it was
 * read by then (so a drill opened later counts the same rows the figure did);
 * a row without one (read before read times were stamped, or never) goes by
 * its status. One expression for the read dimension, timed and acted.
 */
const READ_SQL =
  "CASE WHEN n.read_at IS NOT NULL THEN (CASE WHEN n.read_at <= ? THEN 'read' ELSE 'unread' END) " +
  "WHEN n.status = 'inbox' THEN 'unread' ELSE 'read' END"

function readJs(row: MemRow, ctx: EvalCtx): 'read' | 'unread' {
  if (row.read_at != null)
    return new Date(isoOf(row.read_at)).getTime() <= ctx.asof.getTime() ? 'read' : 'unread'
  return row.status === 'inbox' ? 'unread' : 'read'
}

const senderTypeJs = (row: MemRow): string => {
  if (row.sender == null) {
    const k = pathValue(parseJson(row.delivery_reason), ['path', 'kind'])
    if (k === 'flow') return 'flow'
    if (k === 'integration') return 'integration'
    return 'system'
  }
  const ak = row._sender_account_kind == null ? null : String(row._sender_account_kind)
  return ak != null && ak !== 'placeholder' ? 'integration' : 'person'
}

export const SENDER_TYPE_LABELS: Record<string, string> = {
  person: 'A person',
  system: 'System',
  flow: 'Automation (flow)',
  integration: 'Integration'
}

const reasonJsonSql = 'CASE WHEN ISJSON(n.delivery_reason) = 1 THEN n.delivery_reason END'

function notificationDims(): DimDef[] {
  const base: DimDef[] = [
    {
      key: 'day',
      source: 'n',
      label: 'Day',
      sql: lit('CONVERT(char(10), n.[timestamp], 23)'),
      js: (r) => isoOf(r.timestamp).slice(0, 10)
    },
    {
      key: 'hour',
      source: 'n',
      label: 'Hour',
      sql: lit('CONVERT(char(13), n.[timestamp], 126)'),
      js: (r) => isoOf(r.timestamp).slice(0, 13)
    },
    {
      key: 'category',
      source: 'n',
      label: 'Category',
      sql: lit("COALESCE(NULLIF(n.category, ''), '(none)')"),
      js: (r) => nz(r.category, '(none)'),
      labelled: 'category',
      split: true
    },
    {
      key: 'lane',
      source: 'n',
      label: 'Lane',
      sql: lit("COALESCE(NULLIF(n.lane, ''), 'fyi')"),
      js: (r) => nz(r.lane, 'fyi'),
      split: true
    },
    {
      key: 'kind',
      source: 'n',
      label: 'Kind',
      sql: lit("COALESCE(NULLIF(n.kind, ''), '(none)')"),
      js: (r) => nz(r.kind, '(none)'),
      split: true
    },
    {
      key: 'collection',
      source: 'n',
      label: 'Collection',
      sql: lit("COALESCE(NULLIF(n.collection, ''), '(none)')"),
      js: (r) => nz(r.collection, '(none)'),
      split: true
    },
    {
      key: 'sender',
      source: 'n',
      label: 'Sender',
      sql: lit("COALESCE(CONVERT(char(36), n.sender), '__system__')"),
      js: (r) => (r.sender == null ? '__system__' : str(r.sender).toUpperCase()),
      labelled: 'user',
      split: true
    },
    {
      key: 'sender_type',
      source: 'n',
      label: 'Sender type',
      joins: ['su'],
      sql: lit(
        'CASE WHEN n.sender IS NULL THEN ' +
          `(CASE JSON_VALUE(${reasonJsonSql}, '$.path.kind') WHEN 'flow' THEN 'flow' ` +
          "WHEN 'integration' THEN 'integration' ELSE 'system' END) " +
          "WHEN su.account_kind IS NOT NULL AND su.account_kind <> 'placeholder' THEN 'integration' " +
          "ELSE 'person' END"
      ),
      js: senderTypeJs,
      split: true
    },
    {
      key: 'recipient',
      source: 'n',
      label: 'Recipient',
      sql: lit("COALESCE(CONVERT(char(36), n.recipient), '(none)')"),
      js: (r) => (r.recipient == null ? '(none)' : str(r.recipient).toUpperCase()),
      labelled: 'user',
      split: true
    },
    {
      key: 'recipient_role',
      source: 'n',
      label: 'Recipient role',
      joins: ['ru'],
      sql: lit("COALESCE(CONVERT(char(36), ru.role), '(none)')"),
      js: (r) => (r._recipient_role == null ? '(none)' : str(r._recipient_role).toUpperCase()),
      labelled: 'role',
      split: true
    },
    {
      key: 'reason',
      source: 'n',
      label: 'Why they got it',
      sql: lit(
        `COALESCE(NULLIF(JSON_VALUE(${reasonJsonSql}, '$.path.kind'), ''), '${NOT_RECORDED}')`
      ),
      js: (r) => nz(pathValue(parseJson(r.delivery_reason), ['path', 'kind']), NOT_RECORDED),
      labelled: 'reason',
      split: true
    },
    {
      key: 'read',
      source: 'n',
      label: 'Read',
      sql: (ctx) => ({ sql: READ_SQL, bindings: [ctx.asof] }),
      js: (r, ctx) => readJs(r, ctx),
      split: true
    },
    {
      key: 'timed',
      source: 'n',
      label: 'Has a read time',
      sql: (ctx) => ({
        sql: "CASE WHEN n.read_at IS NOT NULL AND n.read_at >= n.[timestamp] AND n.read_at <= ? THEN 'yes' ELSE 'no' END",
        bindings: [ctx.asof]
      }),
      js: (r, ctx) => {
        if (r.read_at == null) return 'no'
        const at = new Date(isoOf(r.read_at)).getTime()
        return at >= new Date(isoOf(r.timestamp)).getTime() && at <= ctx.asof.getTime()
          ? 'yes'
          : 'no'
      }
    },
    {
      key: 'acted',
      source: 'n',
      label: 'Acted',
      sql: (ctx) => ({
        sql:
          `CASE WHEN NOT (${ELIGIBLE_SQL}) THEN 'not_record' ` +
          "WHEN DATEADD(hour, ?, n.[timestamp]) > ? THEN 'window_open' " +
          `WHEN ${ACTED_EXISTS} THEN 'acted' ` +
          `WHEN (${READ_SQL}) = 'unread' THEN 'unread_no_action' ELSE 'read_no_action' END`,
        bindings: [
          ctx.actedHours,
          ctx.asof,
          ctx.actedHours,
          ctx.actedHours,
          ctx.actedHours,
          ctx.asof
        ]
      }),
      js: actedJs,
      split: true
    }
  ]
  for (const c of CHANNELS) {
    base.push({
      key: `ch.${c}`,
      source: 'n',
      label: `${CHANNEL_LABELS[c]} status`,
      sql: lit(channelSql(c)),
      js: (r) => channelJs(r, c),
      labelled: 'channel_status',
      split: true
    })
    const byOutcome = new Map<Outcome, string[]>()
    for (const s of CHANNEL_STATUSES[c])
      byOutcome.set(s.outcome, [...(byOutcome.get(s.outcome) ?? []), s.status])
    const whens = [...byOutcome.entries()]
      .map(([o, ss]) => `WHEN ${channelSql(c)} IN (${ss.map(sqlQuote).join(', ')}) THEN '${o}'`)
      .join(' ')
    base.push({
      key: `ch_outcome.${c}`,
      source: 'n',
      label: `${CHANNEL_LABELS[c]} outcome`,
      sql: lit(
        `CASE WHEN ${channelSql(c)} = '${NOT_RECORDED}' THEN 'not_recorded' ${whens} ELSE 'other' END`
      ),
      js: (r) => channelOutcome(c, channelJs(r, c)),
      split: true
    })
    base.push({
      key: `ch_attempted.${c}`,
      source: 'n',
      label: `${CHANNEL_LABELS[c]} attempted`,
      sql: lit(
        `CASE WHEN ${channelSql(c)} IN ('not_requested', '${NOT_RECORDED}') THEN 'no' ELSE 'yes' END`
      ),
      js: (r) => {
        const s = channelJs(r, c)
        return s === 'not_requested' || s === NOT_RECORDED ? 'no' : 'yes'
      }
    })
  }
  return base
}

function mailDims(features: Features): DimDef[] {
  const out: DimDef[] = [
    {
      key: 'day',
      source: 'm',
      label: 'Day',
      sql: lit('CONVERT(char(10), m.created_at, 23)'),
      js: (r) => isoOf(r.created_at).slice(0, 10)
    },
    {
      key: 'hour',
      source: 'm',
      label: 'Hour',
      sql: lit('CONVERT(char(13), m.created_at, 126)'),
      js: (r) => isoOf(r.created_at).slice(0, 13)
    },
    {
      key: 'status',
      source: 'm',
      label: 'Status',
      sql: lit("COALESCE(NULLIF(m.status, ''), '(none)')"),
      js: (r) => nz(r.status, '(none)'),
      split: true
    },
    {
      key: 'template',
      source: 'm',
      label: 'Template',
      sql: lit("COALESCE(NULLIF(m.template, ''), '(untemplated)')"),
      js: (r) => nz(r.template, '(untemplated)'),
      labelled: 'template',
      split: true
    },
    {
      key: 'collection',
      source: 'm',
      label: 'Collection',
      sql: lit("COALESCE(NULLIF(m.collection, ''), '(none)')"),
      js: (r) => nz(r.collection, '(none)'),
      split: true
    },
    {
      key: 'reason',
      source: 'm',
      label: 'Reason',
      sql: lit(mailReasonSql()),
      js: (r) => mailReasonOf(r),
      labelled: 'mail_reason',
      split: true
    },
    {
      key: 'outcome',
      source: 'm',
      label: 'Outcome',
      sql: lit(
        `CASE ${mailReasonSql()} ${MAIL_REASONS.map((r) => `WHEN ${sqlQuote(r.key)} THEN ${sqlQuote(r.outcome)}`).join(' ')} END`
      ),
      js: (r) => mailReason(mailReasonOf(r))?.outcome ?? 'other',
      split: true
    },
    {
      key: 'to',
      source: 'm',
      label: 'Recipient address',
      sql: lit("LOWER(LTRIM(RTRIM(COALESCE(m.[to], ''))))"),
      js: (r) => str(r.to).trim().toLowerCase(),
      split: true
    }
  ]
  if (features.resend) {
    out.push({
      key: 'resend',
      source: 'm',
      label: 'Resend',
      sql: lit("CASE WHEN m.resend_of IS NOT NULL THEN 'yes' ELSE 'no' END"),
      js: (r) => (r.resend_of != null ? 'yes' : 'no'),
      split: true
    })
  }
  return out
}

function muteDims(): DimDef[] {
  return [
    {
      key: 'collection',
      source: 'x',
      label: 'Collection',
      sql: lit("COALESCE(NULLIF(x.collection, ''), '(none)')"),
      js: (r) => nz(r.collection, '(none)'),
      split: true
    },
    {
      key: 'user',
      source: 'x',
      label: 'Person',
      sql: lit("COALESCE(CONVERT(char(36), x.[user]), '(none)')"),
      js: (r) => (r.user == null ? '(none)' : str(r.user).toUpperCase()),
      labelled: 'user',
      split: true
    }
  ]
}

export interface Features {
  /** nivaro_mail_log.resend_of exists (migration 534, the resend-trail branch). */
  resend: boolean
}

export interface Registry {
  dims: Record<Source, Map<string, DimDef>>
  features: Features
}

export function buildRegistry(features: Features): Registry {
  const toMap = (list: DimDef[]) => new Map(list.map((d) => [d.key, d]))
  return {
    dims: {
      n: toMap(notificationDims()),
      m: toMap(mailDims(features)),
      x: toMap(muteDims())
    },
    features
  }
}

export function dimOf(reg: Registry, source: Source, key: string): DimDef {
  const d = reg.dims[source].get(key)
  if (!d) throw Object.assign(new Error(`Unknown dimension ${key}`), { statusCode: 400 })
  return d
}

// ── Windows ────────────────────────────────────────────────────────────────

export const WINDOW_PRESETS = {
  '24h': 24 * 3_600_000,
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
  '90d': 90 * 86_400_000
} as const
export type WindowPreset = keyof typeof WINDOW_PRESETS

export const MAX_WINDOW_MS = 366 * 86_400_000

export interface Window {
  from: Date
  to: Date
  /** The previous period of the same length, ending where this one starts. */
  prevFrom: Date
  prevTo: Date
  /** Hourly buckets for windows of two days or less. */
  bucket: 'day' | 'hour'
  preset: WindowPreset | 'custom'
}

const badRequest = (msg: string) => Object.assign(new Error(msg), { statusCode: 400 })

/**
 * The window a request names, in UTC. A preset ends at `now`; `custom` takes
 * `from`/`to` (ISO, or YYYY-MM-DD = that UTC day; a bare `to` date runs to the
 * end of that day). Drills always pass the absolute `from`/`to` the summary
 * resolved, so they count exactly the rows the summary did.
 */
export function resolveWindow(
  q: { window?: string; from?: string; to?: string },
  now: Date = new Date()
): Window {
  const preset = (q.window ?? (q.from || q.to ? 'custom' : '7d')) as WindowPreset | 'custom'
  let from: Date
  let to: Date
  if (preset === 'custom') {
    const parse = (s: string | undefined, end: boolean): Date | null => {
      if (!s) return null
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        const d = new Date(`${s}T00:00:00.000Z`)
        return end ? new Date(d.getTime() + 86_400_000) : d
      }
      const d = new Date(s)
      return Number.isNaN(d.getTime()) ? null : d
    }
    const f = parse(q.from, false)
    const t = parse(q.to, true) ?? now
    if (!f) throw badRequest('A custom window needs a from date')
    if (Number.isNaN(t.getTime())) throw badRequest('Bad to date')
    from = f
    to = t
  } else {
    const span = WINDOW_PRESETS[preset as WindowPreset]
    if (!span) throw badRequest(`Unknown window ${preset}`)
    to = now
    from = new Date(now.getTime() - span)
  }
  if (to.getTime() <= from.getTime()) throw badRequest('The window ends before it starts')
  if (to.getTime() - from.getTime() > MAX_WINDOW_MS)
    throw badRequest('Pick a window of a year or less')
  const span = to.getTime() - from.getTime()
  return {
    from,
    to,
    prevFrom: new Date(from.getTime() - span),
    prevTo: from,
    bucket: span <= 2 * 86_400_000 ? 'hour' : 'day',
    preset
  }
}

/** Every hour / day bucket key a window covers, oldest first (so empty buckets still draw). */
export function bucketKeys(w: Pick<Window, 'from' | 'to' | 'bucket'>): string[] {
  const out: string[] = []
  const step = w.bucket === 'hour' ? 3_600_000 : 86_400_000
  const start = new Date(w.from)
  if (w.bucket === 'hour') start.setUTCMinutes(0, 0, 0)
  else start.setUTCHours(0, 0, 0, 0)
  for (let t = start.getTime(); t < w.to.getTime(); t += step) {
    const iso = new Date(t).toISOString()
    out.push(w.bucket === 'hour' ? iso.slice(0, 13) : iso.slice(0, 10))
    if (out.length > 9000) break
  }
  return out
}

// ── Filters and conditions from a request ──────────────────────────────────

/** Page-level filters (the bar at the top) and which source dimension each one narrows. */
export const PAGE_FILTERS = ['category', 'collection', 'sender', 'channel'] as const
export type PageFilter = (typeof PAGE_FILTERS)[number]

export interface PageFilters {
  category?: string
  collection?: string
  sender?: string
  channel?: Channel
}

/** The conditions the page filters add to a source. Filters a source has no column for add nothing. */
const isUuid = (s: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)

export function pageFilterConds(source: Source, f: PageFilters): Cond[] {
  const out: Cond[] = []
  if (source === 'n') {
    if (f.category) out.push(['category', [f.category]])
    if (f.collection) out.push(['collection', [f.collection]])
    // Person ids are stored upper-case; the `__system__` bucket stays as it is.
    if (f.sender) out.push(['sender', [isUuid(f.sender) ? f.sender.toUpperCase() : f.sender]])
    if (f.channel) out.push([`ch_attempted.${f.channel}`, ['yes']])
  } else if (source === 'm') {
    if (f.collection) out.push(['collection', [f.collection]])
  }
  return out
}

/** Which page filters a source ignores (the page says so instead of silently showing everything). */
export function ignoredFilters(source: Source, f: PageFilters): PageFilter[] {
  const used: PageFilter[] =
    source === 'n'
      ? ['category', 'collection', 'sender', 'channel']
      : source === 'm'
        ? ['collection']
        : []
  return PAGE_FILTERS.filter((k) => f[k] && !used.includes(k)).filter(
    (k) => !(source === 'm' && k === 'channel' && f.channel === 'email')
  )
}

export function parsePageFilters(q: Record<string, unknown>): PageFilters {
  const one = (k: string) => {
    const v = q[k]
    const s = Array.isArray(v) ? v[0] : v
    return typeof s === 'string' && s.trim() !== '' ? s.trim().slice(0, 300) : undefined
  }
  const channel = one('channel')
  if (channel && !(CHANNELS as readonly string[]).includes(channel))
    throw badRequest(`Unknown channel ${channel}`)
  return {
    category: one('category'),
    collection: one('collection'),
    sender: one('sender'),
    channel: channel as Channel | undefined
  }
}

/**
 * Drill conditions from the URL: `w=<dim>:<v1>,<v2>` (repeatable). Each value
 * is URI-encoded on its own, so a value may hold a comma or a colon.
 */
export function parseConds(reg: Registry, source: Source, raw: unknown): Cond[] {
  const list = raw == null ? [] : Array.isArray(raw) ? raw : [raw]
  if (list.length > 12) throw badRequest('Too many conditions')
  return list.map((entry) => {
    const s = String(entry)
    const i = s.indexOf(':')
    if (i <= 0) throw badRequest(`Bad condition ${s.slice(0, 80)}`)
    const dim = s.slice(0, i)
    dimOf(reg, source, dim)
    const values = s
      .slice(i + 1)
      .split(',')
      .map((v) => {
        try {
          return decodeURIComponent(v)
        } catch {
          throw badRequest('Bad condition value')
        }
      })
    if (values.length === 0 || values.length > 50) throw badRequest('Bad condition values')
    return [dim, values] as Cond
  })
}

export const encodeCond = ([dim, values]: Cond): string =>
  `${dim}:${values.map(encodeURIComponent).join(',')}`

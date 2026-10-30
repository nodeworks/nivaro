/**
 * Activity sentences — one readable line per audit-trail entry.
 *
 *   "Pat moved PO 4471 from Draft to Approved"
 *   "Sam deleted 3 invoices"
 *   "Rob as Pat changed Vendor on Workflow 85607"
 *   "Pat updated 40 workflows: Status → On Hold"
 *
 * Pure (no imports, no I/O): the Activity page, the activity detail page, the
 * record history panels and the email digest all render through it. Labels
 * come from POST /api/activity/labels (records read AS THE READER — a record
 * the reader cannot see is "a record you can't see"; people by name;
 * collection / field / choice labels); until they arrive the sentence falls
 * back to the collection name and the stored id.
 *
 * TWIN FILE: packages/shared/src/lib/activity-sentence.ts and
 * api/src/services/activity-sentence.ts must stay byte-identical (the API
 * cannot import packages/shared; an API test compares the two files).
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export type ActivityActorKind =
  | 'person'
  | 'view_as'
  | 'api_key'
  | 'mcp'
  | 'import'
  | 'flow'
  | 'cron'
  | 'system'

/** Who really did it (nivaro_activity.actor, migration 516; derived for older rows). */
export interface ActivityActor {
  kind: ActivityActorKind
  /** view_as: the admin; api_key: the key id; mcp: the connection; import: the definition
   *  key; flow: the flow id; cron: the job id. */
  id?: string | null
  name?: string | null
  /** The person the actor acted for / as (view_as: the person being viewed as). */
  on_behalf_of?: string | null
}

/** A linked approval decision the read API joined onto the entry. */
export interface ActivityApproval {
  decision: string
  comment?: string | null
  chain?: string | null
  step?: string | number | null
  collection?: string | null
  item?: string | null
}

/** The "why" the read API joins onto an entry (#5): reason, note, approval. */
export interface ActivityWhy {
  /** The change reason a person gave for a create / update / delete. */
  reason?: string | null
  /** What a person wrote on a transition. */
  note?: string | null
  approval?: ActivityApproval | null
}

/** A field change the read API summarised from the revision delta. */
export interface ActivityChange {
  field: string
  value?: unknown
}

export interface ActivityEntryInput {
  id?: number | string | null
  action: string | null
  /** The person (nivaro_activity.user); revisions call it user_id. */
  user?: string | null
  user_id?: string | null
  first_name?: string | null
  last_name?: string | null
  user_email?: string | null
  collection?: string | null
  item?: string | number | null
  comment?: string | null
  timestamp?: string | Date | null
  origin?: string | null
  chain_parent?: string | null
  auth_method?: string | null
  api_key_id?: number | string | null
  api_key_name?: string | null
  mcp_conn?: string | null
  via_app?: string | null
  via_agent?: string | null
  group_key?: string | null
  /** Stored JSON (string) or the parsed object. */
  actor?: ActivityActor | string | null
  changes?: ActivityChange[] | null
  changed_fields?: string[] | null
  delta?: Record<string, unknown> | null
  /** A pipeline event folded into a record's history (services/revisions.ts). */
  event?: {
    kind: 'transition' | 'start'
    from_label?: string | null
    to_label?: string | null
    transition_label?: string | null
    source?: string | null
    on_behalf_of?: { id: string; name: string | null } | null
    addendum?: { id: string; title: string | null } | null
  } | null
  why?: ActivityWhy | null
}

export interface CollectionNames {
  singular?: string | null
  plural?: string | null
}

/** What POST /api/activity/labels answers (plus the reader's time zone, if any). */
export interface ActivityLabels {
  /** Person id (any case) → display name. */
  users?: Record<string, string>
  /** `collection:id` → label; null = the reader cannot see that record. */
  records?: Record<string, string | null>
  /** Collection → names (or a bare display name). */
  collections?: Record<string, CollectionNames | string>
  /** `collection.field` → field label. */
  fields?: Record<string, string>
  /** `collection.field` → stored value → choice label. */
  choices?: Record<string, Record<string, string>>
  /** `collection.field` → the collection a link field points at. Link values are ids, so a
   *  sentence names the field, never the raw value. */
  links?: Record<string, string>
  /** IANA zone dates in values render in; unset = the runtime's own zone. */
  timeZone?: string | null
}

export const HIDDEN_RECORD = "a record you can't see"

// ─── Small helpers ──────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ACRONYMS: Record<string, string> = {
  ai: 'AI',
  api: 'API',
  csv: 'CSV',
  db: 'database',
  erp: 'ERP',
  id: 'ID',
  ip: 'IP',
  mcp: 'MCP',
  oauth: 'OAuth',
  o2m: 'related rows',
  pdf: 'PDF',
  scim: 'SCIM',
  sla: 'SLA',
  sql: 'SQL',
  sso: 'SSO',
  totp: 'two-step sign-in',
  ui: 'UI',
  url: 'URL',
  xlsx: 'Excel'
}

function text(v: unknown): string {
  return v == null ? '' : String(v).trim()
}

function upperKey(id: unknown): string {
  return text(id).toUpperCase()
}

/** "traffic-map_kill.sql" → ["traffic", "map", "kill", "sql"]. */
function words(s: string): string[] {
  return s
    .split(/[\s_.:-]+/)
    .map((w) => w.trim())
    .filter(Boolean)
}

function wordOut(w: string): string {
  const lower = w.toLowerCase()
  return ACRONYMS[lower] ?? lower
}

/** "session_replay-share" → "Session replay share". */
export function readableTitle(raw: string): string {
  const out = words(raw).map(wordOut).join(' ')
  return out ? out.charAt(0).toUpperCase() + out.slice(1) : ''
}

function titleWords(s: string): string {
  return words(s)
    .map((w) => ACRONYMS[w.toLowerCase()] ?? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ')
}

function singularize(word: string): string {
  if (/ies$/i.test(word)) return word.replace(/ies$/i, (m) => (m === 'IES' ? 'Y' : 'y'))
  if (/(ss|us|is)$/i.test(word)) return word
  if (/(x|ch|sh|ss|us)es$/i.test(word)) return word.replace(/es$/i, '')
  if (/s$/i.test(word) && word.length > 1) return word.slice(0, -1)
  return word
}

function pluralize(word: string): string {
  if (/[^aeiou]y$/i.test(word)) return word.replace(/y$/i, (m) => (m === 'Y' ? 'IES' : 'ies'))
  if (/(s|x|z|ch|sh)$/i.test(word) && !/^[A-Z0-9]+$/.test(word)) return `${word}es`
  return `${word}s`
}

/** Lower-cases words for use mid-sentence, leaving acronyms ("PO", "API key"). */
function midSentence(s: string): string {
  return s
    .split(' ')
    .map((w) => (/[A-Z][^ ]*[A-Z]/.test(w) ? w : w.toLowerCase()))
    .join(' ')
}

const SYSTEM_NOUNS: Record<string, string> = {
  nivaro_activity: 'Activity entry',
  nivaro_api_keys: 'API key',
  nivaro_approval_chains: 'Approval chain',
  nivaro_approval_instances: 'Approval',
  nivaro_collections: 'Collection',
  nivaro_comments: 'Comment',
  nivaro_custom_queries: 'Custom query',
  nivaro_dashboards: 'Dashboard',
  nivaro_external_apis: 'External API',
  nivaro_fields: 'Field',
  nivaro_files: 'File',
  nivaro_flows: 'Flow',
  nivaro_import_definitions: 'Import definition',
  nivaro_import_queue: 'Import run',
  nivaro_permissions: 'Permission',
  nivaro_policies: 'Policy',
  nivaro_relations: 'Relation',
  nivaro_roles: 'Role',
  nivaro_settings: 'Settings',
  nivaro_tasks: 'Task',
  nivaro_users: 'User',
  nivaro_webhooks: 'Webhook',
  nivaro_workflow_templates: 'Pipeline'
}

/** The singular + plural nouns of a collection ("Purchase Order" / "Purchase Orders"). */
export function collectionNouns(
  collection: string | null | undefined,
  labels?: ActivityLabels | null
): { singular: string; plural: string } {
  const c = text(collection)
  if (!c) return { singular: 'Record', plural: 'Records' }
  const known = labels?.collections?.[c]
  const given: CollectionNames = typeof known === 'string' ? { plural: known } : (known ?? {})
  const display = text(given.plural)
  const sing = text(given.singular)
  if (sing || display) {
    const singular = sing || lastWord(display, singularize)
    const plural = display && display !== singular ? display : lastWord(singular, pluralize)
    return { singular, plural }
  }
  const sys = SYSTEM_NOUNS[c]
  if (sys) return { singular: sys, plural: sys === 'Settings' ? sys : lastWord(sys, pluralize) }
  const base = titleWords(c.replace(/^(nivaro|directus)_/, '')) || 'Record'
  const singular = lastWord(base, singularize)
  return { singular, plural: lastWord(singular, pluralize) }
}

function lastWord(phrase: string, fn: (w: string) => string): string {
  const parts = phrase.split(' ')
  parts[parts.length - 1] = fn(parts[parts.length - 1] ?? '')
  return parts.join(' ')
}

/** "3 invoices", "1 invoice", "40 workflows". */
export function countNoun(
  n: number,
  collection: string | null | undefined,
  labels?: ActivityLabels | null
): string {
  const { singular, plural } = collectionNouns(collection, labels)
  return `${n} ${midSentence(n === 1 ? singular : plural)}`
}

function personName(entry: ActivityEntryInput, labels?: ActivityLabels | null): string | null {
  const id = entry.user ?? entry.user_id ?? null
  const fromLabels = id ? lookupUser(id, labels) : null
  if (fromLabels) return fromLabels
  const full = [text(entry.first_name), text(entry.last_name)].filter(Boolean).join(' ')
  if (full) return full
  if (text(entry.user_email)) return text(entry.user_email)
  return null
}

function lookupUser(id: string | null | undefined, labels?: ActivityLabels | null): string | null {
  if (!id || !labels?.users) return null
  const users = labels.users
  return text(users[id] ?? users[upperKey(id)] ?? users[text(id).toLowerCase()]) || null
}

// ─── Actor ──────────────────────────────────────────────────────────────────

const ACTOR_KINDS = new Set<string>([
  'person',
  'view_as',
  'api_key',
  'mcp',
  'import',
  'flow',
  'cron',
  'system'
])

/** The stored actor column (JSON text or object) → an actor, else null. */
export function parseActor(raw: unknown): ActivityActor | null {
  if (raw == null || raw === '') return null
  let v: unknown = raw
  if (typeof raw === 'string') {
    try {
      v = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const kind = text(o.kind)
  if (!ACTOR_KINDS.has(kind)) return null
  return {
    kind: kind as ActivityActorKind,
    id: o.id == null ? null : String(o.id),
    name: o.name == null ? null : String(o.name),
    on_behalf_of: o.on_behalf_of == null ? null : String(o.on_behalf_of)
  }
}

/**
 * Who really did it. The stored actor (migration 516) wins; older rows derive
 * it from the columns they carry: the MCP connection, the auth method + API
 * key, the event-chain step they were written under (cron / import run / flow
 * run), an import provenance note, the origin, else the person, else "system".
 */
export function actorOf(entry: ActivityEntryInput): ActivityActor {
  const stored = parseActor(entry.actor)
  if (stored) return stored
  const person = entry.user ?? entry.user_id ?? null
  if (text(entry.mcp_conn) || text(entry.via_app) || text(entry.via_agent))
    return {
      kind: 'mcp',
      id: text(entry.mcp_conn) || null,
      name: text(entry.via_app) || text(entry.via_agent) || null,
      on_behalf_of: person
    }
  const auth = text(entry.auth_method)
  if (auth === 'masquerade') return { kind: 'view_as', id: null, name: null, on_behalf_of: person }
  if ((auth === 'api_key' || auth === 'key_sim') && entry.api_key_id != null)
    return {
      kind: 'api_key',
      id: String(entry.api_key_id),
      name: text(entry.api_key_name) || null,
      on_behalf_of: person
    }
  const parent = text(entry.chain_parent)
  const step = /^(cron|import_run|flow_run):(.+)$/.exec(parent)
  if (step) {
    const kind = step[1] === 'cron' ? 'cron' : step[1] === 'import_run' ? 'import' : 'flow'
    return { kind, id: step[2], name: kind === 'cron' ? step[2] : null, on_behalf_of: person }
  }
  const prov = /^import:([^:]+)/i.exec(text(entry.comment))
  if (prov) return { kind: 'import', id: prov[1], name: prov[1], on_behalf_of: person }
  if (text(entry.origin) === 'import')
    return { kind: 'import', id: null, name: null, on_behalf_of: person }
  if (person) return { kind: 'person', id: person, name: null, on_behalf_of: null }
  return {
    kind: 'system',
    id: null,
    name: text(entry.origin) === 'integration' ? 'An integration' : null
  }
}

/** "Pat", "Rob as Pat", "API key “Partner sync”", "Claude for Pat", "Import “Vendors”". */
export function actorName(entry: ActivityEntryInput, labels?: ActivityLabels | null): string {
  const a = actorOf(entry)
  const person = personName(entry, labels)
  const behalf = lookupUser(a.on_behalf_of, labels) ?? person
  switch (a.kind) {
    case 'person':
      return person ?? 'Someone'
    case 'view_as': {
      const admin = lookupUser(a.id, labels) ?? text(a.name) ?? ''
      return `${admin || 'An administrator'} as ${behalf ?? 'someone'}`
    }
    case 'api_key':
      return `API key “${text(a.name) || (a.id ? `#${a.id}` : 'unnamed')}”`
    case 'mcp': {
      const app = text(a.name).replace(/^via\s+/i, '') || 'An assistant'
      return behalf ? `${app} for ${behalf}` : app
    }
    case 'import':
      return text(a.name) ? `Import “${text(a.name)}”` : 'An import'
    case 'flow':
      return text(a.name) ? `Flow “${text(a.name)}”` : 'A flow'
    case 'cron':
      return text(a.name || a.id) ? `Scheduled job “${text(a.name || a.id)}”` : 'A scheduled job'
    default:
      return text(a.name) || 'System'
  }
}

// ─── Records, fields, values ────────────────────────────────────────────────

/** "PO 4471", "Workflow 85607", "a record you can't see"; null when the entry names none. */
export function recordPhrase(
  collection: string | null | undefined,
  item: string | number | null | undefined,
  labels?: ActivityLabels | null
): string | null {
  const id = text(item)
  if (!id || !text(collection)) return null
  const key = `${collection}:${id}`
  const records = labels?.records
  const { singular } = collectionNouns(collection, labels)
  if (records && key in records) {
    const label = records[key]
    if (label == null) return HIDDEN_RECORD
    const l = text(label)
    if (!l) return singular
    return l.toLowerCase().startsWith(singular.toLowerCase()) ? l : `${singular} ${l}`
  }
  if (UUID_RE.test(id)) return `a ${midSentence(singular)}`
  return `${singular} ${id}`
}

export function fieldLabel(
  collection: string | null | undefined,
  field: string,
  labels?: ActivityLabels | null
): string {
  const own = labels?.fields?.[`${collection ?? ''}.${field}`]
  return text(own) || titleWords(field)
}

/** "Vendor", "Vendor and Status", "Vendor, Status and 2 other fields". */
export function fieldList(
  collection: string | null | undefined,
  fields: string[],
  labels?: ActivityLabels | null
): string {
  const names = [...new Set(fields)].map((f) => fieldLabel(collection, f, labels))
  if (names.length === 0) return ''
  if (names.length === 1) return names[0]
  if (names.length <= 3) return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} other fields`
}

/** A choice's display text: legacy Directus `$t:key` labels humanised (choiceLabel()'s rule). */
export function choiceText(raw: string | null | undefined): string {
  const s = String(raw ?? '')
  if (!s.startsWith('$t:')) return s
  return titleWords(s.slice(3).replace(/-/g, '_'))
}

const ISO_DT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/
const ISO_D = /^\d{4}-\d{2}-\d{2}$/

/** A changed value as a reader sees it: choice label, date in their zone, short text. */
export function valueText(
  collection: string | null | undefined,
  field: string,
  value: unknown,
  labels?: ActivityLabels | null
): string {
  if (value == null || value === '') return 'empty'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (typeof value === 'object')
    return Array.isArray(value) ? `${value.length} items` : 'a new value'
  const s = String(value)
  const choice = labels?.choices?.[`${collection ?? ''}.${field}`]?.[s]
  if (choice) return choiceText(choice)
  if (ISO_D.test(s)) return s
  if (ISO_DT.test(s)) {
    const d = new Date(s)
    if (!Number.isNaN(d.getTime())) {
      try {
        return d.toLocaleString(undefined, {
          dateStyle: 'medium',
          timeStyle: 'short',
          ...(labels?.timeZone ? { timeZone: labels.timeZone } : {})
        })
      } catch {
        return d.toLocaleString()
      }
    }
  }
  return s.length > 60 ? `${s.slice(0, 57)}…` : s
}

/**
 * True when a changed value can be shown in a sentence: the labels name the field (they
 * arrived) and it is not a link (an id means nothing to a reader).
 */
export function valueShowable(
  collection: string | null | undefined,
  field: string,
  value: unknown,
  labels?: ActivityLabels | null
): boolean {
  const key = `${collection ?? ''}.${field}`
  if (!labels?.fields || !(key in labels.fields)) return false
  if (labels.links?.[key]) return false
  if (value != null && typeof value === 'object') return false
  return true
}

function changedFieldsOf(entry: ActivityEntryInput): string[] {
  if (entry.changes?.length) return entry.changes.map((c) => c.field)
  if (entry.changed_fields?.length) return entry.changed_fields
  if (entry.delta && typeof entry.delta === 'object') return Object.keys(entry.delta)
  return []
}

// ─── Transition comments ────────────────────────────────────────────────────

export interface ParsedTransition {
  from: string | null
  to: string | null
  via: string | null
  note: string | null
  auto: boolean
}

/**
 * The comment the transition writers store (services/record-transition.ts,
 * workflow-mutations.ts, bulk-actions.ts, routes/items.ts bulk-transition):
 *   `Draft → Approved via Approve — "looks good"`
 *   `→ On Hold via Hold (bulk: Hold all) — "waiting on vendor"`
 *   `bulk: Approve → Approved`
 *   `auto-transition "Escalate"`
 */
export function parseTransitionComment(comment: string | null | undefined): ParsedTransition {
  const out: ParsedTransition = { from: null, to: null, via: null, note: null, auto: false }
  let s = text(comment)
  if (!s) return out
  const auto = /^auto(?:-transition)?:?\s*"?([^"]*)"?$/i.exec(s)
  if (auto) {
    out.auto = true
    out.via = text(auto[1]) || null
    return out
  }
  const note = /\s+—\s+"([\s\S]*)"\s*$/.exec(s)
  if (note) {
    out.note = note[1]
    s = s.slice(0, note.index)
  }
  s = s.replace(/\s*\(bulk:[^)]*\)\s*$/i, '')
  const bulk = /^bulk:\s*(.+?)\s*→\s*(.+)$/i.exec(s)
  if (bulk) {
    out.via = bulk[1]
    out.to = bulk[2]
    return out
  }
  const arrow = /^(.*?)\s*→\s*(.+?)(?:\s+via\s+(.+))?$/.exec(s)
  if (arrow) {
    const from = text(arrow[1])
    out.from = from && from !== 'Start' ? from : null
    out.to = text(arrow[2]) || null
    out.via = text(arrow[3]) || null
  }
  return out
}

// ─── Action vocabulary ──────────────────────────────────────────────────────

/**
 * Routine reads hidden together with `read` ("Hide record views" / "Show reads"): opening a
 * record, a notification, a report or a saved view. Compliance reads (an admin reading a DM,
 * a person's day, an assistant's memory) are NOT routine and always show.
 */
export const ROUTINE_READ_ACTIONS = ['read', 'notification-read', 'report-view', 'saved-view-open']

/** `exclude_actions` with every routine read added when it names `read`. */
export function withRoutineReads(excluded: string[]): string[] {
  return excluded.includes('read') ? [...new Set([...excluded, ...ROUTINE_READ_ACTIONS])] : excluded
}

const VERBS: Record<string, string> = {
  ack: 'acknowledged',
  acknowledge: 'acknowledged',
  acquire: 'took',
  add: 'added',
  adopt: 'adopted',
  apply: 'applied',
  approve: 'approved',
  approved: 'approved',
  archive: 'archived',
  arm: 'armed',
  assign: 'assigned',
  build: 'built',
  bump: 'bumped',
  cancel: 'cancelled',
  change: 'changed',
  cleanup: 'cleaned up',
  clear: 'cleared',
  clone: 'cloned',
  complete: 'completed',
  copy: 'copied',
  create: 'created',
  created: 'created',
  decline: 'declined',
  declined: 'declined',
  delete: 'deleted',
  deploy: 'deployed',
  deprovision: 'deprovisioned',
  disable: 'disabled',
  disarm: 'disarmed',
  dismiss: 'dismissed',
  download: 'downloaded',
  draft: 'drafted',
  drop: 'dropped',
  edit: 'edited',
  enable: 'enabled',
  end: 'ended',
  execute: 'ran',
  export: 'exported',
  fail: 'failed',
  failed: 'failed',
  fix: 'fixed',
  generate: 'generated',
  grant: 'granted',
  granted: 'granted',
  hold: 'put on hold',
  import: 'imported',
  install: 'installed',
  issue: 'issued',
  join: 'joined',
  kill: 'stopped',
  link: 'linked',
  merge: 'merged',
  move: 'moved',
  name: 'named',
  nullify: 'cleared',
  offboard: 'offboarded',
  open: 'opened',
  override: 'overrode',
  pause: 'paused',
  place: 'placed',
  preview: 'previewed',
  promote: 'promoted',
  provision: 'provisioned',
  prune: 'pruned',
  publish: 'published',
  purge: 'purged',
  queue: 'queued',
  read: 'read',
  reassign: 'reassigned',
  recalc: 'recalculated',
  redact: 'redacted',
  regenerate: 'regenerated',
  rehearse: 'rehearsed',
  reject: 'rejected',
  rejected: 'rejected',
  release: 'released',
  remediate: 'fixed',
  remove: 'removed',
  rename: 'renamed',
  render: 'rendered',
  reorder: 'reordered',
  replay: 'replayed',
  reply: 'replied to',
  request: 'requested',
  requeue: 'requeued',
  rerun: 're-ran',
  resend: 'resent',
  reset: 'reset',
  resolve: 'resolved',
  restore: 'restored',
  resume: 'resumed',
  retry: 'retried',
  revert: 'reverted',
  review: 'reviewed',
  revoke: 'revoked',
  rollback: 'rolled back',
  run: 'ran',
  save: 'saved',
  schedule: 'scheduled',
  send: 'sent',
  set: 'set',
  share: 'shared',
  skip: 'skipped',
  snooze: 'snoozed',
  split: 'split',
  start: 'started',
  stop: 'stopped',
  subscribe: 'subscribed to',
  suspend: 'suspended',
  swap: 'swapped',
  sync: 'synced',
  toggle: 'toggled',
  undo: 'undid',
  uninstall: 'uninstalled',
  unpublish: 'unpublished',
  unsubscribe: 'unsubscribed from',
  update: 'updated',
  updated: 'updated',
  upload: 'uploaded',
  view: 'viewed'
}

/** Verbs whose object reads with "a" ("created a share link"); the rest take "the". */
const INDEFINITE = new Set([
  'add',
  'build',
  'create',
  'created',
  'draft',
  'generate',
  'issue',
  'place',
  'queue',
  'request',
  'save',
  'schedule',
  'upload'
])

export interface ActionParts {
  verb: string | null
  /** The past-tense verb ("cancelled"). */
  past: string | null
  /** What the action is about, mid-sentence ("layout schedule"). */
  noun: string
}

/** "layout-schedule-cancel" → {verb: 'cancel', past: 'cancelled', noun: 'layout schedule'}. */
export function actionParts(action: string): ActionParts {
  const w = words(action).map((x) => x.toLowerCase())
  if (w.length === 0) return { verb: null, past: null, noun: '' }
  const last = w[w.length - 1]
  let idx = -1
  if (VERBS[last]) idx = w.length - 1
  else if (VERBS[w[0]]) idx = 0
  else for (let i = w.length - 1; i >= 0; i--) if (VERBS[w[i]]) idx = i
  if (idx < 0) return { verb: null, past: null, noun: w.map(wordOut).join(' ') }
  const verb = w[idx]
  const nounWords = [...w.slice(0, idx), ...w.slice(idx + 1)]
  return { verb, past: VERBS[verb], noun: nounWords.map(wordOut).join(' ') }
}

function article(verb: string | null, noun: string): string {
  if (!noun) return ''
  if (/s$/.test(noun) && !/ss$/.test(noun)) return noun
  if (verb && INDEFINITE.has(verb)) return `${/^[aeiou]/i.test(noun) ? 'an' : 'a'} ${noun}`
  return `the ${noun}`
}

function exportSummary(comment: string): { rows: number | null; format: string | null } {
  const rows = /(\d[\d,]*)\s+rows?/i.exec(comment)
  const format = /^\s*(csv|xlsx|json|pdf|xml)\b/i.exec(comment)
  return {
    rows: rows ? Number(rows[1].replace(/,/g, '')) : null,
    format: format ? (ACRONYMS[format[1].toLowerCase()] ?? format[1].toUpperCase()) : null
  }
}

// ─── The sentence ───────────────────────────────────────────────────────────

const TRANSITION_ACTIONS = new Set(['transition', 'pipeline-transition'])

/** The sentence without the actor ("moved PO 4471 from Draft to Approved"). */
export function activityPredicate(
  entry: ActivityEntryInput,
  labels?: ActivityLabels | null
): string {
  const action = text(entry.action)
  const collection = entry.collection ?? null
  const record = recordPhrase(collection, entry.item, labels)
  const nouns = collectionNouns(collection, labels)
  const aNoun = `${/^[aeiou]/i.test(nouns.singular) ? 'an' : 'a'} ${midSentence(nouns.singular)}`
  const comment = text(entry.comment)
  const on = record ? ` on ${record}` : ''

  // Pipeline events folded into a record's history carry their states.
  if (entry.event?.kind === 'start') {
    const st = text(entry.event.to_label)
    return `started ${record ?? 'the pipeline'}${st ? ` in ${st}` : ''}`
  }
  if (entry.event?.kind === 'transition' || TRANSITION_ACTIONS.has(action)) {
    const t = entry.event
      ? {
          from: text(entry.event.from_label) || null,
          to: text(entry.event.to_label) || null,
          via: text(entry.event.transition_label) || null
        }
      : parseTransitionComment(comment)
    const target = entry.event?.addendum
      ? `Addendum “${text(entry.event.addendum.title) || 'Untitled'}”`
      : (record ?? 'a record')
    if (t.from && t.to) return `moved ${target} from ${t.from} to ${t.to}`
    if (t.to) return `moved ${target} to ${t.to}`
    if (t.via) return `ran “${t.via}” on ${target}`
    return `moved ${target}`
  }

  switch (action) {
    case 'create':
    case 'o2m-create':
      if (action === 'o2m-create') return `added related rows${on}`
      if (collection === 'nivaro_settings') return 'saved the settings'
      return `created ${record ?? aNoun}`
    case 'update':
    case 'o2m-update': {
      if (action === 'o2m-update') return `changed related rows${on}`
      const fields = changedFieldsOf(entry)
      if (collection === 'nivaro_settings')
        return fields.length
          ? `changed the ${fieldList(collection, fields, labels)} setting${fields.length === 1 ? '' : 's'}`
          : 'changed the settings'
      if (collection === 'nivaro_approval_instances' && entry.why?.approval) {
        const ap = entry.why.approval
        const target = recordPhrase(ap.collection, ap.item, labels)
        const past = VERBS[text(ap.decision).toLowerCase()] ?? text(ap.decision).toLowerCase()
        return `${past || 'decided on'} ${target ?? record ?? 'an approval'}${ap.chain ? ` (${ap.chain})` : ''}`
      }
      if (fields.length) {
        const one = entry.changes?.length === 1 ? entry.changes[0] : null
        if (one && 'value' in one && valueShowable(collection, one.field, one.value, labels))
          return `set ${fieldLabel(collection, one.field, labels)} to ${valueText(collection, one.field, one.value, labels)}${on}`
        return `changed ${fieldList(collection, fields, labels)}${on}`
      }
      return `updated ${record ?? aNoun}`
    }
    case 'delete':
    case 'o2m-delete':
      if (action === 'o2m-delete') return `removed related rows${on}`
      return `deleted ${record ?? aNoun}`
    case 'restore':
      return `restored ${record ?? aNoun}`
    case 'pipeline-start': {
      const st = /initial state:\s*(.+)$/i.exec(comment)
      return `started ${record ?? 'the pipeline'}${st ? ` in ${st[1]}` : ''}`
    }
    case 'login':
      return 'signed in'
    case 'logout':
      return 'signed out'
    case 'login-refused':
      return 'was refused sign-in'
    case 'export': {
      const ex = exportSummary(comment)
      const what =
        ex.rows != null ? countNoun(ex.rows, collection, labels) : midSentence(nouns.plural)
      return `exported ${what}${ex.format ? ` to ${ex.format}` : ''}`
    }
    case 'masquerade-start':
      return `started viewing as ${userRecord(entry, labels, comment)}`
    case 'masquerade-stop':
      return `stopped viewing as ${userRecord(entry, labels, comment)}`
    case 'token.generate':
      return `generated a static token for ${userRecord(entry, labels, '')}`
    case 'token.revoke':
      return `revoked the static token of ${userRecord(entry, labels, '')}`
    case 'api_key_created':
      return `created ${record && record !== HIDDEN_RECORD ? record : 'an API key'}`
    case 'api_key_revoked':
      return `revoked ${record && record !== HIDDEN_RECORD ? record : 'an API key'}`
    case 'api_key_deleted':
      return `deleted ${record && record !== HIDDEN_RECORD ? record : 'an API key'}`
    case 'api_key_simulate':
      return `tested requests as ${record && record !== HIDDEN_RECORD ? record : 'an API key'}`
    case 'set_role':
      return `changed the role of ${userRecord(entry, labels, '')}`
    case 'bulk-write':
    case 'bulk-action-execute': {
      const n = /(\d+)\s+(?:item|row)/i.exec(comment)
      const what = n ? countNoun(Number(n[1]), collection, labels) : midSentence(nouns.plural)
      const named =
        action === 'bulk-action-execute' ? /^(.+?)\s*\([^)]*\)\s+on\s/.exec(comment) : null
      return named ? `ran “${named[1]}” on ${what}` : `changed ${what} in bulk`
    }
    case 'import-create':
    case 'import-queue':
      return `started an import into ${midSentence(nouns.plural)}`
    case 'import-complete':
      return `finished an import into ${midSentence(nouns.plural)}${comment ? ` (${comment})` : ''}`
    case 'import-failed':
      return `had an import into ${midSentence(nouns.plural)} fail`
    case 'comment':
      return `commented${on}`
    case 'picker-exclude':
      return `hid ${record ?? aNoun} from pickers`
    case 'picker-include':
      return `showed ${record ?? aNoun} in pickers again`
    case 'ai-brief':
      return 'asked the assistant for a brief'
    case 'config-epoch':
      return 'changed the configuration'
    case 'config-snapshot-store':
      return 'saved a configuration restore point'
    case 'config-snapshot-export':
      return 'downloaded a configuration snapshot'
    default:
      break
  }

  // Everything else reads from the action's own words.
  if (!action) return `did something${on}`
  const parts = actionParts(action)
  if (/settings$/.test(parts.noun) && !parts.verb) return `changed the ${parts.noun}`
  if (!parts.past) return `recorded “${readableTitle(action)}”${on}`
  const nounMatchesRecord =
    record &&
    parts.noun &&
    midSentence(nouns.singular).toLowerCase().includes(parts.noun.toLowerCase())
  if (nounMatchesRecord) return `${parts.past} ${record}`
  if (!parts.noun) return `${parts.past} ${record ?? 'something'}`
  return `${parts.past} ${article(parts.verb, parts.noun)}${on}`
}

function userRecord(
  entry: ActivityEntryInput,
  labels: ActivityLabels | null | undefined,
  fallback: string
): string {
  const id = text(entry.item)
  const name = lookupUser(id, labels) ?? (fallback || null)
  if (name) return name
  const rec =
    entry.collection === 'nivaro_users' ? recordPhrase(entry.collection, entry.item, labels) : null
  return rec && !UUID_RE.test(id) ? rec : 'someone'
}

/** One readable sentence for one activity entry. */
export function renderActivitySentence(
  entry: ActivityEntryInput,
  labels?: ActivityLabels | null
): string {
  return `${actorName(entry, labels)} ${activityPredicate(entry, labels)}`
}

/** The entry's "why" as short lines: change reason, transition note, approval. */
export function activityWhy(entry: ActivityEntryInput): {
  reason: string | null
  note: string | null
  approval: string | null
} {
  const action = text(entry.action)
  const comment = text(entry.comment)
  let reason = text(entry.why?.reason) || null
  let note = text(entry.why?.note) || null
  if (!note && TRANSITION_ACTIONS.has(action) && !entry.event)
    note = parseTransitionComment(comment).note
  if (!note && entry.event?.kind === 'transition' && comment) note = comment
  if (
    !reason &&
    (action === 'create' || action === 'update' || action === 'delete') &&
    comment &&
    !/^import:/i.test(comment)
  )
    reason = comment
  const ap = entry.why?.approval
  const approval = ap
    ? `${titleWords(text(ap.decision)) || 'Decided'}${ap.chain ? ` · ${ap.chain}` : ''}${ap.step != null && ap.step !== '' ? ` · step ${ap.step}` : ''}${text(ap.comment) ? ` — “${text(ap.comment)}”` : ''}`
    : null
  return { reason, note, approval }
}

// ─── Bursts ─────────────────────────────────────────────────────────────────

export interface ActivityGroup<T extends ActivityEntryInput = ActivityEntryInput> {
  /** Stable React key. */
  key: string
  /** Newest first, as given. */
  entries: T[]
  /** 'group_key' = written by one bulk action / import / flow / cron / batch / MCP request;
   *  'time' = same actor + collection + action within the window (rows before 516). */
  by: 'group_key' | 'time' | null
}

export const BURST_WINDOW_MS = 60_000

function tsMs(e: ActivityEntryInput): number {
  if (!e.timestamp) return Number.NaN
  return new Date(e.timestamp).getTime()
}

function actorKey(e: ActivityEntryInput): string {
  const a = actorOf(e)
  return `${a.kind}|${text(a.id)}|${text(e.user ?? e.user_id).toUpperCase()}`
}

/** A bulk summary row ("bulk-action-execute on 40 items") rides its burst as its head. */
function isSummaryRow(e: ActivityEntryInput): boolean {
  const a = text(e.action)
  return !text(e.item) && (a.startsWith('bulk-') || a === 'import-complete')
}

/**
 * Folds consecutive entries of one burst into one group. Entries sharing a
 * group_key always fold; entries without one fold when the same actor did the
 * same action on the same collection, each within `windowMs` of the previous
 * (rows from before migration 516). Order is kept; singles are groups of one.
 */
export function groupActivity<T extends ActivityEntryInput>(
  entries: T[],
  opts: { windowMs?: number } = {}
): ActivityGroup<T>[] {
  const windowMs = opts.windowMs ?? BURST_WINDOW_MS
  const out: ActivityGroup<T>[] = []
  for (const e of entries) {
    const cur = out[out.length - 1]
    const prev = cur?.entries[cur.entries.length - 1]
    const gk = text(e.group_key)
    if (cur && prev) {
      const pgk = text(prev.group_key)
      if (gk && gk === pgk) {
        cur.entries.push(e)
        cur.by = 'group_key'
        continue
      }
      if (
        !gk &&
        !pgk &&
        cur.by !== 'group_key' &&
        text(e.action) === text(prev.action) &&
        text(e.collection) === text(prev.collection) &&
        text(e.collection) !== '' &&
        actorKey(e) === actorKey(prev) &&
        Math.abs(tsMs(prev) - tsMs(e)) <= windowMs
      ) {
        cur.entries.push(e)
        cur.by = 'time'
        continue
      }
    }
    out.push({ key: `${gk || 'e'}:${e.id ?? out.length}`, entries: [e], by: null })
  }
  return out
}

/** "Pat updated 40 workflows: Status → On Hold"; a group of one reads as its entry. */
export function renderActivityGroupSentence(
  entries: ActivityEntryInput[],
  labels?: ActivityLabels | null
): string {
  if (entries.length === 0) return ''
  const members = entries.filter((e) => !isSummaryRow(e))
  const head = members[0] ?? entries[0]
  if (members.length <= 1) return renderActivitySentence(head, labels)
  const who = actorName(head, labels)
  const collections = new Set(members.map((e) => text(e.collection)))
  const collection = collections.size === 1 ? (head.collection ?? null) : null
  const items = new Set(members.map((e) => text(e.item)))
  const n = items.size > 1 ? items.size : members.length
  const what = collection
    ? items.size === 1 && text(head.item)
      ? (recordPhrase(collection, head.item, labels) ?? countNoun(n, collection, labels))
      : countNoun(n, collection, labels)
    : `${n} records`
  const times = items.size === 1 && members.length > 1 ? ` ${members.length} times` : ''
  const actions = new Set(
    members.map((e) => (TRANSITION_ACTIONS.has(text(e.action)) ? 'transition' : text(e.action)))
  )
  if (actions.size !== 1) return `${who} made ${members.length} changes to ${what}`
  const action = [...actions][0]
  if (action === 'transition') {
    const tos = new Set(
      members.map((e) => text(e.event?.to_label ?? parseTransitionComment(e.comment).to))
    )
    const to = tos.size === 1 ? [...tos][0] : ''
    return `${who} moved ${what}${to ? ` to ${to}` : ''}${times}`
  }
  if (action === 'update') {
    const summary = sharedChange(members, collection, labels)
    return `${who} updated ${what}${times}${summary ? `: ${summary}` : ''}`
  }
  if (action === 'create') return `${who} created ${what}`
  if (action === 'delete') return `${who} deleted ${what}`
  if (action === 'picker-exclude') return `${who} hid ${what} from pickers${times}`
  if (action === 'picker-include') return `${who} showed ${what} in pickers again${times}`
  const parts = actionParts(action)
  if (parts.past)
    return `${who} ${parts.past} ${what}${parts.noun && !midSentence(collectionNouns(collection, labels).plural).toLowerCase().includes(parts.noun) ? ` (${parts.noun})` : ''}${times}`
  return `${who} recorded “${readableTitle(action)}” on ${what}`
}

/** "Status → On Hold" when every member set the same field(s) to the same value. */
function sharedChange(
  members: ActivityEntryInput[],
  collection: string | null,
  labels?: ActivityLabels | null
): string {
  const first = members[0]?.changes ?? null
  if (!first?.length) {
    const fieldSets = members.map((m) => changedFieldsOf(m).sort().join(','))
    if (fieldSets[0] && fieldSets.every((f) => f === fieldSets[0]))
      return fieldList(collection, fieldSets[0].split(','), labels)
    return ''
  }
  const sig = (m: ActivityEntryInput) =>
    JSON.stringify((m.changes ?? []).map((c) => [c.field, c.value ?? null]).sort())
  const same = members.every((m) => sig(m) === sig(members[0]))
  if (
    same &&
    first.length <= 2 &&
    first.every((c) => valueShowable(collection, c.field, c.value, labels))
  )
    return first
      .map(
        (c) =>
          `${fieldLabel(collection, c.field, labels)} → ${valueText(collection, c.field, c.value, labels)}`
      )
      .join(', ')
  const fields = new Set(members.flatMap((m) => (m.changes ?? []).map((c) => c.field)))
  return fieldList(collection, [...fields], labels)
}

// ─── What to ask the labels endpoint for ────────────────────────────────────

export interface ActivityLabelsRequest {
  refs: Array<{ collection: string; id: string }>
  users: string[]
  fields: Array<{ collection: string; field: string }>
  collections: string[]
}

/** The records, people, fields and collections a page of entries names (deduplicated). */
export function activityLabelRefs(entries: ActivityEntryInput[]): ActivityLabelsRequest {
  const refs = new Map<string, { collection: string; id: string }>()
  const users = new Set<string>()
  const fields = new Map<string, { collection: string; field: string }>()
  const collections = new Set<string>()
  const addRef = (c: unknown, id: unknown) => {
    const cc = text(c)
    const ii = text(id)
    if (!cc || !ii) return
    collections.add(cc)
    if (cc === 'nivaro_users') users.add(ii)
    refs.set(`${cc}:${ii}`, { collection: cc, id: ii })
  }
  for (const e of entries) {
    const person = text(e.user ?? e.user_id)
    if (person) users.add(person)
    const a = actorOf(e)
    if (a.kind === 'view_as' && a.id) users.add(a.id)
    if (a.on_behalf_of) users.add(a.on_behalf_of)
    if (text(e.collection)) collections.add(text(e.collection))
    addRef(e.collection, e.item)
    if (e.why?.approval) addRef(e.why.approval.collection, e.why.approval.item)
    for (const f of changedFieldsOf(e)) {
      const c = text(e.collection)
      if (c) fields.set(`${c}.${f}`, { collection: c, field: f })
    }
  }
  return {
    refs: [...refs.values()],
    users: [...users],
    fields: [...fields.values()],
    collections: [...collections]
  }
}

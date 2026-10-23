import { db } from '../db/index.js'
import {
  type ActionWritePath,
  actionWriteReason,
  actionWriter,
  createAsAction,
  updateAsAction
} from './action-writes.js'
import { logActivity } from './activity.js'
import { protectTemplatePlaceholders, scrubSecretsFor, secretPathsOf } from './body-secrets.js'
import { chainFields } from './chain-columns.js'
import { changeSignature, type PushWhen, payloadSignature, shouldPush } from './erp-push-gate.js'
import { requesterInsertFields } from './erp-requester-columns.js'
import type { RequestedVia } from './erp-submission-status.js'
import { callExternalApi } from './external-apis.js'
import {
  type ObligationTrigger,
  openObligationForTrigger,
  resolveObligation,
  skipReason
} from './integration-obligations.js'
import {
  addCalendarDays,
  calendarDay,
  payloadLiquid,
  registerPayloadFilters
} from './payload-filters.js'
import {
  getTemplate,
  PayloadTemplateError,
  registeredDef,
  renderPayloadTemplate
} from './payload-templates/index.js'
import { announceRecordAspect } from './record-events.js'
import { type ConditionRule, evalConditionRule } from './workflow-conditions.js'

// ─── Transition actions ──────────────────────────────────────────────────────
// nivaro_workflow_transitions.actions is a JSON array executed AFTER a
// transition lands (manual or auto). Currently supported type:
//
//   {
//     "type": "erp_submit",
//     "external_api": <id | name>,          // nivaro external API config
//     "endpoint_path": "/customers/x/orders",
//     "guard": [ {field, op, value}, ... ], // condition rules on the record; all must pass or the action is skipped
//     "context": {                           // extra template context: one filtered list query per key
//       "lines": { "collection": "order_lines", "filter": { "order": "$id" }, "limit": 500 }
//     },
//     "payload_template": "{ ...liquid producing JSON... }",
//     "payload_template_key": "mwf-workflow-status",  // a saved payload template; wins over payload_template
//     "on_success": { "set": { "order_number": "{{ response.salesOrderNumber }}" } },
//     "on_failure": { "set": { "erp_status": "error" } }
//   }
//
// Actions run sequentially; each template renders with
//   { record, context.<key>, state, responses (prior actions), response (last) }.
// Every attempt is logged to nivaro_erp_submissions (status + payload + error)
// so the /erp-submissions retry/inspect UI covers these automatically.
// Failures never block the transition — they surface via the submission row.
//
// Liquid filters added for scheduling-style payloads:
//   add_days: N            — date + N days
//   iso_date               — format as yyyy-MM-dd
//   at_least_days_out: N   — max(date, today + N days)
//   next_open_day          — skip weekends and nivaro_blackout_dates forward
//   pad_start: N, 'c'      — left-pad to N chars with 'c' (default '0')

interface ContextQueryDef {
  collection: string
  filter?: Record<string, unknown>
  /** Restrict rows to those with a matching junction row — expresses
   *  "lines whose <m2m alias> includes X" (e.g. materials whose warehouses
   *  junction carries a specific warehouse id). */
  junction_filter?: { junction: string; fk_to_row: string; field: string; value: unknown }
  limit?: number
  /** Per-row M2O expansion: fk column → {collection, fields}; merged as <fk>_data. */
  expand?: Record<string, { collection: string; fields: string[] }>
  /** Order rows: column name, '-' prefix for desc (e.g. '-id' = newest first). */
  sort?: string
}

export interface TransitionActionDef {
  type: string
  external_api: number | string
  endpoint_path: string
  method?: string
  guard?: ConditionRule[]
  context?: Record<string, ContextQueryDef>
  payload_template: string
  /** A saved payload template (services/payload-templates) — wins over the inline
   *  `payload_template`. Its `lookups` (context query defs) join `context`; the
   *  action's own keys win. */
  payload_template_key?: string
  on_success?: { set?: Record<string, string> }
  /** Child-row writebacks applied after a successful call — e.g. autofill each
   *  submitted line's order id from the returned order number. `only_empty`
   *  updates only rows where the target field is still null (user-entered
   *  values are never overwritten); `junction_filter` narrows to rows with a
   *  matching junction row (same shape as context junction_filter). */
  on_success_children?: Array<{
    collection: string
    fk_field: string
    field: string
    value_template: string
    only_empty?: boolean
    junction_filter?: { junction: string; fk_to_row: string; field: string; value: unknown }
  }>
  on_failure?: { set?: Record<string, string> }
  /** Detect 200-with-error-body responses (some ERPs do this) — when a `when`
   *  rule matches, the submission records as FAILED with the mined message
   *  even though the HTTP status was 2xx. See ResponseErrorConfig. */
  response_error?: ResponseErrorConfig
  response_success?: ResponseSuccessConfig
  /** Blocking actions run BEFORE the transition mutation; a failure ABORTS
   *  the transition (422 to the caller) instead of landing the new state —
   *  e.g. an order submission whose order number the next state requires. */
  blocking?: boolean
  /** Skip the action silently when this context key resolved to zero rows —
   *  for pushes that only apply when a related record exists (e.g. an external link row). */
  skip_when_empty?: string
  /** Skip silently unless AT LEAST ONE dotted ref resolves non-empty — refs
   *  walk {record, context} (e.g. ['context.ext_link.0.ext_id', 'record.ext_id']
   *  = "has an external id from either source"). OR-semantics counterpart to guard's
   *  AND rules. */
  skip_unless_any?: string[]
  /** When to push at all — see services/erp-push-gate.ts. Absent = every
   *  transition, which is how this behaved before the option existed. */
  push_when?: PushWhen
  // create_record type only:
  target_collection?: string
  skip_if_exists?: { match_field: string; value_template: string }
  link_field?: string
  /** Also write a nivaro_record_links row source → created record (skipped
   *  when the same link already exists), so the pair shows under Related
   *  Records on both sides. link_type must be one of routes/record-links
   *  LINK_TYPES; defaults to 'relates to'. */
  record_link?: { link_type?: string; note?: string }
  m2m?: Record<
    string,
    {
      junction_collection: string
      parent_field: string
      related_field: string
      values_template: string
    }
  >
}

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

const engine = payloadLiquid()

export { addCalendarDays, calendarDay, registerPayloadFilters }

function parseActions(raw: string | null | undefined): TransitionActionDef[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as TransitionActionDef[]) : []
  } catch {
    return []
  }
}

/**
 * Pick a single action off a transition's `actions` JSON for a targeted
 * re-run (the Integrations console "resend this push" affordance) — only a
 * push (`erp_submit`) may be re-run this way; `create_record` mutates other
 * collections and re-running it on demand would duplicate those rows.
 */
export function pickRerunAction(
  actionsJson: string | null,
  index: number
): { ok: true; action: { type: string } & Record<string, unknown> } | { ok: false; error: string } {
  const all = parseActions(actionsJson) as unknown as Array<
    { type: string } & Record<string, unknown>
  >
  const a = Number.isInteger(index) ? all[index] : undefined
  if (!a) return { ok: false, error: 'No action at that position' }
  if (a.type !== 'erp_submit')
    return { ok: false, error: 'Only push (erp_submit) actions can be re-run' }
  return { ok: true, action: a }
}

/**
 * Shape-level validation for the rerun route's body — pure, so it's unit
 * testable without a request/reply. `pickRerunAction` still owns the
 * SEMANTIC checks (is this index in range, is it a push action) once the
 * transition's actions are known; this only rejects a malformed body before
 * any of that lookup work happens.
 */
export function validateRerunBody(
  body: { transition_id?: unknown; action_index?: unknown } | null | undefined
): { ok: true; transitionId: string; actionIndex: number } | { ok: false; error: string } {
  const transitionId = body?.transition_id
  if (typeof transitionId !== 'string' || transitionId.trim() === '') {
    return { ok: false, error: 'transition_id is required' }
  }
  const actionIndex = body?.action_index
  if (typeof actionIndex !== 'number' || !Number.isInteger(actionIndex)) {
    return { ok: false, error: 'action_index must be an integer' }
  }
  return { ok: true, transitionId, actionIndex }
}

// nivaro_users is the ONLY system collection (nivaro_* / directus_*) reachable
// from context queries — submissions routinely need requester/contact emails.
// Fields are always an explicit identifier-checked list, never *.
const CONTEXT_SAFE_SYSTEM = new Set(['nivaro_users'])
function collectionAllowed(name: string | undefined): name is string {
  if (!name || !IDENTIFIER_RE.test(name)) return false
  return !/^(nivaro|directus)_/i.test(name) || CONTEXT_SAFE_SYSTEM.has(name)
}

/** The action `context` lookups for one record (also used by payload template previews). */
export async function buildContext(
  defs: TransitionActionDef['context'],
  itemId: string,
  record: Record<string, unknown>,
  userId?: string | null
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  for (const [key, cfg] of Object.entries(defs ?? {})) {
    if (!collectionAllowed(cfg?.collection)) continue
    try {
      let q = db(cfg.collection)
      for (const [f, v] of Object.entries(cfg.filter ?? {})) {
        if (!IDENTIFIER_RE.test(f)) continue
        let resolved: unknown = v
        if (v === '$id') resolved = itemId
        // '$user' = the ACTING user (null on auto transitions) — lets payloads
        // fall back to whoever clicked the button when the record has no creator.
        else if (v === '$user') resolved = userId ?? null
        else if (typeof v === 'string' && v.startsWith('$record.')) {
          resolved = record[v.slice('$record.'.length)] ?? null
        }
        if (resolved === null || resolved === undefined) {
          q = q.whereNull(f)
        } else {
          q = q.where(f, resolved as never)
        }
      }
      const jf = cfg.junction_filter
      if (
        jf &&
        collectionAllowed(jf.junction) &&
        IDENTIFIER_RE.test(jf.fk_to_row ?? '') &&
        IDENTIFIER_RE.test(jf.field ?? '')
      ) {
        q = q.whereIn(
          'id',
          db(jf.junction)
            .select(jf.fk_to_row)
            .where(jf.field, jf.value as never)
        )
      }
      if (cfg.sort) {
        const desc = cfg.sort.startsWith('-')
        const col = desc ? cfg.sort.slice(1) : cfg.sort
        if (IDENTIFIER_RE.test(col)) q = q.orderBy(col, desc ? 'desc' : 'asc')
      }
      const rows = (await q.limit(Math.min(Number(cfg.limit ?? 500), 2000))) as Array<
        Record<string, unknown>
      >

      // Batched M2O expansion: each configured fk column gains a <fk>_data object
      for (const [fk, exp] of Object.entries(cfg.expand ?? {})) {
        if (!IDENTIFIER_RE.test(fk) || !collectionAllowed(exp?.collection)) continue
        const fields = (exp.fields ?? []).filter((f) => IDENTIFIER_RE.test(f))
        if (fields.length === 0) continue
        const ids = [...new Set(rows.map((r) => r[fk]).filter((v) => v != null))]
        if (ids.length === 0) continue
        try {
          const related = (await db(exp.collection)
            .whereIn('id', ids as never[])
            .select(['id', ...fields])) as Array<Record<string, unknown>>
          const byId = new Map(related.map((r) => [String(r.id), r]))
          for (const r of rows) {
            const hit = r[fk] != null ? byId.get(String(r[fk])) : undefined
            r[`${fk}_data`] = hit ?? null
          }
        } catch {
          /* expansion is best-effort */
        }
      }
      out[key] = rows
    } catch {
      out[key] = []
    }
  }
  return out
}

/** Who an action's writes run as, and the reason they carry (#818). The
 *  writer is resolved once per action run, on first use. */
interface ActionWriteCtx {
  writer: () => Promise<import('../types.js').User | null>
  reason: string
}

function actionWriteCtx(userId: string | null, label: string | null | undefined): ActionWriteCtx {
  let pending: Promise<import('../types.js').User | null> | null = null
  return {
    writer: () => {
      pending ??= actionWriter(userId).catch(() => null)
      return pending
    },
    reason: actionWriteReason(label)
  }
}

/**
 * on_success / on_failure: render the `set` templates and write them onto the
 * transitioning record through the items service (raw fallback — see
 * services/action-writes.ts). The write's own after-hooks would re-run the
 * record's auto transitions mid-transition; applyTransition holds the record
 * "in flight" (workflow-transitions.ts) so that re-entry is skipped, and the
 * caller re-evaluates auto transitions once the transition has landed. Never
 * throws — an on_failure writeback must land even when the action failed.
 */
async function applyWriteback(
  collection: string,
  itemId: string,
  set: Record<string, string> | undefined,
  scope: Record<string, unknown>,
  w: ActionWriteCtx
): Promise<ActionWritePath | null> {
  if (!set) return null
  const patch: Record<string, unknown> = {}
  for (const [field, template] of Object.entries(set)) {
    if (!IDENTIFIER_RE.test(field)) continue
    try {
      const rendered = (await engine.parseAndRender(String(template), scope)).trim()
      patch[field] = rendered === '' ? null : rendered
    } catch {
      /* skip unrenderable */
    }
  }
  if (Object.keys(patch).length === 0) return null
  return updateAsAction(await w.writer(), collection, itemId, patch, w.reason)
}

async function resolveExternalApiId(ref: number | string): Promise<number | null> {
  if (typeof ref === 'number') return ref
  if (/^\d+$/.test(ref)) return Number(ref)
  try {
    const row = (await db('nivaro_external_apis').where({ name: ref }).first()) as
      | { id: number }
      | undefined
    return row?.id ?? null
  } catch {
    return null
  }
}

// ─── Payload body (inline Liquid or a saved payload template) ──────────────────

/** The saved payload template an action names, or null (blank / not a string = none). */
function templateKeyOf(action: Partial<TransitionActionDef>): string | null {
  const k = action.payload_template_key
  return typeof k === 'string' && k.trim() !== '' ? k.trim() : null
}

/** True when the action can produce a body at all (the `not_configured` gate). */
const hasPayload = (action: Partial<TransitionActionDef>): boolean =>
  templateKeyOf(action) != null || !!action.payload_template

/** The action field that keeps it from producing a push, or null. `apiId` = the resolved external
 *  API (null = did not resolve); omitted, the action's own `external_api` is judged. */
function notConfiguredField(
  action: Partial<TransitionActionDef>,
  apiId?: number | null
): 'external_api' | 'endpoint_path' | 'payload_template' | null {
  if (apiId === undefined ? !action.external_api : !apiId) return 'external_api'
  if (!action.endpoint_path) return 'endpoint_path'
  if (!hasPayload(action)) return 'payload_template'
  return null
}

/** The first guard rule the record fails (every rule must pass), or undefined. */
function failedGuardRule(
  action: Partial<TransitionActionDef>,
  record: Record<string, unknown>
): ConditionRule | undefined {
  const guard = Array.isArray(action.guard) ? action.guard : []
  return guard.find((r) => !evalConditionRule(r, record))
}

export type ErpActionGateKind = 'not_configured' | 'skip_when_empty' | 'skip_unless_any' | 'guard'

export interface ErpActionGateResult {
  kind: ErpActionGateKind
  /** Exactly the text the push records (skipReason). */
  reason: string
  /** kind 'guard': the rule that failed. */
  rule?: ConditionRule
}

/**
 * Why an erp_submit action would not push for this record, in the order the push checks:
 * not_configured, skip_when_empty, skip_unless_any, guard. Null = every gate passes. The push,
 * the preview and anything else that predicts a push use this one function so they cannot
 * drift. What each outcome does to the obligation ledger is the push's business:
 * skip_when_empty / skip_unless_any mean "not for this record" (nothing opened);
 * not_configured and guard are recorded refusals.
 */
export function erpActionGateDetail(
  action: Partial<TransitionActionDef>,
  record: Record<string, unknown>,
  context: Record<string, unknown>,
  opts: { apiId?: number | null } = {}
): ErpActionGateResult | null {
  const missing = notConfiguredField(action, opts.apiId)
  if (missing) return { kind: 'not_configured', reason: skipReason('not_configured', missing) }
  if (action.skip_when_empty) {
    const gate = context[action.skip_when_empty]
    if (gate == null || (Array.isArray(gate) && gate.length === 0)) {
      return {
        kind: 'skip_when_empty',
        reason: skipReason('skip_when_empty', action.skip_when_empty)
      }
    }
  }
  if (Array.isArray(action.skip_unless_any) && action.skip_unless_any.length > 0) {
    const walk = (ref: string): unknown => {
      let cur: unknown = { record, context }
      for (const seg of ref.split('.')) {
        if (cur == null || typeof cur !== 'object') return undefined
        cur = (cur as Record<string, unknown>)[seg]
      }
      return cur
    }
    const anySet = action.skip_unless_any.some((ref) => {
      const v = walk(ref)
      return v != null && String(v).trim() !== ''
    })
    if (!anySet) {
      return {
        kind: 'skip_unless_any',
        reason: skipReason('skip_unless_any', action.skip_unless_any.join(', '))
      }
    }
  }
  const rule = failedGuardRule(action, record)
  if (rule) {
    return {
      kind: 'guard',
      reason: skipReason(
        'guard',
        `${rule.field} ${rule.op ?? 'eq'} ${JSON.stringify(rule.value ?? null)}`
      ),
      rule
    }
  }
  return null
}

/** erpActionGateDetail's reason text, or null when the action would push. */
export function erpActionGate(
  action: Partial<TransitionActionDef>,
  record: Record<string, unknown>,
  context: Record<string, unknown>,
  opts: { apiId?: number | null } = {}
): string | null {
  return erpActionGateDetail(action, record, context, opts)?.reason ?? null
}

/** The person performing a transition, for the `acting_user.*` values a payload can carry; null
 *  when there is none (automatic transitions) or the row cannot be read. */
async function actingUser(
  userId: string | null | undefined
): Promise<Record<string, unknown> | null> {
  if (!userId) return null
  try {
    const u = (await db('nivaro_users')
      .where({ id: userId })
      .first('id', 'email', 'first_name', 'last_name', 'employee_id')) as
      | Record<string, unknown>
      | undefined
    if (!u) return null
    const name = [u.first_name, u.last_name].filter((x) => x != null && x !== '').join(' ')
    return {
      id: u.id ?? userId,
      email: u.email ?? null,
      first_name: u.first_name ?? null,
      last_name: u.last_name ?? null,
      name: name || null,
      employee_id: u.employee_id ?? null
    }
  } catch {
    return null
  }
}

/** What the action path needs from a referenced template: its lookups and its external API. */
type TemplateInfo = { lookups: Record<string, unknown> | null; external_api: string | null }

/**
 * The registrar's in-process def answers first; a template without one (created in the UI,
 * installed from a blueprint) is read from its row. Null = unknown or unreadable (the render
 * then reports it).
 */
async function templateInfo(key: string): Promise<TemplateInfo | null> {
  const def = registeredDef(key)
  if (def) return { lookups: def.lookups ?? null, external_api: def.external_api ?? null }
  try {
    const row = await getTemplate(key)
    return row ? { lookups: row.lookups, external_api: row.external_api } : null
  } catch {
    return null
  }
}

/**
 * The context query defs an action runs: its own `context`, over the referenced template's
 * `lookups` (same shape) — the action's keys win on a clash.
 */
async function contextDefsFor(
  action: TransitionActionDef
): Promise<TransitionActionDef['context']> {
  const key = templateKeyOf(action)
  if (!key) return action.context
  const lookups = (await templateInfo(key))?.lookups
  if (!lookups || typeof lookups !== 'object' || Array.isArray(lookups)) return action.context
  return { ...(lookups as Record<string, ContextQueryDef>), ...(action.context ?? {}) }
}

const apiKey = (name: string): string => name.trim().toLowerCase()

/**
 * A template is written for one external API; an action that sends it somewhere else is a
 * configuration mistake, never a push. Compared by name, case-insensitively, after resolving the
 * action's api id. A template with no API set (or an unknown template) is not checked here.
 */
async function assertTemplateApi(
  key: string,
  action: TransitionActionDef,
  apiId: number
): Promise<void> {
  const templateApi = (await templateInfo(key))?.external_api
  if (!templateApi?.trim()) return
  let actionApi: string | null = null
  try {
    const row = (await db('nivaro_external_apis').where({ id: apiId }).first('name')) as
      | { name?: string | null }
      | undefined
    actionApi = row?.name ?? null
  } catch {
    actionApi = null
  }
  actionApi ??= typeof action.external_api === 'string' ? action.external_api : `#${apiId}`
  if (apiKey(templateApi) !== apiKey(actionApi)) {
    throw new PayloadTemplateError(
      'invalid',
      `Payload template '${key}' is for ${templateApi.trim()}, but this action sends to ${actionApi.trim()}`
    )
  }
}

/**
 * Render an action's request body. A saved template (payload_template_key) wins over the inline
 * Liquid: it must be for the action's API, and its published render already neutralizes record /
 * context data, so only the template's own secret slots hold a real placeholder. Inline: only the
 * template text's own placeholders stay real — whatever record / context / response data renders
 * (JSON-escaped markers included) is neutralized after the parse. The push and the preview both
 * render here, so the preview's payload signature matches the real push. Throws on any failure.
 */
async function renderActionBody(
  action: TransitionActionDef,
  scope: Record<string, unknown>,
  apiId: number
): Promise<Record<string, unknown>> {
  const key = templateKeyOf(action)
  if (key) {
    await assertTemplateApi(key, action, apiId)
    const r = await renderPayloadTemplate(key, scope)
    if (!r.body || typeof r.body !== 'object' || Array.isArray(r.body)) {
      throw new PayloadTemplateError(
        'invalid',
        `Payload template '${key}' did not produce a JSON object`,
        r.problems
      )
    }
    return r.body
  }
  const tpl = protectTemplatePlaceholders(action.payload_template)
  const rendered = await engine.parseAndRender(tpl.text, scope)
  return tpl.finish(JSON.parse(rendered)) as Record<string, unknown>
}

/** What a render failure records on the submission: a template error already names its key. */
const renderErrorText = (err: unknown): string =>
  err instanceof PayloadTemplateError
    ? err.message
    : `payload template error: ${err instanceof Error ? err.message : String(err)}`

export class TransitionBlockedError extends Error {
  statusCode = 422
  /** What kind of failure blocked it (integration-remediation classifyError) —
   *  the auto-transition memory keys its retry policy on it (#1217). */
  errorClass: string | null
  constructor(message: string, errorClass: string | null = null) {
    super(message)
    this.errorClass = errorClass
  }
}

const XML_ENTITY_MAP: Record<string, string> = {
  lt: '<',
  gt: '>',
  quot: '"',
  amp: '&',
  '#39': "'"
}
function decodeXmlEntities(s: string): string {
  return s.replace(/&(lt|gt|quot|amp|#39);/g, (_, e: string) => XML_ENTITY_MAP[e] ?? '')
}

/**
 * Pull human-readable details out of an ERP error blob. Oracle Fusion (via OIC)
 * wraps a JSON fragment (`"o:errorDetails": [{ "detail": … }]`) inside an XML
 * element with HTML-entity-escaped content — decode and mine every `detail`.
 * Falls back to a tag-stripped copy of the message when no details embed.
 */
export function extractErpErrorDetails(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw.trim()) return []
  const decoded = decodeXmlEntities(raw)
  const out: string[] = []
  const re = /"detail"\s*:\s*"((?:[^"\\]|\\.)*)"/g
  let m: RegExpExecArray | null = re.exec(decoded)
  while (m) {
    try {
      out.push(JSON.parse(`"${m[1]}"`) as string)
    } catch {
      out.push(m[1])
    }
    m = re.exec(decoded)
  }
  if (out.length === 0) {
    const flat = decoded
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (flat) out.push(flat.slice(0, 400))
  }
  return out
}

/**
 * Config shape for erp_submit's optional `response_error` key — some ERPs
 * answer HTTP 200 with `status: "ERROR"` in the BODY, so a 2xx
 * alone is not success. Nothing here is vendor-specific: `when` names the
 * body paths/values that mean failure, `message_paths` names where the human
 * detail lives. Paths are dotted with `[]` to map over arrays
 * ("orderDetailResponse[].orderLineDetails[].lineDetailedMessage").
 */
export interface ResponseErrorConfig {
  when: Array<{ path: string; in: string[] }>
  message_paths?: string[]
}

/** Resolve a dotted path over the body; `[]` segments fan out over arrays. */
function collectPathValues(root: unknown, path: string): unknown[] {
  let current: unknown[] = [root]
  for (const seg of path.split('.')) {
    const next: unknown[] = []
    const isArraySeg = seg.endsWith('[]')
    const key = isArraySeg ? seg.slice(0, -2) : seg
    for (const node of current) {
      if (node == null || typeof node !== 'object') continue
      const value = key === '' ? node : (node as Record<string, unknown>)[key]
      if (isArraySeg) {
        if (Array.isArray(value)) next.push(...value)
      } else if (value !== undefined) {
        next.push(value)
      }
    }
    current = next
  }
  return current
}

/**
 * Evaluate a `response_error` config against a 2xx response body. Returns a
 * readable summary (mined via extractErpErrorDetails from every configured
 * message path, deduped) when any `when` rule matches, null otherwise.
 */
export function detectConfiguredBodyError(
  cfg: ResponseErrorConfig | null | undefined,
  body: unknown
): string | null {
  if (!cfg || !Array.isArray(cfg.when) || cfg.when.length === 0) return null
  const matches = cfg.when.some((rule) => {
    if (!rule?.path || !Array.isArray(rule.in) || rule.in.length === 0) return false
    const wanted = rule.in.map((v) => String(v).trim().toUpperCase())
    return collectPathValues(body, rule.path).some(
      (v) => typeof v === 'string' && wanted.includes(v.trim().toUpperCase())
    )
  })
  if (!matches) return null

  const messages: string[] = []
  for (const path of cfg.message_paths ?? []) {
    for (const value of collectPathValues(body, path)) {
      for (const d of extractErpErrorDetails(value)) if (!messages.includes(d)) messages.push(d)
    }
  }
  const summary = messages.join(' · ').slice(0, 4000)
  return summary || 'ERP response body reported an error status'
}

/**
 * `response_success` — the mirror of `response_error`: body paths/values that
 * mean the ERP ACCEPTED the write, so the submission records `accepted`
 * instead of parking at `pending` forever. Without config, a small generic
 * heuristic applies: a top-level `status` / `api_status` / `result` string of
 * OK / SUCCESS / ACCEPTED (some ERPs answer `{"api_status": "OK"}`).
 */
export interface ResponseSuccessConfig {
  when: Array<{ path: string; in: string[] }>
}

const DEFAULT_SUCCESS_KEYS = ['status', 'api_status', 'result']
const DEFAULT_SUCCESS_VALUES = new Set(['OK', 'SUCCESS', 'SUCCEEDED', 'ACCEPTED'])
/** Boolean acknowledgements — `{"status": true}` / `{"success": true}` /
 *  `{"ok": true}`. A partner that answers `status: true` said yes just as
 *  loudly as one that answers `"OK"`; only the string form was recognized
 *  before, so those pushes parked at `pending` after a real success. */
const DEFAULT_SUCCESS_BOOL_KEYS = ['status', 'success', 'ok']

/**
 * The generic "the partner said no" check for a response body, used when no
 * `response_error` config applies: a top-level `status` / `api_status` /
 * `result` string such as ERROR / FAILED / REJECTED / "Bad Request", or a
 * boolean `status` / `success` / `ok` of false. Returns the partner's own
 * message (message / statusMessage / error / detail) when it sent one, else a
 * short sentence naming the status; null when the body reads as no rejection.
 * Matters most on a 2xx — some partners answer 200 and refuse in the body.
 */
const DEFAULT_REJECT_VALUES = new Set([
  'ERROR',
  'ERRORS',
  'FAIL',
  'FAILED',
  'FAILURE',
  'REJECTED',
  'DENIED',
  'INVALID',
  'BAD REQUEST',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT FOUND'
])
const DEFAULT_MESSAGE_KEYS = [
  'message',
  'statusMessage',
  'error_description',
  'error',
  'detail',
  'detailMessage'
]

export function detectDefaultBodyRejection(body: unknown): string | null {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) return null
  const obj = body as Record<string, unknown>
  let label: string | null = null
  for (const k of DEFAULT_SUCCESS_BOOL_KEYS) {
    if (obj[k] === false) label = `${k}: false`
  }
  for (const k of DEFAULT_SUCCESS_KEYS) {
    const v = obj[k]
    if (typeof v === 'string' && DEFAULT_REJECT_VALUES.has(v.trim().toUpperCase())) {
      label = `${k}: ${v.trim()}`
    }
  }
  if (!label) return null
  for (const k of DEFAULT_MESSAGE_KEYS) {
    const v = obj[k]
    if (typeof v === 'string' && v.trim()) {
      const detail = extractErpErrorDetails(v)
      return (detail.length ? detail.join(' · ') : v.trim()).slice(0, 1000)
    }
  }
  return `Partner responded with ${label}`
}

export function detectBodyAcceptance(
  cfg: ResponseSuccessConfig | null | undefined,
  body: unknown
): boolean {
  if (cfg && Array.isArray(cfg.when) && cfg.when.length > 0) {
    return cfg.when.some((rule) => {
      if (!rule?.path || !Array.isArray(rule.in) || rule.in.length === 0) return false
      const wanted = rule.in.map((v) => String(v).trim().toUpperCase())
      return collectPathValues(body, rule.path).some(
        (v) => typeof v === 'string' && wanted.includes(v.trim().toUpperCase())
      )
    })
  }
  if (body == null || typeof body !== 'object' || Array.isArray(body)) return false
  const obj = body as Record<string, unknown>
  if (DEFAULT_SUCCESS_BOOL_KEYS.some((k) => obj[k] === true)) return true
  return DEFAULT_SUCCESS_KEYS.some((k) => {
    const v = obj[k]
    return typeof v === 'string' && DEFAULT_SUCCESS_VALUES.has(v.trim().toUpperCase())
  })
}

export async function runTransitionActions(opts: {
  transition: { id: string; label: string; actions: string | null }
  instance: { collection: string; item: string }
  newStateObj: { key: string; label: string; external_label?: string | null } | null
  userId: string | null
  /** 'blocking' runs only blocking:true actions (pre-transition; a failure
   *  returns blockedError), 'post' runs the rest. Default runs everything —
   *  legacy callers keep their behavior. */
  phase?: 'blocking' | 'post'
  /** Run ONLY `parseActions(actions)[onlyIndex]`, ignoring `phase` — a
   *  targeted re-run of one push action ("resend this to the partner") with
   *  the instance's state left untouched by the caller. */
  onlyIndex?: number
  /** What kind of trigger this run's obligation ledger rows should record —
   *  default 'transition' (a normal transition firing this action). A
   *  targeted re-run passes 'manual' so the ledger tells a resend apart from
   *  the original push. */
  obligationTrigger?: ObligationTrigger
  /** How this run's pushes were requested, stamped on each submission row
   *  (migration 350). Default: 'transition' when a person drove it, else
   *  'auto-transition'. A targeted re-run passes 'resend'. */
  requestedVia?: RequestedVia
}): Promise<{
  blockedError: string | null
  /** classifyError of the failure that blocked (null when nothing blocked). */
  blockedClass?: string | null
  skippedReason?: string | null
}> {
  const all = parseActions(opts.transition.actions)
  const actions =
    opts.onlyIndex != null
      ? all.filter((_, i) => i === opts.onlyIndex)
      : opts.phase === 'blocking'
        ? all.filter((a) => a.blocking === true)
        : opts.phase === 'post'
          ? all.filter((a) => a.blocking !== true)
          : all
  if (actions.length === 0) return { blockedError: null, skippedReason: null }

  const { collection, item } = opts.instance
  const who: SubmissionRequester = {
    by: opts.userId ?? null,
    via: opts.requestedVia ?? (opts.userId ? 'transition' : 'auto-transition')
  }
  const writes = actionWriteCtx(opts.userId ?? null, opts.transition.label)

  // Action journal (#327): write-ahead intent for the chain. If the process
  // dies mid-chain the row stays 'running' — boot recovery flags it as
  // interrupted with the record named, so a half-run chain is REPORTED
  // rather than silently half-done. Best-effort: journal failures never
  // block the transition.
  let journalId: number | null = null
  try {
    const inserted = (await db('nivaro_action_journal')
      .insert({
        collection,
        item: String(item),
        transition_label: opts.transition.label?.slice(0, 255) ?? null,
        actions_total: actions.length,
        actions_done: 0,
        status: 'running',
        started_at: new Date()
      })
      .returning('id')) as Array<number | { id: number }>
    const first = inserted[0]
    journalId = typeof first === 'object' ? first.id : (first ?? null)
  } catch {
    journalId = null
  }
  let journalDone = 0
  const journalTick = async (err?: unknown) => {
    if (journalId == null) return
    try {
      if (err !== undefined) {
        await db('nivaro_action_journal')
          .where({ id: journalId })
          .update({
            status: 'error',
            last_error: String(err instanceof Error ? err.message : err).slice(0, 2000),
            actions_done: journalDone,
            finished_at: new Date()
          })
      } else {
        journalDone++
        await db('nivaro_action_journal')
          .where({ id: journalId })
          .update({ actions_done: journalDone })
      }
    } catch {
      /* journal is best-effort */
    }
  }

  const responses: unknown[] = []
  // The reason the last SKIPPED action didn't push — meaningful when the
  // caller runs exactly one action (onlyIndex): "no submission" always means
  // one of the `continue`s below fired, and this is which.
  let skippedReason: string | null = null
  // The acting user's row, read once per run on the first push that renders.
  let acting: { user: Record<string, unknown> | null } | undefined
  for (const action of actions) {
    if (action.type !== 'erp_submit' && action.type !== 'create_record') continue
    void import('./flow-executor.js')
      .then(({ emitFirehose }) =>
        emitFirehose('transition-action', {
          collection,
          item: String(item),
          transition: opts.transition.label,
          action_type: action.type,
          endpoint: (action as { endpoint_path?: string }).endpoint_path ?? null
        })
      )
      .catch(() => {})

    // Refetch per action so guards/templates see prior actions' writebacks
    let record: Record<string, unknown> = {}
    try {
      record = ((await db(collection).where({ id: item }).first()) ?? {}) as Record<string, unknown>
    } catch {
      record = {}
    }

    // Obligation ledger: opened BEFORE the guard, so that a refusal is itself
    // a recorded outcome rather than silence — but AFTER the two applicability
    // gates (skip_when_empty / skip_unless_any). Those say "this action is not
    // for this record" (no lines for this partner, no link to this system),
    // and a partner that was never supposed to be told has no obligation to
    // record: several partners' actions share one transition, and opening for
    // each used to leave every record with a "should have been told" line for
    // the partners that did not apply. An action core cannot attribute to a
    // registered kind opens nothing and behaves exactly as before.
    const triggerContext = {
      collection,
      item: String(item),
      api: String(action.external_api ?? ''),
      source: 'erp_submit' as const,
      endpoint_path: action.endpoint_path ?? null,
      transition_label: opts.transition.label ?? null,
      to_state_key: opts.newStateObj?.key ?? null,
      action_context_keys: action.context ? Object.keys(action.context) : [],
      action_skip_unless_any: action.skip_unless_any ?? [],
      action_skip_when_empty: action.skip_when_empty ?? null
    }
    const openObligation = async (): Promise<number | null> =>
      action.type === 'erp_submit' && action.external_api
        ? openObligationForTrigger(triggerContext, {
            trigger: opts.obligationTrigger ?? 'transition',
            trigger_ref: opts.transition.id
          })
        : null

    if (action.type === 'create_record') {
      // Guard: every rule must pass or the action is skipped
      const failedRule = failedGuardRule(action, record)
      if (failedRule) {
        skippedReason = skipReason(
          'guard',
          `${failedRule.field} ${failedRule.op ?? 'eq'} ${JSON.stringify(failedRule.value ?? null)}`
        )
        continue
      }
      await runCreateRecordAction(
        action,
        collection,
        item,
        record,
        opts.newStateObj,
        responses,
        writes
      )
      await journalTick()
      continue
    }

    const apiId = await resolveExternalApiId(action.external_api)
    // A misconfigured action skips its context queries (it cannot push anyway).
    const context = notConfiguredField(action, apiId)
      ? {}
      : await buildContext(await contextDefsFor(action), item, record, opts.userId)
    const gate = erpActionGateDetail(action, record, context, { apiId })
    if (gate) {
      skippedReason = gate.reason
      // skip_when_empty / skip_unless_any: not for this record — no obligation. A misconfigured
      // action IS worth a recorded no (someone must fix it), and so is a guard refusal.
      if (gate.kind === 'not_configured' || gate.kind === 'guard') {
        await resolveObligation(await openObligation(), {
          outcome: 'skipped',
          reason: skippedReason
        })
      }
      continue
    }
    // The gate refused a missing api / endpoint already; this only narrows the types — and
    // still records why, rather than leaving silently.
    if (!apiId || !action.endpoint_path) {
      skippedReason = skipReason('not_configured', !apiId ? 'external_api' : 'endpoint_path')
      continue
    }

    // The action applies to this record: from here on every way out is a
    // recorded outcome on the partner's ledger.
    const obligationId = await openObligation()

    acting ??= { user: await actingUser(opts.userId) }
    const scope = {
      record,
      context,
      state: opts.newStateObj,
      acting_user: acting.user,
      responses,
      response: responses[responses.length - 1] ?? null
    }

    let body: Record<string, unknown>
    try {
      // Sent with bodySecrets: true — see renderActionBody for which placeholders stay real.
      body = await renderActionBody(action, scope, apiId)
    } catch (err) {
      const submissionId = await recordSubmission(
        collection,
        item,
        apiId,
        action.endpoint_path,
        null,
        'failed',
        renderErrorText(err),
        undefined,
        undefined,
        undefined,
        who
      )
      await resolveObligation(obligationId, {
        outcome: 'failed',
        reason: skipReason('template_error', err instanceof Error ? err.message : String(err)),
        submission_id: submissionId
      })
      if (submissionId != null && obligationId != null) {
        await db('nivaro_erp_submissions')
          .where({ id: submissionId })
          .update({ obligation_id: obligationId })
          .catch(() => {})
      }
      await applyWriteback(
        collection,
        item,
        action.on_failure?.set,
        {
          ...scope,
          error: String(err)
        },
        writes
      )
      continue
    }

    // Change gate: does this integration care about what just happened?
    // Gated AFTER rendering, so a payload comparison can see what would
    // actually be sent — a linked purchase order reaches the payload through a
    // context query, not a record field, and is invisible before this point.
    const signature =
      action.push_when?.payload === true
        ? payloadSignature(body)
        : changeSignature(record, action.push_when?.fields)
    if (action.push_when) {
      let lastSignature: string | null | undefined
      try {
        const prior = (await db('nivaro_erp_submissions')
          .where({ collection, item: String(item) })
          .whereIn('status', ['accepted', 'pending'])
          .orderBy('created_at', 'desc')
          .first('change_signature', 'payload')) as
          | { change_signature: string | null; payload: string | null }
          | undefined
        // Same endpoint only — two integrations on one record must not read as
        // each other's history.
        const samePath = prior?.payload
          ? (() => {
              try {
                return (
                  (JSON.parse(prior.payload) as { endpoint_path?: string }).endpoint_path ===
                  action.endpoint_path
                )
              } catch {
                return false
              }
            })()
          : false
        lastSignature = samePath ? prior?.change_signature : null
      } catch {
        // No history readable — treat as a first push rather than skipping.
        lastSignature = null
      }
      if (
        !shouldPush({
          pushWhen: action.push_when,
          stateChanged: !!opts.newStateObj,
          signature,
          lastSignature
        })
      ) {
        skippedReason = skipReason(
          'push_when',
          action.push_when.payload === true
            ? 'payload unchanged since the last landed push'
            : `no change in ${(action.push_when.fields ?? []).join(', ') || 'the watched fields'}`
        )
        await resolveObligation(obligationId, { outcome: 'skipped', reason: skippedReason })
        continue
      }
    }

    // Outbound contracts (#352): assert the shape WE send. Missing required
    // paths raise a deduped issue naming them — drift surfaces first — but
    // the push still goes (warn, never block; the receiving system is the
    // authority on what it actually rejects).
    try {
      const apiRow = (await db('nivaro_external_apis')
        .where({ id: Number(apiId) })
        .first('name', 'outbound_contract')) as
        | { name: string; outbound_contract: string | null }
        | undefined
      const contract = apiRow?.outbound_contract
        ? (JSON.parse(apiRow.outbound_contract) as { required?: string[] })
        : null
      if (contract?.required?.length && body && typeof body === 'object') {
        const missing = contract.required.filter((path) => {
          const v = String(path)
            .split('.')
            .reduce<unknown>(
              (cur, seg) =>
                cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[seg] : undefined,
              body
            )
          return v === undefined || v === null || v === ''
        })
        if (missing.length > 0) {
          const { trackError } = await import('./error-tracking.js')
          void trackError({
            source: 'server',
            route: `outbound-contract:${apiRow?.name ?? apiId}`,
            message: `Outbound payload to ${apiRow?.name ?? apiId} is missing required path(s): ${missing.join(', ')} (${opts.instance.collection}/${opts.instance.item})`,
            severity: 'medium'
          }).catch(() => {})
        }
      }
    } catch {
      /* contract check is advisory */
    }

    let status: 'pending' | 'accepted' | 'failed' = 'failed'
    let responseBody: unknown = null
    let error: string | null = null
    // #628 — the raw status the response came back with, so a real HTTP
    // failure classifies as itself (404/422/500/…) rather than as
    // "unknown"; stays null for a thrown network failure, which has none.
    let httpStatus: number | null = null
    try {
      const res = await callExternalApi(apiId, {
        method: (action.method as 'POST' | 'PUT') ?? 'POST',
        path: action.endpoint_path,
        body,
        bodySecrets: true,
        // `timeout_ms` on the action config wins; the default is generous
        // because a partner that validates each line (Fusion IIP) answers a
        // 30-line push in minutes, and a timeout here reads as a failed push.
        timeoutMs: Math.min(
          10 * 60_000,
          Math.max(5_000, Number((action as { timeout_ms?: unknown }).timeout_ms) || 120_000)
        ),
        _log: { triggeredBy: 'transition-action', userId: opts.userId ?? undefined }
      })
      responseBody = res.body
      httpStatus = res.status
      if (res.status >= 200 && res.status < 300) {
        // A 2xx can still be a rejection — some ERPs answer 200 with an error
        // status in the body. The action's `response_error` config decides;
        // without one, 2xx keeps meaning pending as before.
        // …else the generic check (status/api_status/result reads ERROR,
        // FAILED, "Bad Request"…, or success/ok/status is false).
        const bodyError =
          detectConfiguredBodyError(
            action.response_error as ResponseErrorConfig | undefined,
            res.body
          ) ?? detectDefaultBodyRejection(res.body)
        if (bodyError) {
          error = bodyError
        } else {
          // …and a 2xx whose body says OK/SUCCESS (config or the generic
          // heuristic) is accepted outright — an `api_status: "OK"` body used
          // to sit at pending forever (2026-09-14).
          status = detectBodyAcceptance(
            action.response_success as ResponseSuccessConfig | undefined,
            res.body
          )
            ? 'accepted'
            : 'pending'
        }
      } else {
        error = `HTTP ${res.status}: ${JSON.stringify(res.body ?? null)?.slice(0, 500)}`
      }
    } catch (err) {
      // Keep every scrap of detail — fetch failures bury the real reason
      // (ECONNREFUSED, DNS, TLS) in `cause`.
      error =
        err instanceof Error
          ? `${err.message}${err.cause ? ` (${String(err.cause)})` : ''}`
          : 'Request failed'
    }

    responses.push(responseBody)
    const submissionId = await recordSubmission(
      collection,
      item,
      apiId,
      action.endpoint_path,
      body,
      status,
      error,
      responseBody,
      // Only a push that LANDED defines "what they already know" — recording a
      // signature for a failure would suppress the retry that fixes it.
      status === 'failed' ? null : signature,
      httpStatus,
      who
    )
    await resolveObligation(obligationId, {
      // A 2xx with no acknowledgement is not `sent` — it is `pending` until
      // the partner says so or the sweep calls it overdue.
      outcome: status === 'accepted' ? 'sent' : status === 'pending' ? 'pending' : 'failed',
      reason: status === 'failed' ? (error?.slice(0, 500) ?? 'submission failed') : null,
      submission_id: submissionId,
      signature: status === 'failed' ? null : signature
    })
    if (submissionId != null && obligationId != null) {
      await db('nivaro_erp_submissions')
        .where({ id: submissionId })
        .update({ obligation_id: obligationId })
        .catch(() => {})
    }

    const postScope = { ...scope, response: responseBody, responses, error }
    if (status === 'failed') {
      await applyWriteback(collection, item, action.on_failure?.set, postScope, writes)
      if (action.blocking === true) {
        // Abort the transition: the caller keeps the record in its current
        // state and surfaces the error. on_failure writebacks (a status column
        // = 'error') already landed, which is what the form banner keys off.
        await journalTick(`blocked: ${error ?? 'unknown error'}`)
        let blockedClass: string | null = null
        try {
          blockedClass = (await import('./integration-remediation.js')).classifyError(
            httpStatus,
            responseBody,
            error
          )
        } catch {
          blockedClass = null
        }
        return {
          blockedError: `${opts.transition.label}: submission failed — ${error ?? 'unknown error'}`,
          blockedClass
        }
      }
    } else {
      await applyWriteback(collection, item, action.on_success?.set, postScope, writes)
      await applyChildWritebacks(action.on_success_children, item, postScope, writes)
    }
    await journalTick()
  }
  if (journalId != null) {
    await db('nivaro_action_journal')
      .where({ id: journalId })
      .update({ status: 'done', actions_done: journalDone, finished_at: new Date() })
      .catch(() => {})
  }
  return { blockedError: null, skippedReason }
}

/**
 * Render + apply per-child-row writebacks (see on_success_children). Each
 * matching child row is written through the items service (#818) — a line's
 * own revision, the parent's stored rollups, its integrity check — instead of
 * one blanket UPDATE. The rows are picked by the same filter the old UPDATE
 * used (fk, only_empty, junction_filter); a refused row falls back to the raw
 * write. Never throws.
 */
const CHILD_WRITEBACK_CAP = 1000

async function applyChildWritebacks(
  entries: TransitionActionDef['on_success_children'],
  itemId: string,
  scope: Record<string, unknown>,
  w: ActionWriteCtx
): Promise<void> {
  for (const e of entries ?? []) {
    if (
      !e ||
      !collectionAllowed(e.collection) ||
      !IDENTIFIER_RE.test(e.fk_field ?? '') ||
      !IDENTIFIER_RE.test(e.field ?? '')
    )
      continue
    try {
      const rendered = (await engine.parseAndRender(String(e.value_template ?? ''), scope)).trim()
      if (rendered === '') continue // nothing to write — never blank children out
      let q = db(e.collection).where({ [e.fk_field]: itemId })
      if (e.only_empty !== false) q = q.whereNull(e.field)
      const jf = e.junction_filter
      if (
        jf &&
        collectionAllowed(jf.junction) &&
        IDENTIFIER_RE.test(jf.fk_to_row ?? '') &&
        IDENTIFIER_RE.test(jf.field ?? '')
      ) {
        q = q.whereIn(
          'id',
          db(jf.junction)
            .select(jf.fk_to_row)
            .where(jf.field, jf.value as never)
        )
      }
      const rows = (await q.orderBy('id').limit(CHILD_WRITEBACK_CAP).select('id')) as Array<{
        id: string | number
      }>
      const writer = await w.writer()
      let n = 0
      for (const r of rows) {
        const path = await updateAsAction(
          writer,
          e.collection,
          r.id,
          { [e.field]: rendered },
          w.reason
        )
        if (path !== 'failed') n++
      }
      if (n > 0)
        console.info(`[transition-action] child writeback: ${e.collection}.${e.field} on ${n} rows`)
    } catch (err) {
      console.error({ err, entry: e }, 'transition action child writeback failed')
    }
  }
}

/**
 * create_record transition action: render a JSON payload from the transitioning
 * record (+context queries), create a row in another business collection, then
 * optionally link it back onto the record and insert M2M junction rows.
 * Idempotent via skip_if_exists (match on one column). Typical use: an
 * approval creating a parent record from the approved record's fields.
 */
/** Rule-engine entry: run a create_record action for a record OUTSIDE a
 *  transition (a create-time automation rule). Guards are the caller's job. */
export async function runCreateRecordForRecord(
  action: TransitionActionDef,
  collection: string,
  itemId: string
): Promise<void> {
  let record: Record<string, unknown> = {}
  try {
    record = ((await db(collection).where({ id: itemId }).first()) ?? {}) as Record<string, unknown>
  } catch {
    return
  }
  if (record.id == null) return
  // A rule fires inside another write's after-hook — no person drove it here,
  // so its writes run as the system (activity names no user, origin machine).
  await runCreateRecordAction(
    action,
    collection,
    itemId,
    record,
    null,
    [],
    actionWriteCtx(null, 'automation rule')
  )
}

async function runCreateRecordAction(
  action: TransitionActionDef,
  collection: string,
  item: string,
  record: Record<string, unknown>,
  newStateObj: { key: string; label: string } | null,
  responses: unknown[],
  w: ActionWriteCtx
): Promise<void> {
  const target = action.target_collection
  if (!target || !IDENTIFIER_RE.test(target) || /^nivaro_/i.test(target)) return
  if (!action.payload_template) return

  const context = await buildContext(action.context, item, record)
  const scope = { record, context, state: newStateObj, responses }

  try {
    // Reuse-existing check first — nothing is created when a match exists.
    let targetId: unknown = null
    if (
      action.skip_if_exists?.match_field &&
      IDENTIFIER_RE.test(action.skip_if_exists.match_field)
    ) {
      const matchVal = (
        await engine.parseAndRender(action.skip_if_exists.value_template ?? '', scope)
      ).trim()
      if (matchVal) {
        const existing = (await db(target)
          .where({ [action.skip_if_exists.match_field]: matchVal })
          .first('id')) as { id: unknown } | undefined
        if (existing) targetId = existing.id
      }
    }

    if (targetId == null) {
      const rendered = await engine.parseAndRender(action.payload_template, scope)
      const payload = JSON.parse(rendered) as Record<string, unknown>
      // Only plain-identifier keys reach SQL; null/undefined values dropped
      const row: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(payload)) {
        if (IDENTIFIER_RE.test(k) && v !== undefined && v !== null && v !== '') row[k] = v
      }
      if (Object.keys(row).length === 0) return
      // Through the items service (#818): auto ids, field rules, the target's
      // own pipeline auto-start, activity + revision, stored rollups. A create
      // the service refuses throws into the catch below — the action failed
      // and its on_failure writeback runs; it is never slipped in raw past
      // the rule that refused it. No administrator role at all = the old raw
      // insert (a fresh instance mid-setup).
      const writer = await w.writer()
      if (writer) {
        targetId = await createAsAction(writer, target, row, w.reason)
      } else {
        await db(target).insert(row)
        // MSSQL/tedious returns row-count on bare insert — insert-then-select.
        const created = (await db(target).orderBy('id', 'desc').first('id')) as
          | { id: unknown }
          | undefined
        targetId = created?.id ?? null
      }
      if (targetId == null) return

      // M2M junction rows for the new record
      for (const [alias, cfg] of Object.entries(action.m2m ?? {})) {
        if (
          !cfg ||
          !IDENTIFIER_RE.test(cfg.junction_collection ?? '') ||
          /^nivaro_/i.test(cfg.junction_collection) ||
          !IDENTIFIER_RE.test(cfg.parent_field ?? '') ||
          !IDENTIFIER_RE.test(cfg.related_field ?? '')
        )
          continue
        try {
          const listRendered = await engine.parseAndRender(cfg.values_template ?? '[]', scope)
          const ids = JSON.parse(listRendered)
          if (!Array.isArray(ids)) continue
          for (const rid of ids) {
            if (rid === null || rid === undefined || rid === '') continue
            const link = { [cfg.parent_field]: targetId, [cfg.related_field]: rid }
            // Junction rows through the items service too — a junction write
            // recomputes the new record's auto-id prefix and its rollups. An
            // unregistered junction (or a refusal) keeps the raw insert.
            let viaItems = false
            if (writer) {
              try {
                await createAsAction(writer, cfg.junction_collection, link, w.reason)
                viaItems = true
              } catch {
                viaItems = false
              }
            }
            if (!viaItems) await db(cfg.junction_collection).insert(link)
          }
        } catch (err) {
          console.error({ err, alias }, 'create_record m2m insert failed')
        }
      }

      // The items service logged the create (with its revision). The raw
      // fallback still needs the breadcrumb.
      if (!writer) {
        await logActivity({
          action: 'create',
          collection: target,
          item: String(targetId),
          user: null,
          comment: `created by transition action from ${collection}/${item}`
        })
      }
    }

    // Link the created/found record back onto the transitioning record
    // The record just became a contributor to the NEW parent (its amount
    // feeds the created parent's stored rollup) — the items service write
    // recalcs that, and the raw fallback recalcs it explicitly.
    if (action.link_field && IDENTIFIER_RE.test(action.link_field)) {
      await updateAsAction(
        await w.writer(),
        collection,
        item,
        { [action.link_field]: targetId },
        w.reason
      )
    }

    // Stays raw on purpose: nivaro_record_links is a system table with no
    // items-service collection behind it (the /record-links routes write it
    // the same way), so there are no hooks, revisions or rollups to reach.
    if (action.record_link && targetId != null) {
      try {
        const { LINK_TYPES } = await import('../routes/record-links.js')
        const linkType = LINK_TYPES.includes(String(action.record_link.link_type))
          ? String(action.record_link.link_type)
          : 'relates to'
        const key = {
          from_collection: collection,
          from_item: String(item),
          to_collection: target,
          to_item: String(targetId)
        }
        const exists = await db('nivaro_record_links').where(key).first('id')
        if (!exists) {
          await db('nivaro_record_links').insert({
            ...key,
            link_type: linkType,
            note: action.record_link.note ? String(action.record_link.note).slice(0, 255) : null,
            created_by: null
          })
        }
      } catch (err) {
        console.error({ err, collection, item, target }, 'create_record record_link failed')
      }
    }

    responses.push({ created_id: targetId })
    await applyWriteback(
      collection,
      item,
      action.on_success?.set,
      {
        ...scope,
        created_id: targetId,
        responses
      },
      w
    )
  } catch (err) {
    console.error({ err, collection, item, target }, 'create_record transition action failed')
    await applyWriteback(
      collection,
      item,
      action.on_failure?.set,
      {
        ...scope,
        error: String(err)
      },
      w
    )
  }
}

// Response bodies can be arbitrarily large upstream HTML error pages — cap
// what we persist so one bad gateway response can't bloat the table.
export function serializeResponseBody(body: unknown): string | null {
  if (body === null || body === undefined) return null
  try {
    const s = typeof body === 'string' ? body : JSON.stringify(body)
    return s.length > 100_000 ? `${s.slice(0, 100_000)}… [truncated]` : s
  } catch {
    return String(body).slice(0, 100_000)
  }
}

/** Who sent a push and how — migration 350's requested_by / requested_via. */
interface SubmissionRequester {
  by: string | null
  via: RequestedVia
}

export async function recordSubmission(
  collection: string,
  item: string,
  externalApi: number,
  endpointPath: string,
  body: Record<string, unknown> | null,
  status: 'pending' | 'accepted' | 'failed',
  error: string | null,
  responseBody?: unknown,
  signature?: string | null,
  // #628 — the raw HTTP status this attempt came back with, when there was
  // one: a payload-template error and a thrown network failure both have
  // none, a real HTTP response does. Threaded through so `classifyError`
  // can tell a 404 apart from a 500 apart from a refused socket, rather than
  // reading every non-2xx failure as equally "unknown".
  httpStatus?: number | null,
  who?: SubmissionRequester
): Promise<number | null> {
  try {
    const now = new Date()
    // Probed once per tenant — naming a column this database hasn't run
    // migration 350 for yet fails the WHOLE insert, not just these two
    // fields, so the requester is spread conditionally instead of written
    // directly.
    const requesterFields = await requesterInsertFields(
      'nivaro_erp_submissions',
      who?.by ?? null,
      who?.via ?? null
    )
    const inserted = (await db('nivaro_erp_submissions')
      .insert({
        collection,
        item: String(item),
        external_api: externalApi,
        external_ref: null,
        status,
        attempts: 1,
        last_error: error,
        // secret_paths: where the template's real placeholders sit — a resend honours only those.
        payload: JSON.stringify({
          endpoint_path: endpointPath,
          body,
          secret_paths: body ? secretPathsOf(body) : []
        }),
        response: await scrubSecretsFor(externalApi, serializeResponseBody(responseBody)),
        change_signature: signature ?? null,
        ...requesterFields,
        ...(await chainFields('nivaro_erp_submissions')),
        // #628 — NULL when this attempt did not fail; otherwise what kind of
        // failure it was, which decides whether a later retry could help.
        error_class:
          status === 'failed'
            ? (
                await import('./integration-remediation.js')
              ).classifyError(httpStatus ?? null, responseBody, error)
            : null,
        created_at: now,
        updated_at: now
      })
      .returning('id')) as Array<number | { id: number }>
    // #1825: the record's Integrations chip refreshes the moment a push lands.
    announceRecordAspect(collection, item, '$integrations')
    await logActivity({
      action: 'create',
      collection: 'nivaro_erp_submissions',
      item: `${collection}/${item}`,
      user: null,
      comment: `transition action → api:${externalApi} (${status}${error ? `: ${error.slice(0, 120)}` : ''})`
    })
    // A failed partner push says so in the record's chat room (#933), when
    // the room type opted in to activity lines.
    if (status === 'failed') {
      void (async () => {
        try {
          const api = (await db('nivaro_external_apis').where({ id: externalApi }).first('name')) as
            | { name?: string }
            | undefined
          const { postRecordActivity } = await import('./chat-records.js')
          const { getApp } = await import('./io-holder.js')
          const app = getApp()
          if (app)
            await postRecordActivity(
              app,
              collection,
              item,
              `⚠ The push to ${api?.name ?? 'a partner system'} failed${
                error ? `: ${error.slice(0, 200)}` : ''
              }`
            )
        } catch {
          /* decoration */
        }
      })()
    }
    const first = inserted[0]
    // tedious hands an OBJECT back from .returning on this stack.
    return typeof first === 'object' && first !== null
      ? Number(first.id)
      : Number(first ?? 0) || null
  } catch (err) {
    console.error({ err, collection, item }, 'failed to record ERP submission')
    return null
  }
}

// ─── Read-only preview (#615 / #616) ────────────────────────────────────────
//
// What a transition's partner pushes WOULD do, without doing it: the same
// applicability gates, guard, context queries and template render the real
// run uses, then a comparison with the payload the partner last received.
// Nothing is sent, written, journaled or opened on the obligation ledger.

export interface ErpActionPreview {
  index: number
  api_id: number | null
  endpoint_path: string | null
  method: string
  blocking: boolean
  push_when: PushWhen | null
  /**
   * would_push   — every gate passes and push_when says send.
   * unchanged    — push_when would hold it back (nothing it watches moved).
   * not_applicable — skip_when_empty / skip_unless_any: not for this record.
   * guard        — a guard rule fails, so the push is skipped.
   * not_configured / template_error — the action cannot produce a payload.
   */
  status:
    | 'would_push'
    | 'unchanged'
    | 'not_applicable'
    | 'guard'
    | 'not_configured'
    | 'template_error'
  reason: string | null
  guard_failed?: { field: string; op: string; value: unknown; actual: unknown } | null
  /** An earlier push on the same transition writes back onto the record
   *  first, so this action's guard and payload may read differently then. */
  after_earlier_writeback: boolean
  body: Record<string, unknown> | null
  /** The newest landed (accepted / pending) push to the same api + endpoint. */
  last: {
    submission_id: number
    status: string
    at: string
    body: unknown
    change_signature: string | null
  } | null
  /** Paths a contract requires that the rendered payload leaves empty. */
  contract_missing: string[]
}

async function lastLandedSubmission(
  collection: string,
  item: string,
  apiId: number,
  endpointPath: string
): Promise<ErpActionPreview['last']> {
  try {
    const rows = (await db('nivaro_erp_submissions')
      .where({ collection, item: String(item), external_api: apiId })
      .whereIn('status', ['accepted', 'pending'])
      .orderBy('created_at', 'desc')
      .limit(25)
      .select('id', 'status', 'created_at', 'payload', 'change_signature')) as Array<{
      id: number
      status: string
      created_at: Date | string
      payload: string | null
      change_signature: string | null
    }>
    for (const r of rows) {
      let parsed: { endpoint_path?: string; body?: unknown } | null = null
      try {
        parsed = r.payload ? JSON.parse(r.payload) : null
      } catch {
        parsed = null
      }
      if (!parsed || parsed.endpoint_path !== endpointPath) continue
      return {
        submission_id: Number(r.id),
        status: r.status,
        at: new Date(r.created_at).toISOString(),
        body: parsed.body ?? null,
        change_signature: r.change_signature
      }
    }
  } catch {
    /* history unreadable — reads as "never sent" */
  }
  return null
}

export async function previewErpActions(opts: {
  transition: { id: string; label: string; actions: string | null }
  instance: { collection: string; item: string }
  newStateObj: { key: string; label: string; external_label?: string | null } | null
  userId: string | null
  /** Shared across several transitions of one record: the record and each
   *  distinct context query set are read once, not once per transition. */
  cache?: Map<string, Promise<unknown>>
}): Promise<ErpActionPreview[]> {
  const actions = parseActions(opts.transition.actions)
  const { collection, item } = opts.instance
  const cached = <T>(key: string, load: () => Promise<T>): Promise<T> => {
    if (!opts.cache) return load()
    let p = opts.cache.get(key) as Promise<T> | undefined
    if (!p) {
      p = load()
      opts.cache.set(key, p)
    }
    return p
  }
  const record = await cached('record', async () => {
    try {
      return ((await db(collection).where({ id: item }).first()) ?? {}) as Record<string, unknown>
    } catch {
      return {} as Record<string, unknown>
    }
  })
  const out: ErpActionPreview[] = []
  let earlierWriteback = false
  for (const [index, action] of actions.entries()) {
    if (action.type !== 'erp_submit') {
      if (action.type === 'create_record') earlierWriteback = true
      continue
    }
    const base: ErpActionPreview = {
      index,
      api_id: null,
      endpoint_path: action.endpoint_path ?? null,
      method: action.method ?? 'POST',
      blocking: action.blocking === true,
      push_when: action.push_when ?? null,
      status: 'would_push',
      reason: null,
      guard_failed: null,
      after_earlier_writeback: earlierWriteback,
      body: null,
      last: null,
      contract_missing: []
    }
    if (action.on_success?.set || action.on_success_children?.length) earlierWriteback = true
    const apiId = action.external_api ? await resolveExternalApiId(action.external_api) : null
    base.api_id = apiId
    let context: Record<string, unknown> = {}
    if (!notConfiguredField(action, apiId)) {
      const ctxDefs = await contextDefsFor(action)
      context = await cached(`ctx:${JSON.stringify(ctxDefs ?? {})}`, () =>
        buildContext(ctxDefs, item, record, opts.userId)
      )
    }
    const gate = erpActionGateDetail(action, record, context, { apiId })
    if (gate && gate.kind !== 'guard') {
      out.push({
        ...base,
        status: gate.kind === 'not_configured' ? 'not_configured' : 'not_applicable',
        reason: gate.reason
      })
      continue
    }
    // Past not_configured, so the api and endpoint are set.
    const endpointPath = action.endpoint_path as string
    base.last = await cached(`last:${apiId}:${endpointPath}`, () =>
      lastLandedSubmission(collection, item, apiId as number, endpointPath)
    )
    if (gate?.rule) {
      const rule = gate.rule
      out.push({
        ...base,
        status: 'guard',
        reason: gate.reason,
        guard_failed: {
          field: rule.field,
          op: String(rule.op ?? 'eq'),
          value: rule.value ?? null,
          actual: record[rule.field] ?? null
        }
      })
      continue
    }
    const scope = {
      record,
      context,
      state: opts.newStateObj,
      acting_user: await cached(`acting:${opts.userId ?? ''}`, () => actingUser(opts.userId)),
      responses: [],
      response: null
    }
    let body: Record<string, unknown>
    try {
      // The same render as the real push, so the payload signature matches.
      body = await renderActionBody(action, scope, apiId as number)
    } catch (err) {
      out.push({
        ...base,
        status: 'template_error',
        reason: skipReason('template_error', err instanceof Error ? err.message : String(err))
      })
      continue
    }
    base.body = body
    if (action.push_when) {
      const signature =
        action.push_when.payload === true
          ? payloadSignature(body)
          : changeSignature(record, action.push_when.fields)
      const go = shouldPush({
        pushWhen: action.push_when,
        stateChanged: !!opts.newStateObj,
        signature,
        lastSignature: base.last?.change_signature ?? null
      })
      if (!go) {
        base.status = 'unchanged'
        base.reason = skipReason(
          'push_when',
          action.push_when.payload === true
            ? 'payload unchanged since the last landed push'
            : `no change in ${(action.push_when.fields ?? []).join(', ') || 'the watched fields'}`
        )
      }
    }
    try {
      const apiRow = (await db('nivaro_external_apis')
        .where({ id: Number(apiId) })
        .first('outbound_contract')) as { outbound_contract: string | null } | undefined
      const contract = apiRow?.outbound_contract
        ? (JSON.parse(apiRow.outbound_contract) as { required?: string[] })
        : null
      if (contract?.required?.length) {
        base.contract_missing = contract.required.filter((path) => {
          const v = String(path)
            .split('.')
            .reduce<unknown>(
              (cur, seg) =>
                cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[seg] : undefined,
              body
            )
          return v === undefined || v === null || v === ''
        })
      }
    } catch {
      /* contract check is advisory */
    }
    out.push(base)
  }
  return out
}

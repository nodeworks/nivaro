import { Liquid } from 'liquidjs'
import { db } from '../db/index.js'
import { logActivity } from './activity.js'
import { changeSignature, payloadSignature, type PushWhen, shouldPush } from './erp-push-gate.js'
import { callExternalApi } from './external-apis.js'
import { evalConditionRule, type ConditionRule } from './workflow-conditions.js'

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
//       "materials": { "collection": "inventory_request_materials", "filter": { "inventory_request": "$id" }, "limit": 500 }
//     },
//     "payload_template": "{ ...liquid producing JSON... }",
//     "on_success": { "set": { "order_number": "{{ response.salesOrderNumber }}" } },
//     "on_failure": { "set": { "mdsi_status": "error" } }
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

interface ContextQueryDef {
  collection: string
  filter?: Record<string, unknown>
  /** Restrict rows to those with a matching junction row — expresses
   *  "lines whose <m2m alias> includes X" (e.g. materials whose warehouses
   *  junction carries the MDSi warehouse id). */
  junction_filter?: { junction: string; fk_to_row: string; field: string; value: unknown }
  limit?: number
  /** Per-row M2O expansion: fk column → {collection, fields}; merged as <fk>_data. */
  expand?: Record<string, { collection: string; fields: string[] }>
  /** Order rows: column name, '-' prefix for desc (e.g. '-id' = newest first). */
  sort?: string
}

interface TransitionActionDef {
  type: string
  external_api: number | string
  endpoint_path: string
  method?: string
  guard?: ConditionRule[]
  context?: Record<string, ContextQueryDef>
  payload_template: string
  on_success?: { set?: Record<string, string> }
  /** Child-row writebacks applied after a successful call — e.g. autofill each
   *  MDSi line's sales_order_id from the returned order number. `only_empty`
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
  /** Detect 200-with-error-body responses (Fusion IIP style) — when a `when`
   *  rule matches, the submission records as FAILED with the mined message
   *  even though the HTTP status was 2xx. See ResponseErrorConfig. */
  response_error?: ResponseErrorConfig
  /** Blocking actions run BEFORE the transition mutation; a failure ABORTS
   *  the transition (422 to the caller) instead of landing the new state —
   *  e.g. the MDSi submission, whose order number the next state requires. */
  blocking?: boolean
  /** Skip the action silently when this context key resolved to zero rows —
   *  for pushes that only apply when a related record exists (e.g. MWF link). */
  skip_when_empty?: string
  /** Skip silently unless AT LEAST ONE dotted ref resolves non-empty — refs
   *  walk {record, context} (e.g. ['context.mwf_link.0.mwf_id', 'record.mwf_id']
   *  = "has an MWF id from either source"). OR-semantics counterpart to guard's
   *  AND rules. */
  skip_unless_any?: string[]
  /** When to push at all — see services/erp-push-gate.ts. Absent = every
   *  transition, which is how this behaved before the option existed. */
  push_when?: PushWhen
  // create_record type only:
  target_collection?: string
  skip_if_exists?: { match_field: string; value_template: string }
  link_field?: string
  m2m?: Record<
    string,
    { junction_collection: string; parent_field: string; related_field: string; values_template: string }
  >
}

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

const engine = new Liquid({ strictFilters: false, strictVariables: false })

engine.registerFilter('add_days', (v: unknown, n: unknown) => {
  const d = new Date(String(v ?? new Date().toISOString()))
  if (Number.isNaN(d.getTime())) return v
  d.setDate(d.getDate() + Number(n ?? 0))
  return d.toISOString().slice(0, 10)
})
// JSON.stringify anything — undefined/missing renders as null, keeping
// generated JSON payloads valid without per-field if-guards.
engine.registerFilter('jsonify', (v: unknown) => JSON.stringify(v ?? null))
// Editor.js document JSON → plain text: paragraph/header block texts joined with
// spaces, HTML tags stripped. Non-editorjs strings pass through unchanged.
engine.registerFilter('editorjs_text', (v: unknown) => {
  const raw = String(v ?? '')
  try {
    const doc = JSON.parse(raw) as { blocks?: Array<{ data?: { text?: string } }> }
    if (!Array.isArray(doc.blocks)) return raw
    return doc.blocks
      .map((b) => String(b?.data?.text ?? ''))
      .filter(Boolean)
      .join(' ')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  } catch {
    // Post-conversion notes are HTML — strip to plain text the same way an
    // EditorJS doc's inline markup was stripped.
    if (/^\s*</.test(raw)) {
      return raw
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim()
    }
    return raw
  }
})
engine.registerFilter('iso_date', (v: unknown) => {
  const d = new Date(String(v ?? ''))
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10)
})
engine.registerFilter('at_least_days_out', (v: unknown, n: unknown) => {
  const min = new Date()
  min.setDate(min.getDate() + Number(n ?? 0))
  const d = new Date(String(v ?? ''))
  const pick = Number.isNaN(d.getTime()) || d < min ? min : d
  return pick.toISOString().slice(0, 10)
})

let blackoutCache: { dates: Set<string>; loadedAt: number } | null = null
async function blackoutDates(): Promise<Set<string>> {
  if (blackoutCache && Date.now() - blackoutCache.loadedAt < 300_000) return blackoutCache.dates
  const dates = new Set<string>()
  try {
    const rows = (await db('nivaro_blackout_dates').select('date')) as Array<{ date: unknown }>
    for (const r of rows) {
      const d = new Date(String(r.date))
      if (!Number.isNaN(d.getTime())) dates.add(d.toISOString().slice(0, 10))
    }
  } catch {
    /* table missing — no blackouts */
  }
  blackoutCache = { dates, loadedAt: Date.now() }
  return dates
}
engine.registerFilter('next_open_day', async (v: unknown) => {
  const blocked = await blackoutDates()
  const d = new Date(String(v ?? ''))
  if (Number.isNaN(d.getTime())) return v
  for (let i = 0; i < 60; i++) {
    const iso = d.toISOString().slice(0, 10)
    const day = d.getUTCDay()
    if (day !== 0 && day !== 6 && !blocked.has(iso)) return iso
    d.setDate(d.getDate() + 1)
  }
  return d.toISOString().slice(0, 10)
})

function parseActions(raw: string | null | undefined): TransitionActionDef[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as TransitionActionDef[]) : []
  } catch {
    return []
  }
}

// nivaro_users is the ONLY system collection reachable from context queries —
// submissions routinely need requester/contact emails. Fields are always an
// explicit identifier-checked list, never *.
const CONTEXT_SAFE_SYSTEM = new Set(['nivaro_users'])
function collectionAllowed(name: string | undefined): name is string {
  if (!name || !IDENTIFIER_RE.test(name)) return false
  return !/^nivaro_/i.test(name) || CONTEXT_SAFE_SYSTEM.has(name)
}

async function buildContext(
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
        q = q.whereIn('id', db(jf.junction).select(jf.fk_to_row).where(jf.field, jf.value as never))
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

async function applyWriteback(
  collection: string,
  itemId: string,
  set: Record<string, string> | undefined,
  scope: Record<string, unknown>
): Promise<void> {
  if (!set) return
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
  if (Object.keys(patch).length === 0) return
  try {
    await db(collection).where({ id: itemId }).update(patch)
  } catch (err) {
    console.error({ err, collection, itemId }, 'transition action writeback failed')
  }
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

export class TransitionBlockedError extends Error {
  statusCode = 422
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
 * (Fusion IIP) answer HTTP 200 with `status: "ERROR"` in the BODY, so a 2xx
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

export async function runTransitionActions(opts: {
  transition: { id: string; label: string; actions: string | null }
  instance: { collection: string; item: string }
  newStateObj: { key: string; label: string } | null
  userId: string | null
  /** 'blocking' runs only blocking:true actions (pre-transition; a failure
   *  returns blockedError), 'post' runs the rest. Default runs everything —
   *  legacy callers keep their behavior. */
  phase?: 'blocking' | 'post'
}): Promise<{ blockedError: string | null }> {
  const all = parseActions(opts.transition.actions)
  const actions =
    opts.phase === 'blocking'
      ? all.filter((a) => a.blocking === true)
      : opts.phase === 'post'
        ? all.filter((a) => a.blocking !== true)
        : all
  if (actions.length === 0) return { blockedError: null }

  const { collection, item } = opts.instance

  const responses: unknown[] = []
  for (const action of actions) {
    if (action.type !== 'erp_submit' && action.type !== 'create_record') continue

    // Refetch per action so guards/templates see prior actions' writebacks
    let record: Record<string, unknown> = {}
    try {
      record = ((await db(collection).where({ id: item }).first()) ?? {}) as Record<string, unknown>
    } catch {
      record = {}
    }

    // Guard: every rule must pass or the action is skipped silently
    const guard = Array.isArray(action.guard) ? action.guard : []
    if (!guard.every((r) => evalConditionRule(r, record))) continue

    if (action.type === 'create_record') {
      await runCreateRecordAction(action, collection, item, record, opts.newStateObj, responses)
      continue
    }

    const apiId = await resolveExternalApiId(action.external_api)
    if (!apiId || !action.endpoint_path || !action.payload_template) continue

    const context = await buildContext(action.context, item, record, opts.userId)
    if (action.skip_when_empty) {
      const gate = context[action.skip_when_empty]
      if (gate == null || (Array.isArray(gate) && gate.length === 0)) continue
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
      if (!anySet) continue
    }
    const scope = {
      record,
      context,
      state: opts.newStateObj,
      responses,
      response: responses[responses.length - 1] ?? null
    }

    let body: Record<string, unknown>
    try {
      const rendered = await engine.parseAndRender(action.payload_template, scope)
      body = JSON.parse(rendered) as Record<string, unknown>
    } catch (err) {

      await recordSubmission(
        collection,
        item,
        apiId,
        action.endpoint_path,
        null,
        'failed',
        `payload template error: ${err instanceof Error ? err.message : String(err)}`
      )
      await applyWriteback(collection, item, action.on_failure?.set, {
        ...scope,
        error: String(err)
      })
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
        continue
      }
    }

    let status: 'pending' | 'accepted' | 'failed' = 'failed'
    let responseBody: unknown = null
    let error: string | null = null
    try {
      const res = await callExternalApi(apiId, {
        method: (action.method as 'POST' | 'PUT') ?? 'POST',
        path: action.endpoint_path,
        body,
        timeoutMs: 30_000,
        _log: { triggeredBy: 'transition-action', userId: opts.userId ?? undefined }
      })
      responseBody = res.body
      if (res.status >= 200 && res.status < 300) {
        // A 2xx can still be a rejection — some ERPs answer 200 with an error
        // status in the body. The action's `response_error` config decides;
        // without one, 2xx keeps meaning pending as before.
        const bodyError = detectConfiguredBodyError(
          action.response_error as ResponseErrorConfig | undefined,
          res.body
        )
        if (bodyError) {
          error = bodyError
        } else {
          status = 'pending'
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
    await recordSubmission(
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
      status === 'failed' ? null : signature
    )

    const postScope = { ...scope, response: responseBody, responses, error }
    if (status === 'failed') {
      await applyWriteback(collection, item, action.on_failure?.set, postScope)
      if (action.blocking === true) {
        // Abort the transition: the caller keeps the record in its current
        // state and surfaces the error. on_failure writebacks (mdsi_status =
        // 'error') already landed, which is what the form banner keys off.
        return { blockedError: `${opts.transition.label}: submission failed — ${error ?? 'unknown error'}` }
      }
    } else {
      await applyWriteback(collection, item, action.on_success?.set, postScope)
      await applyChildWritebacks(action.on_success_children, item, postScope)
    }
  }
  return { blockedError: null }
}

/** Render + apply per-child-row writebacks (see on_success_children). */
async function applyChildWritebacks(
  entries: TransitionActionDef['on_success_children'],
  itemId: string,
  scope: Record<string, unknown>
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
        q = q.whereIn('id', db(jf.junction).select(jf.fk_to_row).where(jf.field, jf.value as never))
      }
      const n = await q.update({ [e.field]: rendered })
      if (n > 0) console.info(`[transition-action] child writeback: ${e.collection}.${e.field} on ${n} rows`)
    } catch (err) {
      console.error({ err, entry: e }, 'transition action child writeback failed')
    }
  }
}

/**
 * create_record transition action: render a JSON payload from the transitioning
 * record (+context queries), create a row in another business collection, then
 * optionally link it back onto the record and insert M2M junction rows.
 * Idempotent via skip_if_exists (match on one column). EFP precedent: CAR
 * approval creating the project from workflow fields.
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
  await runCreateRecordAction(action, collection, itemId, record, null, [])
}

async function runCreateRecordAction(
  action: TransitionActionDef,
  collection: string,
  item: string,
  record: Record<string, unknown>,
  newStateObj: { key: string; label: string } | null,
  responses: unknown[]
): Promise<void> {
  const target = action.target_collection
  if (!target || !IDENTIFIER_RE.test(target) || /^nivaro_/i.test(target)) return
  if (!action.payload_template) return

  const context = await buildContext(action.context, item, record)
  const scope = { record, context, state: newStateObj, responses }

  try {
    // Reuse-existing check first — nothing is created when a match exists.
    let targetId: unknown = null
    if (action.skip_if_exists?.match_field && IDENTIFIER_RE.test(action.skip_if_exists.match_field)) {
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
      await db(target).insert(row)
      // MSSQL/tedious returns row-count on bare insert — insert-then-select
      // (same pattern as the relation POST route).
      const created = (await db(target).orderBy('id', 'desc').first('id')) as
        | { id: unknown }
        | undefined
      targetId = created?.id ?? null
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
            await db(cfg.junction_collection).insert({
              [cfg.parent_field]: targetId,
              [cfg.related_field]: rid
            })
          }
        } catch (err) {
          console.error({ err, alias }, 'create_record m2m insert failed')
        }
      }

      await logActivity({
        action: 'create',
        collection: target,
        item: String(targetId),
        user: null,
        comment: `created by transition action from ${collection}/${item}`
      })
    }

    // Link the created/found record back onto the transitioning record
    if (action.link_field && IDENTIFIER_RE.test(action.link_field)) {
      await db(collection)
        .where({ id: item })
        .update({ [action.link_field]: targetId })
    }

    responses.push({ created_id: targetId })
    await applyWriteback(collection, item, action.on_success?.set, {
      ...scope,
      created_id: targetId,
      responses
    })
  } catch (err) {
    console.error({ err, collection, item, target }, 'create_record transition action failed')
    await applyWriteback(collection, item, action.on_failure?.set, {
      ...scope,
      error: String(err)
    })
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

async function recordSubmission(
  collection: string,
  item: string,
  externalApi: number,
  endpointPath: string,
  body: Record<string, unknown> | null,
  status: 'pending' | 'accepted' | 'failed',
  error: string | null,
  responseBody?: unknown,
  signature?: string | null
): Promise<void> {
  try {
    const now = new Date()
    await db('nivaro_erp_submissions').insert({
      collection,
      item: String(item),
      external_api: externalApi,
      external_ref: null,
      status,
      attempts: 1,
      last_error: error,
      payload: JSON.stringify({ endpoint_path: endpointPath, body }),
      response: serializeResponseBody(responseBody),
      change_signature: signature ?? null,
      created_at: now,
      updated_at: now
    })
    await logActivity({
      action: 'create',
      collection: 'nivaro_erp_submissions',
      item: `${collection}/${item}`,
      user: null,
      comment: `transition action → api:${externalApi} (${status}${error ? `: ${error.slice(0, 120)}` : ''})`
    })
  } catch (err) {
    console.error({ err, collection, item }, 'failed to record ERP submission')
  }
}

/**
 * Doing something about an unmet obligation.
 *
 * Everything here SENDS, so everything here is gated behind
 * `nivaro_settings.integration_remediation_enabled` (migration 346) — a CORE
 * setting, deliberately, because this whole file lives in `api/src` and core
 * must never read an extension's config to decide whether it may act.
 * Without the switch on, every entry point reports that remediation is off
 * and does nothing. Shipping this changes no behaviour on any existing
 * deployment.
 *
 * Two functions actually send, both through the exact path the original send
 * used (`sendPayload`), so every guard and every side effect (the outbound
 * contract check, the activity trail) still applies — neither is ever a
 * bypass. Which one runs depends on whose evidence is being touched:
 *
 *  - `resendSubmission` MUTATES a submission the re-firing obligation
 *    already OWNS — `runRetryPass` climbing its own ladder, or `sendNow` on
 *    a `failed`/`overdue` row that already has a `submission_id`.
 *  - `refireFromPrior` never mutates anything that belongs to another
 *    obligation: for a `missing` row (`sendNow` on one, or
 *    `runMissingRefirePass`'s own sweep), the "most recent request" it is
 *    standing in for is someone ELSE's history, so it is CLONED into a
 *    fresh `nivaro_erp_submissions` row rather than rewritten in place.
 */
import { db } from '../db/index.js'
import { withChainStep } from './chain.js'
import { chainFields } from './chain-columns.js'
import { requesterInsertFields } from './erp-requester-columns.js'
import { hasResendableBody, NO_BODY } from './erp-resend-guard.js'
import {
  allObligationKinds,
  getObligationKind,
  type ObligationKindDef,
  resolveObligation
} from './integration-obligations.js'
import { secretPathsOf } from './secret-markers.js'

export type ErrorClass =
  | 'transient'
  | 'rate_limited'
  | 'auth'
  | 'not_found'
  | 'validation'
  | 'unknown'

/** Minutes between attempts. Five rungs, then we stop and ask a person. */
const LADDER = [1, 5, 30, 120, 120]
/** Classes where sending the identical bytes again could plausibly work. */
export const RETRYABLE_CLASSES: ErrorClass[] = ['transient', 'rate_limited', 'auth']
/** Outcomes that mean the ledger already considers this one closed — asking
 *  to re-send one of these is a genuine conflict, not "nothing to do yet". */
const CLOSED_OUTCOMES = new Set(['sent', 'skipped', 'superseded'])

/**
 * What KIND of failure this was — which is really the question "can sending
 * the same thing again help?". A 422 and a 404 cannot be fixed by
 * repetition; a 503 and a refused socket usually can. Backlog #628.
 *
 * Takes the BODY, not a pre-rendered error string, because a partner that
 * answers 200 and rejects inside the body is a case this codebase already
 * has (`detectBodyAcceptance`/`detectConfiguredBodyError` in
 * workflow-actions.ts), and a status code alone would call that a success.
 */
export function classifyError(httpStatus: number | null, body: unknown, err?: unknown): ErrorClass {
  if (httpStatus === 429) return 'rate_limited'
  if (httpStatus === 401 || httpStatus === 403) return 'auth'
  if (httpStatus === 404) return 'not_found'
  if (httpStatus != null && httpStatus >= 500) return 'transient'
  if (httpStatus != null && httpStatus >= 400) return 'validation'
  if (httpStatus != null && httpStatus >= 200 && httpStatus < 300) {
    // A 2xx that carries a rejection in its body is a validation failure —
    // repetition cannot help it either.
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      const status = String((body as Record<string, unknown>).status ?? '').toUpperCase()
      if (status === 'ERROR' || status === 'REJECTED' || status === 'FAILED') return 'validation'
    }
    return 'unknown'
  }
  const text =
    `${err instanceof Error ? `${err.message} ${String(err.cause ?? '')}` : String(err ?? '')}`.toUpperCase()
  if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ECONNRESET|EAI_AGAIN|SOCKET|FETCH FAILED/.test(text)) {
    return 'transient'
  }
  return 'unknown'
}

/** The backoff ladder: 1, 5, 30, 120 minutes, holding at the fifth attempt,
 *  then giving up (`null`) so the caller can mark the row `failed` and ask a
 *  person to look rather than retrying forever. */
export function nextRetryAt(attempts: number, lastAt: Date): Date | null {
  if (attempts >= LADDER.length) return null
  return new Date(lastAt.getTime() + LADDER[attempts] * 60_000)
}

/** The deployment's remediation switch. Off unless an admin turned it on in
 *  Settings → Integrations, so this code is inert on arrival. Exported so
 *  the read routes can report it once (never a second probe per row) and
 *  the shared UI can show "remediation is off" instead of a button that
 *  looks broken. */
export async function remediationEnabled(): Promise<boolean> {
  try {
    const row = (await db('nivaro_settings').first('integration_remediation_enabled')) as
      | { integration_remediation_enabled?: boolean | number | null }
      | undefined
    return (
      row?.integration_remediation_enabled === true || row?.integration_remediation_enabled === 1
    )
  } catch {
    return false
  }
}

/**
 * The most recent request ever made for this record on this API AND THIS
 * ENDPOINT — what "re-fire" and "send now on a `missing` row" both mean when
 * there is no submission tied to the obligation itself. Shared by `sendNow`
 * (a person clicked Send now on a `missing` row) and `runMissingRefirePass`
 * (the sweep did the same thing automatically), so the two can never
 * disagree about what counts as "the last thing we sent".
 *
 * The endpoint filter is not optional and not a refinement: several kinds
 * routinely share one API (MWF alone carries the state push, the
 * requisition-id push, the PO-number push and the completion push), and
 * (api, collection, item) alone would happily hand a `wf.state` re-fire the
 * rename hook's body — a request that carries no state at all. `endpoint_path`
 * is what the payload column stores alongside the body, and what the kinds'
 * own `expect()` queries already anchor on.
 */
async function mostRecentSubmissionFor(
  api: string,
  collection: string,
  item: string,
  endpointPath: string
): Promise<{ id: number } | undefined> {
  const endpoint = String(endpointPath ?? '').trim()
  if (endpoint === '') return undefined
  return (await db('nivaro_erp_submissions as es')
    .join('nivaro_external_apis as api', 'api.id', 'es.external_api')
    .where('es.collection', collection)
    .where('es.item', String(item))
    .where('api.name', api)
    .whereRaw("JSON_VALUE(es.payload, '$.endpoint_path') = ?", [endpoint])
    .orderBy('es.id', 'desc')
    .first('es.id')) as { id: number } | undefined
}

/**
 * May the sweep — or Send now on a `missing` row — repeat an earlier request
 * for this kind by itself? Opt-in on three counts, all of which must hold:
 *
 *  - the kind declares `safe_to_refire: true`. Absent is NO. Repeating bytes
 *    is only correct where the body cannot have gone stale.
 *  - the kind is not a person's to send (`human`). An obligation whose whole
 *    point is that a human pushes it must never be pushed by a sweep.
 *  - the kind names its `endpoint_path`, so the request repeated is provably
 *    the same SHAPE of request and not a sibling push's body.
 *
 * Returns the sentence for the ledger when the answer is no, so the board and
 * the Send-now button say the same thing for the same reason.
 */
export function refireRefusal(def: ObligationKindDef | undefined): string | null {
  if (!def) return 'this kind is no longer registered — a person needs to look'
  if (def.human) return 'this send belongs to a person — open the record and push it there'
  if (def.safe_to_refire !== true) {
    return 'this kind is never re-fired automatically — repeating the stored request could send stale data'
  }
  if (!String(def.endpoint_path ?? '').trim()) {
    return 'this kind does not name the endpoint it sends to, so an earlier request cannot be repeated safely'
  }
  return null
}

/**
 * Re-send ONE stored request, through the SAME path the original send used
 * (`sendPayload`), so guards still apply and a refusal is reported rather
 * than bypassed. Moves BOTH rows this touches:
 *
 *  - the submission itself, via `applySendOutcome` (erp-submission-status.ts,
 *    extended by this task) — `attempts` in particular, since that is what
 *    every backoff ladder counts. A re-send that only patched the
 *    obligation would leave every caller's ladder stuck on rung zero
 *    forever.
 *  - the obligation it belongs to, via `propagateSubmissionStatus` — the
 *    SAME sent/failed/pending mapping the manual retry route, the bulk
 *    retry route and the automatic sweep already use, so a resend can never
 *    disagree with them about what an outcome means.
 */
/** Why a send with no answer yet (`sending`, erp-unanswered.ts) is never repeated from here. */
const UNANSWERED_DETAIL =
  'the last send got no answer, so the partner may already have it — check there, then mark it received or not received'

async function resendSubmission(
  obligationId: number,
  submissionId: number,
  userId: string | null
): Promise<SendNowResult> {
  const { sendPayload } = await import('../routes/erp-submissions.js')
  const { applySendOutcome, propagateSubmissionStatus } = await import('./erp-submission-status.js')

  const sub = (await db('nivaro_erp_submissions')
    .where({ id: submissionId })
    .first('external_api', 'payload', 'external_ref', 'attempts', 'status')) as
    | {
        external_api: number
        payload: string | null
        external_ref: string | null
        attempts: number
        status?: string | null
      }
    | undefined
  if (!sub) return { detail: 'the original request is no longer stored' }
  if (sub.status === 'sending') return { detail: UNANSWERED_DETAIL }

  let stored: { endpoint_path: string; body: Record<string, unknown> }
  try {
    stored = JSON.parse(sub.payload ?? '') as {
      endpoint_path: string
      body: Record<string, unknown>
    }
    if (!stored?.endpoint_path) throw new Error('no endpoint_path')
  } catch {
    return { detail: 'the original request is not readable' }
  }
  // A payload template that refused to render recorded the row with no body: nothing to send.
  if (!hasResendableBody(stored)) return { detail: NO_BODY.message, code: NO_BODY.error }

  // The resend's call log + attempt row nest under the submission it re-sends.
  const outcome = await withChainStep(`submission:${submissionId}`, async () => {
    const sent = await sendPayload(sub.external_api, stored, userId ?? undefined)
    await applySendOutcome({
      submissionId,
      outcome: sent,
      priorExternalRef: sub.external_ref,
      priorAttempts: sub.attempts,
      // A person's "Send now" is a resend; the retry ladder has nobody behind it.
      requestedBy: userId,
      requestedVia: userId ? 'resend' : 'cron'
    })
    return sent
  })
  await propagateSubmissionStatus({
    submissionId,
    status: outcome.status,
    error: outcome.error,
    obligationId
  })

  return { detail: `re-sent: ${outcome.status}${outcome.error ? ` — ${outcome.error}` : ''}` }
}

/**
 * Re-fire a `missing` obligation by CLONING the most recent prior submission
 * into a FRESH row, rather than mutating it in place.
 *
 * RULING: the "prior" submission `mostRecentSubmissionFor` finds belongs to
 * some OTHER obligation — quite possibly one that is already `sent`, and its
 * row is that obligation's own evidence of what actually happened. Re-firing
 * a `missing` obligation must never rewrite it: `resendSubmission` (above)
 * is correct ONLY when the obligation being acted on already owns the
 * submission it is re-sending — that is not true here. So this reads the
 * prior row (collection, item, external_api, payload, change_signature)
 * WITHOUT ever writing to it, inserts a brand-new row stamped with THIS
 * obligation's own id, and applies the send outcome to that new row only.
 * The prior obligation's submission is byte-unchanged afterward.
 */
async function refireFromPrior(
  obligationId: number,
  priorSubmissionId: number,
  userId: string | null
): Promise<SendNowResult> {
  const prior = (await db('nivaro_erp_submissions')
    .where({ id: priorSubmissionId })
    .first('collection', 'item', 'external_api', 'payload', 'change_signature', 'status')) as
    | {
        collection: string
        item: string
        external_api: number
        payload: string | null
        change_signature: string | null
        status?: string | null
      }
    | undefined
  if (!prior) return { detail: 'the original request is no longer stored' }
  if (prior.status === 'sending') return { detail: UNANSWERED_DETAIL }

  let stored: StoredRequest
  try {
    stored = JSON.parse(prior.payload ?? '') as StoredRequest
    if (!stored?.endpoint_path) throw new Error('no endpoint_path')
  } catch {
    return { detail: 'the original request is not readable' }
  }
  // Checked before the shell row exists: a body-less prior (a render failure) has nothing to
  // repeat, and a pending shell left behind would read as a send in flight.
  if (!hasResendableBody(stored)) return { detail: NO_BODY.message, code: NO_BODY.error }

  const outcome = await sendIntoNewRow(
    obligationId,
    {
      collection: prior.collection,
      item: prior.item,
      external_api: prior.external_api,
      payload: prior.payload as string,
      change_signature: prior.change_signature
    },
    stored,
    userId
  )
  if (!outcome) return { detail: 'could not create a submission row to re-fire into' }
  return { detail: `re-sent: ${outcome.status}${outcome.error ? ` — ${outcome.error}` : ''}` }
}

type StoredRequest = {
  endpoint_path: string
  body: Record<string, unknown>
  secret_paths?: string[]
}

/**
 * The one "send into a brand-new submission row" sequence — a re-fire of
 * someone else's request (`refireFromPrior`) and a fresh send built from the
 * record's current data (`sendFresh`) both land here, so neither can drift
 * from the other or from every other sender:
 *
 * The shell row starts `pending` with `attempts: 0`, stamped with THIS
 * obligation's id; `sendPayload` (the same guards as every resend) makes the
 * call inside the submission's chain step; `applySendOutcome` writes the
 * row (attempts → 1, status, error_class); `propagateSubmissionStatus` moves
 * the obligation and points its `submission_id` at the new row.
 * Returns null when no row could be created.
 */
async function sendIntoNewRow(
  obligationId: number,
  identity: {
    collection: string
    item: string
    external_api: number
    payload: string
    change_signature: string | null
  },
  stored: StoredRequest,
  userId: string | null
): Promise<{ status: string; error?: string | null } | null> {
  const now = new Date()
  // Probed once per tenant — naming a column this database hasn't run
  // migration 350 for fails the WHOLE insert, not just these two fields.
  const requesterFields = await requesterInsertFields(
    'nivaro_erp_submissions',
    userId,
    userId ? 'resend' : 'cron'
  )
  const inserted = (await db('nivaro_erp_submissions')
    .insert({
      collection: identity.collection,
      item: identity.item,
      external_api: identity.external_api,
      external_ref: null,
      status: 'pending',
      attempts: 0,
      last_error: null,
      payload: identity.payload,
      change_signature: identity.change_signature,
      obligation_id: obligationId,
      ...requesterFields,
      ...(await chainFields('nivaro_erp_submissions')),
      created_at: now,
      updated_at: now
    })
    .returning('id')) as Array<number | { id: number }>
  const first = inserted[0]
  // tedious hands an OBJECT back from .returning on this stack.
  const newId =
    typeof first === 'object' && first !== null ? Number(first.id) : Number(first ?? 0) || null
  if (!newId) return null

  const { sendPayload } = await import('../routes/erp-submissions.js')
  const { applySendOutcome, propagateSubmissionStatus } = await import('./erp-submission-status.js')

  const outcome = await withChainStep(`submission:${newId}`, async () => {
    const sent = await sendPayload(identity.external_api, stored, userId ?? undefined)
    await applySendOutcome({
      submissionId: newId,
      outcome: sent,
      priorExternalRef: null,
      priorAttempts: 0,
      requestedBy: userId,
      requestedVia: userId ? 'resend' : 'cron'
    })
    return sent
  })
  // resolveObligation (inside propagateSubmissionStatus) is what points the
  // obligation's own submission_id at the NEW row — no other obligation's
  // row is ever touched by this call.
  await propagateSubmissionStatus({
    submissionId: newId,
    status: outcome.status,
    error: outcome.error,
    obligationId
  })
  return outcome
}

/**
 * May a PERSON send this kind's request rebuilt from the record's current
 * data? Only when the kind declares a builder (`fresh_request`), the send is
 * not a person's own to make on the record (`human` — a Fusion submit is
 * never pushed from here), and the kind names its endpoint. Null = yes.
 */
export function freshSendRefusal(def: ObligationKindDef | undefined): string | null {
  if (!def) return 'this kind is no longer registered — a person needs to look'
  if (def.human) return 'this send belongs to a person — open the record and push it there'
  if (typeof def.fresh_request !== 'function' && !def.fresh_from_transition) {
    return 'this kind cannot rebuild its request from the current data'
  }
  if (!String(def.endpoint_path ?? '').trim()) {
    return 'this kind does not name the endpoint it sends to'
  }
  return null
}

/** What Send now may offer on one obligation row, for the record banner and
 *  the board: repeat a stored request (its own, or — for a kind that allows
 *  it — the newest prior one), and/or send the record's current data. */
export function sendOptionsFor(
  def: ObligationKindDef | undefined,
  row: { submission_id?: number | null }
): { can_resend: boolean; can_send_current: boolean } {
  return {
    can_resend: row.submission_id != null || refireRefusal(def) === null,
    can_send_current: freshSendRefusal(def) === null
  }
}

type FreshBuild =
  | {
      ok: true
      row: { id: number; api: string; kind: string; collection: string; item: string }
      apiId: number
      request: { endpoint_path: string; body: Record<string, unknown>; summary: string }
    }
  | { ok: false; detail: string }

/** Build (never send) the current-data request for one obligation. */
async function buildFresh(obligationId: number, userId: string | null): Promise<FreshBuild> {
  const row = (await db('nivaro_integration_obligations')
    .where({ id: obligationId })
    .first('id', 'api', 'kind', 'collection', 'item')) as
    | { id: number; api: string; kind: string; collection: string; item: string }
    | undefined
  if (!row) return { ok: false, detail: 'no such obligation' }
  const def = getObligationKind(row.api, row.kind)
  const refusal = freshSendRefusal(def)
  if (refusal || !def) return { ok: false, detail: `not sent: ${refusal}` }
  if (typeof def.fresh_request !== 'function' && def.fresh_from_transition) {
    return buildFreshFromTransition(row, def, userId)
  }
  if (typeof def.fresh_request !== 'function') {
    return {
      ok: false,
      detail: 'not sent: this kind cannot rebuild its request from the current data'
    }
  }
  const api = (await db('nivaro_external_apis').where({ name: row.api }).first('id')) as
    | { id: number }
    | undefined
  if (!api) return { ok: false, detail: `not sent: ${row.api} is not set up on this instance` }
  let built: Awaited<ReturnType<NonNullable<ObligationKindDef['fresh_request']>>>
  try {
    built = await def.fresh_request(db, String(row.item))
  } catch (err) {
    return {
      ok: false,
      detail: `not sent: the message could not be built (${err instanceof Error ? err.message : String(err)})`
    }
  }
  if ('refused' in built) return { ok: false, detail: `not sent: ${built.refused}` }
  // The builder may only produce the kind's own shape of request — never a
  // sibling push's endpoint.
  if (String(built.endpoint_path ?? '').trim() !== String(def.endpoint_path ?? '').trim()) {
    return { ok: false, detail: 'not sent: the rebuilt request is for a different endpoint' }
  }
  if (!built.body || typeof built.body !== 'object' || Array.isArray(built.body)) {
    return { ok: false, detail: 'not sent: the message could not be built (no body)' }
  }
  return { ok: true, row, apiId: Number(api.id), request: built }
}

/**
 * The current-data request for a send a TRANSITION makes (e.g. MWF's state push): core's own
 * erp_submit render for a transition into the record's current state
 * (`buildErpPushForCurrentState`), as the clicking person.
 */
async function buildFreshFromTransition(
  row: { id: number; api: string; kind: string; collection: string; item: string },
  def: ObligationKindDef,
  userId: string | null
): Promise<FreshBuild> {
  const { buildErpPushForCurrentState } = await import('./workflow-actions.js')
  const { plainObligationReason } = await import('./obligation-reason-text.js')
  let built: Awaited<ReturnType<typeof buildErpPushForCurrentState>>
  try {
    built = await buildErpPushForCurrentState({
      collection: row.collection,
      item: String(row.item),
      apiName: row.api,
      endpointPath: String(def.endpoint_path ?? ''),
      userId,
      states: {
        only: def.fresh_from_transition?.only_states,
        except: def.fresh_from_transition?.except_states
      }
    })
  } catch (err) {
    return {
      ok: false,
      detail: `not sent: the message could not be built (${err instanceof Error ? err.message : String(err)})`
    }
  }
  if ('refused' in built)
    return { ok: false, detail: `not sent: ${plainObligationReason(built.refused)}` }
  return {
    ok: true,
    row,
    apiId: built.api_id,
    request: {
      endpoint_path: built.endpoint_path,
      body: built.body,
      summary: built.transition_label
        ? `${built.state.label}, as “${built.transition_label}” sends it`
        : built.state.label
    }
  }
}

/** What "Send current data" would send — for the confirm. Sends nothing. */
export async function freshSendPreview(
  obligationId: number,
  userId: string | null = null
): Promise<{ available: boolean; api?: string; summary?: string; detail?: string }> {
  const b = await buildFresh(obligationId, userId)
  if (!b.ok) return { available: false, detail: b.detail }
  return { available: true, api: b.row.api, summary: b.request.summary }
}

/**
 * A person clicked "Send current data": rebuild the request from the
 * record as it is NOW (the kind's own builder — the same template its live
 * sender renders) and send it through the normal path into a fresh
 * submission row. Never called by a sweep: `runRetryPass` and
 * `runMissingRefirePass` only ever repeat stored requests.
 */
export async function sendFresh(
  obligationId: number,
  userId: string | null
): Promise<SendNowResult> {
  if (!(await remediationEnabled())) {
    return { detail: 'remediation is off for this deployment' }
  }
  const b = await buildFresh(obligationId, userId)
  if (!b.ok) return { detail: b.detail }
  const stored: StoredRequest = {
    endpoint_path: b.request.endpoint_path,
    body: b.request.body,
    // The template's own placeholders (body secrets) — the same list every
    // sender stores, so sendPayload honours exactly those.
    secret_paths: secretPathsOf(b.request.body)
  }
  if (!hasResendableBody(stored)) return { detail: NO_BODY.message, code: NO_BODY.error }
  const outcome = await sendIntoNewRow(
    obligationId,
    {
      collection: b.row.collection,
      item: String(b.row.item),
      external_api: b.apiId,
      payload: JSON.stringify(stored),
      change_signature: null
    },
    stored,
    userId
  )
  if (!outcome) return { detail: 'could not create a submission row to send into' }
  return {
    detail: `sent current data (${b.request.summary}): ${outcome.status}${outcome.error ? ` — ${outcome.error}` : ''}`
  }
}

/** What Send now did. `code: 'no_body'` = the submission it would resend has no body (the route
 *  answers 409). */
export type SendNowResult = {
  detail: string
  code?: 'no_body' | 'fresh_available'
}

/**
 * A person clicked "Send now" on one obligation. When the obligation has a
 * submission of its own, that gets re-sent (the ordinary failed/overdue
 * case) — that row is this obligation's OWN evidence of what it tried, so
 * repeating it is exactly what the button says.
 *
 * When it does not — a `missing` obligation, by definition, since nothing
 * was ever attempted for it — the only thing available to repeat is some
 * OTHER obligation's request, and whether that is safe is a property of the
 * kind, not of who clicked: `refireRefusal` decides, identically here and in
 * the automatic sweep. A person clicking a button does not make a stale
 * `efp_state` fresh, and does not turn a Fusion requisition into something
 * the button should create behind the owner's back. When it is allowed, the
 * prior request is CLONED into a fresh row (`refireFromPrior`) rather than
 * rewritten, because it is someone else's history.
 */
export async function sendNow(obligationId: number, userId: string | null): Promise<SendNowResult> {
  if (!(await remediationEnabled())) {
    return { detail: 'remediation is off for this deployment' }
  }
  const row = (await db('nivaro_integration_obligations')
    .where({ id: obligationId })
    .first('id', 'api', 'kind', 'collection', 'item', 'submission_id')) as
    | {
        id: number
        api: string
        kind: string
        collection: string
        item: string
        submission_id: number | null
      }
    | undefined
  if (!row) return { detail: 'no such obligation' }

  if (row.submission_id) {
    return resendSubmission(obligationId, row.submission_id, userId)
  }

  const def = getObligationKind(row.api, row.kind)
  // Nothing safe to repeat — but a kind that can rebuild its request from the
  // current data says so, and the person chooses "Send current data" (a
  // separate, explicitly confirmed click; never done here by itself).
  const fresh = freshSendRefusal(def) === null
  const refusal = refireRefusal(def)
  if (refusal) {
    return fresh
      ? {
          detail: 'the stored request could be out of date — send the current data instead',
          code: 'fresh_available'
        }
      : { detail: `not re-sent: ${refusal}` }
  }

  const prior = await mostRecentSubmissionFor(
    row.api,
    row.collection,
    row.item,
    String(def?.endpoint_path ?? '')
  )
  if (!prior) {
    return fresh
      ? {
          detail: 'nothing was ever sent for this record — send the current data instead',
          code: 'fresh_available'
        }
      : { detail: 'nothing to re-send — this send has never run for this record' }
  }
  return refireFromPrior(obligationId, prior.id, userId)
}

/**
 * Retry the failures worth retrying.
 *
 * Deliberately narrow: the pre-existing `runErpAutoRetries`
 * (routes/erp-submissions.ts) already climbs its OWN ladder for any API
 * carrying a `retry_policy`, so this covers only the obligations whose API
 * has none — running both over one row would double its attempt count and
 * halve its backoff. `validation` and `not_found` never appear here at all
 * (RETRYABLE_CLASSES excludes them): repeating identical bytes cannot fix
 * either.
 */
/** One row of a remediation preview (#772). */
export interface RemediationPlanRow {
  obligation_id: number
  submission_id?: number | null
  api: string | null
  kind: string | null
  collection: string | null
  item: string | null
  error_class?: string | null
  attempts?: number
  /** When the retry ladder next allows a send (retry pass, waiting rows). */
  due_at?: string | null
  /** Why nothing will be sent (queued / left for a person). */
  reason?: string | null
}

/** What the first retry pass would do — sends nothing (#772). */
export interface RetryPlan {
  retry: RemediationPlanRow[]
  waiting: RemediationPlanRow[]
  give_up: RemediationPlanRow[]
  by_error_class: Record<string, { retry: number; waiting: number; give_up: number }>
}

export async function runRetryPass(
  opts: { dryRun?: boolean } = {}
): Promise<{ retried: number; gaveUp: number; plan?: RetryPlan }> {
  const dryRun = opts.dryRun === true
  if (!dryRun && !(await remediationEnabled())) return { retried: 0, gaveUp: 0 }

  const rows = (await db('nivaro_integration_obligations as o')
    .where('o.outcome', 'failed')
    .whereNotNull('o.submission_id')
    // Never re-consider a row this same pass already gave up on — without
    // this a row past the ladder would be re-selected, re-fail
    // `nextRetryAt`, and re-write the identical "gave up" reason on every
    // 15-minute tick forever.
    .where((qb) => qb.whereNull('o.reason').orWhereNot('o.reason', 'like', 'gave up:%'))
    .join('nivaro_erp_submissions as es', 'es.id', 'o.submission_id')
    .whereIn('es.error_class', RETRYABLE_CLASSES)
    .leftJoin('nivaro_external_apis as api', 'api.id', 'es.external_api')
    // Leave rows the pre-existing sweep owns to the pre-existing sweep.
    .whereNull('api.retry_policy')
    .limit(50)
    .select(
      'o.id',
      'o.submission_id',
      'es.attempts',
      'es.updated_at',
      'es.error_class',
      'o.api',
      'o.kind',
      'o.collection',
      'o.item'
    )) as Array<{
    id: number
    submission_id: number
    attempts: number
    updated_at: Date
    error_class?: string | null
    api?: string | null
    kind?: string | null
    collection?: string | null
    item?: string | null
  }>

  if (dryRun) {
    // The same rows, the same ladder, the same "due" test as below — and no
    // write, no resend, no ledger update.
    const now = new Date()
    const plan: RetryPlan = { retry: [], waiting: [], give_up: [], by_error_class: {} }
    for (const r of rows) {
      const due = nextRetryAt(r.attempts, new Date(r.updated_at))
      const cls = String(r.error_class ?? 'unknown')
      const bucket = plan.by_error_class[cls] ?? { retry: 0, waiting: 0, give_up: 0 }
      plan.by_error_class[cls] = bucket
      const row: RemediationPlanRow = {
        obligation_id: Number(r.id),
        submission_id: Number(r.submission_id),
        api: r.api ?? null,
        kind: r.kind ?? null,
        collection: r.collection ?? null,
        item: r.item != null ? String(r.item) : null,
        error_class: cls,
        attempts: Number(r.attempts ?? 0),
        due_at: due ? due.toISOString() : null
      }
      if (!due) {
        plan.give_up.push({ ...row, reason: 'five attempts made — a person needs to look' })
        bucket.give_up++
      } else if (due > now) {
        plan.waiting.push(row)
        bucket.waiting++
      } else {
        plan.retry.push(row)
        bucket.retry++
      }
    }
    return { retried: 0, gaveUp: 0, plan }
  }

  let retried = 0
  let gaveUp = 0
  const now = new Date()
  for (const r of rows) {
    const due = nextRetryAt(r.attempts, new Date(r.updated_at))
    if (!due) {
      gaveUp++
      await resolveObligation(r.id, {
        outcome: 'failed',
        reason: 'gave up: five attempts made, a person needs to look'
      })
      continue
    }
    if (due > now) continue
    const sent = await resendSubmission(r.id, r.submission_id, null)
    if (sent.code === 'no_body') {
      // Nothing to send, ever: classify it 'validation' (as runErpAutoRetries does) so this
      // pass stops selecting it — otherwise it is revisited on every tick forever.
      await db('nivaro_erp_submissions')
        .where({ id: r.submission_id })
        .update({ error_class: 'validation' })
        .catch(() => {})
      continue
    }
    retried++
  }
  return { retried, gaveUp }
}

/**
 * `missing` → re-fire (spec §2.5).
 *
 * The sweep found an expectation the partner is behind on with no send ever
 * attempted at all — the trigger did not fire. Core cannot re-run WHATEVER
 * decision point would have fired it (that lives in an extension, and the
 * registry carries no "fire this" callback, only `expect()` for
 * reconciliation), so the best it can do is repeat the most recent request
 * ever made for the same record on the same API — the same standing-in rule
 * `sendNow` uses when a person clicks Send now on a `missing` row.
 *
 * Re-firing is OPT-IN (`refireRefusal`): a kind is repeated only when it
 * says `safe_to_refire: true`, is not a person's to send, and names the
 * endpoint its body belongs to. Everything else is QUEUED — which here means
 * LEFT ALONE, still `missing`, for a person. It is deliberately not rewritten
 * to `failed`: `missing` is the one outcome that says "the trigger never
 * fired", which is the most diagnostic thing the ledger knows, and laundering
 * it into `failed` would both lose that and flip the readiness check's only
 * FAIL tier to a warning without anything being fixed.
 */
/** What the first missing-obligation re-fire pass would do — sends nothing
 *  (#772). `left_for_a_person` counts the `missing` rows of kinds that never
 *  re-fire by themselves, with the reason the ledger gives for each kind. */
export interface RefirePlan {
  refire: RemediationPlanRow[]
  queued: RemediationPlanRow[]
  left_for_a_person: Array<{ api: string; kind: string; count: number; reason: string }>
}

/** Open `missing` rows per kind that the sweep will never touch, and why. */
async function missingLeftForAPerson(): Promise<RefirePlan['left_for_a_person']> {
  const counts = (await db('nivaro_integration_obligations')
    .where({ outcome: 'missing' })
    .whereNull('resolved_at')
    .groupBy('api', 'kind')
    .select('api', 'kind')
    .count({ n: '*' })) as Array<{ api: string; kind: string; n: number | string }>
  const out: RefirePlan['left_for_a_person'] = []
  for (const c of counts) {
    const refusal = refireRefusal(getObligationKind(c.api, c.kind))
    if (refusal) out.push({ api: c.api, kind: c.kind, count: Number(c.n), reason: refusal })
  }
  return out.sort((a, b) => b.count - a.count)
}

export async function runMissingRefirePass(
  opts: { dryRun?: boolean } = {}
): Promise<{ refired: number; queued: number; plan?: RefirePlan }> {
  const dryRun = opts.dryRun === true
  if (!dryRun && !(await remediationEnabled())) return { refired: 0, queued: 0 }

  // Only the kinds that opted in are even READ. Selecting the oldest 25
  // `missing` rows regardless and then refusing most of them would starve
  // the re-fireable ones out of every batch forever, since a refused row is
  // deliberately left exactly where it is (no write, so it never ages out of
  // the front of the queue). Nothing opted in = no database work at all.
  const refireable = allObligationKinds().filter((d) => refireRefusal(d) === null)
  const plan: RefirePlan | undefined = dryRun
    ? {
        refire: [],
        queued: [],
        left_for_a_person: await missingLeftForAPerson().catch(() => [])
      }
    : undefined
  if (refireable.length === 0) return { refired: 0, queued: 0, ...(plan ? { plan } : {}) }

  const rows = (await db('nivaro_integration_obligations')
    .where({ outcome: 'missing' })
    .whereNull('resolved_at')
    .where((qb) => {
      for (const d of refireable) qb.orWhere({ api: d.api, kind: d.kind })
    })
    .orderBy('due_at', 'asc')
    .orderBy('id', 'asc')
    .limit(25)
    .select('id', 'api', 'kind', 'collection', 'item')) as Array<{
    id: number
    api: string
    kind: string
    collection: string
    item: string
  }>

  let refired = 0
  let queued = 0
  for (const r of rows) {
    const base: RemediationPlanRow = {
      obligation_id: Number(r.id),
      api: r.api,
      kind: r.kind,
      collection: r.collection,
      item: r.item != null ? String(r.item) : null
    }
    const def = getObligationKind(r.api, r.kind)
    const refusal = refireRefusal(def)
    if (refusal) {
      // Left `missing` on purpose — see the note above. No write at all, so
      // the row keeps its own due_at age and its original reason.
      queued++
      plan?.queued.push({ ...base, reason: refusal })
      continue
    }
    const prior = await mostRecentSubmissionFor(
      r.api,
      r.collection,
      r.item,
      String(def?.endpoint_path ?? '')
    )
    if (!prior) {
      queued++
      plan?.queued.push({
        ...base,
        reason: 'nothing to repeat — this send has never run for this record'
      })
      continue
    }
    if (plan) {
      // Preview: name the request that would be repeated, send nothing.
      plan.refire.push({ ...base, submission_id: Number(prior.id) })
      continue
    }
    const sent = await refireFromPrior(r.id, prior.id, null)
    if (sent.code === 'no_body') {
      // The newest request is a render failure: nothing to repeat — left for a person.
      queued++
      continue
    }
    refired++
  }
  return plan ? { refired: 0, queued: 0, plan } : { refired, queued }
}

/** Whether a `send-now` request on this obligation's OUTCOME is even a
 *  sensible question — a `sent`/`skipped`/`superseded` obligation is
 *  already closed, and asking to send it again is a genuine conflict, not
 *  "there is nothing to do yet". Exported so the route can turn the ledger's
 *  own outcome column straight into the right HTTP status without
 *  duplicating the closed-outcome list. */
export function isClosedOutcome(outcome: string): boolean {
  return CLOSED_OUTCOMES.has(outcome)
}

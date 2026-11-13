import { db } from '../db/index.js'
import { tenantState } from './ai-tenant-state.js'
import type { TransitionRefusal } from './manual-transition-gate.js'

/**
 * Extension veto over manual transitions (`ctx.transitions.registerCheck`).
 * Every manual path (record panel, branch, bulk, schema-builder mutation,
 * GraphQL) asks `registeredTransitionRefusal` right after the admin-only gate.
 * Engine-driven (automatic) transitions never come through here.
 *
 * The same checks answer BEFORE the click too: the record's pipeline read asks
 * `transitionAdvisories` for the moves it offers, so a move a check would
 * refuse says so on the page instead of after it is pressed. One evaluator —
 * the notice and the refusal cannot disagree.
 */

export interface TransitionCheckArgs {
  collection: string
  item: string
  transitionId: string
  /** State KEY the record is leaving (null when unknown). */
  fromState: string | null
  /** State KEY the move is heading to (null when unknown or branch-resolved). */
  toState: string | null
  user: { id?: string; role?: string | null } | undefined
  isAdmin: boolean
}

/** A record action (a bulk-action key registered for the collection) that clears a refusal. */
export interface TransitionFix {
  action: string
  /** What the button says ("Flag as Priority"); the action's own label when absent. */
  label?: string | null
}

export interface TransitionCheckRefusal {
  status: number
  error: string
  code: string
  /** Optional: the action that clears this refusal. A client offers it only to a person the
   *  action registry lets run it — the check names it, it never grants it. */
  fix?: TransitionFix | null
}

/** What a check would answer for a move on offer, said ahead of the click. */
export interface TransitionAdvisory {
  code: string
  message: string
  fix?: TransitionFix
}

function fixOf(raw: unknown): TransitionFix | null {
  if (!raw || typeof raw !== 'object') return null
  const f = raw as { action?: unknown; label?: unknown }
  const action = typeof f.action === 'string' ? f.action.trim().slice(0, 100) : ''
  if (!action) return null
  const label = typeof f.label === 'string' ? f.label.trim().slice(0, 80) : ''
  return label ? { action, label } : { action }
}

export type TransitionCheck = (args: TransitionCheckArgs) => Promise<TransitionCheckRefusal | null>

// Map keeps registration order; re-setting an existing owner keeps its slot but replaces the fn.
const checks = new Map<string, TransitionCheck>()

export function registerTransitionCheck(owner: string, fn: TransitionCheck): void {
  checks.set(owner, fn)
}

export function clearTransitionChecks(): void {
  checks.clear()
  keyCache().clear()
  advisoryFlights().clear()
}

const KEY_TTL_MS = 60_000
const keyCache = tenantState(() => new Map<string, { key: string; at: number }>())

/** State id → state key, cached 60 s. An id with no row gives null (and is not cached). */
async function stateKeyOf(id: string | null | undefined): Promise<string | null> {
  if (id === null || id === undefined || id === '') return null
  const cache = keyCache()
  const hit = cache.get(id)
  if (hit && Date.now() - hit.at < KEY_TTL_MS) return hit.key
  const row = (await db('nivaro_workflow_states').where({ id }).first('key')) as
    | { key?: string | null }
    | undefined
  if (!row?.key) return null
  const key = String(row.key)
  cache.set(id, { key, at: Date.now() })
  return key
}

/**
 * Run the registered checks. `fromState` / `toState` are state IDS (what the
 * transition and instance rows hold); the checks receive their KEYS. No checks
 * registered = no database read.
 */
export async function registeredTransitionRefusal(
  args: Omit<TransitionCheckArgs, 'fromState' | 'toState'> & {
    fromState: string | null
    toState: string | null
  }
): Promise<TransitionRefusal | null> {
  if (checks.size === 0) return null
  let full: TransitionCheckArgs
  try {
    full = {
      ...args,
      fromState: await stateKeyOf(args.fromState),
      toState: await stateKeyOf(args.toState)
    }
  } catch (err) {
    console.warn(
      `[transition-checks] state lookup failed: ${err instanceof Error ? err.message : String(err)}`
    )
    return {
      status: 503,
      body: { error: 'A transition check failed — try again', code: 'TRANSITION_CHECK_FAILED' }
    }
  }
  for (const [owner, fn] of checks) {
    try {
      const r = await fn(full)
      if (r) {
        const fix = fixOf(r.fix)
        return { status: r.status, body: { error: r.error, code: r.code, ...(fix ? { fix } : {}) } }
      }
    } catch (err) {
      console.warn(
        `[transition-checks] check from "${owner}" threw: ${err instanceof Error ? err.message : String(err)}`
      )
      return {
        status: 503,
        body: {
          error: 'A transition check failed — try again',
          code: 'TRANSITION_CHECK_FAILED'
        }
      }
    }
  }
  return null
}

/** How long the record's pipeline read waits for the advisories before it answers without them. */
export const ADVISORY_WAIT_MS = 1_500
/** A run of the checks that has not ended after this long is given up on: the next ask starts anew. */
export const ADVISORY_FLIGHT_MAX_MS = 30_000

interface AdvisoryArgs {
  collection: string
  item: string
  /** State ID the record is in. */
  currentState: string | null
  transitions: Array<{ id: unknown; to_state?: string | null }>
  user: TransitionCheckArgs['user']
  isAdmin: boolean
}

interface AdvisoryFlight {
  answer: Promise<Map<string, TransitionAdvisory>>
  /** The "took too long" line is written once per run, not once per ask that waited on it. */
  warned: boolean
}

// Runs of the checks under way, per tenant. Only while they run: an answer is never kept.
const advisoryFlights = tenantState(() => new Map<string, AdvisoryFlight>())

/** Everything a check's answer may depend on: the record, its state, the person, the moves. */
function advisoryKey(args: AdvisoryArgs): string {
  return JSON.stringify([
    args.collection,
    args.item,
    args.currentState,
    args.user?.id ?? null,
    args.user?.role ?? null,
    args.isAdmin,
    args.transitions.map((t) => [String(t.id), t.to_state ?? null])
  ])
}

async function runAdvisories(args: AdvisoryArgs): Promise<Map<string, TransitionAdvisory>> {
  const out = new Map<string, TransitionAdvisory>()
  // The moves are asked side by side (a record offers a handful): the read that lists them
  // waits for the slowest check, not for all of them in a row. Listed in the order offered.
  const answers = await Promise.all(
    args.transitions.map((t) =>
      registeredTransitionRefusal({
        collection: args.collection,
        item: args.item,
        transitionId: String(t.id),
        fromState: args.currentState,
        toState: t.to_state ?? null,
        user: args.user,
        isAdmin: args.isAdmin
      })
    )
  )
  args.transitions.forEach((t, i) => {
    const refusal = answers[i]
    if (!refusal || refusal.status >= 500) return
    const body = refusal.body as { error?: unknown; code?: unknown; fix?: unknown }
    if (typeof body.error !== 'string' || typeof body.code !== 'string') return
    const fix = fixOf(body.fix)
    out.set(String(t.id), { code: body.code, message: body.error, ...(fix ? { fix } : {}) })
  })
  return out
}

/**
 * The moves on offer that a registered check would refuse, keyed by transition
 * id — asked through `registeredTransitionRefusal` itself with the arguments the
 * gate passes (the record's current state, the move's target), so the advisory
 * is the refusal, said early. A check that fails gives no advisory: the page
 * stays quiet and the gate answers if the move is tried. No checks registered =
 * no database read.
 *
 * This rides the record's pipeline read, which every record page makes and
 * makes again on each live update, and a check is an extension's code. So:
 * - The read waits at most ADVISORY_WAIT_MS. Past that it answers without
 *   advisories (the same quiet page a failed check gives); the gate still
 *   refuses the move if it is pressed.
 * - Asks that arrive while the checks are running for the same record, state,
 *   person and moves share that run, so a page that refetches, or many tabs on
 *   one record, cannot multiply a slow check. Nothing is kept once the run has
 *   answered: the ask after a hold was cleared runs the checks again.
 * - A run that has not ended after ADVISORY_FLIGHT_MAX_MS is given up on, so a
 *   check that hangs once does not leave the record without advisories.
 */
export async function transitionAdvisories(
  args: AdvisoryArgs
): Promise<Map<string, TransitionAdvisory>> {
  if (checks.size === 0) return new Map()
  const flights = advisoryFlights()
  const key = advisoryKey(args)
  let flight = flights.get(key)
  if (!flight) {
    const started: AdvisoryFlight = { answer: runAdvisories(args), warned: false }
    flight = started
    flights.set(key, started)
    const forget = (): void => {
      if (flights.get(key) === started) flights.delete(key)
    }
    const giveUp = setTimeout(forget, ADVISORY_FLIGHT_MAX_MS)
    giveUp.unref?.()
    void started.answer.then(forget, forget).finally(() => clearTimeout(giveUp))
  }
  const run = flight
  let wait: ReturnType<typeof setTimeout> | undefined
  const tooLong = new Promise<null>((resolve) => {
    wait = setTimeout(() => resolve(null), ADVISORY_WAIT_MS)
    wait.unref?.()
  })
  try {
    const answer = await Promise.race([run.answer, tooLong])
    if (answer) return new Map(answer)
    if (!run.warned) {
      run.warned = true
      console.warn(
        `[transition-checks] the checks for ${args.collection} took longer than ${ADVISORY_WAIT_MS} ms: the page shows no advisories, the gate still answers`
      )
    }
    return new Map()
  } finally {
    if (wait) clearTimeout(wait)
  }
}

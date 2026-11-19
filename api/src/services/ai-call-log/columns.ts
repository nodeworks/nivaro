import { db } from '../../db/index.js'
import { tenantState } from '../ai-tenant-state.js'

/**
 * Whether migration 539 (question / tools / conversation_id on nivaro_ai_calls)
 * reached this database. Probed once per tenant, rechecked every minute until
 * it has — a database behind 539 keeps logging and the call log falls back to
 * reading the bodies.
 */
const state = tenantState<{ v: { ok: boolean; at: number } | null }>(() => ({ v: null }))

export async function callLogColumnsSupported(): Promise<boolean> {
  const st = state()
  if (st.v && (st.v.ok || Date.now() - st.v.at < 60_000)) return st.v.ok
  let ok = false
  try {
    ok =
      (await db.schema.hasColumn('nivaro_ai_calls', 'question')) &&
      (await db.schema.hasColumn('nivaro_ai_calls', 'conversation_id'))
  } catch {
    ok = false
  }
  st.v = { ok, at: Date.now() }
  return ok
}

/** Tests: forget the probe. */
export function resetCallLogColumnsProbe(): void {
  state().v = null
}

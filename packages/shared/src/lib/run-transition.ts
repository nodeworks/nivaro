/**
 * "Run this transition" as a page-level request — how a part of the record
 * page that is NOT the pipeline panel (the Integrations popup's partner
 * lines: "re-run Submit to Warehouse to resend") asks the panel to do what
 * its own button does: save the form first, then execute, with the
 * requirements dialog and the comment prompt exactly as a click would.
 *
 * Whichever pipeline button mount hears it first CLAIMS it (`claimed`), so
 * the header buttons and the Progress panel — both mounted on a record
 * page — never fire the same transition twice. A mount that has the
 * record but not the transition (it is not available from the current
 * step) claims it too and says so, so a stale request never silently dies.
 */
export const RUN_TRANSITION_EVENT = 'nvr:run-transition'

export interface RunTransitionRequest {
  collection: string
  item: string
  transition_id: string
  /** Set by the first mount that handles it. */
  claimed?: boolean
}

export function requestTransitionRun(req: Omit<RunTransitionRequest, 'claimed'>): boolean {
  if (typeof window === 'undefined') return false
  const detail: RunTransitionRequest = { ...req, claimed: false }
  window.dispatchEvent(new CustomEvent(RUN_TRANSITION_EVENT, { detail }))
  return detail.claimed === true
}

/**
 * "Move to state…" from the record's ⋯ menu — asks the record's pipeline
 * panel to open its admin Move to state form (expanded, scrolled into view).
 * The first panel mount for the record CLAIMS it; when none does (the form's
 * layout has no pipeline panel) the caller opens its own dialog instead.
 */
export const OPEN_MOVE_STATE_EVENT = 'nvr:open-move-state'

export interface OpenMoveStateRequest {
  collection: string
  item: string
  claimed?: boolean
}

export function requestMoveState(req: Omit<OpenMoveStateRequest, 'claimed'>): boolean {
  if (typeof window === 'undefined') return false
  const detail: OpenMoveStateRequest = { ...req, claimed: false }
  window.dispatchEvent(new CustomEvent(OPEN_MOVE_STATE_EVENT, { detail }))
  return detail.claimed === true
}

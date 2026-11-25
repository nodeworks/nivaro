/**
 * A move panel opened from a link (the Capacity tab's move advisor, the Hosts tab): `/hub?app=<id>
 * &move=<envId>&to=shared:<id>|dedicated:<placementId>|new:<driverId>` opens that environment's
 * Move panel with the target picked (`new:` = a new stack on that Docker host). A plan only: the
 * person still checks the plan, ticks the checklist and types the confirmation.
 */
export function movePrefill(
  envId: number,
  search: string = typeof window === 'undefined' ? '' : window.location.search
): { open: boolean; pick: string } {
  const p = new URLSearchParams(search)
  if (p.get('move') !== String(envId)) return { open: false, pick: '' }
  const to = p.get('to') ?? ''
  return { open: true, pick: /^(shared|dedicated|new):\d+$/.test(to) ? to : '' }
}

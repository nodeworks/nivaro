/**
 * Hub placement (review C1): the move a dedicated target was deployed by (HUB_BOOT_MAINTENANCE),
 * or null. Only the move's NEW stack carries it (the Hub drops it when it applies the stack again
 * after the move), so it tells the new stack from the old one of the same environment: /api/version
 * answers it as `move_target`, and the hub-link maintenance `only_target` lifts nothing elsewhere.
 * A leaf module: /api/version reads it without the security module's imports.
 */
export function hubBootMoveId(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = (env.HUB_BOOT_MAINTENANCE ?? '').trim()
  return /^[1-9]\d{0,15}$/.test(raw) ? Number(raw) : null
}

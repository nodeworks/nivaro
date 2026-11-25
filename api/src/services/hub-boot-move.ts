/**
 * Hub placement (review C1): the move a dedicated target was deployed by (HUB_BOOT_MAINTENANCE),
 * or null. Only the move's NEW stack carries it, so it tells the new stack from the old one of
 * the same environment: /api/version answers it as `move_target`, and the hub-link maintenance
 * `only_target` lifts nothing elsewhere. The Hub applies the new stack once more without it when
 * the move can no longer roll back (ops dropTempHost, every Docker target), and a stack setting
 * may never set it (stack-env.ts MOVE_OWNED_ENV_KEYS). A leaf module: /api/version reads it
 * without the security module's imports.
 */
export function hubBootMoveId(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = (env.HUB_BOOT_MAINTENANCE ?? '').trim()
  return /^[1-9]\d{0,15}$/.test(raw) ? Number(raw) : null
}

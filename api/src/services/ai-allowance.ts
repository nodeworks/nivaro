/**
 * AI allowance checks (realtime round 9 follow-up) — a seam for a hosting layer to stop AI calls
 * once ITS allowance is spent. Core sets no allowance of its own: with nothing registered (every
 * self-hosted instance) this is a no-op and nothing is ever limited.
 *
 * An extension registers a check (`ctx.ai.registerAllowance(fn)`); every provider call made
 * through the guarded client (services/ai-client.ts) runs the registered checks first, in the
 * caller's request/tenant context. A check answers null (go ahead) or a refusal; the first
 * refusal stops the call with 429 `AI_ALLOWANCE_USED` and the refusal's own words. A check that
 * throws or takes longer than CHECK_TIMEOUT_MS is skipped (fails open: a broken check must not
 * take AI away from everyone).
 */

export interface AiAllowanceRefusal {
  /** What the person reads ("Your plan's AI allowance for this month is used up."). */
  message: string
  /** Where they can do something about it (a path in the admin app), optional. */
  action_url?: string
  /** When it frees up again, ISO, optional. */
  resets_at?: string
}

export type AiAllowanceCheck = () =>
  | AiAllowanceRefusal
  | null
  | undefined
  | Promise<AiAllowanceRefusal | null | undefined>

export class AiAllowanceError extends Error {
  statusCode = 429
  code = 'AI_ALLOWANCE_USED' as const
  action_url?: string
  resets_at?: string
  constructor(r: AiAllowanceRefusal) {
    super(r.message || 'The AI allowance for this period is used up.')
    this.name = 'AiAllowanceError'
    if (r.action_url) this.action_url = r.action_url
    if (r.resets_at) this.resets_at = r.resets_at
  }
}

const CHECK_TIMEOUT_MS = 1500
const checks: AiAllowanceCheck[] = []
const byOwner = new Map<string, AiAllowanceCheck>()

/** Register a check (module-level: it runs for every tenant, inside that tenant's context).
 *  `owner` (an extension id) replaces that owner's earlier check — a reloaded extension never
 *  stacks a second copy. */
export function registerAiAllowanceCheck(check: AiAllowanceCheck, owner?: string): () => void {
  if (owner) {
    const prev = byOwner.get(owner)
    if (prev) {
      const i = checks.indexOf(prev)
      if (i >= 0) checks.splice(i, 1)
    }
    byOwner.set(owner, check)
  }
  checks.push(check)
  return () => {
    const i = checks.indexOf(check)
    if (i >= 0) checks.splice(i, 1)
    if (owner && byOwner.get(owner) === check) byOwner.delete(owner)
  }
}

/** Throws AiAllowanceError when a registered check refuses; otherwise returns. */
export async function checkAiAllowance(): Promise<void> {
  if (checks.length === 0) return
  for (const check of [...checks]) {
    let refusal: AiAllowanceRefusal | null | undefined
    try {
      refusal = await Promise.race([
        Promise.resolve().then(check),
        new Promise<null>((r) => setTimeout(() => r(null), CHECK_TIMEOUT_MS).unref?.())
      ])
    } catch {
      refusal = null
    }
    if (refusal && typeof refusal.message === 'string') throw new AiAllowanceError(refusal)
  }
}

/** Tests only. */
export function _resetAiAllowanceChecks(): void {
  checks.length = 0
  byOwner.clear()
}

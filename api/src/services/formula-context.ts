import { db } from '../db/index.js'
import { registerAppKeyed } from './app-forget.js'
import { currentTenantKey } from './tenant-rooms.js'

/**
 * Formula constants (#244) + fiscal calendar config (#343) for server-side
 * formula evaluation. Both live on nivaro_settings and change rarely — 60s
 * cache, busted by the settings PATCH route.
 */

// Per app (currentTenantKey()): each app on a shared deployment has its own settings row.
const cache = registerAppKeyed(
  new Map<
    string,
    { at: number; value: { constants: Record<string, number>; fiscalStartMonth: number } }
  >()
)
const TTL = 60_000

export async function getFormulaContext(): Promise<{
  constants: Record<string, number>
  fiscalStartMonth: number
}> {
  const app = currentTenantKey()
  const hit = cache.get(app)
  if (hit && Date.now() - hit.at < TTL) return hit.value
  let constants: Record<string, number> = {}
  let fiscalStartMonth = 1
  try {
    const row = await db('nivaro_settings')
      .select('formula_constants', 'fiscal_year_start_month')
      .first()
    if (row?.formula_constants) {
      try {
        const parsed = JSON.parse(row.formula_constants)
        if (parsed && typeof parsed === 'object') {
          for (const [k, v] of Object.entries(parsed)) {
            const n = Number(v)
            if (Number.isFinite(n) && /^[A-Z][A-Z0-9_]*$/.test(k)) constants[k] = n
          }
        }
      } catch {
        constants = {}
      }
    }
    const fm = Number(row?.fiscal_year_start_month)
    if (Number.isFinite(fm) && fm >= 1 && fm <= 12) fiscalStartMonth = fm
  } catch {
    // settings unreadable (mid-migration) — formulas run without constants
  }
  const value = { constants, fiscalStartMonth }
  cache.set(app, { at: Date.now(), value })
  return value
}

/** Drop the cached context: the current app's, or every app's outside one. */
export function bustFormulaContextCache(): void {
  const app = currentTenantKey()
  if (app) cache.delete(app)
  else cache.clear()
}

/** networkdays(a, b): Mon–Fri days between two dates; negative when b < a. */
export function networkdaysBetween(a: Date, b: Date): number {
  const sign = b.getTime() >= a.getTime() ? 1 : -1
  let [from, to] = sign === 1 ? [a, b] : [b, a]
  from = new Date(from.getFullYear(), from.getMonth(), from.getDate())
  to = new Date(to.getFullYear(), to.getMonth(), to.getDate())
  let days = 0
  const cur = new Date(from)
  while (cur.getTime() < to.getTime()) {
    const dow = cur.getDay()
    if (dow !== 0 && dow !== 6) days++
    cur.setDate(cur.getDate() + 1)
  }
  return days * sign
}

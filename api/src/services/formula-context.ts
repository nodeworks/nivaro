import { db } from '../db/index.js'

/**
 * Formula constants (#244) + fiscal calendar config (#343) for server-side
 * formula evaluation. Both live on nivaro_settings and change rarely — 60s
 * cache, busted by the settings PATCH route.
 */

let cache: { constants: Record<string, number>; fiscalStartMonth: number } | null = null
let cachedAt = 0
const TTL = 60_000

export async function getFormulaContext(): Promise<{
  constants: Record<string, number>
  fiscalStartMonth: number
}> {
  if (cache && Date.now() - cachedAt < TTL) return cache
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
  cache = { constants, fiscalStartMonth }
  cachedAt = Date.now()
  return cache
}

export function bustFormulaContextCache(): void {
  cache = null
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

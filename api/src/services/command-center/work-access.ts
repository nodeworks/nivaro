import type { User } from '../../types.js'
import { currentTenantKey } from '../tenant-rooms.js'
import { narrowToRegion } from './work-math.js'

/**
 * What one viewer may see of the work index, per request: collection read permission, then the
 * record gates (row filter + User Scopes) set-based through record-access visibleIds, then the
 * region lens. One Viewer object per request caches each collection's answer.
 */
export class Viewer {
  private readonly canRead = new Map<string, boolean>()
  private readonly visible = new Map<string, Set<string>>()
  private readonly region = new Map<string, Set<string> | null>()
  /** Whether a region focus narrowed any read (false = it could not be placed anywhere). */
  regionApplied = false

  constructor(
    readonly user: User,
    readonly isAdmin: boolean,
    readonly regionId: string | null
  ) {}

  async mayRead(collection: string): Promise<boolean> {
    let ok = this.canRead.get(collection)
    if (ok === undefined) {
      try {
        if (this.isAdmin) ok = true
        else {
          const { can } = await import('../permissions.js')
          ok = await can(this.user, 'read', collection)
        }
      } catch {
        ok = false
      }
      this.canRead.set(collection, ok)
    }
    return ok
  }

  /**
   * The ids (of those given) this viewer can open, upper-cased. Admins pass every id; anyone else
   * goes through the same gates a record read applies.
   */
  async visibleUpper(collection: string, ids: string[]): Promise<Set<string>> {
    const wanted = [...new Set(ids.map((i) => String(i).toUpperCase()))]
    if (!(await this.mayRead(collection))) return new Set()
    if (this.isAdmin) return new Set(wanted)
    const known = this.visible.get(collection) ?? new Set<string>()
    const ask = wanted.filter((i) => !known.has(i) && !known.has(`!${i}`))
    if (ask.length > 0) {
      try {
        const { compileAccessGates, visibleIds } = await import('../record-access.js')
        const gates = await compileAccessGates(this.user, collection)
        const seen = new Set([...(await visibleIds(gates, ask))].map((s) => s.toUpperCase()))
        for (const id of ask) known.add(seen.has(id) ? id : `!${id}`)
      } catch {
        for (const id of ask) known.add(`!${id}`)
      }
      this.visible.set(collection, known)
    }
    return new Set(wanted.filter((i) => known.has(i)))
  }

  /** Keep the rows whose record this viewer can open and that sit in the focused region. */
  async filter<T>(collection: string, rows: T[], idOf: (r: T) => string): Promise<T[]> {
    if (rows.length === 0) return rows
    const ok = await this.visibleUpper(collection, rows.map(idOf))
    const seen = rows.filter((r) => ok.has(idOf(r).toUpperCase()))
    if (!this.regionId) return seen
    const narrowed = narrowToRegion(seen, idOf, await this.regionSet(collection))
    if (narrowed.applies) this.regionApplied = true
    return narrowed.rows
  }

  async regionSet(collection: string): Promise<Set<string> | null> {
    if (!this.regionId) return null
    if (!this.region.has(collection)) {
      let set: Set<string> | null = null
      try {
        const { recordIdsInRegion } = await import('./regions.js')
        set = await recordIdsInRegion(collection, this.regionId)
      } catch {
        set = null
      }
      this.region.set(collection, set)
    }
    return this.region.get(collection) ?? null
  }
}

/**
 * A small per-tenant memo: answers from cache while fresh; when stale, answers the stale copy at
 * once and starts one rebuild; on a cold start waits for the build (at most `waitMs` when given,
 * then undefined).
 * Module state is shared by every cloud tenant, so every key carries the tenant.
 */
interface MemoEntry<T> {
  at: number
  value: T | undefined
  building: Promise<T> | null
}
const memos = new Map<string, MemoEntry<unknown>>()

export async function tenantMemo<T>(
  name: string,
  ttlMs: number,
  build: () => Promise<T>,
  opts: { waitMs?: number; now?: () => number } = {}
): Promise<T | undefined> {
  const now = opts.now ?? Date.now
  const key = `${currentTenantKey() || '-'}|${name}`
  let entry = memos.get(key) as MemoEntry<T> | undefined
  if (!entry) {
    entry = { at: 0, value: undefined, building: null }
    memos.set(key, entry as MemoEntry<unknown>)
    if (memos.size > 500) memos.delete(memos.keys().next().value as string)
  }
  const fresh = entry.value !== undefined && now() - entry.at < ttlMs
  if (fresh) return entry.value
  if (!entry.building) {
    const e = entry
    e.building = build()
      .then((v) => {
        e.value = v
        e.at = now()
        return v
      })
      .finally(() => {
        e.building = null
      })
    // A failed build leaves the previous value; callers below see the rejection only if waiting.
    e.building.catch(() => {})
  }
  // Stale-while-revalidate: a recently stale copy answers now while the rebuild runs; a cold
  // start (or a copy older than 5 × ttl) waits.
  if (entry.value !== undefined && now() - entry.at < ttlMs * 5) return entry.value
  const pending = entry.building as Promise<T>
  if (opts.waitMs == null) {
    try {
      return await pending
    } catch {
      return entry.value
    }
  }
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<undefined>((r) => {
    timer = setTimeout(() => r(undefined), opts.waitMs)
  })
  try {
    const v = await Promise.race([pending.catch(() => undefined), timeout])
    return v ?? entry.value
  } finally {
    clearTimeout(timer)
  }
}

/** Tests only. */
export function resetTenantMemos(): void {
  memos.clear()
}

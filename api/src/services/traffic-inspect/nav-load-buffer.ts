// api/src/services/traffic-inspect/nav-load-buffer.ts
/**
 * Traffic Map drill-down (#1205): the calls of each recent page load, in memory.
 *
 * The screens tap counts calls per load id (`x-nivaro-load`, one id per route navigation) but kept
 * only totals. This buffer keeps, per load id, the calls themselves — request id, route, start,
 * duration, status — so a load can be drawn as a waterfall and each bar opened as a request.
 *
 * Bounded twice: the newest MAX_LOADS loads (the least recently active one is forgotten first)
 * and MAX_CALLS calls per load (later calls are counted in `dropped`, not kept). The load id is
 * not stored on API log rows, so this buffer is the only place a load lives: it is per API process
 * and empties on restart. Pure — no I/O; the screens tap owns the instance (per store).
 */

export const LOAD_BUFFER_MAX_LOADS = 200
export const LOAD_BUFFER_MAX_CALLS = 300

export interface LoadCall {
  /** Request id (= trace id = API log request_id); null when the request had none. */
  rid: string | null
  /** Route template (`GET /api/items/workflows/:id`, or the GraphQL operation). */
  route: string
  /** Epoch ms the call started. */
  start: number
  ms: number
  status: number
}

export interface LoadEntry {
  load: string
  /** Screen key as the screens tap records it: `<app> <pattern>` (app optional). */
  screen: string
  caller: string
  /** The signed-in person behind the calls (uuid), when one was. */
  user: string | null
  /** Epoch ms of the first call's start / the last call's end. */
  first: number
  last: number
  calls: LoadCall[]
  /** Calls past MAX_CALLS (counted, not kept). */
  dropped: number
}

export interface LoadInfo {
  screen: string
  caller: string
  user: string | null
}

export class LoadCallBuffer {
  private loads = new Map<string, LoadEntry>()
  private byRid = new Map<string, string>()

  constructor(
    readonly maxLoads = LOAD_BUFFER_MAX_LOADS,
    readonly maxCalls = LOAD_BUFFER_MAX_CALLS
  ) {}

  get size(): number {
    return this.loads.size
  }

  /** Record one call of load `id`. A load seen on another screen starts over (a new visit). */
  note(id: string, info: LoadInfo, call: LoadCall): void {
    if (!id) return
    let e = this.loads.get(id)
    if (e && e.screen !== info.screen) {
      this.forget(id)
      e = undefined
    }
    if (e) {
      // Move to the newest end: the least recently active load is the one evicted.
      this.loads.delete(id)
      this.loads.set(id, e)
    } else {
      while (this.loads.size >= this.maxLoads) {
        const oldest = this.loads.keys().next().value
        if (oldest === undefined) break
        this.forget(oldest)
      }
      e = {
        load: id,
        screen: info.screen,
        caller: info.caller,
        user: info.user,
        first: call.start,
        last: call.start + Math.max(0, call.ms),
        calls: [],
        dropped: 0
      }
      this.loads.set(id, e)
    }
    if (!e.user && info.user) e.user = info.user
    e.first = Math.min(e.first, call.start)
    e.last = Math.max(e.last, call.start + Math.max(0, call.ms))
    if (e.calls.length >= this.maxCalls) {
      e.dropped++
      return
    }
    e.calls.push({ ...call, ms: Math.max(0, call.ms) })
    if (call.rid) this.byRid.set(call.rid, id)
  }

  get(id: string): LoadEntry | null {
    return this.loads.get(id) ?? null
  }

  /** The load a request belonged to, while that load is still kept. */
  loadOfRequest(rid: string): LoadEntry | null {
    const id = this.byRid.get(rid)
    return id ? (this.loads.get(id) ?? null) : null
  }

  /** Kept loads, newest (most recently started) first, optionally filtered; at most `n`. */
  list(filter?: (e: LoadEntry) => boolean, n = 30): LoadEntry[] {
    const out: LoadEntry[] = []
    for (const e of this.loads.values()) if (!filter || filter(e)) out.push(e)
    out.sort((a, b) => b.first - a.first)
    return out.slice(0, Math.max(0, n))
  }

  clear(): void {
    this.loads.clear()
    this.byRid.clear()
  }

  private forget(id: string): void {
    const e = this.loads.get(id)
    if (!e) return
    for (const c of e.calls) if (c.rid && this.byRid.get(c.rid) === id) this.byRid.delete(c.rid)
    this.loads.delete(id)
  }
}

/**
 * Who is really looking at a record (realtime gaps 2026-11-17, P1 / P3 / P9).
 *
 * A record room (`record:<collection>:<id>`) used to count every socket that joined it as
 * "viewing": a record left open in a background tab skipped its person's notifications for good
 * (services/notification-channels.ts asks `isUserViewing`), and co-viewers saw them as "also
 * viewing". Now:
 *
 * - **Visibility (P1).** A client reports when its tab is away (hidden, or idle — shared
 *   lib/presence-hooks.ts `onRecordTabAway`) with `record:visibility {collection, item, hidden,
 *   hidden_ms?}`. A viewer whose tab has been away longer than HIDDEN_GRACE_MS is not viewing:
 *   not in `record:viewers` / `presence:rows`, never suppresses a notification. The socket stays
 *   in the room (it still hears field marks, so the page is current when the person comes back).
 *   A client that never reports is visible (older builds keep the old behaviour).
 * - **View-as (P3, Rob's call: option a).** A View-as socket (`masq` bind) is an audience, never
 *   a viewer: it hears the room's presence but is never listed, never suppresses the person's
 *   notifications and sends no field marks, typing or signals as them.
 * - **Machines and API keys (P9).** An integration / bot / service account, or a socket signed
 *   in with an API key, is neither: it never receives presence (record:viewers, typing, field
 *   marks, signals, row chips) and is never listed.
 *
 * Presence goes to the audience room `viewers:<record room>` (viewersRoomName), which only
 * screen sockets join; the record room itself keeps carrying record notices (comments,
 * integrity, automation) to every socket that may open the record.
 */

/** How long a record tab may be away (hidden or idle) and still count as viewing it. */
export const HIDDEN_GRACE_MS = 30_000

/** Sign-in kinds that are a person at a screen (the field-change-relay / coedit SCREEN set). */
const SCREEN_BINDS = new Set(['session', 'masq', 'token', 'device'])

/** One socket's place in a record room, as the socket plugin keeps it. */
export interface RecordViewerEntry {
  id: string
  name: string
  /** When the tab went away (ms epoch); absent = looking at it. */
  hiddenAt?: number
}

/** Is this viewer looking at the record now (visible, or away for less than the grace)? */
export function viewingNow(
  v: { hiddenAt?: number | null },
  now = Date.now(),
  graceMs = HIDDEN_GRACE_MS
): boolean {
  return v.hiddenAt == null || now - v.hiddenAt < graceMs
}

/** The `{id, name}` of the viewers looking now — what `record:viewers` carries (no timings). */
export function activeViewers(
  entries: Iterable<RecordViewerEntry> | null | undefined,
  now = Date.now()
): Array<{ id: string; name: string }> {
  const out: Array<{ id: string; name: string }> = []
  for (const v of entries ?? []) if (viewingNow(v, now)) out.push({ id: v.id, name: v.name })
  return out
}

/**
 * What a socket is to a record room:
 *   'viewer'   — a person at a screen: listed, may send marks / typing / signals, hears presence
 *   'audience' — View-as: hears presence, never listed, sends nothing as the person (P3)
 *   'none'     — machine account, API key or unknown sign-in: no presence either way (P9)
 */
export type PresenceRole = 'viewer' | 'audience' | 'none'

export function presenceRole(
  bindKind: string | null | undefined,
  user: { account_kind?: string | null } | null | undefined
): PresenceRole {
  if (!user || !SCREEN_BINDS.has(String(bindKind))) return 'none'
  const kind = user.account_kind
  // A machine identity (integration, bot, service); a placeholder row never signs in.
  if (typeof kind === 'string' && kind !== '' && kind !== 'placeholder') return 'none'
  return bindKind === 'masq' ? 'audience' : 'viewer'
}

/** The bind kind of a socket (`socket.data.nvrBind.kind`), or undefined. */
export function socketBindKindOf(socket: { data?: Record<string, unknown> } | null | undefined) {
  const kind = (socket?.data?.nvrBind as { kind?: unknown } | undefined)?.kind
  return typeof kind === 'string' ? kind : undefined
}

/** The presence audience room of a (tenant-scoped) record room. */
export function viewersRoomName(recordRoom: string): string {
  return `viewers:${recordRoom}`
}

/** A day: a longer "away for" is clamped (a tab hidden overnight is simply away). */
const HIDDEN_MS_MAX = 86_400_000

export interface RecordVisibility {
  collection: string
  item: string
  hidden: boolean
  /** How long the tab has been away already (0 when it just went). */
  hiddenMs: number
}

/** Clean a `record:visibility` message. */
export function parseRecordVisibility(payload: unknown): RecordVisibility | null {
  const p = payload as
    | { collection?: unknown; item?: unknown; hidden?: unknown; hidden_ms?: unknown }
    | null
    | undefined
  const collection = p?.collection
  const item = p?.item
  if (typeof collection !== 'string' || !collection || collection.length > 128) return null
  if (item == null || (typeof item !== 'string' && typeof item !== 'number')) return null
  const id = String(item)
  if (!id || id.length > 200) return null
  const hidden = p?.hidden === true
  const ms = Number(p?.hidden_ms)
  return {
    collection,
    item: id,
    hidden,
    hiddenMs: hidden && Number.isFinite(ms) && ms > 0 ? Math.min(ms, HIDDEN_MS_MAX) : 0
  }
}

/** How many records one socket's away-state is remembered for before it joins them. */
const PENDING_MAX = 200

/**
 * One socket's away-state per record, and the timer that re-tells a room when a hidden viewer's
 * grace runs out. A report may arrive before the (async, gated) join finishes, so the state is
 * kept per `collection\u0000item` and read at join time.
 */
export class RecordVisibilityBook {
  private hiddenAt = new Map<string, number>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(
    private readonly opts: {
      graceMs?: number
      now?: () => number
      setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
      clearTimer?: (t: ReturnType<typeof setTimeout>) => void
    } = {}
  ) {}

  static key(collection: string, item: string): string {
    return `${collection}\u0000${item}`
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now()
  }

  /** Remember the latest report; the hiddenAt it implies (undefined = visible). */
  note(v: RecordVisibility): number | undefined {
    const key = RecordVisibilityBook.key(v.collection, v.item)
    if (!v.hidden) {
      this.hiddenAt.delete(key)
      return undefined
    }
    // A repeat "still hidden" keeps the first moment it went.
    const known = this.hiddenAt.get(key)
    const at = known ?? this.now() - v.hiddenMs
    if (known == null) {
      if (this.hiddenAt.size >= PENDING_MAX) this.hiddenAt.clear()
      this.hiddenAt.set(key, at)
    }
    return at
  }

  /** The away moment remembered for a record (undefined = visible / never reported). */
  hiddenAtOf(collection: string, item: string): number | undefined {
    return this.hiddenAt.get(RecordVisibilityBook.key(collection, item))
  }

  /**
   * Call `onLapse` once the grace after `hiddenAt` is over (at once when it already is). A new
   * arm or a disarm replaces the previous timer for the record.
   */
  arm(collection: string, item: string, hiddenAt: number, onLapse: () => void): void {
    const key = RecordVisibilityBook.key(collection, item)
    this.disarm(collection, item)
    const left = (this.opts.graceMs ?? HIDDEN_GRACE_MS) - (this.now() - hiddenAt)
    if (left <= 0) {
      onLapse()
      return
    }
    const set = this.opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    const t = set(() => {
      this.timers.delete(key)
      onLapse()
    }, left + 50)
    ;(t as { unref?: () => void }).unref?.()
    this.timers.set(key, t)
  }

  disarm(collection: string, item: string): void {
    const key = RecordVisibilityBook.key(collection, item)
    const t = this.timers.get(key)
    if (t == null) return
    ;(this.opts.clearTimer ?? clearTimeout)(t)
    this.timers.delete(key)
  }

  /** The record was left: forget it entirely. */
  forget(collection: string, item: string): void {
    this.disarm(collection, item)
    this.hiddenAt.delete(RecordVisibilityBook.key(collection, item))
  }

  dispose(): void {
    for (const t of this.timers.values()) (this.opts.clearTimer ?? clearTimeout)(t)
    this.timers.clear()
    this.hiddenAt.clear()
  }

  get pending(): number {
    return this.hiddenAt.size
  }
}

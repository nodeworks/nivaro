import { onOpsWrite } from '../db/ops-signal.js'
import { onOwnersChanged } from '../db/owner-signal.js'
import { getIo } from './io-holder.js'
import { currentTenantKey, tenantScopedRoom } from './tenant-rooms.js'

/**
 * Live operations pages (Readiness, Issues, Support desk, Team workload, My
 * Work, Delegation console, Broadcasts). One event, `ops:changed`, to a
 * tenant-scoped room per topic:
 *
 *   {topic, at}                 a poke — "something you show moved": the page
 *                               refetches through its own permission-checked
 *                               route. Never names a row, a person or a value.
 *   {topic, ...detail}          a detail event (readiness report, an issue
 *                               occurrence) — only for rooms whose join gate is
 *                               as strict as the route that serves the same data.
 *
 * Join gates live in plugins/socketio.ts (`ops:join`); `opsTopicGate` is the
 * one place the topic → who-may-join table is written.
 */

export type OpsTopic =
  | 'readiness'
  | 'issues'
  | 'support'
  | 'team'
  | 'delegation'
  | 'broadcasts'
  | 'my-work'

/** 'ticket' — the person must be able to see that support ticket (canSeeTicket). */
export type OpsGate = 'admin' | 'auth' | 'ticket'

const TOPIC_GATES: Record<OpsTopic, OpsGate> = {
  readiness: 'admin',
  issues: 'auth',
  support: 'auth',
  team: 'auth',
  delegation: 'auth',
  broadcasts: 'admin',
  'my-work': 'auth'
}

/**
 * Topics with a per-id room: `issue:<id>` streams occurrences (names a person → admin);
 * `ticket:<id>` and `issue-view:<id>` carry who is looking at / replying to one ticket or
 * issue (services/presence-topics.ts) — a ticket's room only admits people who can see it.
 * `layout:<id>` is who has that layout open in the layout editor and what each has
 * selected (#2651) — administrators only, like the editor's routes.
 */
const ID_TOPICS: Record<string, OpsGate> = {
  issue: 'admin',
  ticket: 'ticket',
  'issue-view': 'auth',
  layout: 'admin'
}

/** A client-supplied topic string → its room suffix and gate, or null when not a real topic. */
export function opsTopicGate(raw: unknown): { topic: string; gate: OpsGate } | null {
  if (typeof raw !== 'string' || raw.length > 40) return null
  if (raw in TOPIC_GATES) return { topic: raw, gate: TOPIC_GATES[raw as OpsTopic] }
  const m = /^([a-z-]+):(\d{1,12})$/.exec(raw)
  if (m && m[1] in ID_TOPICS) return { topic: raw, gate: ID_TOPICS[m[1]] }
  return null
}

/** The socket room for a topic (tenant-scoped in cloud mode). */
export function opsRoom(topic: string, tenant: string = currentTenantKey()): string {
  return tenantScopedRoom(`ops:${topic}`, tenant)
}

/** Emit a detail event to a topic's room right now (not coalesced). */
export function emitOps(topic: string, detail: Record<string, unknown> = {}): void {
  try {
    getIo()
      ?.to(opsRoom(topic))
      .emit('ops:changed', { topic, ...detail, at: Date.now() })
  } catch {
    /* best-effort: a live notice never affects the write that caused it */
  }
}

// ── Coalesced pokes ──────────────────────────────────────────────────────────
// A burst of writes (an import, a cron sweep) is ONE poke: it fires SETTLE_MS
// after the first write (so a surrounding transaction has committed by the
// time the page refetches), then holds COOLDOWN_MS; writes inside the hold
// schedule one more poke at its end. Keyed by tenant so one tenant's burst
// never delays another's.
const SETTLE_MS = 400
const COOLDOWN_MS = 1500

interface PokeState {
  dirty: boolean
  timer: ReturnType<typeof setTimeout>
}
const pokes = new Map<string, PokeState>()

function fire(tenant: string, topic: string): void {
  try {
    getIo()?.to(opsRoom(topic, tenant)).emit('ops:changed', { topic, at: Date.now() })
  } catch {
    /* best-effort */
  }
}

export function pokeOps(topic: OpsTopic): void {
  const tenant = currentTenantKey()
  const key = `${tenant}|${topic}`
  const cur = pokes.get(key)
  if (cur) {
    cur.dirty = true
    return
  }
  const state = { dirty: false } as PokeState
  const cooldown = () => {
    state.timer = setTimeout(() => {
      if (state.dirty) {
        state.dirty = false
        fire(tenant, topic)
        cooldown()
      } else pokes.delete(key)
    }, COOLDOWN_MS)
    state.timer.unref?.()
  }
  state.timer = setTimeout(() => {
    fire(tenant, topic)
    cooldown()
  }, SETTLE_MS)
  state.timer.unref?.()
  pokes.set(key, state)
}

let wired = false
/** Hook the driver-seam signals to pokes. Idempotent; called once at boot. */
export function wireOpsLive(): void {
  if (wired) return
  wired = true
  onOpsWrite((topics) => {
    for (const t of topics) pokeOps(t)
  })
  // Who owns what changed (transition, owner group, team member, delegate,
  // out-of-office): every page that shows owners or cover moves.
  onOwnersChanged(() => {
    pokeOps('my-work')
    pokeOps('team')
    pokeOps('delegation')
  })
}

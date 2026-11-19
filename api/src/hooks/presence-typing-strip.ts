import { db } from '../db/index.js'
import { hooks } from './registry.js'

/**
 * Realtime gaps P2 / P10 (2026-11-17): `user_presence.typing_room` named who was writing to whom
 * (`dm:<A>:<B>`, private channel keys, record ids) to anyone who may read presence rows. Chat
 * typing is a socket signal now (`chat:typing`, gated by the chat room's canSeeRoom), so the
 * column is never written with a room again: a tab still on an older build that sets it gets
 * it blanked here, which also clears the last stale value on that person's row.
 */
export function stripTypingRoom(payload: Record<string, unknown> | undefined): void {
  if (payload && Object.hasOwn(payload, 'typing_room')) payload.typing_room = null
}

/**
 * Realtime audit M3 (2026-11-18): one presence row per person, written by every tab. A tab in
 * the background (last touched an hour ago) wrote its own `last_active` over the active tab's,
 * and the Online list, Command Center and "stuck" read the person as "Idle · 60m" while they
 * worked in another tab. Newest activity wins: a claim older than the stored `last_active`
 * keeps the stored one, and that tab's `is_idle` with it (an older tab cannot say the person
 * left). Mutates `payload`; pure.
 */
export function keepNewestActivity(
  payload: Record<string, unknown> | undefined,
  stored: unknown
): void {
  if (!payload || !Object.hasOwn(payload, 'last_active')) return
  const claim =
    payload.last_active == null ? Number.NaN : new Date(payload.last_active as string).getTime()
  const have = stored == null ? Number.NaN : new Date(stored as string).getTime()
  if (!Number.isFinite(have)) return
  if (Number.isFinite(claim) && claim >= have) return
  delete payload.last_active
  delete payload.is_idle
}

export function registerPresenceTypingStripHooks(): void {
  for (const action of ['create', 'update'] as const)
    hooks.before('user_presence', action, (ctx) => {
      stripTypingRoom(ctx.payload)
    })
  hooks.before('user_presence', 'update', async (ctx) => {
    const id = ctx.keys?.[0]
    if (id == null || !ctx.payload || !Object.hasOwn(ctx.payload, 'last_active')) return
    try {
      const row = (await db('user_presence').where({ id }).first('last_active')) as
        | { last_active?: unknown }
        | undefined
      keepNewestActivity(ctx.payload, row?.last_active)
    } catch {
      // Presence must never refuse a write: the claim stands as sent.
    }
  })
}

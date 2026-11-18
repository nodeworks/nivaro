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

export function registerPresenceTypingStripHooks(): void {
  for (const action of ['create', 'update'] as const)
    hooks.before('user_presence', action, (ctx) => {
      stripTypingRoom(ctx.payload)
    })
}

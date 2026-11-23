import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * FW-4 (ruling P6-37): which move's own run the current async work belongs to. The MOVE_OPEN
 * guards (services/hub/move-open.ts) refuse actions on an environment or shared deployment an open
 * move touches; the move's own runner must still act on them, so it runs every step, undo and op
 * inside `withMoveRun(moveId, …)`, and a guard lets an action through only when
 * `currentMoveRun()` is the very move that holds it open. Nothing outside a run sets it (a person's
 * request, another move, an upgrade): null there.
 */
const store = new AsyncLocalStorage<{ moveId: number }>()

export function withMoveRun<T>(moveId: number, work: () => Promise<T>): Promise<T> {
  return store.run({ moveId }, work)
}

/** The move whose run this async work belongs to, or null. */
export function currentMoveRun(): number | null {
  return store.getStore()?.moveId ?? null
}

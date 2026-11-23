import type { CommentCreatedEvent } from '@nivaro/extension-kit'
import { runInBackgroundPool } from '../db/pool-context.js'

/**
 * What extensions hear when a record comment is written (`ctx.comments.onCreated`).
 *
 * Record comments are not an items collection: routes/comments.ts (and the chat "copy to Notes"
 * path) insert `nivaro_comments` rows directly, so `hooks.after(...)` never fires for them. An
 * integration that must react to a comment (EFP: send a workflow's comment to MWF as a message)
 * registers here. Listeners run AFTER the comment is stored, off the request, on the background
 * pool: they never delay or fail the comment, and a throw is logged and swallowed.
 *
 * Process-wide by design (like every extension registry): the event itself runs inside the
 * request's async context, so a listener's reads land in the right tenant.
 */

export type { CommentCreatedEvent } from '@nivaro/extension-kit'

type Listener = (event: CommentCreatedEvent) => void | Promise<void>

const listeners = new Map<string, Listener[]>()

/** Test seam: replaced in tests so the loader (and its imports) never loads. */
let isEnabled: (extension: string) => Promise<boolean> = async (extension) => {
  const { extensionRegistry } = await import('../extensions/loader.js')
  return extensionRegistry.get(extension)?.enabled !== false
}
export function _setCommentListenersEnabledCheck(fn: typeof isEnabled): void {
  isEnabled = fn
}
export function _resetCommentListeners(): void {
  listeners.clear()
}

/** Returns false (and registers nothing) for a handler that is not a function. */
export function registerCommentListener(extension: string, fn: Listener): boolean {
  if (typeof fn !== 'function') return false
  const list = listeners.get(extension) ?? []
  list.push(fn)
  listeners.set(extension, list)
  return true
}

export function unregisterCommentListeners(extension: string): void {
  listeners.delete(extension)
}

export function commentListenerCount(extension: string): number {
  return listeners.get(extension)?.length ?? 0
}

/**
 * Tell every listener a comment was written. Fire-and-forget: returns at once; the listeners
 * run on the background pool. Resolves (for tests) once every listener has finished.
 */
export function commentCreated(event: CommentCreatedEvent): Promise<void> {
  if (listeners.size === 0) return Promise.resolve()
  const frozen = Object.freeze({ ...event })
  const run = async () => {
    for (const [extension, list] of [...listeners]) {
      let enabled = true
      try {
        enabled = await isEnabled(extension)
      } catch {
        enabled = true
      }
      if (!enabled) continue
      for (const fn of list) {
        try {
          await fn(frozen)
        } catch (err) {
          console.error(
            { err, extension, collection: event.collection, item: event.item },
            'comment listener failed'
          )
        }
      }
    }
  }
  return runInBackgroundPool(() => run()).catch(() => {})
}

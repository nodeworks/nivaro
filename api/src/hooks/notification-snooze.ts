import { hooks } from './registry.js'
import { wakeOnChange } from '../services/notification-snooze.js'

/** #647: a field write on a record wakes the notifications snoozed until it changes. */
export function registerSnoozeWakeHooks(): void {
  for (const action of ['update', 'delete'] as const) {
    hooks.after('*', action, async (ctx) => {
      if (/^nivaro_|^directus_/i.test(ctx.collection)) return
      const actor = (ctx.user as { id?: string } | null | undefined)?.id ?? null
      for (const id of ctx.keys ?? []) {
        void wakeOnChange(ctx.collection, id, actor, action === 'delete' ? 'deleted' : 'changed')
      }
    })
  }
}

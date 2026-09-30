import { getApp } from '../services/io-holder.js'
import { checkDoneWhen, doneWhenWatchlist } from '../services/tasks.js'
import { hooks } from './registry.js'

/**
 * Self-closing tasks (#1016): a write to a record — or to a row its task's
 * related-row rule counts ("a line item was added") — re-checks the open
 * tasks with a done_when on that record. Coalesced per record so a form
 * save that writes twenty lines costs one check; the hourly sweep covers
 * raw-SQL writers.
 */
const QUIET_MS = 1500
const pending = new Map<string, ReturnType<typeof setTimeout>>()

function schedule(collection: string, id: string): void {
  const key = `${collection}:${id}`
  const prior = pending.get(key)
  if (prior) clearTimeout(prior)
  pending.set(
    key,
    setTimeout(() => {
      pending.delete(key)
      void checkDoneWhen(getApp() ?? null, collection, id).catch(() => 0)
    }, QUIET_MS)
  )
}

export function registerTaskDoneWhenHooks(): void {
  for (const action of ['create', 'update', 'delete'] as const) {
    hooks.after('*', action, async (ctx) => {
      if (/^nivaro_|^directus_/i.test(ctx.collection)) return
      const watch = await doneWhenWatchlist().catch(() => null)
      if (!watch) return
      const id = ctx.keys?.[0]
      if (action !== 'delete' && id != null && watch.parents.has(ctx.collection))
        schedule(ctx.collection, String(id))
      const parents = watch.children.get(ctx.collection)
      if (!parents?.length) return
      const row = {
        ...(ctx.previousData ?? {}),
        ...(ctx.payload ?? {}),
        ...((ctx.result && typeof ctx.result === 'object' ? ctx.result : {}) as Record<
          string,
          unknown
        >)
      }
      for (const p of parents) {
        const fk = row[p.fk]
        if (fk != null && fk !== '') schedule(p.parent, String(fk))
      }
    })
  }
}

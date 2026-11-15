import type { FastifyInstance } from 'fastify'
import { deferEffect } from '../services/unit-of-work.js'
import { hooks } from './registry.js'

/**
 * Watch-list field alerts (rt6 #5): "tell me when <field> changes" on a pinned record. The
 * write path pays one cached lookup (which collections have any rule at all, 30 s) and nothing
 * else; the matching and the notify run after the write commits.
 */
export function registerWatchListHooks(): void {
  hooks.after('*', 'update', async (ctx) => {
    if (ctx.dryRun || !ctx.previousData || !ctx.result || !ctx.keys?.[0]) return
    if (/^(nivaro_|directus_)/i.test(ctx.collection)) return
    const { collectionsWithAlerts, runFieldAlerts } = await import(
      '../services/watch-list/alerts.js'
    )
    const watched = await collectionsWithAlerts().catch(() => new Set<string>())
    if (!watched.has(ctx.collection)) return
    const collection = ctx.collection
    const item = String(ctx.keys[0])
    const previous = ctx.previousData as Record<string, unknown>
    const next = ctx.result as Record<string, unknown>
    const actorId = ctx.user?.id != null ? String(ctx.user.id) : null
    void deferEffect('watch-list-field-alerts', async () => {
      const { getApp } = await import('../services/io-holder.js')
      const { runInBackgroundPool } = await import('../db/pool-context.js')
      await runInBackgroundPool(() =>
        runFieldAlerts(getApp() as FastifyInstance | null, {
          collection,
          item,
          previous,
          next,
          actorId
        })
      )
    })
  })

  // "Remove records when they're completed" for collections WITHOUT a pipeline: the picker
  // badges' automatic Inactive / Archived rule decides. Gate: a collection someone watches with
  // the switch on (in memory, 30 s); then one pipeline check (cached) and the rule on the row.
  hooks.after('*', 'update', async (ctx) => {
    if (ctx.dryRun || !ctx.result || !ctx.keys?.[0]) return
    if (/^(nivaro_|directus_)/i.test(ctx.collection)) return
    const { watchedForDone } = await import('../services/watch-list/completed.js')
    const watched = await watchedForDone().catch(() => new Set<string>())
    if (!watched.has(ctx.collection)) return
    const collection = ctx.collection
    const item = String(ctx.keys[0])
    const row = ctx.result as Record<string, unknown>
    void deferEffect('watch-list-completed', async () => {
      const { runInBackgroundPool } = await import('../db/pool-context.js')
      await runInBackgroundPool(async () => {
        const { applyCompletion, closedByRule } = await import(
          '../services/watch-list/completed.js'
        )
        const closed = await closedByRule(collection, row)
        if (closed === null) return
        await applyCompletion(collection, item, closed)
      })
    })
  })
}

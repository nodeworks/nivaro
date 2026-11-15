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
}

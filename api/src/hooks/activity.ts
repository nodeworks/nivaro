import { logActivity } from '../services/activity.js'
import { computeDelta, writeRevision } from '../services/revisions.js'
import { fireWebhooks } from '../services/webhook-dispatch.js'
import { hooks } from './registry.js'

export function registerActivityHooks() {
  hooks.after('*', 'create', async (ctx) => {
    if (ctx.collection.startsWith('nivaro_')) return
    const activityId = await logActivity({
      action: 'create',
      user: ctx.user?.id,
      collection: ctx.collection,
      item: ctx.keys?.[0] != null ? String(ctx.keys[0]) : undefined,
      req: ctx.req
    })
    if (activityId && ctx.result && ctx.keys?.[0] != null) {
      await writeRevision({
        activity: activityId,
        collection: ctx.collection,
        item: String(ctx.keys[0]),
        data: ctx.result as Record<string, unknown>,
        delta: null
      })
    }
    await fireWebhooks(ctx.collection, 'create', ctx.result)
  })

  hooks.after('*', 'update', async (ctx) => {
    if (ctx.collection.startsWith('nivaro_')) return
    const activityId = await logActivity({
      action: 'update',
      user: ctx.user?.id,
      collection: ctx.collection,
      item: ctx.keys?.[0] != null ? String(ctx.keys[0]) : undefined,
      req: ctx.req
    })
    if (activityId && ctx.result && ctx.keys?.[0] != null) {
      const delta = ctx.previousData
        ? computeDelta(ctx.previousData, ctx.result as Record<string, unknown>)
        : null
      await writeRevision({
        activity: activityId,
        collection: ctx.collection,
        item: String(ctx.keys[0]),
        data: ctx.result as Record<string, unknown>,
        delta
      })
    }
    await fireWebhooks(ctx.collection, 'update', ctx.result)
  })

  hooks.after('*', 'delete', async (ctx) => {
    if (ctx.collection.startsWith('nivaro_')) return
    const activityId = await logActivity({
      action: 'delete',
      user: ctx.user?.id,
      collection: ctx.collection,
      item: ctx.keys?.[0] != null ? String(ctx.keys[0]) : undefined,
      req: ctx.req
    })
    if (activityId && ctx.previousData && ctx.keys?.[0] != null) {
      await writeRevision({
        activity: activityId,
        collection: ctx.collection,
        item: String(ctx.keys[0]),
        data: ctx.previousData,
        delta: null
      })
    }
    await fireWebhooks(ctx.collection, 'delete', ctx.previousData)
  })
}

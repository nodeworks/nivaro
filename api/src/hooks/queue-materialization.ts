import { syncMaterializedQueueItem } from '../services/queue-materialization.js'
import { hooks } from './registry.js'

// Keeps nivaro_queue_items in sync with every collection write. syncMaterializedQueueItem
// itself is a cheap no-op (single lookup against nivaro_queue_sources/nivaro_queues) for
// any collection that isn't a source of a materialized queue, so registering this on '*'
// adds negligible cost for the common case.
export function registerQueueMaterializationHooks() {
  hooks.after('*', 'create', async (ctx) => {
    if (ctx.collection.startsWith('nivaro_')) return
    if (ctx.keys?.[0] == null) return
    await syncMaterializedQueueItem(ctx.collection, String(ctx.keys[0]))
  })

  hooks.after('*', 'update', async (ctx) => {
    if (ctx.collection.startsWith('nivaro_')) return
    if (ctx.keys?.[0] == null) return
    await syncMaterializedQueueItem(ctx.collection, String(ctx.keys[0]))
  })

  hooks.after('*', 'delete', async (ctx) => {
    if (ctx.collection.startsWith('nivaro_')) return
    if (ctx.keys?.[0] == null) return
    await syncMaterializedQueueItem(ctx.collection, String(ctx.keys[0]))
  })
}

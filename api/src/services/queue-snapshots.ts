import { db } from '../db/index.js'
import type { CronManager } from '../plugins/cron.js'
import type { User } from '../types.js'
import { fetchQueueItems } from './queues.js'

// Daily stat snapshots per queue, powering the stat-tile sparklines/deltas on the
// queue detail page. Each queue is resolved AS ITS OWNER — the same identity
// precedent the materialization backfill and public widget feeds already use
// (the owner configured the sources knowing what they expose).
export async function snapshotAllQueues(): Promise<{ ok: number; failed: number }> {
  const queues = (await db('nivaro_queues').where({ is_active: true }).select('id', 'owner')) as {
    id: string
    owner: string
  }[]

  let ok = 0
  let failed = 0
  const today = new Date()
  const snapshotDate = today.toISOString().slice(0, 10)

  for (const queue of queues) {
    try {
      const ownerUser = (await db('nivaro_users').where({ id: queue.owner }).first()) as
        | User
        | undefined
      if (!ownerUser) {
        failed++
        continue
      }
      const { stats, items } = await fetchQueueItems(queue.id, ownerUser, 'all', {})

      // Per-owner rollup from the same resolved item set — an item with N
      // owners counts once for each of them.
      const byOwner = new Map<
        string,
        { owned: number; sla_warning: number; sla_breached: number; at_risk: number }
      >()
      for (const item of items) {
        for (const o of item.owners) {
          const row = byOwner.get(o.id) ?? {
            owned: 0,
            sla_warning: 0,
            sla_breached: 0,
            at_risk: 0
          }
          row.owned++
          if (item.sla_status === 'warning') row.sla_warning++
          if (item.sla_status === 'breached') row.sla_breached++
          if (item.at_risk) row.at_risk++
          byOwner.set(o.id, row)
        }
      }

      // Idempotent upsert keyed on UNIQUE(queue_id, snapshot_date) — a manual
      // re-run replaces today's rows (queue-wide and per-owner alike).
      await db.transaction(async (trx) => {
        await trx('nivaro_queue_stat_snapshots')
          .where({ queue_id: queue.id, snapshot_date: snapshotDate })
          .delete()
        await trx('nivaro_queue_stat_snapshots').insert({
          queue_id: queue.id,
          snapshot_date: snapshotDate,
          total: stats.total,
          unowned: stats.unowned,
          sla_warning: stats.sla_warning,
          sla_breached: stats.sla_breached,
          at_risk: stats.at_risk,
          by_state: JSON.stringify(stats.by_state),
          created_at: new Date()
        })
        await trx('nivaro_queue_owner_snapshots')
          .where({ queue_id: queue.id, snapshot_date: snapshotDate })
          .delete()
        const ownerRows = [...byOwner.entries()].map(([userId, r]) => ({
          queue_id: queue.id,
          snapshot_date: snapshotDate,
          user: userId,
          owned: r.owned,
          sla_warning: r.sla_warning,
          sla_breached: r.sla_breached,
          at_risk: r.at_risk,
          created_at: new Date()
        }))
        // 8 bound params per row keeps chunks far under MSSQL's ~2100-param cap.
        for (let i = 0; i < ownerRows.length; i += 200) {
          await trx('nivaro_queue_owner_snapshots').insert(ownerRows.slice(i, i + 200))
        }
      })
      ok++
    } catch (err) {
      failed++
      // eslint-disable-next-line no-console
      console.warn(`queue snapshot failed for ${queue.id}:`, err)
    }
  }
  return { ok, failed }
}

export function registerQueueSnapshotCron(cron: CronManager): void {
  cron.schedule('queue-stats-snapshot', '0 2 * * *', async () => {
    await snapshotAllQueues()
  })
}

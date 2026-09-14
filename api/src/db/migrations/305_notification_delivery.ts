import type { Knex } from 'knex'

/**
 * Notification delivery + lanes + read tracking:
 *  - nivaro_notifications.category  — the notification-rules category the row
 *    was judged under (stamped at write; backfilled from the subject the same
 *    way classifyNotification sniffs it)
 *  - nivaro_notifications.lane      — 'critical' | 'needs_you' | 'fyi'
 *  - nivaro_notifications.read_at   — when the row was marked read (time-to-read)
 *  - nivaro_notifications.delivery  — JSON: per-channel outcome (in-app / push /
 *    email / sms) + the mail-log row id + unread-escalation stamps
 *  - nivaro_announcement_deliveries.notification_id — the inbox row a broadcast's
 *    'message' channel produced, so receipts can say "opened"
 *  - index (recipient, status, timestamp) — the badge counts every 30–60s per
 *    open tab and the table had only its PK
 */
export async function up(knex: Knex): Promise<void> {
  const t = 'nivaro_notifications'
  const add = async (col: string, fn: (tb: Knex.CreateTableBuilder) => void) => {
    if (!(await knex.schema.hasColumn(t, col))) await knex.schema.alterTable(t, fn)
  }
  await add('category', (tb) => {
    tb.string('category', 20).nullable()
  })
  await add('lane', (tb) => {
    tb.string('lane', 20).nullable()
  })
  await add('read_at', (tb) => {
    tb.datetime('read_at').nullable()
  })
  await add('delivery', (tb) => {
    tb.text('delivery').nullable()
  })

  // Backfill category from the subject — the same prefix/keyword rules
  // classifyNotification applies at write time, expressed in SQL.
  await knex.raw(`
    UPDATE ${t} SET category = CASE
      WHEN LOWER(subject) LIKE 'anomaly%' THEN 'anomaly'
      WHEN LOWER(subject) LIKE 'alert%' OR LOWER(subject) LIKE 'report alert%' THEN 'alerts'
      WHEN LOWER(subject) LIKE '%report%' OR LOWER(subject) LIKE 'view "%' THEN 'reports'
      WHEN LOWER(subject) LIKE '%mention%' THEN 'mentions'
      WHEN LOWER(subject) LIKE 'sla%' OR LOWER(subject) LIKE '%escalation%' OR LOWER(subject) LIKE '%breach%' THEN 'sla'
      WHEN LOWER(subject) LIKE '%watch%' OR (LOWER(subject) LIKE '%field%' AND LOWER(subject) LIKE '%changed%') THEN 'watch'
      WHEN LOWER(subject) LIKE '%workflow%' OR LOWER(subject) LIKE '%transition%' OR LOWER(subject) LIKE '%moved to%' OR LOWER(subject) LIKE '%approval%' THEN 'workflow'
      WHEN LOWER(subject) LIKE '%maintenance%' OR LOWER(subject) LIKE '%monitor%' OR LOWER(subject) LIKE '%import%' OR LOWER(subject) LIKE '%digest%' THEN 'system'
      ELSE 'other' END
    WHERE category IS NULL
  `)
  // Lane: critical subjects, then anything that asks the person to act
  // (a task / approval / access request / SLA row, any non-open action, a
  // mention), else FYI.
  await knex.raw(`
    UPDATE ${t} SET lane = CASE
      WHEN LOWER(subject) LIKE '%sla escalation%' OR LOWER(subject) LIKE '%maintenance%' OR LOWER(subject) LIKE '%monitor failing%' THEN 'critical'
      WHEN kind IN ('task','approval','access_request','sla') THEN 'needs_you'
      WHEN action IS NOT NULL AND action <> 'open' THEN 'needs_you'
      WHEN category IN ('mentions','sla') THEN 'needs_you'
      WHEN LOWER(subject) LIKE 'task assigned%' OR LOWER(subject) LIKE 'approval requested%' OR LOWER(subject) LIKE '%requested access%' THEN 'needs_you'
      ELSE 'fyi' END
    WHERE lane IS NULL
  `)

  const idx = await knex.raw(
    `SELECT 1 AS x FROM sys.indexes WHERE name = 'idx_notifications_recipient_status' AND object_id = OBJECT_ID('${t}')`
  )
  if (!(Array.isArray(idx) ? idx.length : 0)) {
    await knex.raw(
      `CREATE INDEX idx_notifications_recipient_status ON ${t} (recipient, status, timestamp)`
    )
  }

  const d = 'nivaro_announcement_deliveries'
  if ((await knex.schema.hasTable(d)) && !(await knex.schema.hasColumn(d, 'notification_id'))) {
    await knex.schema.alterTable(d, (tb) => {
      tb.integer('notification_id').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  const t = 'nivaro_notifications'
  await knex.raw(`DROP INDEX IF EXISTS idx_notifications_recipient_status ON ${t}`)
  for (const c of ['category', 'lane', 'read_at', 'delivery']) {
    if (await knex.schema.hasColumn(t, c)) {
      await knex.schema.alterTable(t, (tb) => {
        tb.dropColumn(c)
      })
    }
  }
  const d = 'nivaro_announcement_deliveries'
  if (await knex.schema.hasColumn(d, 'notification_id')) {
    await knex.schema.alterTable(d, (tb) => {
      tb.dropColumn('notification_id')
    })
  }
}

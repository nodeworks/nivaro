import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAuth } from '../middleware/authenticate.js'
import { getRelations } from '../services/collections.js'
import { classifyRelationSegment, getLabels } from '../services/queues.js'

/**
 * "Where do all my emails/texts/notifications come from?" — one endpoint
 * enumerating EVERY per-user notification source in the system, so the
 * profile page can show (and let the user prune) the complete picture.
 *
 * Every section is best-effort: a missing table (feature not deployed) or a
 * broken join degrades that section to empty, never 500s the profile.
 * Deletion/unsubscription stays with each feature's own routes — this is a
 * read model; the client wires each row to its existing own-CRUD endpoint.
 */
export async function meNotificationRoutes(app: FastifyInstance) {
  /**
   * Notification hygiene — per-source unread pile and read rate over the
   * last 30 days. A source someone never reads is a candidate to mute; the
   * client prompts when a pile crosses the threshold.
   */
  app.get('/users/me/notification-stats', { preHandler: requireAuth }, async (req) => {
    const since = new Date(Date.now() - 30 * 86_400_000)
    const rows = (await db('nivaro_notifications')
      .where('recipient', req.user!.id)
      .where('timestamp', '>=', since)
      .groupBy('collection')
      .select('collection')
      .count({ total: '*' })
      .sum({ unread: db.raw("CASE WHEN status = 'inbox' THEN 1 ELSE 0 END") } as never)) as Array<{
      collection: string | null
      total: number
      unread: number
    }>
    return {
      data: rows
        .map((r) => ({
          collection: r.collection,
          total: Number(r.total),
          unread: Number(r.unread ?? 0),
          read_rate:
            Number(r.total) > 0
              ? Math.round(((Number(r.total) - Number(r.unread ?? 0)) / Number(r.total)) * 100)
              : 100
        }))
        .sort((a, b) => b.unread - a.unread)
    }
  })

  app.get('/users/me/notification-sources', { preHandler: requireAuth }, async (req, reply) => {
    const uid = req.user!.id

    const [
      subscriptions,
      fieldWatches,
      recordAlerts,
      metricAlerts,
      anomalyRules,
      reportSubs,
      reportAlerts,
      viewSubs,
      chatRooms,
      pushDevices,
      prefsRow,
      ownerGroups,
      slaEscalations
    ] = await Promise.all([
      // Collection / queue / record subscriptions
      db('nivaro_notification_subscriptions as s')
        .leftJoin('nivaro_queues as q', 'q.id', 's.queue_id')
        .where('s.user', uid)
        .select(
          's.id',
          's.collection',
          's.event_type',
          's.filter_field',
          's.filter_value',
          's.label',
          's.is_active',
          's.digest_frequency',
          's.queue_id',
          's.filters',
          'q.name as queue_name'
        )
        .catch(() => []),
      // Field watches
      db('nivaro_field_watch_subscribers as fs')
        .join('nivaro_field_watches as w', 'w.id', 'fs.watch')
        .where('fs.user', uid)
        .select('fs.id', 'w.id as watch_id', 'w.name', 'w.collection', 'w.field')
        .catch(() => []),
      // Per-record alert engine subscriptions
      db('nivaro_alert_subscriptions as a')
        .join('nivaro_alert_definitions as d', 'd.id', 'a.alert_definition')
        .where('a.user', uid)
        .select(
          'a.id',
          'd.id as definition_id',
          'd.name',
          'd.collection',
          'a.notify_email',
          'a.notify_inapp',
          'd.is_active'
        )
        .catch(() => []),
      // Metric alert engine subscriptions
      db('nivaro_metric_alert_subscriptions as m')
        .join('nivaro_metric_alert_rules as r', 'r.id', 'm.rule_id')
        .leftJoin('nivaro_metric_definitions as md', 'md.id', 'r.definition_id')
        .where('m.user', uid)
        .select(
          'm.id',
          'r.id as rule_id',
          'md.metric_key',
          'r.operator',
          'r.threshold_value',
          'r.status as rule_status',
          'm.delivery_in_app',
          'm.delivery_email',
          'm.digest_frequency',
          'm.last_notified'
        )
        .catch(() => []),
      // Anomaly rules the user created (they receive the detections)
      db('nivaro_anomaly_rules')
        .where({ created_by: uid })
        .whereNot('status', 'archived')
        .select('id', 'name', 'check_frequency', 'delivery_in_app', 'delivery_email', 'status')
        .catch(() => []),
      // Report digests
      db('nivaro_report_subscriptions as rs')
        .join('nivaro_report_defs as r', 'r.id', 'rs.report')
        .where('rs.user', uid)
        .select(
          'rs.id',
          'r.id as report_id',
          'r.name',
          'rs.cadence',
          'rs.delivery_email',
          'rs.delivery_inapp',
          'rs.deliver_room',
          'rs.deliver_teams',
          'rs.attach_pdf',
          'rs.last_sent_at'
        )
        .catch(() => []),
      // Report alerts the user created (delivery goes to the creator)
      db('nivaro_report_alerts as ra')
        .join('nivaro_report_defs as r', 'r.id', 'ra.report')
        .where({ 'ra.created_by': uid, 'ra.is_active': 1 })
        .select(
          'ra.id',
          'r.id as report_id',
          'r.name as report_name',
          'ra.name',
          'ra.delivery_email',
          'ra.delivery_inapp'
        )
        .catch(() => []),
      // Saved-view digests
      db('nivaro_view_subscriptions as vs')
        .join('nivaro_saved_views as v', 'v.id', 'vs.view_id')
        .where('vs.user', uid)
        .select('vs.id', 'v.name', 'v.collection', 'vs.digest', 'vs.is_active', 'vs.last_run_at')
        .catch(() => []),
      // Chat rooms with customized delivery (muted / mentions-only)
      db('nivaro_chat_memberships')
        .where({ user: uid })
        .where((b) => b.where('is_muted', 1).orWhereNotNull('notify_mode'))
        .select('room', 'is_muted', 'notify_mode')
        .catch(() => []),
      // Web push devices
      db('nivaro_push_subscriptions')
        .where({ user: uid })
        .select('id', 'user_agent', 'created_at', 'last_used_at')
        .catch(() => []),
      // Email delivery preference (instant vs daily digest)
      db('nivaro_users')
        .where({ id: uid })
        .first('preferences')
        .catch(() => null),
      // Implicit: pipeline owner-group memberships — being an owner means
      // owner-notification flows and the daily digest can email you about
      // records you never explicitly subscribed to.
      db('nivaro_pipeline_owner_group_users as gu')
        .join('nivaro_pipeline_owner_groups as g', 'g.id', 'gu.group')
        .leftJoin('nivaro_workflow_templates as t', 't.id', 'g.template')
        .where('gu.user', uid)
        .select('t.name as template')
        .catch(() => []),
      // Implicit: SLA rules that escalate to this user
      db('nivaro_sla_rules as sr')
        .leftJoin('nivaro_workflow_templates as t', 't.id', 'sr.workflow_template')
        .where({ 'sr.escalation_user': uid, 'sr.is_active': 1 })
        .select('sr.id', 'sr.name', 'sr.state_key', 't.name as template')
        .catch(() => [])
    ])

    // Friendly labels for workflow-state subscriptions: the stored
    // filter_value is a machine state KEY — resolve it to the state's human
    // label so the profile never shows "waiting_on_oracle_approval".
    try {
      const stateKeys = [
        ...new Set(
          (
            subscriptions as Array<{
              event_type: string
              filter_field: string | null
              filter_value: string | null
            }>
          )
            .filter((r) => r.event_type === 'workflow_transition' && r.filter_value)
            .map((r) => String(r.filter_value))
        )
      ]
      if (stateKeys.length > 0) {
        const states = (await db('nivaro_workflow_states')
          .whereIn('key', stateKeys)
          .select('key', 'label')) as Array<{ key: string; label: string }>
        const byKey = new Map(states.map((r) => [r.key, r.label]))
        for (const r of subscriptions as Array<Record<string, unknown>>) {
          if (r.event_type === 'workflow_transition' && r.filter_value) {
            r.state_label = byKey.get(String(r.filter_value)) ?? null
          }
        }
      }
    } catch {
      /* labels are decoration */
    }

    // Human filter criteria: a state subscription scoped by zone/region/project
    // type must SAY so — "Zone 3 · Project type Commercial" — or the profile
    // implies a much broader subscription than the user actually has. Fields
    // resolve through the live relation graph (M2M alias, dotted M2O, plain
    // FK); ids resolve to display labels in ONE batched lookup per collection.
    try {
      type Cond = { field: string; op: string; value: unknown }
      const parsed = new Map<number, Cond[]>()
      for (const r of subscriptions as Array<Record<string, unknown>>) {
        if (!r.filters) continue
        try {
          const list = JSON.parse(String(r.filters)) as Cond[]
          if (Array.isArray(list) && list.length > 0) parsed.set(r.id as number, list)
        } catch {
          /* skip */
        }
      }
      if (parsed.size > 0) {
        // field path -> final target collection (per source collection)
        const targetCache = new Map<string, string | null>()
        const resolveTarget = async (collection: string, path: string): Promise<string | null> => {
          const key = `${collection}|${path}`
          if (targetCache.has(key)) return targetCache.get(key) ?? null
          let cur = collection
          let target: string | null = null
          try {
            for (const seg of path.split('.')) {
              const info = classifyRelationSegment(cur, seg, await getRelations(cur))
              if (!info?.relatedCollection) {
                target = null
                break
              }
              cur = info.relatedCollection
              target = cur
            }
          } catch {
            target = null
          }
          targetCache.set(key, target)
          return target
        }

        // Field display labels off nivaro_fields (first path segment).
        const fieldRows = (await db('nivaro_fields')
          .whereIn('collection', [
            ...new Set(
              (subscriptions as Array<{ collection: string | null }>)
                .map((r) => r.collection)
                .filter(Boolean)
            )
          ] as string[])
          .select('collection', 'field', 'label')) as Array<{
          collection: string
          field: string
          label: string | null
        }>
        const fieldLabel = (collection: string | null, path: string): string => {
          const head = path.split('.')[0]
          const leaf = path.split('.').pop() ?? path
          const row = fieldRows.find(
            (f) => f.collection === collection && f.field === (path.includes('.') ? leaf : head)
          )
          const base = row?.label ?? leaf.replace(/_/g, ' ')
          return base.charAt(0).toUpperCase() + base.slice(1)
        }

        // Gather ids per target collection for one batched label fetch.
        const wanted = new Map<string, Set<string>>()
        const condTargets = new Map<string, string | null>()
        for (const [id, conds] of parsed) {
          const sub = (subscriptions as Array<Record<string, unknown>>).find((r) => r.id === id)
          const coll = String(sub?.collection ?? '')
          for (const c of conds) {
            if (!coll || c.value == null) continue
            const target = c.field === 'id' ? coll : await resolveTarget(coll, c.field)
            condTargets.set(`${coll}|${c.field}`, target)
            if (!target) continue
            const vals = Array.isArray(c.value) ? c.value : [c.value]
            let set = wanted.get(target)
            if (!set) wanted.set(target, (set = new Set()))
            for (const v of vals) set.add(String(v))
          }
        }
        const labels =
          wanted.size > 0 ? await getLabels(wanted).catch(() => ({}) as Record<string, string>) : {}

        for (const [id, conds] of parsed) {
          const sub = (subscriptions as Array<Record<string, unknown>>).find((r) => r.id === id)
          if (!sub) continue
          const coll = String(sub.collection ?? '')
          const sentences: string[] = []
          for (const c of conds) {
            if (c.op === 'null') {
              sentences.push(`${fieldLabel(coll, c.field)} is empty`)
              continue
            }
            if (c.op === 'nnull') {
              sentences.push(`${fieldLabel(coll, c.field)} is set`)
              continue
            }
            const target = condTargets.get(`${coll}|${c.field}`)
            const vals = (Array.isArray(c.value) ? c.value : [c.value]).map((v) => {
              const lbl = target ? (labels as Record<string, string>)[`${target}:${v}`] : null
              return lbl ?? String(v)
            })
            const shown =
              vals.slice(0, 4).join(', ') + (vals.length > 4 ? ` +${vals.length - 4} more` : '')
            sentences.push(`${fieldLabel(coll, c.field)}: ${shown}`)
          }
          if (sentences.length > 0) sub.criteria = sentences
        }
      }
    } catch {
      /* criteria are decoration — the subscription list must never fail */
    }

    // Last-fired per record-alert definition (one grouped query).
    try {
      const defIds = (recordAlerts as Array<{ definition_id: number }>).map((r) => r.definition_id)
      if (defIds.length > 0) {
        const lastRows = (await db('nivaro_alert_log')
          .whereIn('alert_definition', defIds)
          .groupBy('alert_definition')
          .select('alert_definition')
          .max({ last: 'triggered_at' })) as Array<{ alert_definition: number; last: Date }>
        const byDef = new Map(lastRows.map((r) => [r.alert_definition, r.last]))
        for (const r of recordAlerts as Array<Record<string, unknown>>) {
          const last = byDef.get(r.definition_id as number)
          r.last_fired = last ? new Date(last).toISOString() : null
        }
      }
    } catch {
      /* decoration */
    }

    let emailDigest: string = 'instant'
    try {
      const prefs =
        typeof (prefsRow as { preferences?: unknown } | null)?.preferences === 'string'
          ? JSON.parse(String((prefsRow as { preferences?: unknown }).preferences))
          : ((prefsRow as { preferences?: unknown } | null)?.preferences ?? {})
      if (prefs && typeof prefs === 'object' && (prefs as { email_digest?: string }).email_digest) {
        emailDigest = String((prefs as { email_digest?: string }).email_digest)
      }
    } catch {
      /* default */
    }

    const templateCounts = new Map<string, number>()
    for (const g of ownerGroups as Array<{ template: string | null }>) {
      const t = g.template ?? 'Unknown template'
      templateCounts.set(t, (templateCounts.get(t) ?? 0) + 1)
    }

    return reply.send({
      data: {
        preferences: { email_digest: emailDigest },
        subscriptions,
        field_watches: fieldWatches,
        record_alerts: recordAlerts,
        metric_alerts: metricAlerts,
        anomaly_rules: anomalyRules,
        report_subscriptions: reportSubs,
        report_alerts: reportAlerts,
        view_subscriptions: viewSubs,
        chat_rooms: chatRooms,
        push_devices: pushDevices,
        implicit: {
          owner_group_memberships: [...templateCounts.entries()].map(([template, groups]) => ({
            template,
            groups
          })),
          sla_escalations: slaEscalations
        }
      }
    })
  })
  /** Merged "what actually fired" feed: in-app deliveries to me + alert-log
   *  firings for rules I subscribe to (or created). Newest first, capped.
   *  Each source degrades to empty — the history tab must never 500. */
  app.get('/users/me/notification-history', { preHandler: requireAuth }, async (req, reply) => {
    const uid = req.user!.id
    const limit = Math.min(200, Math.max(10, Number((req.query as { limit?: string }).limit) || 80))

    const [inApp, metricLog, recordLog, reportLog, deferredEmails, pushCountRow] =
      await Promise.all([
        db('nivaro_notifications')
          .where({ recipient: uid })
          .orderBy('timestamp', 'desc')
          .limit(limit)
          .select('id', 'subject', 'message', 'collection', 'item', 'timestamp', 'status', 'sender')
          .catch(() => []),
        db('nivaro_metric_alert_log as l')
          .join('nivaro_metric_alert_rules as r', 'r.id', 'l.rule_id')
          .join('nivaro_metric_alert_subscriptions as ms', 'ms.rule_id', 'r.id')
          .leftJoin('nivaro_metric_definitions as md', 'md.id', 'r.definition_id')
          .where('ms.user', uid)
          .orderBy('l.fired_at', 'desc')
          .limit(40)
          .select(
            'l.id',
            'md.metric_key',
            'l.metric_value',
            'l.threshold_value',
            'l.status',
            'l.fired_at',
            'l.resolved_at',
            'ms.delivery_in_app',
            'ms.delivery_email'
          )
          .catch(() => []),
        db('nivaro_alert_log as l')
          .join('nivaro_alert_definitions as d', 'd.id', 'l.alert_definition')
          .join('nivaro_alert_subscriptions as sub', 'sub.alert_definition', 'd.id')
          .where('sub.user', uid)
          .orderBy('l.triggered_at', 'desc')
          .limit(40)
          .select(
            'l.id',
            'd.name',
            'l.collection',
            'l.item',
            'l.field_value',
            'l.triggered_at',
            'sub.notify_email',
            'sub.notify_inapp'
          )
          .catch(() => []),
        db('nivaro_report_alert_log as l')
          .join('nivaro_report_alerts as a', 'a.id', 'l.alert')
          .join('nivaro_report_defs as r', 'r.id', 'a.report')
          .where('a.created_by', uid)
          .orderBy('l.fired_at', 'desc')
          .limit(40)
          .select(
            'l.id',
            'a.name',
            'r.name as report_name',
            'l.status',
            'l.fired_at',
            'a.delivery_email',
            'a.delivery_inapp'
          )
          .catch(() => []),
        // Emails queued for the daily action digest — the email leg of a
        // notification whose recipient prefers digest delivery.
        db('nivaro_deferred_emails')
          .where({ user: uid })
          .orderBy('created_at', 'desc')
          .limit(20)
          .select('id', 'subject', 'snippet', 'created_at')
          .catch(() => []),
        db('nivaro_push_subscriptions')
          .where({ user: uid })
          .count({ c: '*' })
          .first()
          .catch(() => ({ c: 0 }))
      ])

    type Entry = {
      kind: string
      at: string
      title: string
      detail: string | null
      collection?: string | null
      item?: string | null
      status?: string | null
      /** How this one was delivered — 'in-app' | 'email' | 'push' | 'digest email'. */
      channels?: string[]
    }
    const entries: Entry[] = []
    const hasPush = Number((pushCountRow as { c?: unknown })?.c ?? 0) > 0
    const chan = (email: unknown, inApp: unknown): string[] => {
      const out: string[] = []
      if (inApp) out.push('in-app')
      if (email) out.push('email')
      return out.length > 0 ? out : ['in-app']
    }
    for (const n of inApp as Array<Record<string, unknown>>) {
      entries.push({
        kind: 'notification',
        at: new Date(n.timestamp as string).toISOString(),
        title: String(n.subject ?? 'Notification'),
        detail: n.message ? String(n.message).slice(0, 200) : null,
        collection: (n.collection as string | null) ?? null,
        item: (n.item as string | null) ?? null,
        status: (n.status as string | null) ?? null,
        // Every nivaro_notifications row IS an in-app delivery; web push
        // mirrors it whenever the user has a registered device. The email
        // leg has no per-row delivery log, so it is never claimed here —
        // digest emails appear as their own entries below.
        channels: hasPush ? ['in-app', 'push'] : ['in-app']
      })
    }
    for (const m of metricLog as Array<Record<string, unknown>>) {
      if (!m.fired_at) continue
      entries.push({
        kind: 'metric_alert',
        at: new Date(m.fired_at as string).toISOString(),
        title: `Metric alert: ${String(m.metric_key ?? 'metric')}`,
        detail: `value ${String(m.metric_value)} crossed ${String(m.threshold_value)}${m.resolved_at ? ' — since resolved' : ''}`,
        status: (m.status as string | null) ?? null,
        channels: chan(m.delivery_email, m.delivery_in_app)
      })
    }
    for (const r of recordLog as Array<Record<string, unknown>>) {
      if (!r.triggered_at) continue
      entries.push({
        kind: 'record_alert',
        at: new Date(r.triggered_at as string).toISOString(),
        title: `Alert: ${String(r.name)}`,
        detail: r.field_value != null ? `value ${String(r.field_value)}` : null,
        collection: (r.collection as string | null) ?? null,
        item: (r.item as string | null) ?? null,
        channels: chan(r.notify_email, r.notify_inapp)
      })
    }
    for (const r of reportLog as Array<Record<string, unknown>>) {
      if (!r.fired_at) continue
      entries.push({
        kind: 'report_alert',
        at: new Date(r.fired_at as string).toISOString(),
        title: `Report alert: ${String(r.name)}`,
        detail: String(r.report_name ?? ''),
        status: (r.status as string | null) ?? null,
        channels: chan(r.delivery_email, r.delivery_inapp)
      })
    }
    for (const d of deferredEmails as Array<Record<string, unknown>>) {
      if (!d.created_at) continue
      entries.push({
        kind: 'digest_email',
        at: new Date(d.created_at as string).toISOString(),
        title: `Queued for your daily digest: ${String(d.subject ?? '')}`,
        detail: d.snippet ? String(d.snippet).slice(0, 160) : null,
        channels: ['digest email']
      })
    }
    entries.sort((a, b) => b.at.localeCompare(a.at))
    return reply.send({ data: entries.slice(0, limit) })
  })
  /** Pre-OOO exposure check: what goes uncovered if this user goes out of
   *  office WITHOUT a working delegate — open records they currently resolve
   *  as an owner of, plus SLA rules that escalate to them. The delegation
   *  card shows this at the moment the person can still fix it. Owner
   *  resolution is the my-work resolver (seconds, not ms) — the card fetches
   *  lazily, only when OOO is being enabled with no delegate. */
  app.get('/users/me/ooo-exposure', { preHandler: requireAuth }, async (req, reply) => {
    const uid = req.user!.id
    const [owned, slaRules] = await Promise.all([
      import('../services/queues.js')
        .then((m) => m.resolveOwnedByMeSource(uid))
        .then((r) =>
          Array.isArray((r as { items?: unknown[] }).items)
            ? (r as { items: unknown[] }).items.length
            : 0
        )
        .catch(() => 0),
      db('nivaro_sla_rules')
        .where({ escalation_user: uid, is_active: 1 })
        .count({ c: '*' })
        .first()
        .catch(() => ({ c: 0 }))
    ])
    return reply.send({
      data: {
        owned_open_records: owned,
        sla_escalations: Number((slaRules as { c?: unknown })?.c ?? 0)
      }
    })
  })
}

import { db } from '../../../db/index.js'
import type { HubNotifyEvent, HubNotifyPayload } from './notify.js'

/**
 * The one line deploy / incident / approval / drift / backup / certificate code calls for an
 * outbound Hub event (Task 13): `hubNotify('deploy.failed', {envId, detail})`. A leaf: it loads the
 * notify module (and the provider adapters behind it) only when some notify route is enabled, so a
 * Hub without routes — and every test of those flows — pays one indexed read and nothing else.
 * Never throws, never waits.
 */
export function hubNotify(event: HubNotifyEvent, payload: HubNotifyPayload = {}): void {
  void (async () => {
    const any = await db('nivaro_hub_notify_routes').where('enabled', true).first('id')
    if (!any) return
    const { notifyHub } = await import('./notify.js')
    await notifyHub(event, payload)
  })().catch(() => undefined)
}

/**
 * Task 33: a promotion (or rollback / apply) closed. A failure goes out as `deploy.failed` under
 * the dedupKey `deploy:<id>` (a PagerDuty incident opens, a Slack thread starts); a success goes
 * out as `deploy.finished` and — when the environment's previous closed run failed — resolves that
 * failure on the `deploy.failed` routes (the PagerDuty incident closes, the thread hears it is
 * fixed). The extra read happens only when some route is enabled. Never throws, never waits.
 */
export function hubNotifyDeployClosed(o: {
  deployId: number
  envId: number
  status: 'success' | 'failed'
  detail: string
}): void {
  void (async () => {
    const any = await db('nivaro_hub_notify_routes').where('enabled', true).first('id')
    if (!any) return
    const { notifyHub } = await import('./notify.js')
    if (o.status === 'failed') {
      await notifyHub('deploy.failed', {
        envId: o.envId,
        detail: o.detail,
        dedupKey: `deploy:${o.deployId}`,
        action: 'open'
      })
      return
    }
    await notifyHub('deploy.finished', { envId: o.envId, detail: o.detail })
    const prev = (await db('nivaro_hub_deploys')
      .where('environment_id', o.envId)
      .where('id', '<', o.deployId)
      .whereIn('status', ['success', 'failed'])
      .orderBy('id', 'desc')
      .first('id', 'status')) as { id: number; status: string } | undefined
    if (prev && String(prev.status) === 'failed')
      await notifyHub('deploy.failed', {
        envId: o.envId,
        title: `Deploy fixed: run #${Number(prev.id)} is resolved`,
        body: `A later run succeeded — ${o.detail}.`,
        severity: 'info',
        dedupKey: `deploy:${Number(prev.id)}`,
        action: 'resolve'
      })
  })().catch(() => undefined)
}

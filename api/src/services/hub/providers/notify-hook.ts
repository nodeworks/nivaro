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

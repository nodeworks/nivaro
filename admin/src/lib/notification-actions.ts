import type { NotificationActionSpec } from '@nivaro/shared'
import { toast } from 'sonner'
import { api } from '@/lib/api'

/**
 * Run a notification's inline action (server-described: endpoint + body) and
 * mark the row read when the action says so. Domain-blind on purpose — the
 * server decides what "Mark done" or "Acknowledge" hits.
 */
export async function runNotificationAction(
  action: NotificationActionSpec,
  notificationId: number,
  onDone?: () => void
): Promise<boolean> {
  try {
    if (action.method === 'PATCH') await api.patch(action.endpoint, action.body ?? {})
    else await api.post(action.endpoint, action.body ?? {})
    if (action.mark_read) await api.post(`/notifications/${notificationId}/read`).catch(() => {})
    toast.success(`${action.label} — done`)
    onDone?.()
    return true
  } catch (e) {
    const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error
    toast.error(msg ?? `${action.label} failed`)
    return false
  }
}

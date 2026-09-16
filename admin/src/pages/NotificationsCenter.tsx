import { createNivaro } from '@nivaro/sdk'
import {
  NavigationContext,
  NivaroProvider,
  NotificationCenterView,
  type NotificationRouteMap
} from '@nivaro/shared'
import { useMemo } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'

/** Where a notification's click lands in the admin app. */
const NOTIF_ROUTES: NotificationRouteMap = {
  record: (c, i) => `/collections/${c}/${i}`,
  list: (c) => `/collections/${c}`,
  report: (id) => `/report-studio/${id}`,
  queue: (id) => `/queues/${id}`,
  dashboard: (id) => `/dashboards/${id}`,
  alerts: () => '/alert-manager',
  imports: () => '/imports',
  issues: () => '/issues',
  tasks: () => '/tasks',
  approvals: () => '/approvals',
  access_requests: () => '/access-requests',
  my_work: () => '/my-work'
}

const sharedClient = createNivaro(typeof window !== 'undefined' ? window.location.origin : '')

/** Notifications Center — hosts the shared inbox view (lanes, delivery
 *  chips, reply actions, snooze) so the admin and the portal never drift. */
export function NotificationsCenterPage() {
  const navigate = useNavigate()
  const nav = useMemo(() => ({ navigate: (path: string) => navigate(path) }), [navigate])
  return (
    <NivaroProvider client={sharedClient}>
      <NavigationContext.Provider value={nav}>
        <NotificationCenterView
          routes={NOTIF_ROUTES}
          onNavigate={(p) => navigate(p)}
          app='admin'
          mailLogUrl={(id) => `/mail-log?id=${id}`}
          subscriptionsPath='/notification-subscriptions'
          onNotice={(m) => toast.success(m)}
          onError={(m) => toast.error(m)}
        />
      </NavigationContext.Provider>
    </NivaroProvider>
  )
}

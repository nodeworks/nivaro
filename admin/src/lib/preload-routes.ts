/**
 * Nav preloading (#369): hovering a sidebar item warms the route's lazy chunk
 * so the click renders instantly. The map mirrors App.tsx's lazy() imports for
 * the nav-reachable pages; a path with no entry is a no-op. Each import fires
 * at most once (the dynamic import cache makes repeats free anyway).
 */
const loaders: Record<string, () => Promise<unknown>> = {
  '/': () => import('@/pages/Dashboard'),
  '/my-work': () => import('@/pages/MyWork'),
  '/collections': () => import('@/pages/Collections'),
  '/users': () => import('@/pages/Users'),
  '/roles': () => import('@/pages/Roles'),
  '/pipelines': () => import('@/pages/Pipelines'),
  '/flows': () => import('@/pages/Flows'),
  '/dashboards': () => import('@/pages/Dashboards'),
  '/queues': () => import('@/pages/Queues'),
  '/tasks': () => import('@/pages/Tasks'),
  '/reports': () => import('@/pages/Reports'),
  '/alerts': () => import('@/pages/Alerts'),
  '/imports': () => import('@/pages/Imports'),
  '/settings': () => import('@/pages/Settings'),
  '/data-model': () => import('@/pages/DataModel'),
  '/activity': () => import('@/pages/Activity'),
  '/files': () => import('@/pages/Files'),
  '/background-jobs': () => import('@/pages/BackgroundJobs'),
  '/realtime': () => import('@/pages/Realtime'),
  '/health': () => import('@/pages/HealthDashboard'),
  '/api-analytics': () => import('@/pages/ApiAnalytics'),
  '/notifications': () => import('@/pages/NotificationsCenter'),
  '/chat': () => import('@/pages/Chat'),
  '/docs': () => import('@/pages/Docs')
}

const fired = new Set<string>()

export function preloadRoute(path: string): void {
  const loader = loaders[path]
  if (!loader || fired.has(path)) return
  fired.add(path)
  loader().catch(() => {
    // Chunk fetch failed (offline, deploy in flight) — allow a retry later.
    fired.delete(path)
  })
}

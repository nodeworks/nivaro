import { ErrorSurface } from '@nivaro/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Suspense, useEffect, useRef } from 'react'
import { BrowserRouter, Navigate, Route, useLocation, useNavigate, useParams } from 'react-router'
import { Toaster } from 'sonner'
import { HubRedirect } from '@/components/hub-page'
import { ExtensionPluginLoader } from '@/extensions/loader'
import { AppLayout } from '@/layouts/AppLayout'
import { AuthProvider, useAuth } from '@/lib/auth'
import { HUB_REDIRECTS, HUBS, hubTabPath } from '@/lib/hubs'
import { I18nProvider } from '@/lib/i18n'
// #2448 — lazy that remembers its loader, so nav hover can preload a screen's chunk
import { lazy, PreloadRoutes } from '@/lib/route-preload'
import { ThemeProvider, useTheme } from '@/lib/theme'
import { RecordAliasRedirect, SlugResolverPage } from '@/pages/SlugResolver'

/**
 * Sonner needs to be TOLD the theme — without the prop it renders light
 * surfaces no matter what class the app root carries, which under dark mode
 * meant near-white toasts with near-white text. resolvedTheme is the app's
 * actual light/dark answer (explicit choice or system), so toasts follow the
 * theme switcher exactly like every other surface.
 */
function ThemedToaster() {
  const { resolvedTheme } = useTheme()
  return <Toaster richColors position='bottom-right' theme={resolvedTheme} />
}

function safeRedirectPath(raw: string | null | undefined, fallback = '/'): string {
  if (!raw) return fallback
  try {
    const url = new URL(raw, window.location.origin)
    if (url.origin !== window.location.origin) return fallback
    return url.pathname + url.search + url.hash
  } catch {
    if (raw.startsWith('/') && !raw.startsWith('//')) return raw
    return fallback
  }
}

/** A post-login target the SPA does not route (the OAuth consent page, an API
 *  URL) — it must be a full page load, not a client-side navigation. */
const isServerPath = (path: string) => /^\/(oauth|api)\//.test(path)

const ActivityDetailPage = lazy(() =>
  import('@/pages/ActivityDetail').then((m) => ({ default: m.ActivityDetailPage }))
)
const CollectionBrowserV2Page = lazy(() =>
  import('@/pages/CollectionBrowserV2').then((m) => ({ default: m.CollectionBrowserV2Page }))
)
const CollectionsPage = lazy(() =>
  import('@/pages/Collections').then((m) => ({ default: m.CollectionsPage }))
)
const DashboardPage = lazy(() =>
  import('@/pages/Dashboard').then((m) => ({ default: m.DashboardPage }))
)
const ExtensionsPage = lazy(() =>
  import('@/pages/Extensions').then((m) => ({ default: m.ExtensionsPage }))
)
const FilesPage = lazy(() => import('@/pages/Files').then((m) => ({ default: m.FilesPage })))
const FlowEditPage = lazy(() =>
  import('@/pages/FlowEdit').then((m) => ({ default: m.FlowEditPage }))
)
const ItemEditPage = lazy(() =>
  import('@/pages/ItemEdit').then((m) => ({ default: m.ItemEditPage }))
)
const LoginPage = lazy(() => import('@/pages/Login').then((m) => ({ default: m.LoginPage })))
const SetupPage = lazy(() => import('@/pages/Setup').then((m) => ({ default: m.SetupPage })))
const RolesPage = lazy(() => import('@/pages/Roles').then((m) => ({ default: m.RolesPage })))
const SettingsPage = lazy(() =>
  import('@/pages/Settings').then((m) => ({ default: m.SettingsPage }))
)
const UserEditPage = lazy(() =>
  import('@/pages/UserEdit').then((m) => ({ default: m.UserEditPage }))
)
const UsersPage = lazy(() => import('@/pages/Users').then((m) => ({ default: m.UsersPage })))
const DataModelPage = lazy(() =>
  import('@/pages/DataModel').then((m) => ({ default: m.DataModelPage }))
)
const TableEditorPage = lazy(() =>
  import('@/pages/TableEditor').then((m) => ({ default: m.TableEditorPage }))
)
const PipelineEditPage = lazy(() =>
  import('@/pages/PipelineEdit').then((m) => ({ default: m.PipelineEditPage }))
)
const PipelinesPage = lazy(() =>
  import('@/pages/Pipelines').then((m) => ({ default: m.PipelinesPage }))
)
const ExternalApiEditPage = lazy(() =>
  import('@/pages/ExternalApiEdit').then((m) => ({ default: m.ExternalApiEditPage }))
)
const PayloadTemplateEditorPage = lazy(() =>
  import('@/pages/payload-templates/PayloadTemplateEditor').then((m) => ({
    default: m.PayloadTemplateEditorPage
  }))
)
const PayloadTemplateRedirectPage = lazy(() =>
  import('@/pages/payload-templates/PayloadTemplateEditor').then((m) => ({
    default: m.PayloadTemplateRedirectPage
  }))
)
const WebhookEditPage = lazy(() =>
  import('@/pages/WebhookEdit').then((m) => ({ default: m.WebhookEditPage }))
)
const ProceduresPage = lazy(() =>
  import('@/pages/Procedures').then((m) => ({ default: m.ProceduresPage }))
)
const CustomQueryEditPage = lazy(() =>
  import('@/pages/CustomQueryEdit').then((m) => ({ default: m.CustomQueryEditPage }))
)
const AskPage = lazy(() => import('@/pages/Ask').then((m) => ({ default: m.AskPage })))
const ChatPage = lazy(() => import('@/pages/Chat').then((m) => ({ default: m.ChatPage })))
const WallboardPage = lazy(() =>
  import('@/pages/Wallboard').then((m) => ({ default: m.WallboardPage }))
)
const TrashPage = lazy(() => import('@/pages/Trash').then((m) => ({ default: m.TrashPage })))
const ReportStudioEditPage = lazy(() =>
  import('@/pages/ReportStudioEdit').then((m) => ({ default: m.ReportStudioEditPage }))
)
const PublicDashboardPage = lazy(() =>
  import('@/pages/PublicDashboard').then((m) => ({ default: m.PublicDashboardPage }))
)
const ErdViewPage = lazy(() => import('@/pages/ErdView').then((m) => ({ default: m.ErdViewPage })))
const SchemaGraphPage = lazy(() =>
  import('@/pages/SchemaGraph').then((m) => ({ default: m.SchemaGraphPage }))
)
const DataIntegrityPage = lazy(() => import('@/pages/DataIntegrity'))
const AnnouncementsPage = lazy(() => import('@/pages/Announcements'))
const MyWorkPage = lazy(() => import('@/pages/MyWork').then((m) => ({ default: m.MyWorkPage })))
const SupportPage = lazy(() => import('@/pages/Support').then((m) => ({ default: m.SupportPage })))
const IdeasPage = lazy(() => import('@/pages/Ideas').then((m) => ({ default: m.IdeasPage })))
const IdeaDetailPage = lazy(() =>
  import('@/pages/IdeaDetail').then((m) => ({ default: m.IdeaDetailPage }))
)
const HelpVideosPage = lazy(() =>
  import('@/pages/HelpVideos').then((m) => ({ default: m.HelpVideosPage }))
)
const IntegrationHealthPage = lazy(() =>
  import('@/pages/IntegrationHealth').then((m) => ({ default: m.IntegrationHealthPage }))
)
const Realtime = lazy(() => import('@/pages/Realtime'))
const TrafficMap = lazy(() => import('@/pages/traffic-map/TrafficMap'))

const FindReplace = lazy(() => import('@/pages/FindReplace'))
const M2MMatrix = lazy(() => import('@/pages/M2MMatrix'))
const SetupChecklist = lazy(() => import('@/pages/SetupChecklist'))
const Sequences = lazy(() => import('@/pages/Sequences'))

const RuleEditPage = lazy(() =>
  import('@/pages/RuleEdit').then((m) => ({ default: m.RuleEditPage }))
)
const DashboardsPage = lazy(() =>
  import('@/pages/Dashboards').then((m) => ({ default: m.DashboardsPage }))
)
const DashboardDraftPage = lazy(() =>
  import('@/pages/DashboardDraft').then((m) => ({ default: m.DashboardDraftPage }))
)
const DashboardEditPage = lazy(() =>
  import('@/pages/DashboardEdit').then((m) => ({ default: m.DashboardEditPage }))
)
const ProfilePage = lazy(() => import('@/pages/Profile').then((m) => ({ default: m.ProfilePage })))
const WorkspacesPage = lazy(() =>
  import('@/pages/Workspaces').then((m) => ({ default: m.WorkspacesPage }))
)
const ScopeDimensionsPage = lazy(() =>
  import('@/pages/ScopeDimensions').then((m) => ({ default: m.ScopeDimensionsPage }))
)
const SubmissionFormsPage = lazy(() =>
  import('@/pages/SubmissionForms').then((m) => ({ default: m.SubmissionFormsPage }))
)
const SubmissionFormEditPage = lazy(() =>
  import('@/pages/SubmissionFormEdit').then((m) => ({ default: m.SubmissionFormEditPage }))
)
const ImportsPage = lazy(() => import('@/pages/Imports').then((m) => ({ default: m.ImportsPage })))
const AlertEditPage = lazy(() =>
  import('@/pages/AlertEdit').then((m) => ({ default: m.AlertEditPage }))
)
const HierarchiesPage = lazy(() =>
  import('@/pages/Hierarchies').then((m) => ({ default: m.HierarchiesPage }))
)
const HierarchyViewPage = lazy(() =>
  import('@/pages/HierarchyView').then((m) => ({ default: m.HierarchyViewPage }))
)
const RecordTemplatesPage = lazy(() => import('@/pages/RecordTemplates'))
const VirtualCollectionsPage = lazy(() => import('@/pages/VirtualCollections'))
const ApiKeysPage = lazy(() => import('@/pages/ApiKeys').then((m) => ({ default: m.ApiKeysPage })))
const NotificationsCenterPage = lazy(() =>
  import('@/pages/NotificationsCenter').then((m) => ({ default: m.NotificationsCenterPage }))
)
const PdfTemplatesPage = lazy(() =>
  import('@/pages/PdfTemplates').then((m) => ({ default: m.PdfTemplatesPage }))
)
const PlaygroundPage = lazy(() =>
  import('@/pages/Playground').then((m) => ({ default: m.PlaygroundPage }))
)
const PagesAdminPage = lazy(() =>
  import('@/pages/PagesAdmin').then((m) => ({ default: m.PagesAdminPage }))
)
const PageEditPage = lazy(() =>
  import('@/pages/PageEdit').then((m) => ({ default: m.PageEditPage }))
)
const PageViewPage = lazy(() =>
  import('@/pages/PageView').then((m) => ({ default: m.PageViewPage }))
)
const AiPlansPage = lazy(() => import('@/pages/AiPlans').then((m) => ({ default: m.AiPlansPage })))
const HubRoute = lazy(() => import('@/pages/Hubs').then((m) => ({ default: m.HubRoute })))
const InfrastructurePage = lazy(() =>
  import('@/pages/Infrastructure').then((m) => ({ default: m.InfrastructurePage }))
)
const ChaosPage = lazy(() => import('@/pages/Chaos').then((m) => ({ default: m.ChaosPage })))
const ChaosRunReport = lazy(() =>
  import('@/pages/chaos/RunReportPage').then((m) => ({ default: m.RunReportPage }))
)
const UserGroupsPage = lazy(() =>
  import('@/pages/UserGroups').then((m) => ({ default: m.UserGroupsPage }))
)
const FeatureFlagsPage = lazy(() =>
  import('@/pages/FeatureFlags').then((m) => ({ default: m.FeatureFlagsPage }))
)
const OpsConsolePage = lazy(() =>
  import('@/pages/OpsConsole').then((m) => ({ default: m.OpsConsolePage }))
)
const CommandCenterPage = lazy(() =>
  import('@/pages/CommandCenter').then((m) => ({ default: m.CommandCenterPage }))
)

const IssuesPage = lazy(() => import('@/pages/Issues').then((m) => ({ default: m.IssuesPage })))

const WidgetsPage = lazy(() => import('@/pages/Widgets').then((m) => ({ default: m.WidgetsPage })))
const TasksPage = lazy(() => import('@/pages/Tasks').then((m) => ({ default: m.TasksPage })))
// /workflows/:id was the standalone workflow-template editor (parallel
// branches); it now lives inside the pipeline editor.
function WorkflowTemplateRedirect() {
  const { id } = useParams<{ id: string }>()
  return <Navigate to={`/pipelines/${id ?? ''}`} replace />
}

/** ERP submissions became a tab of the Integrations console; record links
 *  (?collection=&item=) keep their lookup. */
function ErpSubmissionsRedirect() {
  const params = new URLSearchParams(useLocation().search)
  params.set('tab', 'erp')
  return <Navigate to={`/integration-health?${params}`} replace />
}

/** #743 — the classic browser was retired; old links land on the shared one. */
function ClassicBrowserRedirect() {
  const { collection } = useParams<{ collection: string }>()
  return <Navigate to={`/collections/${collection ?? ''}`} replace />
}

const ApprovalsPage = lazy(() =>
  import('@/pages/Approvals').then((m) => ({ default: m.ApprovalsPage }))
)
const QueuesPage = lazy(() => import('@/pages/Queues').then((m) => ({ default: m.QueuesPage })))
const QueueDetailPage = lazy(() =>
  import('@/pages/QueueDetail').then((m) => ({ default: m.QueueDetailPage }))
)
const AccountPage = lazy(() => import('@/pages/Account').then((m) => ({ default: m.AccountPage })))

const queryClient = new QueryClient({
  defaultOptions: {
    // A read that timed out (#2857) is not tried again: the error state is the answer, and a
    // second 30 s wait would double the spinner.
    queries: {
      retry: (failures, err) => {
        const e = err as { code?: string; name?: string } | null
        return failures < 1 && e?.code !== 'ECONNABORTED' && e?.name !== 'TimeoutError'
      },
      staleTime: 30_000
    }
  }
})

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth()
  const location = useLocation()
  if (loading) return <AppShell />
  if (!user) {
    const redirect = location.pathname + location.search
    return <Navigate to={`/login?redirect=${encodeURIComponent(redirect)}`} replace />
  }
  return <>{children}</>
}

/** `/login?reauth=1`: someone already signed in must sign in again (an AI app's
 *  consent page wants a recent sign-in) — show the form, do not bounce them. */
const isReauth = () =>
  window.location.pathname === '/login' &&
  new URLSearchParams(window.location.search).get('reauth') === '1'

function PublicRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth()
  if (loading) return <AppShell />
  if (user && !isReauth()) {
    const params = new URLSearchParams(window.location.search)
    const raw = params.get('redirect') ?? sessionStorage.getItem('nivaro_post_login_redirect')
    sessionStorage.removeItem('nivaro_post_login_redirect')
    const target = safeRedirectPath(raw)
    if (isServerPath(target)) {
      window.location.replace(target)
      return <AppShell />
    }
    return <Navigate to={target} replace />
  }
  return <>{children}</>
}

function PostLoginRedirect() {
  const { user, loading } = useAuth()
  const navigate = useNavigate()
  const fired = useRef(false)
  useEffect(() => {
    if (loading || !user || fired.current) return
    // The re-sign-in page redirects itself once the person signs in again.
    if (isReauth()) return
    const raw = sessionStorage.getItem('nivaro_post_login_redirect')
    if (raw) {
      fired.current = true
      sessionStorage.removeItem('nivaro_post_login_redirect')
      const target = safeRedirectPath(raw)
      if (isServerPath(target)) window.location.replace(target)
      else navigate(target, { replace: true })
    }
  }, [user, loading, navigate])
  return null
}

function NotFoundPage() {
  const navigate = useNavigate()
  return (
    <ErrorSurface
      variant='404'
      action={
        <button
          type='button'
          onClick={() => navigate('/')}
          className='rounded-md bg-nvr-cyan px-3 py-1.5 text-xs font-semibold text-white hover:brightness-110'
        >
          Go to the dashboard
        </button>
      }
    />
  )
}

function AppShell() {
  return (
    <div className='min-h-screen bg-secondary flex items-center justify-center'>
      <svg width='56' height='56' viewBox='0 0 24 24' fill='none' aria-label='Loading' role='img'>
        <polyline
          points='4,20 4,4 20,20 20,4'
          stroke='#1e96d2'
          strokeWidth='2'
          strokeLinecap='round'
          strokeLinejoin='round'
          className='nvr-loader'
        />
      </svg>
    </div>
  )
}

export default function App() {
  return (
    <ThemeProvider>
      <I18nProvider>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <BrowserRouter>
              <PostLoginRedirect />
              <PreloadRoutes>
                <Route
                  path='/login'
                  element={
                    <PublicRoute>
                      <Suspense fallback={<AppShell />}>
                        <LoginPage />
                      </Suspense>
                    </PublicRoute>
                  }
                />
                <Route
                  path='/setup'
                  element={
                    <Suspense fallback={<AppShell />}>
                      <SetupPage />
                    </Suspense>
                  }
                />
                <Route
                  path='/wallboard'
                  element={
                    <Suspense fallback={<AppShell />}>
                      <WallboardPage />
                    </Suspense>
                  }
                />
                <Route
                  path='/d/:token'
                  element={
                    <Suspense fallback={<AppShell />}>
                      <PublicDashboardPage />
                    </Suspense>
                  }
                />
                <Route
                  element={
                    <ProtectedRoute>
                      <ExtensionPluginLoader />
                      <AppLayout />
                    </ProtectedRoute>
                  }
                >
                  <Route index element={<DashboardPage />} />
                  <Route path='collections' element={<CollectionsPage />} />
                  <Route path='collections/:collection' element={<CollectionBrowserV2Page />} />
                  <Route
                    path='collections/:collection/classic'
                    element={<ClassicBrowserRedirect />}
                  />
                  <Route path='collections/:collection/s/:slug' element={<SlugResolverPage />} />
                  <Route
                    path='collections/:collection/:id'
                    element={
                      <RecordAliasRedirect>
                        <ItemEditPage />
                      </RecordAliasRedirect>
                    }
                  />
                  <Route path='users' element={<UsersPage />} />
                  <Route path='users/:id' element={<UserEditPage />} />
                  <Route path='roles' element={<RolesPage />} />
                  <Route path='flows/:id' element={<FlowEditPage />} />
                  <Route path='files' element={<FilesPage />} />
                  <Route path='activity/:id' element={<ActivityDetailPage />} />
                  <Route path='data-model' element={<DataModelPage />} />
                  <Route path='data-model/erd' element={<ErdViewPage />} />
                  <Route path='data-model/graph' element={<SchemaGraphPage />} />
                  <Route path='data-model/:table' element={<TableEditorPage />} />
                  <Route path='pipelines' element={<PipelinesPage />} />
                  <Route path='pipelines/:id' element={<PipelineEditPage />} />
                  <Route path='external-apis/:id' element={<ExternalApiEditPage />} />
                  <Route
                    path='external-apis/:id/payloads/:key?'
                    element={<PayloadTemplateEditorPage />}
                  />
                  <Route path='payload-templates/:key' element={<PayloadTemplateRedirectPage />} />
                  <Route path='extensions' element={<ExtensionsPage />} />
                  <Route path='settings' element={<SettingsPage />} />
                  <Route path='webhooks/:id' element={<WebhookEditPage />} />
                  <Route path='procedures' element={<ProceduresPage />} />
                  <Route path='custom-queries/:id' element={<CustomQueryEditPage />} />
                  <Route path='data-integrity' element={<DataIntegrityPage />} />
                  <Route path='announcements' element={<AnnouncementsPage />} />
                  <Route path='my-work' element={<MyWorkPage />} />
                  <Route path='support' element={<SupportPage />} />
                  <Route path='help-videos' element={<HelpVideosPage />} />
                  <Route path='ideas' element={<IdeasPage />} />
                  <Route path='ideas/:id' element={<IdeaDetailPage />} />
                  <Route path='integration-health' element={<IntegrationHealthPage />} />
                  <Route
                    path='integration-events'
                    element={<Navigate to='/integration-health?tab=events' replace />}
                  />
                  <Route path='realtime' element={<Realtime />} />
                  <Route path='traffic-map' element={<TrafficMap />} />
                  <Route path='find-replace' element={<FindReplace />} />
                  <Route path='m2m-matrix' element={<M2MMatrix />} />
                  <Route path='setup-checklist' element={<SetupChecklist />} />
                  <Route path='sequences' element={<Sequences />} />
                  <Route path='trash' element={<TrashPage />} />
                  <Route path='report-studio/:id' element={<ReportStudioEditPage />} />
                  <Route path='rules/:id' element={<RuleEditPage />} />
                  <Route path='dashboards' element={<DashboardsPage />} />
                  <Route path='ask' element={<AskPage />} />
                  <Route path='chat' element={<ChatPage />} />
                  <Route path='dashboards/draft' element={<DashboardDraftPage />} />
                  <Route path='dashboards/:id' element={<DashboardEditPage />} />
                  <Route path='profile' element={<ProfilePage />} />
                  <Route path='workspaces' element={<WorkspacesPage />} />
                  <Route path='scope-dimensions' element={<ScopeDimensionsPage />} />
                  <Route path='submission-forms' element={<SubmissionFormsPage />} />
                  <Route path='submission-forms/:id' element={<SubmissionFormEditPage />} />
                  <Route path='imports' element={<ImportsPage />} />
                  <Route path='imports/:id' element={<ImportsPage />} />
                  <Route path='alerts/:id' element={<AlertEditPage />} />
                  <Route path='hierarchies' element={<HierarchiesPage />} />
                  <Route path='hierarchies/:id' element={<HierarchiesPage />} />
                  <Route path='hierarchies/:id/tree' element={<HierarchyViewPage />} />
                  <Route path='record-templates' element={<RecordTemplatesPage />} />
                  <Route path='virtual-collections' element={<VirtualCollectionsPage />} />
                  <Route path='api-keys' element={<ApiKeysPage />} />
                  <Route path='notifications' element={<NotificationsCenterPage />} />
                  <Route path='pdf-templates' element={<PdfTemplatesPage />} />
                  <Route path='playground' element={<PlaygroundPage />} />
                  <Route path='pages-admin' element={<PagesAdminPage />} />
                  <Route path='pages-admin/:id/edit' element={<PageEditPage />} />
                  <Route path='p/:slug' element={<PageViewPage />} />
                  <Route path='ai-plans' element={<AiPlansPage />} />
                  {/* Hub pages (lib/hubs.ts): one route per tab; the old standalone
                      paths redirect onto their tab with the query string kept. */}
                  {HUBS.flatMap((hub) =>
                    hub.tabs.map((tab) => {
                      const path = hubTabPath(hub, tab)
                      return <Route key={path} path={path.slice(1)} element={<HubRoute />} />
                    })
                  )}
                  {HUB_REDIRECTS.map((r) => (
                    <Route
                      key={r.from}
                      path={r.from.slice(1)}
                      element={<HubRedirect to={r.to} />}
                    />
                  ))}
                  <Route path='erp-submissions' element={<ErpSubmissionsRedirect />} />
                  <Route path='infrastructure' element={<InfrastructurePage />} />
                  <Route path='chaos' element={<ChaosPage />} />
                  <Route path='chaos/runs/:id' element={<ChaosRunReport />} />
                  <Route path='ops-console' element={<OpsConsolePage />} />
                  <Route path='user-groups' element={<UserGroupsPage />} />
                  <Route path='feature-flags' element={<FeatureFlagsPage />} />
                  <Route path='command' element={<CommandCenterPage />} />
                  <Route
                    path='data-quality'
                    element={<Navigate to='/data-integrity?tab=quality' replace />}
                  />
                  <Route path='issues' element={<IssuesPage />} />
                  <Route path='issues/:id' element={<IssuesPage />} />
                  {/* The workflow template editor merged into /pipelines —
                      old links land on the unified editor. */}
                  <Route path='workflows' element={<Navigate to='/pipelines' replace />} />
                  <Route path='workflows/:id' element={<WorkflowTemplateRedirect />} />
                  <Route path='widgets' element={<WidgetsPage />} />
                  <Route path='tasks' element={<TasksPage />} />
                  <Route path='approvals' element={<ApprovalsPage />} />
                  <Route path='queues' element={<QueuesPage />} />
                  <Route path='queues/:id' element={<QueueDetailPage />} />
                  <Route path='account' element={<AccountPage />} />
                  <Route
                    path='extensions/ui/*'
                    element={
                      <div className='flex flex-1 min-h-0 flex-col items-center justify-center text-slate-400 text-sm'>
                        No plugin page found for this route.
                      </div>
                    }
                  />
                  <Route path='*' element={<NotFoundPage />} />
                </Route>
              </PreloadRoutes>
            </BrowserRouter>
            <ThemedToaster />
          </AuthProvider>
        </QueryClientProvider>
      </I18nProvider>
    </ThemeProvider>
  )
}

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { lazy, Suspense, useEffect, useRef } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router'
import { Toaster } from 'sonner'
import { ExtensionPluginLoader } from '@/extensions/loader'
import { AppLayout } from '@/layouts/AppLayout'
import { AuthProvider, useAuth } from '@/lib/auth'
import { ThemeProvider } from '@/lib/theme'

const ActivityPage = lazy(() =>
  import('@/pages/Activity').then((m) => ({ default: m.ActivityPage }))
)
const ActivityDetailPage = lazy(() =>
  import('@/pages/ActivityDetail').then((m) => ({ default: m.ActivityDetailPage }))
)
const CollectionBrowserPage = lazy(() =>
  import('@/pages/CollectionBrowser').then((m) => ({ default: m.CollectionBrowserPage }))
)
const CollectionsPage = lazy(() =>
  import('@/pages/Collections').then((m) => ({ default: m.CollectionsPage }))
)
const DashboardPage = lazy(() =>
  import('@/pages/Dashboard').then((m) => ({ default: m.DashboardPage }))
)
const DocsPage = lazy(() => import('@/pages/Docs').then((m) => ({ default: m.DocsPage })))
const ExtensionsPage = lazy(() =>
  import('@/pages/Extensions').then((m) => ({ default: m.ExtensionsPage }))
)
const FilesPage = lazy(() => import('@/pages/Files').then((m) => ({ default: m.FilesPage })))
const FlowEditPage = lazy(() =>
  import('@/pages/FlowEdit').then((m) => ({ default: m.FlowEditPage }))
)
const FlowsPage = lazy(() => import('@/pages/Flows').then((m) => ({ default: m.FlowsPage })))
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
const ExternalApisPage = lazy(() =>
  import('@/pages/ExternalApis').then((m) => ({ default: m.ExternalApisPage }))
)
const ExternalApiEditPage = lazy(() =>
  import('@/pages/ExternalApiEdit').then((m) => ({ default: m.ExternalApiEditPage }))
)
const GraphQLExplorerPage = lazy(() =>
  import('@/pages/GraphQLExplorer').then((m) => ({ default: m.GraphQLExplorerPage }))
)
const ApiDocsPage = lazy(() => import('@/pages/ApiDocs').then((m) => ({ default: m.ApiDocsPage })))
const WebhooksPage = lazy(() =>
  import('@/pages/Webhooks').then((m) => ({ default: m.WebhooksPage }))
)
const WebhookEditPage = lazy(() =>
  import('@/pages/WebhookEdit').then((m) => ({ default: m.WebhookEditPage }))
)
const CustomQueriesPage = lazy(() =>
  import('@/pages/CustomQueries').then((m) => ({ default: m.CustomQueriesPage }))
)
const CustomQueryEditPage = lazy(() =>
  import('@/pages/CustomQueryEdit').then((m) => ({ default: m.CustomQueryEditPage }))
)
const SchemaSnapshotPage = lazy(() =>
  import('@/pages/SchemaSnapshot').then((m) => ({ default: m.SchemaSnapshotPage }))
)
const BlackoutDatesPage = lazy(() =>
  import('@/pages/BlackoutDates').then((m) => ({ default: m.BlackoutDatesPage }))
)
const RulesPage = lazy(() => import('@/pages/Rules').then((m) => ({ default: m.RulesPage })))
const RuleEditPage = lazy(() =>
  import('@/pages/RuleEdit').then((m) => ({ default: m.RuleEditPage }))
)
const DashboardsPage = lazy(() =>
  import('@/pages/Dashboards').then((m) => ({ default: m.DashboardsPage }))
)
const DashboardEditPage = lazy(() =>
  import('@/pages/DashboardEdit').then((m) => ({ default: m.DashboardEditPage }))
)
const ReportsPage = lazy(() => import('@/pages/Reports').then((m) => ({ default: m.ReportsPage })))
const ProfilePage = lazy(() => import('@/pages/Profile').then((m) => ({ default: m.ProfilePage })))
const WorkspacesPage = lazy(() =>
  import('@/pages/Workspaces').then((m) => ({ default: m.WorkspacesPage }))
)
const PresencePage = lazy(() =>
  import('@/pages/Presence').then((m) => ({ default: m.PresencePage }))
)
const AnalyticsPage = lazy(() =>
  import('@/pages/Analytics').then((m) => ({ default: m.AnalyticsPage }))
)
const SubmissionFormsPage = lazy(() =>
  import('@/pages/SubmissionForms').then((m) => ({ default: m.SubmissionFormsPage }))
)
const SubmissionFormEditPage = lazy(() =>
  import('@/pages/SubmissionFormEdit').then((m) => ({ default: m.SubmissionFormEditPage }))
)
const FieldWatchesPage = lazy(() =>
  import('@/pages/FieldWatches').then((m) => ({ default: m.FieldWatchesPage }))
)
const NotificationSubscriptionsPage = lazy(() =>
  import('@/pages/NotificationSubscriptions').then((m) => ({
    default: m.NotificationSubscriptionsPage
  }))
)
const ImportsPage = lazy(() => import('@/pages/Imports').then((m) => ({ default: m.ImportsPage })))
const ImportJobPage = lazy(() =>
  import('@/pages/ImportJobPage').then((m) => ({ default: m.ImportJobPage }))
)
const SlaRulesPage = lazy(() =>
  import('@/pages/SlaRules').then((m) => ({ default: m.SlaRulesPage }))
)
const AlertsPage = lazy(() => import('@/pages/Alerts').then((m) => ({ default: m.AlertsPage })))
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
const ScheduledChangesPage = lazy(() => import('@/pages/ScheduledChanges'))
const CollectionPresetsPage = lazy(() => import('@/pages/CollectionPresets'))
const VirtualCollectionsPage = lazy(() => import('@/pages/VirtualCollections'))
const ApiKeysPage = lazy(() => import('@/pages/ApiKeys').then((m) => ({ default: m.ApiKeysPage })))
const NotificationsCenterPage = lazy(() =>
  import('@/pages/NotificationsCenter').then((m) => ({ default: m.NotificationsCenterPage }))
)
const SyncJobsPage = lazy(() =>
  import('@/pages/SyncJobs').then((m) => ({ default: m.SyncJobsPage }))
)
const PdfTemplatesPage = lazy(() =>
  import('@/pages/PdfTemplates').then((m) => ({ default: m.PdfTemplatesPage }))
)
const SdkPlaygroundPage = lazy(() =>
  import('@/pages/SdkPlayground').then((m) => ({ default: m.SdkPlaygroundPage }))
)
const DeadLetterQueuePage = lazy(() =>
  import('@/pages/DeadLetterQueue').then((m) => ({ default: m.DeadLetterQueuePage }))
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
const ApiAnalyticsPage = lazy(() =>
  import('@/pages/ApiAnalytics').then((m) => ({ default: m.ApiAnalyticsPage }))
)
const HealthDashboardPage = lazy(() =>
  import('@/pages/HealthDashboard').then((m) => ({ default: m.HealthDashboardPage }))
)
const DataQualityPage = lazy(() =>
  import('@/pages/DataQuality').then((m) => ({ default: m.DataQualityPage }))
)
const RetentionPoliciesPage = lazy(() =>
  import('@/pages/RetentionPolicies').then((m) => ({ default: m.RetentionPoliciesPage }))
)
const IssuesPage = lazy(() => import('@/pages/Issues').then((m) => ({ default: m.IssuesPage })))
const WorkflowsPage = lazy(() =>
  import('@/pages/Workflows').then((m) => ({ default: m.WorkflowsPage }))
)
const WorkflowEditPage = lazy(() =>
  import('@/pages/WorkflowEdit').then((m) => ({ default: m.WorkflowEditPage }))
)
const WidgetsPage = lazy(() => import('@/pages/Widgets').then((m) => ({ default: m.WidgetsPage })))
const PersistedQueriesPage = lazy(() =>
  import('@/pages/PersistedQueries').then((m) => ({ default: m.PersistedQueriesPage }))
)
const ErpSubmissionsPage = lazy(() =>
  import('@/pages/ErpSubmissions').then((m) => ({ default: m.ErpSubmissionsPage }))
)
const TasksPage = lazy(() => import('@/pages/Tasks').then((m) => ({ default: m.TasksPage })))
const ApprovalsPage = lazy(() =>
  import('@/pages/Approvals').then((m) => ({ default: m.ApprovalsPage }))
)
const AtRiskPage = lazy(() => import('@/pages/AtRisk').then((m) => ({ default: m.AtRiskPage })))

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 30_000 }
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

function PublicRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth()
  if (loading) return <AppShell />
  if (user) {
    const params = new URLSearchParams(window.location.search)
    const to = params.get('redirect') ?? sessionStorage.getItem('nivaro_post_login_redirect') ?? '/'
    sessionStorage.removeItem('nivaro_post_login_redirect')
    return <Navigate to={to} replace />
  }
  return <>{children}</>
}

function PostLoginRedirect() {
  const { user, loading } = useAuth()
  const navigate = useNavigate()
  const fired = useRef(false)
  useEffect(() => {
    if (loading || !user || fired.current) return
    const to = sessionStorage.getItem('nivaro_post_login_redirect')
    if (to) {
      fired.current = true
      sessionStorage.removeItem('nivaro_post_login_redirect')
      navigate(to, { replace: true })
    }
  }, [user, loading, navigate])
  return null
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
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <BrowserRouter>
            <PostLoginRedirect />
            <Routes>
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
                element={
                  <ProtectedRoute>
                    <ExtensionPluginLoader />
                    <AppLayout />
                  </ProtectedRoute>
                }
              >
                <Route index element={<DashboardPage />} />
                <Route path='collections' element={<CollectionsPage />} />
                <Route path='collections/:collection' element={<CollectionBrowserPage />} />
                <Route path='collections/:collection/:id' element={<ItemEditPage />} />
                <Route path='users' element={<UsersPage />} />
                <Route path='users/:id' element={<UserEditPage />} />
                <Route path='roles' element={<RolesPage />} />
                <Route path='flows' element={<FlowsPage />} />
                <Route path='flows/:id' element={<FlowEditPage />} />
                <Route path='files' element={<FilesPage />} />
                <Route path='activity' element={<ActivityPage />} />
                <Route path='activity/:id' element={<ActivityDetailPage />} />
                <Route path='data-model' element={<DataModelPage />} />
                <Route path='data-model/:table' element={<TableEditorPage />} />
                <Route path='pipelines' element={<PipelinesPage />} />
                <Route path='pipelines/:id' element={<PipelineEditPage />} />
                <Route path='external-apis' element={<ExternalApisPage />} />
                <Route path='external-apis/:id' element={<ExternalApiEditPage />} />
                <Route path='extensions' element={<ExtensionsPage />} />
                <Route path='settings' element={<SettingsPage />} />
                <Route path='docs' element={<DocsPage />} />
                <Route path='graphql' element={<GraphQLExplorerPage />} />
                <Route path='api-docs' element={<ApiDocsPage />} />
                <Route path='webhooks' element={<WebhooksPage />} />
                <Route path='webhooks/:id' element={<WebhookEditPage />} />
                <Route path='custom-queries' element={<CustomQueriesPage />} />
                <Route path='custom-queries/:id' element={<CustomQueryEditPage />} />
                <Route path='schema-snapshot' element={<SchemaSnapshotPage />} />
                <Route path='blackout-dates' element={<BlackoutDatesPage />} />
                <Route path='rules' element={<RulesPage />} />
                <Route path='rules/:id' element={<RuleEditPage />} />
                <Route path='dashboards' element={<DashboardsPage />} />
                <Route path='dashboards/:id' element={<DashboardEditPage />} />
                <Route path='reports' element={<ReportsPage />} />
                <Route path='profile' element={<ProfilePage />} />
                <Route path='workspaces' element={<WorkspacesPage />} />
                <Route path='presence' element={<PresencePage />} />
                <Route path='analytics' element={<AnalyticsPage />} />
                <Route path='submission-forms' element={<SubmissionFormsPage />} />
                <Route path='submission-forms/:id' element={<SubmissionFormEditPage />} />
                <Route path='field-watches' element={<FieldWatchesPage />} />
                <Route
                  path='notification-subscriptions'
                  element={<NotificationSubscriptionsPage />}
                />
                <Route path='imports' element={<ImportsPage />} />
                <Route path='imports/:id' element={<ImportJobPage />} />
                <Route path='sla-rules' element={<SlaRulesPage />} />
                <Route path='alerts' element={<AlertsPage />} />
                <Route path='alerts/:id' element={<AlertEditPage />} />
                <Route path='hierarchies' element={<HierarchiesPage />} />
                <Route path='hierarchies/:id' element={<HierarchiesPage />} />
                <Route path='hierarchies/:id/tree' element={<HierarchyViewPage />} />
                <Route path='record-templates' element={<RecordTemplatesPage />} />
                <Route path='scheduled-changes' element={<ScheduledChangesPage />} />
                <Route path='collection-presets' element={<CollectionPresetsPage />} />
                <Route path='virtual-collections' element={<VirtualCollectionsPage />} />
                <Route path='api-keys' element={<ApiKeysPage />} />
                <Route path='notifications' element={<NotificationsCenterPage />} />
                <Route path='sync-jobs' element={<SyncJobsPage />} />
                <Route path='pdf-templates' element={<PdfTemplatesPage />} />
                <Route path='sdk-playground' element={<SdkPlaygroundPage />} />
                <Route path='dead-letters' element={<DeadLetterQueuePage />} />
                <Route path='pages-admin' element={<PagesAdminPage />} />
                <Route path='pages-admin/:id/edit' element={<PageEditPage />} />
                <Route path='p/:slug' element={<PageViewPage />} />
                <Route path='api-analytics' element={<ApiAnalyticsPage />} />
                <Route path='health' element={<HealthDashboardPage />} />
                <Route path='data-quality' element={<DataQualityPage />} />
                <Route path='privacy-retention' element={<RetentionPoliciesPage />} />
                <Route path='issues' element={<IssuesPage />} />
                <Route path='workflows' element={<WorkflowsPage />} />
                <Route path='workflows/:id' element={<WorkflowEditPage />} />
                <Route path='widgets' element={<WidgetsPage />} />
                <Route path='persisted-queries' element={<PersistedQueriesPage />} />
                <Route path='erp-submissions' element={<ErpSubmissionsPage />} />
                <Route path='tasks' element={<TasksPage />} />
                <Route path='approvals' element={<ApprovalsPage />} />
                <Route path='at-risk' element={<AtRiskPage />} />
                <Route
                  path='extensions/ui/*'
                  element={
                    <div className='flex flex-1 min-h-0 flex-col items-center justify-center text-slate-400 text-sm'>
                      No plugin page found for this route.
                    </div>
                  }
                />
              </Route>
            </Routes>
          </BrowserRouter>
          <Toaster richColors position='bottom-right' />
        </AuthProvider>
      </QueryClientProvider>
    </ThemeProvider>
  )
}

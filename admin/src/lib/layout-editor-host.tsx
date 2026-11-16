import {
  type LayoutEditorHost,
  LayoutEditorHostContext,
  type OverviewResponse,
  overviewKeys,
  useQueryEntryState
} from '@nivaro/shared'
import { type ReactNode, useMemo } from 'react'
import { useNavigate } from 'react-router'
import { LayoutAssistSection } from '@/components/ai-layout-assist'
import { LayoutReviewSection } from '@/components/ai-layout-review'
import { ExplainButton } from '@/components/explain-button'
import { useAuth } from '@/lib/auth'

/** What the editor hands explainSlot: `{ kind, label?, ...params }` for POST /ai-explain/:kind. */
type ExplainSubject = { kind?: unknown; label?: unknown } & Record<string, unknown>

function explain(subject: object): ReactNode {
  const { kind, label, ...params } = subject as ExplainSubject
  if (typeof kind !== 'string' || !kind) return null
  return (
    <ExplainButton
      key={JSON.stringify(subject)}
      kind={kind}
      params={params}
      label={typeof label === 'string' && label ? label : 'Describe this'}
    />
  )
}

/**
 * Admin's side of the layout editor contract (packages/shared layout-editor/host.tsx):
 * the admin gate, router navigation, the AI layout review and Explain, and the
 * "layouts here are overwritten" warning.
 */
export function AdminLayoutEditorHost({
  collection,
  children
}: {
  collection: string
  children: ReactNode
}) {
  const { user } = useAuth()
  const navigate = useNavigate()
  const isAdmin = !!user?.is_admin
  // The warning rides on the overview answer the editor and overview already
  // fetch: read that cache entry, never fetch it a second time. Watched, never observed: a
  // skipToken observer leaves the Query's queryFn as skipToken and the next invalidate of the
  // overview fails it with "Missing queryFn" (lib/use-query-entry.ts).
  const overview = useQueryEntryState<OverviewResponse>(overviewKeys.overview(collection))?.data
  const warning = overview?.warning ?? null
  const host = useMemo<LayoutEditorHost>(
    () => ({
      isAdmin,
      navigate: (to) => navigate(to),
      aiReviewSlot: isAdmin
        ? (layoutId, ctx) => (
            <>
              <LayoutReviewSection layoutId={layoutId} ctx={ctx} />
              <LayoutAssistSection layoutId={layoutId} ctx={ctx} />
            </>
          )
        : undefined,
      explainSlot: isAdmin ? explain : undefined,
      warning,
      recordLink: (col, id) =>
        `/collections/${encodeURIComponent(col)}/${encodeURIComponent(String(id))}`,
      layoutLink: (col, layoutId) =>
        `/data-model/${encodeURIComponent(col)}?tab=groups&layout=${layoutId}`
    }),
    [isAdmin, navigate, warning]
  )
  return (
    <LayoutEditorHostContext.Provider value={host}>{children}</LayoutEditorHostContext.Provider>
  )
}

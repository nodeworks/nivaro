import {
  type LayoutEditorHost,
  LayoutEditorHostContext,
  type OverviewResponse,
  overviewKeys
} from '@nivaro/shared'
import { skipToken, useQuery } from '@tanstack/react-query'
import { type ReactNode, useMemo } from 'react'
import { useNavigate } from 'react-router'
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
  // fetch: read that cache entry, never fetch it a second time.
  const { data: overview } = useQuery<OverviewResponse>({
    queryKey: overviewKeys.overview(collection),
    queryFn: skipToken
  })
  const warning = overview?.warning ?? null
  const host = useMemo<LayoutEditorHost>(
    () => ({
      isAdmin,
      navigate: (to) => navigate(to),
      aiReviewSlot: isAdmin ? (layoutId) => <LayoutReviewSection layoutId={layoutId} /> : undefined,
      explainSlot: isAdmin ? explain : undefined,
      warning,
      recordLink: (col, id) =>
        `/collections/${encodeURIComponent(col)}/${encodeURIComponent(String(id))}`
    }),
    [isAdmin, navigate, warning]
  )
  return (
    <LayoutEditorHostContext.Provider value={host}>{children}</LayoutEditorHostContext.Provider>
  )
}

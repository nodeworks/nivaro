import { createNivaro } from '@nivaro/sdk'
import {
  DrilldownContext,
  type DrilldownTarget,
  ItemEditAuthContext,
  ItemEditForm,
  NavigationContext,
  NivaroProvider
} from '@nivaro/shared'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, ExternalLink } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { titleCase } from '@/lib/utils'

// Drill-down sheet: a detailed view of any record, rendered by the SAME
// ItemEditForm that powers ItemEdit — so tabs, containers, field widths
// (col_span), groups, every field interface, per-field read-only, display
// formats, visibility rules, and lock rules all apply identically. The view is
// scoped by the target collection's DETAIL layout (layout_type='detail'):
// an explicit layoutId (pinned per queue column) beats the active default.
// Without any detail layout the full active grouped layout renders instead.
// All edits save through the normal items PATCH — RBAC / row security / locks
// enforce server-side.

interface DetailLayoutResponse {
  layout: { id: number; name: string; slug: string | null }
  groups: unknown[]
  assignments: unknown[]
}

export function RecordDrilldownSheet({
  collection,
  itemId,
  layoutId,
  width,
  title,
  onClose
}: {
  collection: string
  itemId: string
  layoutId?: number | null
  /** Panel width per config: px number or 'NN%' of the viewport; default 640. */
  width?: number | string | null
  title?: string
  onClose: () => void
}) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { user } = useAuth()
  const client = useMemo(() => createNivaro(window.location.origin), [])

  // Nested drilling: relation fields inside the sheet push onto this stack;
  // Back pops. The initial target comes from the props.
  const [stack, setStack] = useState<DrilldownTarget[]>([
    { collection, itemId, layoutId, width, title }
  ])
  const current = stack[stack.length - 1]
  const drillCtx = useMemo(
    () => ({ open: (target: DrilldownTarget) => setStack((prev) => [...prev, target]) }),
    []
  )

  const { data: detailLayout, isLoading: layoutLoading } = useQuery<DetailLayoutResponse | null>({
    queryKey: ['drilldown-layout', current.collection, current.layoutId ?? null],
    queryFn: () =>
      api
        .get(`/collection-layouts/detail/${current.collection}`, {
          params: current.layoutId ? { layout_id: current.layoutId } : {}
        })
        .then((r) => r.data.data ?? null)
  })

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        className='flex flex-col gap-0 overflow-hidden p-0'
        style={{ width: current.width ?? width ?? 640, maxWidth: '96vw' }}
      >
        <SheetHeader className='shrink-0 border-b border-slate-200 px-4 py-3 dark:border-border'>
          <SheetTitle className='flex items-center justify-between gap-2 pr-6 text-[14px]'>
            <span className='flex min-w-0 items-center gap-1.5'>
              {stack.length > 1 && (
                <button
                  type='button'
                  aria-label='Back'
                  onClick={() => setStack((prev) => prev.slice(0, -1))}
                  className='shrink-0 rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200'
                >
                  <ArrowLeft className='h-4 w-4' />
                </button>
              )}
              <span className='truncate'>
                {current.title || `${titleCase(current.collection)} · ${current.itemId}`}
              </span>
            </span>
            <Link
              to={`/collections/${current.collection}/${current.itemId}`}
              className='flex shrink-0 items-center gap-1 text-[11px] font-normal text-nvr-navy hover:underline dark:text-nvr-cyan'
            >
              Open record <ExternalLink className='h-3 w-3' />
            </Link>
          </SheetTitle>
          <p className='text-left text-[11px] text-slate-400'>
            {titleCase(current.collection)}
            {detailLayout ? ` · ${detailLayout.layout.name}` : ''}
          </p>
        </SheetHeader>

        <div className='min-h-0 flex-1 overflow-y-auto'>
          {layoutLoading ? (
            <div className='space-y-2 px-4 py-3'>
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <div key={i} className='h-8 animate-pulse rounded bg-slate-100 dark:bg-muted' />
              ))}
            </div>
          ) : (
            <NivaroProvider client={client}>
              <NavigationContext.Provider value={{ navigate }}>
                <ItemEditAuthContext.Provider
                  value={{ isAdmin: !!user?.is_admin, userId: String(user?.id ?? '') }}
                >
                  <DrilldownContext.Provider value={drillCtx}>
                    <ItemEditForm
                      key={`${current.collection}:${current.itemId}:${detailLayout?.layout.slug ?? 'default'}`}
                      collection={current.collection}
                      itemId={current.itemId}
                      layoutSlug={detailLayout?.layout.slug ?? undefined}
                      showHeader={false}
                      showRevisions={false}
                      showClone={false}
                      onSaved={() => {
                        qc.invalidateQueries({ queryKey: ['queue-items'] })
                      }}
                    />
                  </DrilldownContext.Provider>
                </ItemEditAuthContext.Provider>
              </NavigationContext.Provider>
            </NivaroProvider>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, ExternalLink } from 'lucide-react'
import { useMemo, useState } from 'react'
import { DrilldownContext, type DrilldownTarget, useNavigation, useNivaroClient } from '../context'
import { get } from '../lib/commands'
import { titleCase } from '../lib/utils'
import { ItemEditForm } from './ItemEditForm'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from './ui/sheet'

// Drill-down sheet: a detailed view of any record, rendered by the SAME
// ItemEditForm that powers ItemEdit — so tabs, containers, field widths
// (col_span), groups, every field interface, per-field read-only, display
// formats, visibility rules, and lock rules all apply identically. The view is
// scoped by the target collection's DETAIL layout (layout_type='detail'):
// an explicit layoutId (pinned per queue column) beats the active default.
// Without any detail layout the full active grouped layout renders instead.
// All edits save through the normal items PATCH — RBAC / row security / locks
// enforce server-side.
//
// Consumes the HOST's NivaroProvider / ItemEditAuthContext / NavigationContext
// (ItemEdit and QueueWorklist both render this inside their own provider
// trees) — it does not stand up its own client or auth context.

interface DetailLayoutResponse {
  layout: { id: number; name: string; slug: string | null }
  groups: unknown[]
  assignments: unknown[]
}

export function RecordDrilldownSheet({
  collection,
  itemId,
  layoutId,
  rootLayoutSlug,
  width,
  title,
  onClose
}: {
  collection: string
  itemId: string
  layoutId?: number | null
  /** Render the ROOT record with this exact layout slug (a queue's configured
   *  grouped item_layout), bypassing detail-layout resolution. Nested drills
   *  still use detail layouts. */
  rootLayoutSlug?: string | null
  /** Panel width per config: px number or 'NN%' of the viewport; default 640. */
  width?: number | string | null
  title?: string
  onClose: () => void
}) {
  const qc = useQueryClient()
  const client = useNivaroClient()
  const { navigate } = useNavigation()

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

  // The root record can render a pinned grouped layout (rootLayoutSlug) instead
  // of a resolved detail layout; nested drills always resolve detail layouts.
  const useRootSlug = stack.length === 1 && !!rootLayoutSlug

  const { data: detailLayout, isLoading: layoutLoading } = useQuery<DetailLayoutResponse | null>({
    queryKey: ['drilldown-layout', current.collection, current.layoutId ?? null],
    enabled: !useRootSlug,
    queryFn: () =>
      client
        .request<{ data: DetailLayoutResponse | null }>(
          get(
            `/collection-layouts/detail/${current.collection}`,
            current.layoutId ? { layout_id: current.layoutId } : {}
          )
        )
        .then((r) => r.data ?? null)
  })

  const effectiveSlug = useRootSlug
    ? (rootLayoutSlug ?? undefined)
    : (detailLayout?.layout.slug ?? undefined)

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
            <button
              type='button'
              onClick={() => navigate(`/collections/${current.collection}/${current.itemId}`)}
              className='flex shrink-0 items-center gap-1 text-[11px] font-normal text-nvr-navy hover:underline dark:text-nvr-cyan'
            >
              Open record <ExternalLink className='h-3 w-3' />
            </button>
          </SheetTitle>
          <p className='text-left text-[11px] text-slate-400'>
            {titleCase(current.collection)}
            {detailLayout ? ` · ${detailLayout.layout.name}` : ''}
          </p>
        </SheetHeader>

        <div className='min-h-0 flex-1 overflow-y-auto'>
          {layoutLoading && !useRootSlug ? (
            <div className='space-y-2 px-4 py-3'>
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <div key={i} className='h-8 animate-pulse rounded bg-slate-100 dark:bg-muted' />
              ))}
            </div>
          ) : (
            <DrilldownContext.Provider value={drillCtx}>
              <ItemEditForm
                key={`${current.collection}:${current.itemId}:${effectiveSlug ?? 'default'}`}
                collection={current.collection}
                itemId={current.itemId}
                layoutSlug={effectiveSlug}
                onSaved={() => {
                  qc.invalidateQueries({ queryKey: ['queue-items'] })
                }}
              />
            </DrilldownContext.Provider>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

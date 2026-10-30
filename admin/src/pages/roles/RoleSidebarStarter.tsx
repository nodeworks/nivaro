import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronUp, Eye, EyeOff, Pin, PinOff, RotateCcw } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { navCategories } from '@/layouts/nav-config'
import {
  applyNavLayout,
  MAX_PINNED,
  moveItem,
  type NavLayout,
  parseNavLayout,
  permittedCategories,
  resetCategory,
  toggleHidden,
  togglePinned
} from '@/layouts/nav-layout'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * #3227 — a role's starter sidebar: what people with this role see until they
 * customise their own, and what "Reset to default" brings them back to.
 * Built from the pages this role may open (its UI access list), so a starter
 * can only pin or order pages the role can reach. Saves on every change.
 */
export function RoleSidebarStarter({
  roleId,
  isAdminRole,
  disabled
}: {
  roleId: string
  isAdminRole: boolean
  disabled: string[]
}) {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({
    queryKey: ['nav-layout-roles'],
    queryFn: () =>
      api
        .get<{ data: Record<string, unknown>; available?: boolean }>('/nav-layout/roles')
        .then((r) => ({ map: r.data.data ?? {}, available: r.data.available !== false })),
    staleTime: 30_000
  })
  const stored = useMemo(
    () => parseNavLayout(data?.map?.[roleId.toUpperCase()] ?? null),
    [data, roleId]
  )
  // The optimistic copy belongs to the role it was made for; another role reads its own.
  const [draft, setDraft] = useState<{ role: string; layout: NavLayout | null } | null>(null)
  const layout = draft && draft.role === roleId ? draft.layout : stored

  const save = useMutation({
    mutationFn: (next: NavLayout | null) =>
      api.put(`/nav-layout/roles/${roleId}`, { layout: next }),
    onMutate: (next) => setDraft({ role: roleId, layout: next }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['nav-layout-roles'] })
      await qc.invalidateQueries({ queryKey: ['nav-layout-starter'] })
      setDraft(null)
    },
    onError: (err: unknown) => {
      setDraft(null)
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
      toast.error(msg ?? 'Could not save the starter sidebar')
    }
  })

  const disabledSet = useMemo(() => new Set(isAdminRole ? [] : disabled), [disabled, isAdminRole])
  const permitted = useMemo(() => permittedCategories(navCategories, disabledSet), [disabledSet])
  const shown = applyNavLayout(permitted, layout, { includeHidden: true })
  const [open, setOpen] = useState<string>('home')

  if (isLoading) {
    return (
      <div className='space-y-2'>
        {[0, 1, 2].map((i) => (
          <div key={i} className='h-8 animate-pulse rounded bg-slate-100 dark:bg-muted' />
        ))}
      </div>
    )
  }

  if (data && !data.available) {
    return (
      <p className='py-4 text-[13px] text-slate-500 dark:text-slate-400'>
        Starter sidebars need database migration 520 — restart the API to apply it.
      </p>
    )
  }

  const btn =
    'flex h-6 w-6 shrink-0 items-center justify-center rounded text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60 disabled:pointer-events-none disabled:opacity-30 dark:text-slate-500 dark:hover:bg-white/[0.06] dark:hover:text-slate-200'

  return (
    <div className='space-y-4' data-role-sidebar-starter={roleId}>
      <div className='flex flex-wrap items-start justify-between gap-3'>
        <p className='max-w-[560px] text-[12px] leading-relaxed text-slate-500 dark:text-slate-400'>
          The sidebar people with this role start from: pin pages to the top of a panel, hide the
          ones they rarely need, and set the order inside each section. Anyone who has not
          customised their own sidebar sees this, and Reset to default brings them back to it. Only
          pages this role may open are listed.
        </p>
        <button
          type='button'
          disabled={!layout || save.isPending}
          onClick={() => save.mutate(null)}
          className='inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 text-[12px] font-medium text-slate-600 transition-colors hover:bg-slate-50 hover:text-slate-900 disabled:pointer-events-none disabled:opacity-40 dark:border-border dark:bg-card dark:text-slate-300 dark:hover:bg-muted dark:hover:text-slate-100'
        >
          <RotateCcw className='h-3.5 w-3.5' />
          Clear starter
        </button>
      </div>

      <div className='overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
        {shown.map((cat) => {
          const expanded = open === cat.id
          const custom = !!layout?.categories[cat.id]
          const pinnedCount = cat.items.filter((i) => i.pinned).length
          return (
            <div
              key={cat.id}
              className='border-b border-slate-100 last:border-b-0 dark:border-border'
            >
              <div className='flex items-center gap-2 px-3 py-2'>
                <button
                  type='button'
                  onClick={() => setOpen(expanded ? '' : cat.id)}
                  aria-expanded={expanded}
                  className='flex min-w-0 flex-1 items-center gap-2 text-left text-[13px] font-medium text-slate-800 dark:text-slate-100'
                >
                  <cat.icon className='h-4 w-4 shrink-0 text-slate-400' />
                  <span className='truncate'>{cat.label}</span>
                  <span className='text-[11px] font-normal text-slate-400'>
                    {cat.items.filter((i) => !i.hidden).length} of {cat.items.length} shown
                  </span>
                  {custom && (
                    <span className='rounded-full bg-nvr-cyan/10 px-1.5 py-px text-[10px] font-semibold text-nvr-cyan'>
                      customised
                    </span>
                  )}
                </button>
                {custom && (
                  <button
                    type='button'
                    disabled={save.isPending}
                    onClick={() => save.mutate(resetCategory(layout, cat.id))}
                    className='text-[11px] font-medium text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100'
                  >
                    Reset
                  </button>
                )}
              </div>
              {expanded && (
                <ul className='pb-2'>
                  {cat.items.map((item, idx) => {
                    const block = cat.items.filter(
                      (i) =>
                        (i.section ?? '') === (item.section ?? '') && !!i.pinned === !!item.pinned
                    )
                    const pos = block.findIndex((i) => i.key === item.key)
                    return (
                      <li key={item.key}>
                        {item.section && item.section !== cat.items[idx - 1]?.section && (
                          <p className='px-9 pb-1 pt-2 text-[11px] font-semibold text-slate-400'>
                            {item.section}
                          </p>
                        )}
                        <div
                          className={cn(
                            'flex items-center gap-1 py-1 pl-9 pr-3 text-[12.5px]',
                            item.hidden
                              ? 'text-slate-400 line-through dark:text-slate-600'
                              : 'text-slate-700 dark:text-slate-200'
                          )}
                        >
                          <item.icon className='h-3.5 w-3.5 shrink-0 opacity-70' />
                          <span className='ml-1.5 min-w-0 flex-1 truncate'>{item.label}</span>
                          <button
                            type='button'
                            className={btn}
                            disabled={pos <= 0 || save.isPending}
                            onClick={() =>
                              save.mutate(moveItem(layout, cat.id, cat.items, item.key, -1))
                            }
                            aria-label={`Move ${item.label} up`}
                          >
                            <ChevronUp className='h-3.5 w-3.5' />
                          </button>
                          <button
                            type='button'
                            className={btn}
                            disabled={pos < 0 || pos >= block.length - 1 || save.isPending}
                            onClick={() =>
                              save.mutate(moveItem(layout, cat.id, cat.items, item.key, 1))
                            }
                            aria-label={`Move ${item.label} down`}
                          >
                            <ChevronDown className='h-3.5 w-3.5' />
                          </button>
                          <button
                            type='button'
                            className={cn(
                              btn,
                              item.pinned && 'text-nvr-cyan hover:text-nvr-cyan dark:text-nvr-cyan'
                            )}
                            disabled={(!item.pinned && pinnedCount >= MAX_PINNED) || save.isPending}
                            aria-pressed={!!item.pinned}
                            onClick={() => save.mutate(togglePinned(layout, cat.id, item.key))}
                            aria-label={item.pinned ? `Unpin ${item.label}` : `Pin ${item.label}`}
                            data-tip={item.pinned ? 'Unpin' : 'Pin to the top'}
                          >
                            {item.pinned ? (
                              <PinOff className='h-3.5 w-3.5' />
                            ) : (
                              <Pin className='h-3.5 w-3.5' />
                            )}
                          </button>
                          <button
                            type='button'
                            className={btn}
                            disabled={save.isPending}
                            aria-pressed={!!item.hidden}
                            onClick={() => save.mutate(toggleHidden(layout, cat.id, item.key))}
                            aria-label={item.hidden ? `Show ${item.label}` : `Hide ${item.label}`}
                            data-tip={item.hidden ? 'Show' : 'Hide'}
                          >
                            {item.hidden ? (
                              <EyeOff className='h-3.5 w-3.5' />
                            ) : (
                              <Eye className='h-3.5 w-3.5' />
                            )}
                          </button>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

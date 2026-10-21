import { useQuery } from '@tanstack/react-query'
import { BookmarkPlus, ChevronLeft, Copy } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../../context'
import { get } from '../../../lib/commands'
import type { GroupRow, LayoutBundle } from '../../../lib/layout-ops'
import { cn, titleCase } from '../../../lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover'
import { apiFailure, useInvalidateLayouts, useLayoutOverview } from '../overview/overview-api'
import { FieldMapStep, useFieldMapping } from './FieldMapStep'
import { copySection, leftOutWords, saveTemplate, useRefreshTemplates } from './reuse-api'

// A section's own reuse actions in the inspector (#2584, #2606): copy it to
// another layout — of this collection or any other — and save it to the
// section library. The keyboard path for the rail drag (drag a section onto a
// layout in the Layouts list).

export const reuseBtn =
  'inline-flex h-7 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2 text-[12px] font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50 dark:border-border dark:bg-card dark:text-foreground dark:hover:bg-muted'
export const reusePrimary =
  'inline-flex h-7 items-center gap-1.5 rounded-md bg-nvr-cyan px-2.5 text-[12px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50'
export const reuseInput =
  'h-8 w-full rounded-md border border-slate-200 bg-white px-2.5 text-[12.5px] text-slate-800 outline-none placeholder:text-slate-400 focus:border-nvr-cyan dark:border-border dark:bg-background dark:text-foreground dark:placeholder:text-muted-foreground'
export const reuseLabel =
  'mb-1 block text-[11.5px] font-semibold text-slate-600 dark:text-muted-foreground'
const rowCls =
  'flex w-full items-center gap-2 truncate rounded px-2 py-1.5 text-left text-[12.5px] text-slate-700 hover:bg-muted dark:text-foreground'

/** Fields a section holds (with its tabs), slot cards left out. */
export function sectionFields(bundle: LayoutBundle, key: string): string[] {
  const keys = new Set([key])
  for (let grew = true; grew; ) {
    grew = false
    for (const g of bundle.groups)
      if (g.parent_key && keys.has(g.parent_key) && !keys.has(g.key)) {
        keys.add(g.key)
        grew = true
      }
  }
  return [
    ...new Set(
      bundle.placements
        .filter((p) => p.group_key && keys.has(p.group_key) && !p.field.startsWith('__'))
        .map((p) => p.field)
    )
  ]
}

function useCollectionNames(enabled: boolean) {
  const client = useNivaroClient()
  return useQuery<Array<{ collection: string; label: string }>>({
    queryKey: ['layout-editor', 'collection-names'],
    queryFn: () =>
      client
        .request<{ data: Array<{ collection: string; display_name?: string | null }> }>(
          get('/collections')
        )
        .then((r) =>
          (r.data ?? [])
            .filter((c) => !c.collection.startsWith('nivaro_'))
            .map((c) => ({
              collection: c.collection,
              label: c.display_name || titleCase(c.collection)
            }))
            .sort((a, b) => a.label.localeCompare(b.label))
        ),
    enabled,
    staleTime: 5 * 60_000
  })
}

/** Copy `group` onto a layout: after a pick, the mapping step when the collection differs. */
export function CopyToLayout({
  bundle,
  collection,
  group,
  onCopied
}: {
  bundle: LayoutBundle
  collection: string
  group: GroupRow
  onCopied?: (layoutId: number, collection: string) => void
}) {
  const client = useNivaroClient()
  const [open, setOpen] = useState(false)
  const [target, setTarget] = useState(collection)
  const [picking, setPicking] = useState(false)
  const [q, setQ] = useState('')
  const [layoutId, setLayoutId] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const { data: overview, isLoading } = useLayoutOverview(target)
  const { data: collections = [] } = useCollectionNames(open && picking)
  const fields = useMemo(() => sectionFields(bundle, group.key), [bundle, group.key])
  const mapping = useFieldMapping(fields, collection, target)
  const invalidateTarget = useInvalidateLayouts(target)
  const sourceId = Number(bundle.layout.id)
  const layouts = (overview?.rows ?? []).filter(
    (r) => !(target === collection && r.layout_id === sourceId)
  )
  const name = group.label || titleCase(group.key)
  const needle = q.trim().toLowerCase()

  const reset = () => {
    setTarget(collection)
    setPicking(false)
    setQ('')
    setLayoutId(null)
  }

  const run = async () => {
    if (layoutId == null || busy) return
    setBusy(true)
    try {
      const res = await copySection(client, layoutId, {
        source_layout_id: sourceId,
        group_key: group.key,
        source_bundle: bundle,
        field_map: target === collection ? undefined : mapping.map
      })
      invalidateTarget()
      const to = layouts.find((l) => l.layout_id === layoutId)?.name ?? 'the layout'
      const extra = leftOutWords(res)
      toast.success(`Copied ${name} to ${to}${extra ? ` (${extra})` : ''}`)
      onCopied?.(layoutId, target)
      setOpen(false)
      reset()
    } catch (err) {
      toast.error(apiFailure(err, 'Could not copy the section').message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        setOpen(v)
        if (!v) reset()
      }}
    >
      <PopoverTrigger asChild>
        <button type='button' className={reuseBtn} data-reuse-copy=''>
          <Copy className='h-3.5 w-3.5' />
          Copy to layout…
        </button>
      </PopoverTrigger>
      <PopoverContent align='start' className='w-[340px] p-3'>
        <p className='mb-2 text-[12px] leading-snug text-slate-600 dark:text-muted-foreground'>
          Copy <b className='font-semibold text-slate-800 dark:text-foreground'>{name}</b> with its
          fields and settings. Tip: drag the section onto a layout in the Layouts list.
        </p>
        {picking ? (
          <>
            <button
              type='button'
              onClick={() => setPicking(false)}
              className='mb-1 inline-flex items-center gap-0.5 text-[12px] text-slate-500 hover:text-slate-800 dark:text-muted-foreground dark:hover:text-foreground'
            >
              <ChevronLeft className='h-3.5 w-3.5' />
              Back
            </button>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder='Find a collection'
              aria-label='Find a collection'
              className={reuseInput}
            />
            <div className='mt-1 max-h-[220px] overflow-y-auto overscroll-contain'>
              {collections
                .filter(
                  (c) =>
                    !needle ||
                    c.label.toLowerCase().includes(needle) ||
                    c.collection.includes(needle)
                )
                .slice(0, 60)
                .map((c) => (
                  <button
                    key={c.collection}
                    type='button'
                    className={rowCls}
                    onClick={() => {
                      setTarget(c.collection)
                      setLayoutId(null)
                      setPicking(false)
                      setQ('')
                    }}
                  >
                    <span className='truncate'>{c.label}</span>
                    <span className='ml-auto shrink-0 font-mono text-[11px] text-slate-400'>
                      {c.collection}
                    </span>
                  </button>
                ))}
            </div>
          </>
        ) : (
          <>
            <div className='flex items-center justify-between'>
              <span className={reuseLabel}>
                Layouts of <span className='font-mono font-normal'>{target}</span>
              </span>
              <button
                type='button'
                onClick={() => setPicking(true)}
                className='mb-1 text-[11.5px] font-medium text-[#0089ad] hover:underline dark:text-nvr-cyan'
              >
                Another collection…
              </button>
            </div>
            <div
              role='listbox'
              aria-label='Copy to layout'
              className='max-h-[200px] overflow-y-auto overscroll-contain'
            >
              {layouts.map((l) => (
                <button
                  key={l.layout_id}
                  type='button'
                  role='option'
                  aria-selected={layoutId === l.layout_id}
                  data-reuse-target={l.layout_id}
                  onClick={() => setLayoutId(l.layout_id)}
                  className={cn(rowCls, layoutId === l.layout_id && 'bg-accent hover:bg-accent')}
                >
                  <span className='truncate'>{l.name}</span>
                </button>
              ))}
              {!isLoading && layouts.length === 0 && (
                <p className='px-2 py-1.5 text-[12px] text-slate-500 dark:text-muted-foreground'>
                  No other layout here yet.
                </p>
              )}
            </div>
            {layoutId != null && target !== collection && (
              <div className='mt-2 border-t border-slate-200 pt-2 dark:border-border'>
                <FieldMapStep
                  needed={mapping.needed}
                  map={mapping.map}
                  onChange={mapping.setMap}
                  targetCollection={target}
                />
              </div>
            )}
            <div className='mt-3 flex justify-end'>
              <button
                type='button'
                className={reusePrimary}
                disabled={layoutId == null || busy || mapping.loading}
                onClick={() => void run()}
              >
                {busy ? 'Copying…' : 'Copy'}
              </button>
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}

/** Save `group` (with its tabs) to the section library. */
export function SaveSectionToLibrary({ bundle, group }: { bundle: LayoutBundle; group: GroupRow }) {
  const client = useNivaroClient()
  const refresh = useRefreshTemplates()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const fallback = group.label || titleCase(group.key)

  const save = async () => {
    const n = (name || fallback).trim()
    if (!n || busy) return
    setBusy(true)
    try {
      await saveTemplate(client, {
        kind: 'section',
        name: n,
        description: description || null,
        layout_id: Number(bundle.layout.id),
        group_key: group.key,
        bundle
      })
      refresh('section')
      toast.success(`Saved ${n} to the section library`)
      setOpen(false)
      setName('')
      setDescription('')
    } catch (err) {
      toast.error(apiFailure(err, 'Could not save the section').message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type='button' className={reuseBtn} data-reuse-save-section=''>
          <BookmarkPlus className='h-3.5 w-3.5' />
          Save to library…
        </button>
      </PopoverTrigger>
      <PopoverContent align='start' className='w-[320px] p-3'>
        <p className='mb-2 text-[12px] leading-snug text-slate-600 dark:text-muted-foreground'>
          Saved sections show under Add → Section library on every collection’s forms.
        </p>
        <label className='block'>
          <span className={reuseLabel}>Name</span>
          <input
            value={name}
            placeholder={fallback}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void save()
            }}
            className={reuseInput}
          />
        </label>
        <label className='mt-2 block'>
          <span className={reuseLabel}>Description (optional)</span>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder='What it is for'
            className={reuseInput}
          />
        </label>
        <div className='mt-3 flex justify-end'>
          <button
            type='button'
            className={reusePrimary}
            disabled={busy}
            onClick={() => void save()}
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** Both actions, for the section inspector. */
export function SectionReuseActions({
  bundle,
  collection,
  group
}: {
  bundle: LayoutBundle
  collection: string
  group: GroupRow
}) {
  return (
    <div
      data-reuse-actions=''
      className='flex flex-wrap gap-1.5 border-t border-slate-200 pt-3 dark:border-border'
    >
      <CopyToLayout bundle={bundle} collection={collection} group={group} />
      <SaveSectionToLibrary bundle={bundle} group={group} />
    </div>
  )
}

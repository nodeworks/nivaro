import { BookMarked, Link2, X } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../../context'
import type { LayoutBundle, LayoutOp } from '../../../lib/layout-ops'
import { cn } from '../../../lib/utils'
import { sectionOp } from '../add-target'
import type { DesignTarget } from '../design-context'
import { apiFailure } from '../overview/overview-api'
import type { ApplyOptions } from '../useLayoutDraft'
import { FieldMapStep, useFieldMapping } from './FieldMapStep'
import { createLink, useLinkedSectionsContext } from './linked-sections'
import {
  deleteTemplate,
  leftOutWords,
  planBlock,
  type TemplateSummary,
  useRefreshTemplates,
  useTemplates
} from './reuse-api'
import { reusePrimary } from './SectionReuseActions'

// "Section library" in the Add panel (#2606): sections saved from any
// collection's forms. A click drops one after the selection as one undo step;
// one from another collection first asks where fields without a same-name
// counterpart go.

const head = 'px-2 pb-1 pt-3 text-[11.5px] font-semibold text-slate-500 dark:text-muted-foreground'

interface Props {
  bundle: LayoutBundle
  collection: string
  selected: DesignTarget | null
  apply(ops: LayoutOp[], opts?: ApplyOptions): void
  onSelect(t: DesignTarget): void
  /** The Add panel's search. */
  matches: (...texts: Array<string | null | undefined>) => boolean
}

/** Where a dropped section goes in the top-level order: after the selection. */
function dropIndex(bundle: LayoutBundle, selected: DesignTarget | null): number | undefined {
  const op = sectionOp(bundle, selected)
  return op.op === 'group_create' && op.parent_key === null ? op.index : undefined
}

function LibraryRow({ t, ...p }: Props & { t: TemplateSummary }) {
  const client = useNivaroClient()
  const refresh = useRefreshTemplates()
  const linkedCtx = useLinkedSectionsContext()
  const [mapping, setMapping] = useState<null | 'copy' | 'linked'>(null)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const other = !!t.source_collection && t.source_collection !== p.collection
  const map = useFieldMapping(other ? t.fields : [], t.source_collection, p.collection)
  const layoutId = Number(p.bundle.layout.id)
  // Linking needs a saved layout to point at (and the editor's link state).
  const canLink = !!linkedCtx && Number.isInteger(layoutId) && layoutId > 0

  /** Drop a copy, or (#3194) a linked section that keeps following the library. */
  const drop = async (mode: 'copy' | 'linked') => {
    if (busy) return
    if (other && mapping !== mode && map.needed.length) {
      setMapping(mode)
      return
    }
    const linked = mode === 'linked'
    setBusy(true)
    try {
      const plan = await planBlock(client, {
        source: { template_id: t.id },
        target_collection: p.collection,
        target_bundle: p.bundle,
        field_map: other ? map.map : undefined,
        index: dropIndex(p.bundle, p.selected),
        linked
      })
      if (!plan.ops.length) throw new Error('Nothing to add')
      p.apply(plan.ops, { label: linked ? `Add ${t.name} (linked)` : `Add ${t.name}` })
      const first = plan.ops.find((o) => o.op === 'group_create')
      if (first?.op === 'group_create') p.onSelect({ kind: 'group', key: first.key })
      if (linked && plan.linked_key)
        try {
          await createLink(client, layoutId, {
            template_id: t.id,
            group_key: plan.linked_key,
            field_map: other ? map.map : undefined
          })
          linkedCtx?.refresh()
        } catch (err) {
          toast.error(
            `${t.name} was added as an ordinary copy: ${apiFailure(err, 'it could not be linked').message}`
          )
        }
      const extra = leftOutWords(plan)
      if (extra) toast(`${t.name} added: ${extra}`)
      setMapping(null)
    } catch (err) {
      toast.error(apiFailure(err, 'Could not add the section').message)
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    try {
      await deleteTemplate(client, t.id)
      refresh('section')
    } catch (err) {
      toast.error(apiFailure(err, 'Could not remove it').message)
    }
  }

  const sub = [
    `${t.fields.length} ${t.fields.length === 1 ? 'field' : 'fields'}`,
    t.linked_forms
      ? `linked on ${t.linked_forms} ${t.linked_forms === 1 ? 'form' : 'forms'}`
      : null,
    t.source_collection && t.source_collection !== p.collection
      ? `from ${t.source_collection}`
      : null,
    t.description
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div data-library-section={t.id}>
      <div className='group flex items-center gap-0.5'>
        <button
          type='button'
          disabled={busy || map.loading}
          onClick={() => void drop('copy')}
          className='flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted disabled:opacity-60'
        >
          <span className='flex min-w-0 flex-1 flex-col'>
            <span className='truncate text-[12.5px] font-medium text-slate-900 dark:text-foreground'>
              {t.name}
            </span>
            <span className='truncate text-[11.5px] text-slate-500 dark:text-muted-foreground'>
              {sub}
            </span>
          </span>
          <BookMarked className='h-3.5 w-3.5 shrink-0 text-slate-400' />
        </button>
        {canLink && (
          <button
            type='button'
            aria-label={`Add ${t.name} linked`}
            data-tip='Add linked: it follows the library, so a change there updates this form too'
            data-library-linked={t.id}
            disabled={busy || map.loading}
            onClick={() => void drop('linked')}
            className='invisible inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-muted hover:text-slate-700 group-hover:visible focus-visible:visible disabled:opacity-50 dark:hover:text-foreground'
          >
            <Link2 className='h-3.5 w-3.5' />
          </button>
        )}
        <button
          type='button'
          aria-label={`Remove ${t.name} from the library`}
          data-tip='Remove from the library'
          onClick={() => setConfirm(true)}
          className='invisible inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-muted hover:text-slate-700 group-hover:visible focus-visible:visible dark:hover:text-foreground'
        >
          <X className='h-3.5 w-3.5' />
        </button>
      </div>
      {confirm && (
        <div className='mx-2 mb-1 flex items-center gap-2 text-[12px] text-slate-600 dark:text-muted-foreground'>
          <span className='flex-1'>
            Remove from the library? Forms keep their copies
            {t.linked_forms ? '; linked ones become ordinary sections' : ''}.
          </span>
          <button
            type='button'
            onClick={() => void remove()}
            className='font-medium text-red-600 hover:underline dark:text-red-400'
          >
            Remove
          </button>
          <button type='button' onClick={() => setConfirm(false)} className='hover:underline'>
            Keep
          </button>
        </div>
      )}
      {mapping && (
        <div
          className={cn(
            'mx-1 mb-2 rounded-md border border-slate-200 bg-slate-50 p-2 dark:border-border dark:bg-muted/40'
          )}
        >
          <FieldMapStep
            needed={map.needed}
            map={map.map}
            onChange={map.setMap}
            targetCollection={p.collection}
          />
          <div className='mt-2 flex justify-end gap-2'>
            <button
              type='button'
              onClick={() => setMapping(null)}
              className='text-[12px] text-slate-500 hover:underline dark:text-muted-foreground'
            >
              Cancel
            </button>
            <button
              type='button'
              className={reusePrimary}
              disabled={busy}
              onClick={() => void drop(mapping ?? 'copy')}
            >
              {busy ? 'Adding…' : mapping === 'linked' ? 'Add linked' : 'Add section'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export function LibraryRows(props: Props) {
  const { data = [] } = useTemplates('section')
  const rows = data.filter((t) => props.matches(t.name, t.description, ...t.fields))
  if (!rows.length) return null
  return (
    <>
      <p className={head}>Section library</p>
      {rows.map((t) => (
        <LibraryRow key={t.id} t={t} {...props} />
      ))}
    </>
  )
}

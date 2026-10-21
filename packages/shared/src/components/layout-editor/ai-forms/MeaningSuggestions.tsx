import { Plus, Sparkles } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNivaroClient } from '../../../context'
import type { LayoutBundle, LayoutOp } from '../../../lib/layout-ops'
import { cn } from '../../../lib/utils'
import { useLayoutEditorHost } from '../host'
import { apiFailure, useOverviewFields } from '../overview/overview-api'
import { tintCard } from '../panel-style'
import type { ApplyOptions } from '../useLayoutDraft'
import { ghostBtn, quiet } from './AiComposer'
import { fetchMeaning } from './ai-forms-api'
import {
  type MeaningSuggestion,
  meaningChoices,
  meaningGroups,
  planMeaning,
  unplacedFields
} from './plan'

/**
 * Sections by meaning (#2672), in the Add panel: a home section for each field
 * that is not on the form, from what the field means — useful on a new
 * collection, where the usage suggestions (#2605) have no history yet. Each
 * suggestion is checked against the draft as it is now; Add / Add all is one
 * undo step. Admins only (AI).
 */
export function MeaningSuggestions({
  bundle,
  collection,
  apply
}: {
  bundle: LayoutBundle
  collection: string
  apply(ops: LayoutOp[], opts?: ApplyOptions): void
}) {
  const host = useLayoutEditorHost()
  const client = useNivaroClient()
  const { data: fields = [] } = useOverviewFields(collection)
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'asking' }
    | { kind: 'done'; suggestions: MeaningSuggestion[] }
    | { kind: 'error'; error: string }
  >({ kind: 'idle' })
  const env = useMemo(() => ({ fields }), [fields])
  const unplaced = useMemo(
    () => unplacedFields(bundle, fields as Array<{ field: string; hidden?: boolean | null }>),
    [bundle, fields]
  )
  const groups = useMemo(() => meaningGroups(bundle), [bundle])
  const choices = useMemo(
    () => (state.kind === 'done' ? meaningChoices(bundle, state.suggestions, env) : []),
    [state, bundle, env]
  )

  if (!host.isAdmin || unplaced.length === 0 || groups.length === 0) return null

  const ask = async () => {
    setState({ kind: 'asking' })
    try {
      const r = await fetchMeaning(client, Number(bundle.layout.id), { groups, fields: unplaced })
      setState({ kind: 'done', suggestions: r.suggestions })
    } catch (err) {
      const f = apiFailure(err, 'The AI could not suggest sections')
      setState({
        kind: 'error',
        error: f.status === 503 ? 'AI is not set up here.' : f.message
      })
    }
  }

  const n = unplaced.length
  return (
    <div className={cn(tintCard, 'mx-1 mt-3 space-y-2 px-2.5 py-2')} data-ai-meaning=''>
      <p className='flex items-center gap-1.5 text-[12px] font-semibold text-slate-700 dark:text-foreground'>
        <Sparkles className='h-3.5 w-3.5 text-nvr-cyan' />
        Sections by meaning
      </p>
      {state.kind !== 'done' && (
        <>
          <p className={quiet}>
            {n} field{n === 1 ? ' is' : 's are'} not on this form. The AI can suggest a section for
            each from what it means.
          </p>
          {state.kind === 'error' && (
            <p role='alert' className='text-[12px] text-red-700 dark:text-red-300'>
              {state.error}
            </p>
          )}
          <button
            type='button'
            className={cn(ghostBtn, 'px-2')}
            disabled={state.kind === 'asking'}
            onClick={() => void ask()}
            data-ai-meaning-ask=''
          >
            {state.kind === 'asking' ? 'Thinking…' : 'Suggest sections'}
          </button>
        </>
      )}
      {state.kind === 'done' &&
        (choices.length === 0 ? (
          <p className={quiet}>No suggestions left: no section fits the remaining fields.</p>
        ) : (
          <>
            <ul className='space-y-1' data-ai-meaning-list=''>
              {choices.map((c) => (
                <li key={c.field} className='flex items-start gap-1.5'>
                  <span className='min-w-0 flex-1'>
                    <span className='block truncate text-[12.5px] text-slate-800 dark:text-foreground'>
                      {c.label} <span className='text-slate-400'>→</span> {c.group_label}
                    </span>
                    {c.reason && <span className={cn(quiet, 'block')}>{c.reason}</span>}
                  </span>
                  <button
                    type='button'
                    aria-label={`Add ${c.label} to ${c.group_label}`}
                    data-tip={`Add to ${c.group_label}`}
                    className='inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-muted hover:text-slate-800 dark:hover:text-foreground'
                    onClick={() => apply([c.op], { label: `Add ${c.label} to ${c.group_label}` })}
                    data-ai-meaning-add={c.field}
                  >
                    <Plus className='h-3.5 w-3.5' />
                  </button>
                </li>
              ))}
            </ul>
            {choices.length > 1 && (
              <button
                type='button'
                className={cn(ghostBtn, 'px-2')}
                data-ai-meaning-all=''
                onClick={() => {
                  const plan = planMeaning(bundle, choices)
                  if (plan.ops.length)
                    apply(plan.ops, { label: `Place ${plan.ops.length} fields by meaning` })
                }}
              >
                Add all {choices.length}
              </button>
            )}
          </>
        ))}
    </div>
  )
}

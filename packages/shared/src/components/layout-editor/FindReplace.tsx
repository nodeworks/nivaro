import { Replace } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { LayoutBundle, LayoutOp } from '../../lib/layout-ops'
import { cn } from '../../lib/utils'
import { Checkbox } from '../ui/checkbox'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { useCollectionMeta } from './inspector/field-context'
import { effectText, inputBase } from './panel-style'
import { findHits, HIT_KIND_LABELS, type ReplaceHit, replacePlan } from './structure-ops'
import type { ApplyOptions } from './useLayoutDraft'

// Find and replace in labels (#2630): a button in the top bar opens a panel
// beside it. It searches this form's field labels, section names, text
// blocks and help text — plus the collection's own labels and help text where
// the form sets none (replacing one gives this form its own). Every hit is
// listed with a checkbox; Replace applies the ticked ones as one undo step.

const triggerCls =
  'inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md border border-slate-200 bg-white px-2.5 text-[12.5px] font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:pointer-events-none disabled:opacity-40 dark:border-border dark:bg-card dark:text-foreground dark:hover:bg-muted'

const checkCls =
  'mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 data-[state=checked]:border-nvr-cyan data-[state=checked]:bg-nvr-cyan data-[state=checked]:text-white dark:border-slate-600 [&_svg]:h-3 [&_svg]:w-3'

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** `text` cut into plain and matched runs. */
function runs(text: string, find: string, matchCase: boolean) {
  const out: Array<{ text: string; hit: boolean }> = []
  const re = new RegExp(escapeRe(find), matchCase ? 'g' : 'gi')
  let last = 0
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0
    if (at > last) out.push({ text: text.slice(last, at), hit: false })
    out.push({ text: m[0], hit: true })
    last = at + m[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last), hit: false })
  return out
}

function HitText({
  hit,
  find,
  replace,
  matchCase
}: {
  hit: ReplaceHit
  find: string
  replace: string
  matchCase: boolean
}) {
  const parts = runs(hit.before, find, matchCase)
  return (
    <span className='block min-w-0 text-[12.5px] leading-snug'>
      <span className='block truncate text-slate-500 dark:text-muted-foreground'>
        {parts.map((p, i) =>
          p.hit ? (
            <s
              // biome-ignore lint/suspicious/noArrayIndexKey: runs of one string never reorder
              key={i}
              className='rounded-sm bg-amber-100 text-amber-900 dark:bg-amber-500/20 dark:text-amber-200'
            >
              {p.text}
            </s>
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: runs of one string never reorder
            <span key={i}>{p.text}</span>
          )
        )}
      </span>
      <span className='block truncate text-slate-900 dark:text-foreground'>
        {parts.map((p, i) =>
          p.hit ? (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: runs of one string never reorder
              key={i}
              className='rounded-sm bg-nvr-cyan/15 font-medium'
            >
              {replace}
            </span>
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: runs of one string never reorder
            <span key={i}>{p.text}</span>
          )
        )}
      </span>
    </span>
  )
}

export function FindReplaceButton({
  bundle,
  apply,
  collection
}: {
  bundle: LayoutBundle
  apply: (ops: LayoutOp[], opts?: ApplyOptions) => void
  collection: string
}) {
  const [open, setOpen] = useState(false)
  const [find, setFind] = useState('')
  const [replace, setReplace] = useState('')
  const [matchCase, setMatchCase] = useState(false)
  // Unticked hits; anything new found is ticked.
  const [skip, setSkip] = useState<Set<string>>(new Set())
  const { data: meta } = useCollectionMeta(open ? collection : null)
  const globals = meta?.fields
  const hits = useMemo(
    () => (open ? findHits(bundle, find, replace, { matchCase, globals }) : []),
    [open, bundle, find, replace, matchCase, globals]
  )
  const chosen = useMemo(() => hits.filter((h) => !skip.has(h.id)), [hits, skip])
  const plan = useMemo(() => replacePlan(bundle, chosen), [bundle, chosen])
  const count = chosen.reduce((s, h) => s + h.count, 0)
  const toggle = (id: string) =>
    setSkip((cur) => {
      const next = new Set(cur)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const all = chosen.length === hits.length

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          data-find-replace-open=''
          className={triggerCls}
          data-tip='Find and replace in labels, section names and help text'
        >
          <Replace className='h-3.5 w-3.5 shrink-0' />
          Replace
        </button>
      </PopoverTrigger>
      <PopoverContent align='end' className='w-[440px] p-3' data-find-replace=''>
        <p className='text-[13px] font-semibold text-slate-900 dark:text-foreground'>
          Find and replace in labels
        </p>
        <p className={cn(effectText, 'mt-0.5')}>
          Field labels, section names, text blocks and help text on this form. Undo puts every one
          back.
        </p>
        <div className='mt-3 grid grid-cols-2 gap-2'>
          <input
            aria-label='Find'
            placeholder='Find'
            value={find}
            onChange={(e) => {
              setFind(e.target.value)
              setSkip(new Set())
            }}
            className={inputBase}
          />
          <input
            aria-label='Replace with'
            placeholder='Replace with'
            value={replace}
            onChange={(e) => setReplace(e.target.value)}
            className={inputBase}
          />
        </div>
        <div className='mt-2 flex items-center gap-3 text-[12.5px] text-slate-700 dark:text-foreground'>
          {/* biome-ignore lint/a11y/noLabelWithoutControl: the Radix checkbox is the control */}
          <label className='flex items-center gap-1.5'>
            <Checkbox
              checked={matchCase}
              onCheckedChange={(v) => setMatchCase(v === true)}
              className={checkCls.replace('mt-0.5 ', '')}
            />
            Match case
          </label>
          {hits.length > 0 && (
            <button
              type='button'
              onClick={() => setSkip(all ? new Set(hits.map((h) => h.id)) : new Set())}
              className='ml-auto text-[12px] font-medium text-sky-700 hover:underline dark:text-nvr-cyan'
            >
              {all ? 'Untick all' : 'Tick all'}
            </button>
          )}
        </div>
        <div
          data-find-replace-hits=''
          className='mt-2 max-h-[320px] overflow-y-auto border-t border-slate-100 pt-1 dark:border-border'
        >
          {!find ? (
            <p className={cn(effectText, 'py-2')}>Type the words to find.</p>
          ) : hits.length === 0 ? (
            <p className={cn(effectText, 'py-2')}>No matches on this form.</p>
          ) : (
            hits.map((h) => (
              // biome-ignore lint/a11y/noLabelWithoutControl: the Radix checkbox is the control
              <label
                key={h.id}
                data-find-hit={h.kind}
                className='flex cursor-pointer items-start gap-2 rounded px-1 py-1.5 hover:bg-muted'
              >
                <Checkbox
                  checked={!skip.has(h.id)}
                  onCheckedChange={() => toggle(h.id)}
                  className={checkCls}
                />
                <span className='min-w-0 flex-1'>
                  <span className='block truncate text-[11.5px] text-slate-500 dark:text-muted-foreground'>
                    {HIT_KIND_LABELS[h.kind]} · {h.where}
                  </span>
                  <HitText hit={h} find={find} replace={replace} matchCase={matchCase} />
                </span>
              </label>
            ))
          )}
        </div>
        <div className='mt-2 flex items-center justify-end gap-2 border-t border-slate-100 pt-2.5 dark:border-border'>
          <span className={cn(effectText, 'mr-auto')}>
            {hits.length > 0 && `${chosen.length} of ${hits.length} places`}
          </span>
          <button
            type='button'
            data-find-replace-apply=''
            disabled={!plan.ok}
            onClick={() => {
              if (!plan.ok) return
              apply(plan.ops, { label: plan.label })
              setOpen(false)
            }}
            className='inline-flex h-7 items-center rounded-md bg-nvr-cyan px-3 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-40'
          >
            {count > 0 ? `Replace ${count}` : 'Replace'}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

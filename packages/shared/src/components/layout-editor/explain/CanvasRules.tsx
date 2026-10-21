import { AlertTriangle, GitBranch } from 'lucide-react'
import { useCallback, useState } from 'react'
import { cn } from '../../../lib/utils'
import type { DesignMark, DesignTarget } from '../design-context'
import { amberStrip } from '../panel-style'
import { loopSentence, type OpenSource, type StateChip } from './field-sources'
import type { CanvasExplain } from './use-explain'

// The canvas explanations as one annotation layer (DesignNode marks): why each
// field is required / read-only / hidden (#2632), section and lock rules as
// sentences (#2640) and rule loops (#2642), under one "Rules" view switch.

const TONE: Record<StateChip['state'], DesignMark['tone']> = {
  required: 'amber',
  readonly: 'slate',
  hidden: 'slate',
  filled: 'violet'
}

const PREF_KEY = 'nvr:layout-editor:rules-view'

/** The Rules view switch, remembered per browser (default on). */
export function useRulesView(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(() => {
    try {
      return window.localStorage.getItem(PREF_KEY) !== 'off'
    } catch {
      return true
    }
  })
  const set = useCallback((v: boolean) => {
    setOn(v)
    try {
      window.localStorage.setItem(PREF_KEY, v ? 'on' : 'off')
    } catch {
      /* private window: the switch still works for this visit */
    }
  }, [])
  return [on, set]
}

export function RulesToggle({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button
      type='button'
      aria-pressed={on}
      aria-label='Rules'
      data-rules-view={on ? 'on' : 'off'}
      data-tip={
        on
          ? 'Hide the rule tags and default values on the canvas'
          : 'Show why fields are required, read-only or hidden, section rules and default values'
      }
      onClick={() => onChange(!on)}
      className={cn(
        'inline-flex h-8 items-center gap-1 rounded-md px-2 text-[12px] font-medium transition-colors',
        on
          ? 'bg-accent text-slate-900 dark:text-foreground'
          : 'text-slate-500 hover:bg-muted hover:text-slate-800 dark:text-muted-foreground dark:hover:text-foreground'
      )}
    >
      <GitBranch className='h-3.5 w-3.5' />
      <span data-tb-wide=''>Rules</span>
    </button>
  )
}

/**
 * The tags for each canvas node. `open` runs when a tag is clicked (the
 * node it sits on is already selected by then).
 */
export function explainMarks(
  explain: CanvasExplain,
  opts: {
    chips: boolean
    /** Field → ghost text for fields whose input shows no placeholder (yes/no, links). */
    ghostTags?: Map<string, string>
    open: (source: OpenSource, target: DesignTarget) => void
  }
): ((t: DesignTarget) => DesignMark[]) | undefined {
  const loopTip = new Map<string, string[]>()
  for (const loop of explain.loops) {
    const text = loopSentence(loop, explain.describe, explain.groupLabel)
    for (const f of loop.fields) loopTip.set(f, [...(loopTip.get(f) ?? []), text])
  }
  const anything =
    loopTip.size > 0 ||
    (opts.ghostTags?.size ?? 0) > 0 ||
    (opts.chips && (explain.fieldChips.size > 0 || explain.groupChips.size > 0))
  if (!anything) return undefined
  return (t) => {
    const out: DesignMark[] = []
    if (t.kind === 'group') {
      if (opts.chips)
        for (const c of explain.groupChips.get(t.key) ?? [])
          out.push({ text: c.text, tone: 'slate', tip: c.tip, onClick: () => opts.open(c.open, t) })
      return out
    }
    if (t.kind !== 'field' && t.kind !== 'header') return out
    const loops = loopTip.get(t.field)
    if (loops)
      out.push({
        text: 'Rule loop',
        tone: 'amber',
        tip: loops.join(' · '),
        highlight: true,
        kind: 'loop'
      })
    if (opts.chips)
      for (const c of explain.fieldChips.get(t.field) ?? [])
        out.push({
          text: c.text,
          tone: TONE[c.state],
          tip: c.tip,
          onClick: () => opts.open(c.open, t)
        })
    const ghost = opts.ghostTags?.get(t.field)
    if (ghost) out.push({ text: ghost, tone: 'slate', tip: 'What a new record starts with' })
    return out
  }
}

/** Rule loops in the editor (#2642): one line each, with a way to the field. */
export function RuleLoopsBanner({
  explain,
  onShow
}: {
  explain: CanvasExplain
  onShow: (field: string) => void
}) {
  const [open, setOpen] = useState(false)
  if (explain.loops.length === 0) return null
  const lines = explain.loops.map((l) => ({
    field: l.fields[0],
    text: loopSentence(l, explain.describe, explain.groupLabel)
  }))
  const shown = open ? lines : lines.slice(0, 1)
  return (
    <div
      role='note'
      data-rule-loops=''
      className={cn(
        'flex shrink-0 items-start gap-2 border-b px-4 py-1.5 text-[12.5px]',
        amberStrip
      )}
    >
      <AlertTriangle className='mt-0.5 h-3.5 w-3.5 shrink-0' />
      <ul className='m-0 min-w-0 flex-1 list-none space-y-0.5 p-0'>
        {shown.map((l) => (
          <li key={l.text} className='flex min-w-0 items-baseline gap-2'>
            <span className='min-w-0'>Rule loop: {l.text}.</span>
            <button
              type='button'
              onClick={() => onShow(l.field)}
              className='shrink-0 font-medium underline underline-offset-2 hover:no-underline'
            >
              Show
            </button>
          </li>
        ))}
      </ul>
      {lines.length > 1 && (
        <button
          type='button'
          onClick={() => setOpen(!open)}
          className='shrink-0 font-medium underline underline-offset-2 hover:no-underline'
        >
          {open ? 'Fewer' : `${lines.length - 1} more`}
        </button>
      )}
    </div>
  )
}

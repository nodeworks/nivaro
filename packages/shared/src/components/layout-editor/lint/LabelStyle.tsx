import { ChevronRight } from 'lucide-react'
import { type ReactNode, useEffect, useId, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  DEFAULT_JARGON,
  DEFAULT_MAX_LABEL_LENGTH,
  MAX_LABEL_LENGTH_RANGE,
  STYLE_RULES,
  type StyleRule
} from '../../../lib/layout-lint'
import { cn } from '../../../lib/utils'
import { effectText, groupTitle, inputBase, labelText } from '../panel-style'
import { Toggle } from '../settings/controls'
import { EMPTY_LINT_STYLE, type StoredLintStyle, useLintStyle, useSaveLintStyle } from './lint-api'

/**
 * Label house style (#3184) in the Problems panel: each style check on or
 * off, the longest label, extra abbreviations and words that keep their
 * capital. Per instance — every form here is checked the same way.
 */

export const STYLE_RULE_NAMES: Record<StyleRule, { label: string; effect: string }> = {
  'label-sentence-case': {
    label: 'Sentence case',
    effect: 'Only the first word of a label starts with a capital.'
  },
  'label-too-long': {
    label: 'Short labels',
    effect: 'Labels past the limit move detail into help.'
  },
  'label-jargon': {
    label: 'No abbreviations',
    effect: 'Qty, Amt, Dept and the like are spelled out.'
  },
  'help-repeats-label': {
    label: 'Help says something new',
    effect: 'Help text that only repeats the label is flagged.'
  },
  'label-duplicate': {
    label: 'One label per field',
    effect: 'Two fields on one form never share a label.'
  }
}

export function isStyleRule(rule: string): rule is StyleRule {
  return (STYLE_RULES as readonly string[]).includes(rule)
}

/** "Qty = quantity" lines ↔ jargon entries. */
export function parseJargonLines(text: string): Array<{ term: string; say: string }> {
  const out: Array<{ term: string; say: string }> = []
  const seen = new Set<string>()
  for (const line of text.split('\n')) {
    const m = /^\s*(.+?)\s*(?:=|→|->)\s*(.+?)\s*$/.exec(line)
    if (!m || seen.has(m[1].toLowerCase())) continue
    seen.add(m[1].toLowerCase())
    out.push({ term: m[1], say: m[2] })
  }
  return out
}

export function jargonLines(list: Array<{ term: string; say: string }>): string {
  return list.map((t) => `${t.term} = ${t.say}`).join('\n')
}

/** Turning one check off from a finding; the panel's settings block. */
export function useLabelStyleControls(enabled = true): {
  onTurnOff: (rule: string) => void
  settings: ReactNode
} {
  const { data } = useLintStyle(enabled)
  const { mutate } = useSaveLintStyle()
  return useMemo(
    () => ({
      onTurnOff: (rule: string) => {
        if (!isStyleRule(rule)) return
        const off = [...new Set([...(data?.off ?? []), rule])]
        mutate(
          { off },
          {
            onSuccess: () =>
              toast.success(`${STYLE_RULE_NAMES[rule].label} is off for every form here`),
            onError: () => toast.error('That check could not be turned off')
          }
        )
      },
      settings: <LabelStyleSettings />
    }),
    [data?.off, mutate]
  )
}

export function LabelStyleSettings() {
  const [open, setOpen] = useState(false)
  const bodyId = useId()
  const { data = EMPTY_LINT_STYLE, isLoading } = useLintStyle(open)
  const save = useSaveLintStyle()
  const commit = (next: Partial<StoredLintStyle>) =>
    save.mutate(next, { onError: () => toast.error('The label style was not saved') })

  return (
    <section aria-label='Label style' data-label-style='' className='space-y-2'>
      <button
        type='button'
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen(!open)}
        className='flex w-full items-center gap-1 rounded-md text-left transition-colors hover:text-slate-900 dark:hover:text-foreground'
      >
        <ChevronRight
          className={cn(
            'h-3.5 w-3.5 text-slate-400 transition-transform motion-reduce:transition-none',
            open && 'rotate-90'
          )}
        />
        <span className={groupTitle}>Label style</span>
      </button>
      {open && (
        <div id={bodyId} className='space-y-3'>
          <p className={effectText}>
            Checks every form on this instance against house style. Turning a check off here turns
            it off for everyone.
          </p>
          {isLoading ? (
            <p className={effectText}>Loading…</p>
          ) : (
            <StyleBody data={data} commit={commit} busy={save.isPending} />
          )}
        </div>
      )}
    </section>
  )
}

function StyleBody({
  data,
  commit,
  busy
}: {
  data: StoredLintStyle
  commit: (next: Partial<StoredLintStyle>) => void
  busy: boolean
}) {
  const ids = { max: useId(), allow: useId(), jargon: useId() }
  const off = new Set(data.off)
  const [max, setMax] = useState(String(data.max_label_length ?? ''))
  const [allow, setAllow] = useState(data.allow_words.join(', '))
  const [jargon, setJargon] = useState(jargonLines(data.jargon))
  useEffect(() => setMax(String(data.max_label_length ?? '')), [data.max_label_length])
  useEffect(() => setAllow(data.allow_words.join(', ')), [data.allow_words])
  useEffect(() => setJargon(jargonLines(data.jargon)), [data.jargon])

  const maxNum = max.trim() === '' ? null : Number(max)
  const maxBad =
    maxNum != null &&
    (!Number.isInteger(maxNum) ||
      maxNum < MAX_LABEL_LENGTH_RANGE[0] ||
      maxNum > MAX_LABEL_LENGTH_RANGE[1])
  const commitMax = () => {
    if (maxBad || maxNum === data.max_label_length) return
    commit({ max_label_length: maxNum })
  }
  const commitAllow = () => {
    const words = [
      ...new Set(
        allow
          .split(',')
          .map((w) => w.trim())
          .filter(Boolean)
      )
    ]
    if (words.join('\u0000') !== data.allow_words.join('\u0000')) commit({ allow_words: words })
  }
  const commitJargon = () => {
    const list = parseJargonLines(jargon)
    if (jargonLines(list) !== jargonLines(data.jargon)) commit({ jargon: list })
  }

  return (
    <div className='space-y-3'>
      <ul className='space-y-2.5'>
        {STYLE_RULES.map((rule) => (
          <li key={rule} data-style-rule={rule} className='flex items-start justify-between gap-3'>
            <span className='min-w-0'>
              <span className={cn(labelText, 'block')}>{STYLE_RULE_NAMES[rule].label}</span>
              <span className={cn(effectText, 'block')}>{STYLE_RULE_NAMES[rule].effect}</span>
            </span>
            <Toggle
              label={STYLE_RULE_NAMES[rule].label}
              checked={!off.has(rule)}
              disabled={busy}
              onChange={(on) =>
                commit({
                  off: on ? data.off.filter((r) => r !== rule) : [...new Set([...data.off, rule])]
                })
              }
            />
          </li>
        ))}
      </ul>
      <div className='space-y-1'>
        <label htmlFor={ids.max} className={labelText}>
          Longest label
        </label>
        <input
          id={ids.max}
          inputMode='numeric'
          value={max}
          placeholder={String(DEFAULT_MAX_LABEL_LENGTH)}
          aria-invalid={maxBad || undefined}
          onChange={(e) => setMax(e.target.value)}
          onBlur={commitMax}
          onKeyDown={(e) => e.key === 'Enter' && commitMax()}
          className={cn(inputBase, 'w-24', maxBad && 'border-red-400 dark:border-red-500')}
        />
        <p className={effectText}>
          {maxBad
            ? `A whole number from ${MAX_LABEL_LENGTH_RANGE[0]} to ${MAX_LABEL_LENGTH_RANGE[1]}.`
            : `Characters. Empty = ${DEFAULT_MAX_LABEL_LENGTH}.`}
        </p>
      </div>
      <div className='space-y-1'>
        <label htmlFor={ids.allow} className={labelText}>
          Words that keep their capital
        </label>
        <input
          id={ids.allow}
          value={allow}
          placeholder='Fusion, Oracle'
          onChange={(e) => setAllow(e.target.value)}
          onBlur={commitAllow}
          onKeyDown={(e) => e.key === 'Enter' && commitAllow()}
          className={inputBase}
        />
        <p className={effectText}>Names, comma between. They are never called jargon either.</p>
      </div>
      <div className='space-y-1'>
        <label htmlFor={ids.jargon} className={labelText}>
          More abbreviations
        </label>
        <textarea
          id={ids.jargon}
          value={jargon}
          rows={3}
          placeholder='PM = project manager'
          onChange={(e) => setJargon(e.target.value)}
          onBlur={commitJargon}
          className={cn(inputBase, 'h-auto py-1.5 font-mono text-[12px]')}
        />
        <p className={effectText}>
          One per line, the word and what to say instead. Checked already:{' '}
          {DEFAULT_JARGON.slice(0, 8)
            .map((t) => t.term)
            .join(', ')}
          …
        </p>
      </div>
    </div>
  )
}

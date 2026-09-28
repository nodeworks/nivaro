import { useMemo } from 'react'
import { type HighlightKind, highlightGraphql, highlightJson } from '../../lib/highlight'

/** Colour classes per token kind — every pair ≥4.5:1 on the light slate-50
 *  and dark #0f172a code blocks. */
export const HL_CLASS: Record<HighlightKind, string> = {
  keyword: 'font-semibold text-violet-700 dark:text-violet-300',
  name: 'font-semibold text-slate-900 dark:text-slate-100',
  field: 'text-sky-800 dark:text-sky-300',
  arg: 'text-slate-600 dark:text-slate-400',
  string: 'text-emerald-800 dark:text-emerald-300',
  number: 'text-amber-800 dark:text-amber-300',
  bool: 'text-rose-700 dark:text-rose-300',
  punct: 'text-slate-400 dark:text-slate-500',
  comment: 'italic text-slate-400 dark:text-slate-500',
  text: ''
}

export function HighlightedCode({ kind, text }: { kind: string; text: string }) {
  const tokens = useMemo(
    () =>
      kind === 'query' ? highlightGraphql(text) : kind === 'text' ? null : highlightJson(text),
    [kind, text]
  )
  if (!tokens) return <>{text}</>
  return (
    <>
      {tokens.map((t, i) =>
        t.kind === 'text' ? (
          t.text
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: static token stream
          <span key={i} className={HL_CLASS[t.kind]}>
            {t.text}
          </span>
        )
      )}
    </>
  )
}

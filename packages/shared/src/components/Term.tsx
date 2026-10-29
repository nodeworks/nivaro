import type { ReactNode } from 'react'
import { findGlossaryTerm, uiHint } from '../lib/core-glossary'
import { useGlossary } from '../lib/glossary'

const MARK = 'cursor-help underline decoration-dotted decoration-1 underline-offset-[3px]'

/**
 * One app word with its meaning on hover (#2): `<Term id="pipeline">pipeline</Term>`.
 * Dotted underline + an instant TipLayer `data-tip` (never `title`). The
 * meaning is the instance glossary's entry when one names the term, else the
 * built-in Nivaro one; an unknown id renders the children plain. Use it on a
 * few high-value labels (tab names, headings), not in running text — labels
 * and answers already mark instance terms through GlossaryLabel.
 */
export function Term({
  id,
  children,
  className
}: {
  id: string
  children?: ReactNode
  className?: string
}) {
  const terms = useGlossary({ withCore: true })
  const term = findGlossaryTerm(terms, id)
  const body = children ?? term?.term ?? id
  if (!term) return <>{body}</>
  return (
    <span
      data-term={term.overrides ?? term.slug}
      data-tip={`${term.term}: ${uiHint(term)}`}
      className={className ? `${MARK} ${className}` : MARK}
    >
      {body}
    </span>
  )
}

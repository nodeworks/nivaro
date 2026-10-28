import { Fragment, useMemo } from 'react'
import { highlightParts, type SynonymGroups } from '../lib/search-text'
import { cn } from '../lib/utils'

/**
 * Text with the typed search marked (lib/search-text.ts `highlightParts`):
 * every token and synonym, case- and accent-insensitive. The mark keeps the
 * text's own colour and only tints behind it (the admin palette's treatment),
 * so it reads in light and dark alike. No query = the plain text.
 */
export function SearchHighlight({
  text,
  query,
  synonyms,
  className,
  markClassName
}: {
  text: string | null | undefined
  query: string | null | undefined
  synonyms?: SynonymGroups
  className?: string
  markClassName?: string
}) {
  const parts = useMemo(() => highlightParts(text, query, { synonyms }), [text, query, synonyms])
  if (!parts.some((p) => p.match)) return <span className={className}>{text ?? ''}</span>
  return (
    <span className={className}>
      {parts.map((p, i) =>
        p.match ? (
          <mark
            // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional and never reorder
            key={i}
            data-search-hit
            className={cn('rounded-sm bg-nvr-cyan/20 px-0 text-inherit', markClassName)}
          >
            {p.text}
          </mark>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional and never reorder
          <Fragment key={i}>{p.text}</Fragment>
        )
      )}
    </span>
  )
}

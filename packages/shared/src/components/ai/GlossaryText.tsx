import type { ReactNode } from 'react'
import { useNavigation } from '../../context'
import { type GlossaryTerm, glossarySegments, glossaryTip, useGlossary } from '../../lib/glossary'

/** Where a term's entry lives: the admin glossary, through the host's consoleUrl. */
export function useGlossaryHref(): (t: GlossaryTerm) => string | null {
  const nav = useNavigation()
  return (t) => {
    const path = `/ai-knowledge?tab=glossary&term=${encodeURIComponent(t.slug)}`
    return nav.consoleUrl ? nav.consoleUrl(path) : path
  }
}

const MARK = 'cursor-help underline decoration-dotted decoration-1 underline-offset-[3px]'

/**
 * A glossary term in running text (#1997): dotted underline, the definition
 * on hover (TipLayer `data-tip`), and — when `href` is given — a link to the
 * term's entry. Ctrl/⌘ click keeps the browser's new-tab behaviour.
 */
export function GlossaryMark({
  term,
  children,
  href
}: {
  term: GlossaryTerm
  children: ReactNode
  href?: string | null
}) {
  const nav = useNavigation()
  if (!href)
    return (
      <span data-glossary-term={term.slug} data-tip={glossaryTip(term)} className={MARK}>
        {children}
      </span>
    )
  return (
    <a
      href={href}
      data-glossary-term={term.slug}
      data-tip={glossaryTip(term)}
      className={MARK}
      onClick={(e) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
        if (!href.startsWith('/')) return
        e.preventDefault()
        nav.navigate(href)
      }}
    >
      {children}
    </a>
  )
}

/**
 * A label with its glossary terms marked (#1899) — field labels on forms.
 * Terms scoped to another collection are not marked. No link: a label is
 * often inside a <label>, and the hover definition is the point.
 */
export function GlossaryLabel({ text, collection }: { text: string; collection?: string | null }) {
  const terms = useGlossary()
  if (!terms.length) return text
  const segs = glossarySegments(text, terms, { collection: collection ?? null })
  if (segs.length === 1 && !segs[0].term) return text
  return (
    <>
      {segs.map((s, i) =>
        s.term ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments of one static label
          <GlossaryMark key={i} term={s.term}>
            {s.text}
          </GlossaryMark>
        ) : (
          s.text
        )
      )}
    </>
  )
}

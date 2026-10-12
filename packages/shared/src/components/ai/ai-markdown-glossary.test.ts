import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import type { GlossaryTerm } from '../../lib/glossary'
import { renderInline } from './AiMarkdown'
import { GlossaryMark } from './GlossaryText'

const held: GlossaryTerm = {
  id: 1,
  term: 'Held',
  slug: 'held',
  aliases: [],
  definition: 'An invoice with is_on_hold set.',
  query_slug: null,
  query_note: null,
  collection: null,
  updated_at: null
}

const marks = (nodes: ReactNode[]): ReactElement<Record<string, unknown>>[] =>
  nodes
    .flat(3)
    .filter(isValidElement)
    .filter((n) => n.type === GlossaryMark) as ReactElement<Record<string, unknown>>[]

describe('glossary terms in Ask AI answers (#1997)', () => {
  it('marks the first occurrence with a link to the term', () => {
    const out = renderInline('3 invoices are held; held ones wait.', false, {
      terms: [held],
      once: new Set(),
      href: (t) => `/ai-knowledge?tab=glossary&term=${t.slug}`
    })
    const m = marks(out)
    expect(m).toHaveLength(1)
    expect(m[0].props.href).toBe('/ai-knowledge?tab=glossary&term=held')
  })

  it('never marks inside a link label', () => {
    const out = renderInline('[Held invoices](/collections/invoices)', false, {
      terms: [held],
      once: new Set()
    })
    expect(marks(out)).toHaveLength(0)
  })
})

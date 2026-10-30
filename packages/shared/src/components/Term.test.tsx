// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../context'
import { CORE_GLOSSARY, findGlossaryTerm, mergeGlossary, uiHint } from '../lib/core-glossary'
import type { GlossaryTerm } from '../lib/glossary'
import { Term } from './Term'

// #2 One glossary, everywhere: <Term> shows the built-in Nivaro meaning with
// no API, no glossary route and no AI configured; an instance glossary entry
// for the same word replaces it.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const entry = (over: Partial<GlossaryTerm>): GlossaryTerm => ({
  id: 7,
  term: 'Pipeline',
  slug: 'pipeline',
  aliases: [],
  definition: 'Our approval route for purchase orders. It has five steps and two owners.',
  query_slug: null,
  query_note: null,
  collection: null,
  updated_at: null,
  ...over
})

let root: Root | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
})

async function render(node: React.ReactNode): Promise<HTMLElement> {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root?.render(node))
  for (let i = 0; i < 5; i++) await act(async () => new Promise((r) => setTimeout(r, 0)))
  return host
}

describe('core glossary (pure)', () => {
  it('ships ~30 built-in terms, each with a one-line hint', () => {
    expect(CORE_GLOSSARY.length).toBeGreaterThanOrEqual(28)
    for (const t of CORE_GLOSSARY) {
      expect(t.id).toBeLessThan(0)
      expect(uiHint(t)).not.toMatch(/\n/)
      expect(uiHint(t).length).toBeLessThanOrEqual(160)
    }
    for (const id of ['pipeline', 'owner-group', 'layout', 'queue', 'scope', 'rollup', 'addendum'])
      expect(findGlossaryTerm(CORE_GLOSSARY, id)).not.toBeNull()
    expect(findGlossaryTerm(CORE_GLOSSARY, 'hidden from pickers')?.slug).toBe('hidden-from-pickers')
  })

  it('an instance entry replaces the built-in one by slug, term or alias', () => {
    const byAlias = entry({ id: 9, term: 'Route', slug: 'route', aliases: ['pipeline'] })
    const merged = mergeGlossary(CORE_GLOSSARY, [
      byAlias,
      entry({ id: 10, term: 'Held', slug: 'held' })
    ])
    const p = findGlossaryTerm(merged, 'pipeline')!
    expect(p.id).toBe(9)
    expect(p.overrides).toBe('pipeline')
    expect(merged.filter((t) => t.slug === 'pipeline')).toHaveLength(0)
    expect(findGlossaryTerm(merged, 'held')?.id).toBe(10)
    expect(merged).toHaveLength(CORE_GLOSSARY.length + 1)
  })

  it("an instance definition's hint is its first sentence", () => {
    expect(uiHint(entry({}))).toBe('Our approval route for purchase orders.')
    expect(uiHint({ definition: 'x', ui_hint: 'given' })).toBe('given')
  })
})

describe('<Term>', () => {
  it('falls back to the built-in meaning with no provider at all', async () => {
    const host = await render(<Term id='pipeline'>pipeline</Term>)
    const span = host.querySelector('[data-term="pipeline"]')!
    expect(span.textContent).toBe('pipeline')
    expect(span.getAttribute('data-tip')).toMatch(/^Pipeline: The steps a record moves through/)
    expect(span.getAttribute('title')).toBeNull()
  })

  it('falls back when the glossary read fails (no AI / no route)', async () => {
    const client = { request: vi.fn(async () => Promise.reject(new Error('404'))) }
    const host = await render(
      <NivaroProvider client={client as never}>
        <Term id='queue'>Queues</Term>
      </NivaroProvider>
    )
    expect(host.querySelector('[data-term="queue"]')?.getAttribute('data-tip')).toMatch(
      /^Queue: A worklist/
    )
  })

  it("uses the instance's wording when it defines the term", async () => {
    const client = { request: vi.fn(async () => ({ data: [entry({})] })) }
    const host = await render(
      <NivaroProvider client={client as never}>
        <Term id='pipeline'>pipeline</Term>
      </NivaroProvider>
    )
    expect(host.querySelector('[data-term="pipeline"]')?.getAttribute('data-tip')).toBe(
      'Pipeline: Our approval route for purchase orders.'
    )
  })

  it('an unknown id renders plain text', async () => {
    const host = await render(<Term id='no-such-term'>thing</Term>)
    expect(host.innerHTML).toBe('thing')
  })
})

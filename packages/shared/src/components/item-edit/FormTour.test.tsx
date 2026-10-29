// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../context'
import {
  buildTourSteps,
  FormTour,
  sectionKeysOnScreen,
  type TourStep,
  useFormTourSeen
} from './FormTour'
import { FORM_DENSITY_CSS, formDensityOf } from './form-density'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
Element.prototype.scrollIntoView ??= () => {}
window.matchMedia ??= ((q: string) => ({
  matches: false,
  media: q,
  addEventListener() {},
  removeEventListener() {}
})) as never

const GROUPS = [
  { key: 'who', label: 'Who', type: 'section', content: 'Tell us who is asking.' },
  { key: 'what', label: 'What', type: 'section', content: null },
  { key: 'tabs', label: 'Tabs', type: 'container' },
  { key: 'empty', label: 'Later', type: 'section' },
  { key: 'rule', label: 'Rule', type: 'section', content: 'x', content_tone: 'divider' }
]
const FIELDS = {
  what: [
    { field: 'a', label: 'Amount', required: true },
    { field: 'b', label: 'Budget' },
    { field: 'c', label: 'Cost centre', required: 1 },
    { field: 'd', label: 'Date' },
    { field: 'e', label: 'Extra' },
    { field: 'h', label: 'Hidden', hidden: true }
  ],
  rule: [{ field: 'z', label: 'Zone' }]
}

describe('buildTourSteps', () => {
  it('uses help text, else the fields a section holds', () => {
    const steps = buildTourSteps(GROUPS, FIELDS)
    expect(steps.has('tabs')).toBe(false)
    expect(steps.get('who')).toMatchObject({ title: 'Who', body: 'Tell us who is asking.' })
    expect(steps.get('what')?.body).toBe('5 fields: Amount, Budget, Cost centre, Date and 1 more.')
    expect(steps.get('what')?.required).toBe(2)
    expect(steps.get('empty')?.body).toBe('Nothing to fill in here yet.')
    // A divider's text is not help text.
    expect(steps.get('rule')?.body).toBe('One field: Zone.')
  })

  it('cuts long help text', () => {
    const long = buildTourSteps(
      [{ key: 'k', label: 'K', type: 'section', content: 'x'.repeat(400) }],
      {}
    )
    expect(long.get('k')?.body.length).toBe(280)
    expect(long.get('k')?.body.endsWith('…')).toBe(true)
  })
})

describe('sectionKeysOnScreen', () => {
  it('lists edit and summary sections in page order, skipping hidden ones', () => {
    const root = document.createElement('div')
    root.innerHTML = `
      <div data-section-key="a"></div>
      <div hidden><div data-section-key="b"></div></div>
      <section data-read-section="c"></section>
      <div class="hidden" data-section-key="d"></div>
      <div data-section-key="a"></div>`
    expect(sectionKeysOnScreen(root)).toEqual(['a', 'c'])
    expect(sectionKeysOnScreen(null)).toEqual([])
  })
})

describe('form density (#3182)', () => {
  it('reads compact only; anything else is comfortable', () => {
    expect(formDensityOf({ density: 'compact' })).toBe('compact')
    expect(formDensityOf({ density: 'tight' })).toBe('comfortable')
    expect(formDensityOf(null)).toBe('comfortable')
  })
  it('keys every rule on the form root attribute (host CSS loads after full.css)', () => {
    const rules = FORM_DENSITY_CSS.split('\n').filter((l) => l.includes('{') && !l.startsWith('@'))
    expect(rules.length).toBeGreaterThan(5)
    for (const r of rules) expect(r.startsWith('[data-form-density=compact] ')).toBe(true)
    // Touch screens keep their control heights.
    expect(FORM_DENSITY_CSS).toMatch(/@media \(hover: hover\) and \(pointer: fine\)\{[^}]*\.h-9/)
  })
})

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  localStorage.clear()
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
})

function Harness({
  steps,
  onClose
}: {
  steps: Map<string, TourStep>
  onClose: (f: boolean) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  return (
    <div ref={ref}>
      <div data-section-key='who'>Who</div>
      <div data-section-key='what'>What</div>
      <div data-section-key='unknown'>Not a step</div>
      <FormTour rootRef={ref} steps={steps} formName='Order form' onClose={onClose} />
    </div>
  )
}

const card = () => document.querySelector('[data-form-tour]')
const press = async (sel: string) => {
  const el = document.querySelector(sel) as HTMLElement | null
  if (!el) throw new Error(`no ${sel}`)
  await act(async () => el.click())
}

describe('FormTour', () => {
  const steps = buildTourSteps(GROUPS, FIELDS)

  it('walks the sections on screen and finishes with Done', async () => {
    const onClose = vi.fn()
    await act(async () => root.render(<Harness steps={steps} onClose={onClose} />))
    expect(card()?.getAttribute('data-form-tour-step')).toBe('who')
    expect(card()?.textContent).toContain('Order form · 1 of 2')
    expect(card()?.textContent).toContain('Tell us who is asking.')
    // The card is portaled to body, outside the form.
    expect(host.contains(card())).toBe(false)
    await press('[data-form-tour-next]')
    expect(card()?.getAttribute('data-form-tour-step')).toBe('what')
    expect(card()?.textContent).toContain('2 fields here are required')
    expect(document.querySelector('[data-form-tour-next]')?.textContent).toBe('Done')
    await press('[data-form-tour-back]')
    expect(card()?.getAttribute('data-form-tour-step')).toBe('who')
    await press('[data-form-tour-next]')
    await press('[data-form-tour-next]')
    expect(onClose).toHaveBeenCalledWith(true)
  })

  it('Skip tour and Escape close it unfinished', async () => {
    const onClose = vi.fn()
    await act(async () => root.render(<Harness steps={steps} onClose={onClose} />))
    await press('[data-form-tour-skip]')
    expect(onClose).toHaveBeenLastCalledWith(false)
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('arrow keys move only while the tour has focus', async () => {
    const onClose = vi.fn()
    await act(async () =>
      root.render(
        <>
          <input data-outside='' />
          <Harness steps={steps} onClose={onClose} />
        </>
      )
    )
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }))
    })
    expect(card()?.getAttribute('data-form-tour-step')).toBe('what')
    ;(document.querySelector('[data-outside]') as HTMLInputElement).focus()
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }))
    })
    expect(card()?.getAttribute('data-form-tour-step')).toBe('what')
  })
})

describe('useFormTourSeen', () => {
  function Probe({
    id,
    onReady
  }: {
    id: number
    onReady: (s: ReturnType<typeof useFormTourSeen>) => void
  }) {
    const s = useFormTourSeen({ layoutId: id, userId: 'u1', enabled: true })
    onReady(s)
    return <span data-seen={s.seen ? 'yes' : 'no'} data-known={s.known ? 'yes' : 'no'} />
  }

  it('reads the done list from /auth/me and stores a finished tour', async () => {
    const calls: Array<{ _method?: string; _path?: string; _body?: unknown }> = []
    const client = {
      request: vi.fn(async (cmd: { _method?: string; _path?: string; _body?: unknown }) => {
        calls.push(cmd)
        if (cmd._path === '/auth/me') return { data: { preferences: { form_tours_done: [3] } } }
        return { data: {} }
      })
    }
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    let latest: ReturnType<typeof useFormTourSeen> | null = null
    const render = (id: number) =>
      act(async () =>
        root.render(
          <QueryClientProvider client={qc}>
            <NivaroProvider client={client as never}>
              <Probe id={id} onReady={(s) => (latest = s)} />
            </NivaroProvider>
          </QueryClientProvider>
        )
      )
    await render(3)
    for (let i = 0; i < 5; i++) await act(async () => new Promise((r) => setTimeout(r, 5)))
    expect(host.querySelector('[data-seen]')?.getAttribute('data-seen')).toBe('yes')
    await render(8)
    for (let i = 0; i < 5; i++) await act(async () => new Promise((r) => setTimeout(r, 5)))
    expect(host.querySelector('[data-seen]')?.getAttribute('data-seen')).toBe('no')
    expect(host.querySelector('[data-known]')?.getAttribute('data-known')).toBe('yes')
    await act(async () => (latest as unknown as { markSeen: () => void }).markSeen())
    expect(host.querySelector('[data-seen]')?.getAttribute('data-seen')).toBe('yes')
    expect(calls.find((c) => c._method === 'PATCH')).toMatchObject({
      _path: '/users/me/preferences',
      _body: { form_tour_done: 8 }
    })
    expect(localStorage.getItem('nvr:form-tour:u1:8')).toBe('1')
  })
})

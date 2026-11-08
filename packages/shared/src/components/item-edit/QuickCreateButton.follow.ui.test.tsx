// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider, ParentDraftContext, useParentDraft } from '../../context'
import {
  endQuickCreateFollows,
  FOLLOW_DEBOUNCE_MS,
  fieldLimit,
  pendingOptionalSeeds,
  QuickCreateButton,
  type QuickCreateConfig,
  resetQuickCreateFollows,
  runQuickCreateFollow,
  seedFollowPatch,
  seedKey,
  startQuickCreateFollow,
  useQuickCreateFollow
} from './QuickCreateButton'

// army9 b02 HIGH: New Unit sits on step 1, before the fields it seeds from.
// A unit made there got only Zone/Region, failed the picker's narrowing at
// Create ("Not an available option") and stayed behind as an orphan. It now
// follows the form: each seed filled in later is written to it.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const CONFIG: QuickCreateConfig = {
  label: 'New Unit',
  title: 'Create a new unit',
  fields: [
    { field: 'name', label: 'Unit Name', required: true },
    { field: 'project_type', from: '$parent.project_type' },
    { field: 'region', from: '$parent.region', required: true, label: 'Region' },
    { field: 'division', from: '$parent.division', required: true, label: 'Zone' },
    { field: 'project', from: '$parent.project' },
    { field: 'status', from: 'started' },
    { field: 'funding_years', from: '$parent.funding_year' }
  ]
}

describe('quick-create helpers', () => {
  const draft: Record<string, unknown> = { region: 2, division: 1, project_type: null }
  const resolve = (from: unknown) =>
    typeof from === 'string' && from.startsWith('$parent.') ? (draft[from.slice(8)] ?? null) : from

  it('names the optional seeds still empty on the form', () => {
    expect(pendingOptionalSeeds(CONFIG.fields, resolve, { project_type: 'Project Type' })).toEqual([
      'Project Type',
      'Project',
      'Funding Year'
    ])
  })

  it('patches only seeds that changed since they were written, never blanks', () => {
    const written = { region: '2', division: '1' }
    expect(seedFollowPatch(CONFIG.fields, resolve, written, new Set(['funding_years']))).toBeNull()
    draft.project_type = 3
    draft.funding_year = 7
    const out = seedFollowPatch(CONFIG.fields, resolve, written, new Set(['funding_years']))
    expect(out?.patch).toEqual({ project_type: 3, funding_years: [7] })
    expect(
      seedFollowPatch(
        CONFIG.fields,
        resolve,
        { ...written, ...out?.written },
        new Set(['funding_years'])
      )
    ).toBeNull()
  })

  // army9 review L4: 8161 → "8161" on the form re-PATCHed the unit.
  it('a seed that only changed type is not written again', () => {
    expect(seedKey(8161)).toBe(seedKey('8161'))
    expect(seedKey([7])).toBe(seedKey(['7']))
    const r = (from: unknown) => (from === '$parent.project' ? '8161' : null)
    expect(
      seedFollowPatch(
        [{ field: 'project', from: '$parent.project' }],
        r,
        { project: seedKey(8161) },
        new Set()
      )
    ).toBeNull()
  })

  it('reads a soft max rule with its own message', () => {
    expect(
      fieldLimit({
        field: 'name',
        max_length: 255,
        validation_rules: [{ type: 'max', value: 30, soft: true, message: 'MDSi takes 30' }]
      })
    ).toEqual({ max: 30, soft: true, message: 'MDSi takes 30' })
    expect(fieldLimit({ field: 'x', max_length: 40 })).toEqual({ max: 40, soft: false })
  })
})

let root: Root | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
  resetQuickCreateFollows()
})
const tick = async () => {
  for (let i = 0; i < 10; i++) await act(async () => new Promise((r) => setTimeout(r, 0)))
}

describe('QuickCreateButton', () => {
  it('a unit made before Basic Information picks up the fields filled in later', async () => {
    const calls: Array<{ method?: string; path: string; body?: unknown }> = []
    const client = {
      url: 'http://test',
      getToken: () => null,
      request: vi.fn(async (cmd: { _method?: string; _path: string; _body?: unknown }) => {
        calls.push({ method: cmd._method, path: cmd._path, body: cmd._body })
        if (cmd._path === '/collections/units')
          return {
            data: {
              relations: [
                { one_collection: 'units', one_field: 'funding_years', junction_field: 'fy' }
              ]
            }
          }
        if (cmd._path === '/field-config/units')
          return {
            data: [
              {
                field: 'name',
                max_length: 255,
                validation_rules: [
                  {
                    type: 'max',
                    value: 30,
                    soft: true,
                    message: 'MDSi takes at most 30 characters.'
                  }
                ]
              }
            ]
          }
        if (cmd._path === '/items/units' && cmd._method === 'POST') return { data: { id: 273026 } }
        return { data: {} }
      })
    }
    let setDraft: (d: Record<string, unknown>) => void = () => {}
    let picked: unknown = null
    function Host() {
      const [draft, sd] = useState<Record<string, unknown>>({ region: 2, division: 1 })
      const [v, setV] = useState<unknown>(null)
      setDraft = sd
      picked = v
      return (
        <ParentDraftContext.Provider value={{ draft, collection: 'inventory_request' }}>
          <QuickCreateButton targetCollection='units' config={CONFIG} value={v} onCreated={setV} />
        </ParentDraftContext.Provider>
      )
    }
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () =>
      root?.render(
        <QueryClientProvider client={qc}>
          <NivaroProvider client={client as never}>
            <Host />
          </NivaroProvider>
        </QueryClientProvider>
      )
    )
    await act(async () => document.querySelector<HTMLButtonElement>('button')?.click())
    await tick()
    const panel = document.querySelector('[data-quick-create-panel]') as HTMLElement
    // Portaled out of the field (a short step card used to clip it).
    expect(panel.parentElement).toBe(document.body)
    expect(panel.textContent).toContain('picks them up from the form')
    const input = panel.querySelector('input') as HTMLInputElement
    expect(document.activeElement).toBe(input)
    const long = 'ARMY9 Peter Moniz Unit Z1 long name test'
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, long)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(panel.querySelector('[data-quick-create-count]')?.textContent).toBe(`${long.length}/30`)
    expect(panel.querySelector('[data-quick-create-limit]')?.textContent).toContain('MDSi takes')
    await act(async () =>
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    )
    await tick()
    expect(picked).toBe(273026)
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(0)

    await act(async () => setDraft({ region: 2, division: 1, project_type: 3, project: 8161 }))
    await act(async () => new Promise((r) => setTimeout(r, 600)))
    await tick()
    const patches = calls.filter((c) => c.method === 'PATCH')
    expect(patches).toHaveLength(1)
    expect(patches[0].path).toBe('/items/units/273026')
    expect(patches[0].body).toEqual({ project_type: 3, project: 8161 })
  })

  // army 11 f2 HIGH: the stepper unmounts step 1 (Unit Selection) when the
  // person moves on, so the follow that lived in the button never saw the
  // seeds filled in on step 2 and Create still failed. The follow now outlives
  // the button: any field on the visible step drives it.
  it('keeps following after the step holding the button is unmounted', async () => {
    const calls: Array<{ method?: string; path: string; body?: unknown }> = []
    const client = {
      url: 'http://test',
      getToken: () => null,
      request: vi.fn(async (cmd: { _method?: string; _path: string; _body?: unknown }) => {
        calls.push({ method: cmd._method, path: cmd._path, body: cmd._body })
        if (cmd._path === '/collections/units') return { data: { relations: [] } }
        if (cmd._path === '/field-config/units') return { data: [] }
        if (cmd._path === '/items/units' && cmd._method === 'POST') return { data: { id: 273029 } }
        return { data: {} }
      })
    }
    function Follower() {
      useQuickCreateFollow(useParentDraft())
      return <span>step 2</span>
    }
    let setDraft: (fn: (d: Record<string, unknown>) => Record<string, unknown>) => void = () => {}
    let setStep: (n: number) => void = () => {}
    function Host() {
      const [draft, sd] = useState<Record<string, unknown>>({ region: 2, division: 1, unit: null })
      const [step, ss] = useState(1)
      setDraft = sd
      setStep = ss
      return (
        <ParentDraftContext.Provider
          value={{ draft, collection: 'inventory_request', formKey: 'form-A', isNew: true }}
        >
          {step === 1 ? (
            <QuickCreateButton
              targetCollection='units'
              config={CONFIG}
              field='unit'
              value={draft.unit}
              onCreated={(id) => sd((d) => ({ ...d, unit: id }))}
            />
          ) : (
            <Follower />
          )}
        </ParentDraftContext.Provider>
      )
    }
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () =>
      root?.render(
        <QueryClientProvider client={qc}>
          <NivaroProvider client={client as never}>
            <Host />
          </NivaroProvider>
        </QueryClientProvider>
      )
    )
    await act(async () => document.querySelector<HTMLButtonElement>('button')?.click())
    await tick()
    const input = document.querySelector('[data-quick-create-panel] input') as HTMLInputElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        'ARMY11 PM Unit A'
      )
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () =>
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    )
    await tick()
    // Next: step 1 (and the button) unmount; step 2 fills the seeds.
    await act(async () => setStep(2))
    expect(document.querySelector('[data-quick-create-panel]')).toBeNull()
    await act(async () => setDraft((d) => ({ ...d, project_type: 3 })))
    await act(async () => setDraft((d) => ({ ...d, project: 8161, funding_year: 7 })))
    await act(async () => new Promise((r) => setTimeout(r, 600)))
    await tick()
    const patches = calls.filter((c) => c.method === 'PATCH')
    expect(patches).toHaveLength(1)
    expect(patches[0].path).toBe('/items/units/273029')
    expect(patches[0].body).toEqual({ project_type: 3, project: 8161, funding_years: 7 })

    // Another unit picked: the one made here stops following.
    await act(async () => setDraft((d) => ({ ...d, unit: 99, project: 9000 })))
    await act(async () => new Promise((r) => setTimeout(r, 600)))
    await tick()
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(1)
  })

  // army9 review L4: Escape in the popover closed a drill sheet around it —
  // Radix listens on document in the capture phase, before React's handlers.
  it('Escape closes the popover only, never the sheet around it', async () => {
    const client = {
      url: 'http://test',
      getToken: () => null,
      request: vi.fn(async () => ({ data: { relations: [] } }))
    }
    const sheetEscape = vi.fn()
    const onDoc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') sheetEscape()
    }
    document.addEventListener('keydown', onDoc, true)
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () =>
      root?.render(
        <QueryClientProvider client={qc}>
          <NivaroProvider client={client as never}>
            <ParentDraftContext.Provider
              value={{ draft: { region: 2, division: 1 }, collection: 'x' }}
            >
              <QuickCreateButton targetCollection='units' config={CONFIG} onCreated={() => {}} />
            </ParentDraftContext.Provider>
          </NivaroProvider>
        </QueryClientProvider>
      )
    )
    await act(async () => document.querySelector<HTMLButtonElement>('button')?.click())
    await tick()
    const input = document.querySelector('[data-quick-create-panel] input') as HTMLInputElement
    expect(document.activeElement).toBe(input)
    await act(async () =>
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      )
    )
    document.removeEventListener('keydown', onDoc, true)
    expect(document.querySelector('[data-quick-create-panel]')).toBeNull()
    expect(sheetEscape).not.toHaveBeenCalled()
  })
})

// army 11 review HIGH 1: the follow was global — another open form holding the
// same record (with other seeds) PATCHed it, or cancelled the follow.
describe('follow scope (one form instance, while new)', () => {
  const SEEDS: QuickCreateConfig['fields'] = [
    { field: 'project', from: '$parent.project' },
    { field: 'region', from: '$parent.region' }
  ]
  function start(request: ReturnType<typeof vi.fn>) {
    return startQuickCreateFollow({
      id: 77,
      targetCollection: 'units',
      parentCollection: 'inventory_request',
      formKey: 'form-A',
      field: 'unit',
      seeds: SEEDS,
      written: { region: '2' },
      m2mAliases: new Set(),
      request: request as never,
      invalidate: () => {}
    })
  }
  const settle = () => new Promise((r) => setTimeout(r, FOLLOW_DEBOUNCE_MS + 50))

  it('another form holding the same record never PATCHes it nor cancels the follow', async () => {
    const request = vi.fn(async () => ({}))
    start(request)
    // form-B: an unrelated record that uses unit 77 with another region.
    runQuickCreateFollow({ unit: 77, region: 9, project: 5 }, 'inventory_request', {
      formKey: 'form-B',
      isNew: false
    })
    // form-B with a different unit picked must not cancel form-A's follow either.
    runQuickCreateFollow({ unit: 12, region: 9 }, 'inventory_request', { formKey: 'form-B' })
    await settle()
    expect(request).not.toHaveBeenCalled()
    runQuickCreateFollow({ unit: 77, region: 2, project: 8161 }, 'inventory_request', {
      formKey: 'form-A',
      isNew: true
    })
    await settle()
    expect(request).toHaveBeenCalledTimes(1)
    expect((request.mock.calls[0] as unknown[])[0]).toMatchObject({
      _path: '/items/units/77',
      _body: { project: 8161 }
    })
  })

  it('the creating form unmounting ends the follow', async () => {
    const request = vi.fn(async () => ({}))
    start(request)
    endQuickCreateFollows('form-A')
    runQuickCreateFollow({ unit: 77, project: 8161 }, 'inventory_request', {
      formKey: 'form-A',
      isNew: true
    })
    await settle()
    expect(request).not.toHaveBeenCalled()
  })

  it('Create saved the form (no longer new): the follow ends, nothing more is written', async () => {
    const request = vi.fn(async () => ({}))
    start(request)
    runQuickCreateFollow({ unit: 77, project: 8161 }, 'inventory_request', {
      formKey: 'form-A',
      isNew: false
    })
    runQuickCreateFollow({ unit: 77, project: 8161 }, 'inventory_request', {
      formKey: 'form-A',
      isNew: true
    })
    await settle()
    expect(request).not.toHaveBeenCalled()
  })

  it('a form with no identity only follows from its own mounted button', async () => {
    const request = vi.fn(async () => ({}))
    const key = startQuickCreateFollow({
      id: 5,
      targetCollection: 'units',
      parentCollection: 'inventory_request',
      formKey: null,
      seeds: SEEDS,
      written: {},
      m2mAliases: new Set(),
      request: request as never,
      invalidate: () => {}
    })
    runQuickCreateFollow({ project: 1 }, 'inventory_request', {})
    await settle()
    expect(request).not.toHaveBeenCalled()
    expect(key).toContain('units|5')
  })
})

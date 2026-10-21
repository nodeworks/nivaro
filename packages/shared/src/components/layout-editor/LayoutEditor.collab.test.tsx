// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../context'
import {
  applyLayoutOps,
  type LayoutBundle,
  type LayoutOp,
  newGroup,
  newPlacement,
  ungroupedGroup
} from '../../lib/layout-ops'
import { RealtimeContext } from '../../lib/realtime'
import type { CMSField } from '../item-edit/types'
import { storedDraftKey } from './draft-recovery'
import { LayoutEditor } from './LayoutEditor'
import { closeBarMenu, openBarMenu } from './toolbar-kit.test-utils'

// Collaboration in the layout editor: unsaved markers (#2629), presence (#2651),
// crash recovery (#2653) and the required change note (#2654). The rebase
// itself (#2652) is the draft engine's (useLayoutDraft.test.ts).
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function field(name: string, label: string, over: Partial<CMSField> = {}): CMSField {
  return {
    field: name,
    type: 'string',
    interface: 'input',
    label,
    required: false,
    hidden: false,
    readonly: false,
    sort: 0,
    group_key: null,
    options: null,
    computed_formula: null,
    computed_type: null,
    note: null,
    placeholder: null,
    repeater_schema: null,
    dependency_config: null,
    ...over
  }
}

const FIELDS: Record<string, CMSField> = {
  title: field('title', 'Title'),
  amount: field('amount', 'Amount', { type: 'decimal' }),
  notes: field('notes', 'Notes', { type: 'text' }),
  vendor: field('vendor', 'Vendor name')
}

function makeBundle(layout: Record<string, unknown> = {}): LayoutBundle {
  return {
    layout: { id: 7, collection: 'orders', name: 'Order form', layout_type: 'grouped', ...layout },
    groups: [
      { ...newGroup('main', 'Main', 'section', null), id: 1, sort: 0 },
      { ...newGroup('extra', 'Extra', 'section', null), id: 2, sort: 1 },
      ungroupedGroup(2)
    ],
    placements: [
      { ...newPlacement('title', 'main'), id: 10, sort: 0 },
      { ...newPlacement('amount', 'main'), id: 11, sort: 1 },
      { ...newPlacement('notes', 'extra'), id: 12, sort: 0 }
    ],
    rev: 'r0'
  }
}

type Cmd = { _method?: string; _path: string; _body?: Record<string, unknown> }

function project(assignments: Array<Record<string, unknown>>): CMSField[] {
  const placed = assignments.filter((a) => !String(a.field).startsWith('__'))
  const rows = placed.map((a) => ({
    ...FIELDS[String(a.field)],
    group_key: (a.group_key as string | null) ?? null,
    sort: Number(a.sort),
    layout_assigned: true
  }))
  const names = new Set(placed.map((a) => a.field))
  for (const f of Object.values(FIELDS))
    if (!names.has(f.field)) rows.push({ ...f, group_key: null, layout_assigned: false })
  return rows
}

// The server's staged copy of my draft (#2589), per test.
let stagedAnswer: unknown = { data: null, others: [], available: true }

function makeClient(initial: LayoutBundle) {
  const calls: Cmd[] = []
  let stored = initial
  let rev = 0
  const client = {
    url: 'http://test',
    getToken: () => null,
    request: vi.fn(async (cmd: Cmd) => {
      calls.push(cmd)
      const p = cmd._path
      const method = (cmd._method ?? 'GET').toUpperCase()
      if (p === '/collection-layouts/7/bundle') return stored
      if (p === '/collection-layouts/7/staged' && method === 'GET') return stagedAnswer
      if (p === '/users/me') return { data: { id: 'u1' } }
      if (p === '/collection-layouts/7/ops') {
        stored = { ...applyLayoutOps(stored, cmd._body?.ops as LayoutOp[]), rev: `r${++rev}` }
        return stored
      }
      if (p === '/field-config/orders') return { data: project(stored.placements as never) }
      if (p === '/field-config/orders/project')
        return { data: project((cmd._body?.assignments ?? []) as never) }
      if (p === '/collections/orders')
        return { data: { display_name: 'Orders', fields: Object.values(FIELDS) } }
      if (method !== 'GET') return { data: null }
      return { data: [] }
    })
  }
  return { client, calls }
}

/** A host realtime adapter: records emits, delivers events on demand. */
function fakeRealtime() {
  const listeners = new Map<string, Set<(p: unknown) => void>>()
  const emits: Array<{ event: string; payload: any }> = []
  return {
    emits,
    deliver(event: string, payload: unknown) {
      act(() => {
        for (const cb of listeners.get(event) ?? []) cb(payload)
      })
    },
    adapter: {
      subscribeCollections: () => () => {},
      on(event: string, cb: (p: unknown) => void) {
        const set = listeners.get(event) ?? new Set()
        set.add(cb)
        listeners.set(event, set)
        return () => set.delete(cb)
      },
      emit(event: string, payload?: unknown) {
        emits.push({ event, payload })
      }
    }
  }
}

class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return []
  }
}
const g = globalThis as Record<string, unknown>
g.ResizeObserver ??= NoopObserver
g.IntersectionObserver ??= NoopObserver
window.matchMedia ??= ((q: string) => ({
  matches: false,
  media: q,
  onchange: null,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent: () => false
})) as typeof window.matchMedia
Element.prototype.scrollIntoView ??= () => {}
g.CSS ??= { escape: (v: string) => v }

let root: Root
let host: HTMLDivElement
beforeEach(() => {
  window.localStorage.clear()
  stagedAnswer = { data: null, others: [], available: true }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

async function settle(until: () => boolean) {
  for (let i = 0; i < 100 && !until(); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
  }
  expect(until()).toBe(true)
}

function click(el: Element | null) {
  if (!el) throw new Error('nothing to click')
  act(() => {
    ;(el as HTMLElement).click()
  })
}

async function type(el: Element | null, value: string) {
  if (!el) throw new Error('no input')
  const input = el as HTMLInputElement
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const q = (sel: string) => document.querySelector(sel) as HTMLElement | null
const node = (k: string) => q(`[data-design-target="${k}"]`)
const canvasFields = () => document.querySelectorAll('[data-editor-canvas] [data-field]')
const opsBodies = (calls: Cmd[]) =>
  calls.filter((c) => c._path === '/collection-layouts/7/ops').map((c) => c._body ?? {})
const unsaved = () => q('[data-save-status]')?.getAttribute('data-unsaved')

async function mount(
  opts: { bundle?: LayoutBundle; realtime?: ReturnType<typeof fakeRealtime> } = {}
) {
  const { client, calls } = makeClient(opts.bundle ?? makeBundle())
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const tree = (
    <QueryClientProvider client={qc}>
      <NivaroProvider client={client as never}>
        <LayoutEditor collection='orders' layoutId={7} onBack={() => {}} mode='page' />
      </NivaroProvider>
    </QueryClientProvider>
  )
  await act(async () =>
    root.render(
      opts.realtime ? (
        <RealtimeContext.Provider value={opts.realtime.adapter as never}>
          {tree}
        </RealtimeContext.Provider>
      ) : (
        tree
      )
    )
  )
  await settle(() => canvasFields().length >= 3)
  return { calls }
}

async function addVendor() {
  click(q('[data-editor-tab="add"]'))
  await settle(() => !!q('[data-add-field="vendor"]'))
  click(q('[data-add-field="vendor"]'))
  await settle(() => unsaved() === '1')
}

describe('unsaved markers (#2629)', () => {
  it('dots what an unsaved change touched; the count lists it with a jump; Save clears both', async () => {
    const { calls } = await mount()
    await addVendor()
    await settle(() => !!node('field:vendor:main'))
    expect(node('field:vendor:main')?.hasAttribute('data-unsaved')).toBe(true)
    expect(node('field:vendor:main')?.querySelector('[data-unsaved-dot]')).not.toBeNull()
    expect(node('field:title:main')?.hasAttribute('data-unsaved')).toBe(false)

    click(q('[data-unsaved-list-open]'))
    await settle(() => !!q('[data-unsaved-list]'))
    const step = q('[data-unsaved-step="0"]')
    expect(step?.textContent).toContain('Vendor name in Main')
    click(step)
    await settle(() => node('field:vendor:main')?.getAttribute('data-selected') === 'true')
    expect(q('[data-unsaved-list]')).toBeNull()

    click(q('[data-editor-save]'))
    await settle(() => unsaved() === '0')
    expect(opsBodies(calls)).toHaveLength(1)
    await settle(() => !document.querySelector('[data-unsaved-dot]'))
  })
})

// One recoverable step, for the browser copy and the server copy alike.
const step = {
  label: 'Add Vendor name',
  ops: [{ op: 'place', field: 'vendor', group_key: 'main', index: 2 }]
}

describe('crash recovery (#2653)', () => {
  it('keeps the unsaved steps in this browser and clears them on Save', async () => {
    await mount()
    await addVendor()
    await settle(() => !!window.localStorage.getItem(storedDraftKey(7, 'u1')))
    const kept = JSON.parse(window.localStorage.getItem(storedDraftKey(7, 'u1')) ?? '{}')
    expect(kept).toMatchObject({ v: 1, layoutId: 7, userId: 'u1', baseRev: 'r0' })
    expect(kept.steps).toHaveLength(1)
    click(q('[data-editor-save]'))
    await settle(() => !window.localStorage.getItem(storedDraftKey(7, 'u1')))
  })

  it('offers a draft left on the same rev; Recover brings the changes back unsaved', async () => {
    window.localStorage.setItem(
      storedDraftKey(7, 'u1'),
      JSON.stringify({
        v: 1,
        layoutId: 7,
        userId: 'u1',
        baseRev: 'r0',
        steps: [step],
        at: Date.now()
      })
    )
    const { calls } = await mount()
    await settle(() => !!q('[data-draft-recovery="offer"]'))
    expect(q('[data-draft-recovery]')?.textContent).toContain('1 unsaved change')
    click(q('[data-draft-recover]'))
    await settle(() => unsaved() === '1')
    expect(q('[data-draft-recovery]')).toBeNull()
    await settle(() => !!node('field:vendor:main'))
    expect(opsBodies(calls)).toHaveLength(0)
  })

  it('offers a draft whose layout was saved since as stale; Recover lays it on top', async () => {
    window.localStorage.setItem(
      storedDraftKey(7, 'u1'),
      JSON.stringify({
        v: 1,
        layoutId: 7,
        userId: 'u1',
        baseRev: 'r-old',
        steps: [step],
        at: Date.now()
      })
    )
    await mount()
    await settle(() => !!q('[data-draft-recovery="offer"][data-draft-stale]'))
    expect(q('[data-draft-recovery]')?.textContent).toContain('saved since')
    click(q('[data-draft-recover]'))
    await settle(() => unsaved() === '1')
    await settle(() => !!node('field:vendor:main'))
  })

  it('Discard on the offer clears both copies', async () => {
    window.localStorage.setItem(
      storedDraftKey(7, 'u1'),
      JSON.stringify({ v: 1, layoutId: 7, userId: 'u1', baseRev: 'r0', steps: [step], at: 5 })
    )
    stagedAnswer = {
      data: { steps: [step], base_rev: 'r0', saved_at: new Date(10).toISOString() },
      others: [],
      available: true
    }
    const { calls } = await mount()
    await settle(() => !!q('[data-draft-recovery="offer"]'))
    expect(q('[data-draft-recovery]')?.textContent).toContain('kept for you')
    click(q('[data-draft-dismiss]'))
    await settle(() => !q('[data-draft-recovery]'))
    expect(window.localStorage.getItem(storedDraftKey(7, 'u1'))).toBeNull()
    await settle(() => calls.some((c) => c._path === '/collection-layouts/7/staged/clear'))
    expect(unsaved()).toBe('0')
  })
})

describe('staged edits on the server (#2589)', () => {
  it('keeps unsaved steps on the server after a pause; Save clears them', async () => {
    const { calls } = await mount()
    await addVendor()
    await settle(() =>
      calls.some((c) => c._path === '/collection-layouts/7/staged' && c._method === 'POST')
    )
    const kept = calls.find(
      (c) => c._path === '/collection-layouts/7/staged' && c._method === 'POST'
    )
    expect(kept?._body).toMatchObject({ base_rev: 'r0' })
    expect((kept?._body?.steps as unknown[]).length).toBe(1)
    expect(q('[data-save-status]')?.getAttribute('data-tip')).toContain('Kept for you')
    click(q('[data-editor-save]'))
    await settle(() => calls.some((c) => c._path === '/collection-layouts/7/staged/clear'))
    expect(unsaved()).toBe('0')
  })

  it('offers the server copy from another browser and shows who else is drafting', async () => {
    stagedAnswer = {
      data: { steps: [step], base_rev: 'r0', saved_at: new Date().toISOString() },
      others: [
        {
          user_id: 'u2',
          name: 'Ana Ruiz',
          step_count: 3,
          op_count: 4,
          saved_at: new Date().toISOString()
        }
      ],
      available: true
    }
    const { calls } = await mount()
    await settle(() => !!q('[data-draft-recovery="offer"]'))
    expect(q('[data-draft-recovery]')?.textContent).toContain('kept for you')
    expect(q('[data-staged-others]')?.textContent).toContain('Ana is drafting')
    expect(q('[data-staged-others]')?.getAttribute('data-tip')).toContain('3 unsaved changes')
    click(q('[data-draft-recover]'))
    await settle(() => unsaved() === '1')
    expect(opsBodies(calls)).toHaveLength(0)
  })
})

describe('required change note (#2654)', () => {
  it('Save asks for a reason and a ticket and sends them; autosave is off', async () => {
    const { calls } = await mount({ bundle: makeBundle({ change_note: 'note_ticket' }) })
    await addVendor()
    // No Autosave row in the Save menu: every save needs a reason.
    await openBarMenu('Save options')
    expect(q('[data-editor-schedule]')).not.toBeNull()
    expect(q('[data-autosave-switch]')).toBeNull()
    await closeBarMenu('Save options')
    click(q('[data-editor-save]'))
    await settle(() => !!q('[data-change-note-save]'))
    const submit = () => q('[data-change-note-submit]') as HTMLButtonElement
    expect(submit().disabled).toBe(true)
    await type(q('[data-change-note-reason]'), 'Vendor needed for triage')
    expect(submit().disabled).toBe(true)
    await type(q('[data-change-note-ticket]'), 'OPS-12')
    expect(submit().disabled).toBe(false)
    click(submit())
    await settle(() => unsaved() === '0')
    expect(opsBodies(calls)[0]).toMatchObject({
      reason: 'Vendor needed for triage',
      ticket: 'OPS-12'
    })
    await settle(() => !q('[data-change-note-save]'))
  })

  it('⌘S opens the same question instead of saving', async () => {
    const { calls } = await mount({ bundle: makeBundle({ change_note: 'note' }) })
    await addVendor()
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true }))
    })
    await settle(() => !!q('[data-change-note-save]'))
    expect(opsBodies(calls)).toHaveLength(0)
  })
})

describe('live presence (#2651)', () => {
  it('joins the layout topic, shows others with their selection and says what is selected', async () => {
    const rt = fakeRealtime()
    await mount({ realtime: rt })
    expect(rt.emits).toContainEqual({ event: 'ops:join', payload: { topic: 'layout:7' } })

    rt.deliver('ops:changed', {
      topic: 'layout:7',
      viewers: [
        { id: 'u1', name: 'Me Myself' },
        { id: 'u2', name: 'Ben Ode', selected: 'field:title:main' }
      ],
      at: 1
    })
    await settle(() => !!q('[data-presence-peer="u2"]'))
    expect(q('[data-presence-peer="u1"]')).toBeNull()
    expect(q('[data-presence-peer="u2"]')?.textContent).toBe('BO')
    expect(q('[data-presence-peer="u2"]')?.getAttribute('data-tip')).toContain('Title in Main')
    // On the canvas: a small avatar with the initials, the name in its tip.
    const avatar = node('field:title:main')?.querySelector('[data-design-peer="u2"]')
    expect(avatar?.textContent).toBe('BO')
    expect(avatar?.getAttribute('data-tip')).toBe('Ben Ode')

    click(node('field:amount:main'))
    await settle(() =>
      rt.emits.some(
        (e) =>
          e.event === 'ops:signal' &&
          e.payload?.kind === 'select' &&
          e.payload?.target === 'field:amount:main'
      )
    )

    // A click on their avatar jumps to what they selected.
    click(q('[data-presence-peer="u2"]'))
    await settle(() => node('field:title:main')?.getAttribute('data-selected') === 'true')
  })
})

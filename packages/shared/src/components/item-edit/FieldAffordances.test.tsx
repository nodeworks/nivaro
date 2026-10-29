// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../context'
import type { SavedDefault } from '../../lib/personal-defaults'
import { useFieldContextMenu } from './FieldAffordances'
import type { CascadeRule } from './helpers'
import {
  PERSONAL_DEFAULT_CSS,
  PersonalDefaultSlot,
  personalDefaultSlotFor,
  personalDefaultSlotState
} from './PersonalDefaultControl'
import type { CMSField } from './types'
import {
  PersonalDefaultsContext,
  usePersonalDefaults,
  usePersonalDefaultsApi
} from './usePersonalDefaults'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn()
}))
vi.mock('sonner', () => ({ toast: toastMock }))

const RULES: Record<string, CascadeRule[]> = {
  region: [{ parent_field: 'zone', filter_column: 'zone' }],
  ship_to: [{ parent_field: 'region', filter_column: 'region' }]
}
const LABELS: Record<string, string> = { '2': 'Zone 2', '10': 'Boston', '100': 'Cambridge' }

type Req = { _method?: string; _path: string; _body?: Record<string, unknown> }
let requests: Req[]
let failWith: string | null
let root: Root
let host: HTMLDivElement
let saved: SavedDefault[]
/** false = the picker knows no label (a record the person cannot read, a failed lookup). */
let labelsKnown: boolean
/** GET /field-defaults/mine fails. */
let getFails: boolean
const FIELD_LABELS: Record<string, string> = { zone: 'Zone', region: 'Region', ship_to: 'Ship to' }

function Harness({
  field,
  draft,
  allowed,
  editable,
  inDialog = false
}: {
  field: string
  draft: Record<string, unknown>
  allowed: string[]
  editable: boolean
  /** Render the row inside a modal sheet's [role=dialog]. */
  inDialog?: boolean
}) {
  const draftRef = useRef(draft)
  draftRef.current = draft
  const pd = usePersonalDefaults({
    collection: 'orders',
    isNew: true,
    layoutAllows: (f) => allowed.includes(f),
    draftRef,
    setFieldValue: () => {},
    markAutoFilled: () => {},
    revalidate: async () => true,
    disabled: true,
    rulesFor: (f) => RULES[f] ?? [],
    valueLabel: (_f, v) => (labelsKnown ? (LABELS[String(v)] ?? String(v)) : null),
    fieldLabel: (f) => FIELD_LABELS[f] ?? f
  })
  const row = <Row field={field} draft={draft} editable={editable} />
  return (
    <PersonalDefaultsContext.Provider value={pd.context}>
      {inDialog ? (
        <div role='dialog' aria-modal='true' data-testid='sheet'>
          {row}
        </div>
      ) : (
        row
      )}
    </PersonalDefaultsContext.Provider>
  )
}

function Row({
  field,
  draft,
  editable
}: {
  field: string
  draft: Record<string, unknown>
  editable: boolean
}) {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const api = usePersonalDefaultsApi()
  const slot = personalDefaultSlotFor(api, field, editable)
  const { onContextMenu, menu, openFrom, hasFieldItems, confirmSaveFrom, openedBy } =
    useFieldContextMenu({
      wrapperRef,
      field: { field, interface: null } as unknown as CMSField,
      value: draft[field],
      relations: [],
      collection: 'orders',
      itemId: 'new',
      editable
    })
  return (
    <>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: test host for the context menu */}
      <div ref={wrapperRef} data-testid='row' onContextMenu={onContextMenu}>
        row
        {hasFieldItems && (
          <button
            type='button'
            data-field-menu-trigger
            aria-label='Field options'
            onClick={(e) => openFrom(e.currentTarget)}
          />
        )}
        {slot && (
          <PersonalDefaultSlot
            field={field}
            label={FIELD_LABELS[field] ?? field}
            state={slot}
            confirmOpen={openedBy === 'make' || openedBy === 'update' ? openedBy : null}
            onConfirm={(el, mode) => confirmSaveFrom(el, undefined, mode)}
            onUndo={() => {}}
          />
        )}
      </div>
      {menu}
    </>
  )
}

async function flush(n = 8) {
  for (let i = 0; i < n; i++)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
}

async function mount(props: React.ComponentProps<typeof Harness>) {
  const client = {
    request: vi.fn(async (cmd: Req) => {
      requests.push(cmd)
      const m = cmd._method ?? 'GET'
      if (m === 'GET') {
        if (getFails) throw new Error('offline')
        return { data: saved }
      }
      if (failWith)
        throw Object.assign(new Error('boom'), { response: { data: { error: failWith } } })
      // The server's upsert (one row per field + context) and delete, so the refetch sees them.
      const b = cmd._body as { field: string; value: unknown; context: Record<string, unknown> }
      if (m === 'PUT') {
        const same = (r: SavedDefault) =>
          r.field === b.field && JSON.stringify(r.context) === JSON.stringify(b.context)
        saved = [
          ...saved.filter((r) => !same(r)),
          { id: 100 + requests.length, ...b, updated_at: '2026-10-28' }
        ]
      } else if (m === 'DELETE') {
        const id = Number(cmd._path.split('/').pop())
        saved = saved.filter((r) => r.id !== id)
      }
      return { data: null }
    })
  }
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () =>
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client as never}>
          <Harness {...props} />
        </NivaroProvider>
      </QueryClientProvider>
    )
  )
  await flush()
}

async function open(props: React.ComponentProps<typeof Harness>) {
  await mount(props)
  await act(async () => {
    host
      .querySelector('[data-testid=row]')
      ?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  })
  await flush(2)
}

const items = () => [...document.querySelectorAll('[role=menuitem]')].map((e) => e.textContent)
const item = (t: string) =>
  [...document.querySelectorAll<HTMLElement>('[role=menuitem]')].find((e) =>
    e.textContent?.includes(t)
  )
const button = (t: string) =>
  [...document.querySelectorAll<HTMLElement>('button')].find((e) => e.textContent?.trim() === t)
const click = async (el: HTMLElement | undefined) => {
  await act(async () => el?.click())
  await flush()
}
const writes = () => requests.filter((r) => r._method === 'PUT' || r._method === 'DELETE')

const FULL = { zone: 2, region: 10, ship_to: 100 }

beforeEach(() => {
  requests = []
  failWith = null
  saved = []
  labelsKnown = true
  getFails = false
  vi.clearAllMocks()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
})

describe('field menu: Save as my default', () => {
  it('shows when allowed, editable and the field has a value', async () => {
    await open({ field: 'ship_to', draft: FULL, allowed: ['ship_to'], editable: true })
    expect(items()).toContain('Save as my default')
  })
  it('is hidden when the layout does not allow it', async () => {
    await open({ field: 'ship_to', draft: FULL, allowed: [], editable: true })
    expect(items().join('|')).not.toContain('my default')
  })
  it('is hidden on a read-only / computed / hidden field (not editable)', async () => {
    await open({ field: 'ship_to', draft: FULL, allowed: ['ship_to'], editable: false })
    expect(items().join('|')).not.toContain('my default')
  })
  it('is hidden when the field is empty', async () => {
    await open({ field: 'ship_to', draft: { zone: 2 }, allowed: ['ship_to'], editable: true })
    expect(items().join('|')).not.toContain('my default')
  })

  it('confirms inline with the parents listed, then saves child + allowed parents', async () => {
    await open({
      field: 'ship_to',
      draft: FULL,
      allowed: ['ship_to', 'zone'],
      editable: true
    })
    await click(item('Save as my default'))
    expect(writes()).toHaveLength(0)
    expect(document.body.textContent).toContain('Save Zone 2 · Cambridge as your defaults?')
    await click(button('Save'))
    const puts = writes().filter((r) => r._method === 'PUT')
    expect(puts.map((r) => r._body?.field)).toEqual(['ship_to', 'zone'])
    expect(puts[0]._body).toMatchObject({
      collection: 'orders',
      field: 'ship_to',
      value: 100,
      context: { zone: 2, region: 10 }
    })
    expect(toastMock.success).toHaveBeenCalled()
    expect(document.querySelector('[data-field-context-menu]')).toBeNull()
  })

  it('lists all three when region is allowed too', async () => {
    await open({
      field: 'ship_to',
      draft: FULL,
      allowed: ['ship_to', 'region', 'zone'],
      editable: true
    })
    await click(item('Save as my default'))
    expect(document.body.textContent).toContain(
      'Save Zone 2 · Boston · Cambridge as your defaults?'
    )
  })

  it('moves focus into the confirm: Save once labels resolve; the panel is a labelled group', async () => {
    await open({ field: 'ship_to', draft: FULL, allowed: ['ship_to'], editable: true })
    await click(item('Save as my default'))
    expect(document.activeElement).toBe(button('Save'))
    const group = document.querySelector('[data-personal-default-confirm]')
    // A menu holds only menu items: while it asks, the panel is a small non-modal dialog.
    const panel = document.querySelector('[data-field-context-menu]')
    expect(panel?.getAttribute('role')).toBe('dialog')
    expect(panel?.getAttribute('aria-modal')).toBe('false')
    expect(panel?.getAttribute('aria-label')).toBe('Save as my default')
    expect(group?.hasAttribute('role')).toBe(false)
    expect(group?.querySelector('[aria-live=polite]')).not.toBeNull()
  })

  it('keeps Tab inside the confirm (Cancel <-> Save)', async () => {
    await open({ field: 'ship_to', draft: FULL, allowed: ['ship_to'], editable: true })
    await click(item('Save as my default'))
    const tab = async (shiftKey = false) =>
      act(async () => {
        document.activeElement?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true })
        )
      })
    await tab()
    expect(document.activeElement).toBe(button('Cancel'))
    await tab()
    expect(document.activeElement).toBe(button('Save'))
    await tab(true)
    expect(document.activeElement).toBe(button('Cancel'))
  })

  it('never shows a stored id when a value has no label: the field name stands in', async () => {
    labelsKnown = false
    await open({ field: 'ship_to', draft: FULL, allowed: ['ship_to', 'zone'], editable: true })
    await click(item('Save as my default'))
    const text = document.querySelector('[data-personal-default-confirm] p')?.textContent ?? ''
    expect(text).toBe('Save Zone · Ship to as your defaults?')
    expect(text).not.toMatch(/\d/)
    await click(button('Save'))
    expect(toastMock.success).toHaveBeenCalledWith('Saved Zone · Ship to as your defaults')
  })

  it('Save says Saving… while the write runs', async () => {
    await open({ field: 'ship_to', draft: FULL, allowed: ['ship_to'], editable: true })
    await click(item('Save as my default'))
    const save = button('Save')
    await act(async () => save?.click())
    expect(save?.textContent).toBe('Saving…')
    await flush()
  })

  it('Cancel saves nothing', async () => {
    await open({ field: 'ship_to', draft: FULL, allowed: ['ship_to'], editable: true })
    await click(item('Save as my default'))
    await click(button('Cancel'))
    expect(writes()).toHaveLength(0)
  })

  it('shows the server message when the save is refused', async () => {
    failWith = 'That field cannot carry a default'
    await open({ field: 'ship_to', draft: FULL, allowed: ['ship_to'], editable: true })
    await click(item('Save as my default'))
    await click(button('Save'))
    expect(toastMock.error).toHaveBeenCalledWith('That field cannot carry a default')
  })
})

describe('field menu: the ⋯ button and where the panel goes', () => {
  it('shows a ⋯ trigger only where the menu has Save / Clear my default', async () => {
    await open({ field: 'ship_to', draft: FULL, allowed: ['ship_to'], editable: true })
    expect(host.querySelector('[data-field-menu-trigger]')).not.toBeNull()
    act(() => root.unmount())
    root = createRoot(host)
    await open({ field: 'ship_to', draft: FULL, allowed: [], editable: true })
    expect(host.querySelector('[data-field-menu-trigger]')).toBeNull()
  })

  it('the ⋯ trigger opens the same menu and toggles it shut', async () => {
    await open({ field: 'ship_to', draft: FULL, allowed: ['ship_to'], editable: true })
    // open() right-clicked; close with Escape, then use the button.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(document.querySelector('[data-field-context-menu]')).toBeNull()
    const trigger = host.querySelector<HTMLElement>('[data-field-menu-trigger]') ?? undefined
    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      trigger?.click()
    })
    expect(items()).toContain('Save as my default')
    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      trigger?.click()
    })
    expect(document.querySelector('[data-field-context-menu]')).toBeNull()
  })

  it('portals into the hosting [role=dialog] inside a modal sheet, else into body', async () => {
    await open({
      field: 'ship_to',
      draft: FULL,
      allowed: ['ship_to'],
      editable: true,
      inDialog: true
    })
    const panel = document.querySelector<HTMLElement>('[data-field-context-menu]')
    expect(panel?.parentElement).toBe(host.querySelector('[data-testid=sheet]'))
    expect(panel?.style.position).toBe('absolute')
    act(() => root.unmount())
    root = createRoot(host)
    await open({ field: 'ship_to', draft: FULL, allowed: ['ship_to'], editable: true })
    const bodyPanel = document.querySelector<HTMLElement>('[data-field-context-menu]')
    expect(bodyPanel?.parentElement).toBe(document.body)
    expect(bodyPanel?.style.position).toBe('fixed')
  })
})

describe('field menu: Clear my default', () => {
  const row: SavedDefault = {
    id: 7,
    field: 'ship_to',
    value: 100,
    context: { zone: 2, region: 10 },
    updated_at: '2026-10-20'
  }
  it('shows only when a default fits the current context, and deletes it', async () => {
    saved = [row]
    await open({ field: 'ship_to', draft: FULL, allowed: ['ship_to'], editable: true })
    expect(items()).toContain('Clear my default')
    await click(item('Clear my default'))
    expect(writes().map((r) => [r._method, r._path])).toEqual([
      ['DELETE', '/field-defaults/mine/7']
    ])
    expect(toastMock.success).toHaveBeenCalled()
  })
  it('the cleared toast offers Undo, which saves the same value and context back', async () => {
    saved = [row]
    await open({ field: 'ship_to', draft: FULL, allowed: ['ship_to'], editable: true })
    await click(item('Clear my default'))
    const [text, opts] = toastMock.success.mock.calls[0] as [
      string,
      { action: { label: string; onClick: () => void } }
    ]
    expect(text).toBe('Your default was cleared')
    expect(opts.action.label).toBe('Undo')
    await act(async () => opts.action.onClick())
    await flush()
    const put = writes().find((r) => r._method === 'PUT')
    expect(put?._body).toEqual({
      collection: 'orders',
      field: 'ship_to',
      value: 100,
      context: { zone: 2, region: 10 }
    })
    expect(toastMock.success).toHaveBeenLastCalledWith('Your default is back')
  })
  it('is hidden with no default', async () => {
    await open({ field: 'ship_to', draft: FULL, allowed: ['ship_to'], editable: true })
    expect(items()).not.toContain('Clear my default')
  })
  it('is hidden when the saved default is for another context', async () => {
    saved = [{ ...row, context: { zone: 9, region: 10 } }]
    await open({ field: 'ship_to', draft: FULL, allowed: ['ship_to'], editable: true })
    expect(items()).not.toContain('Clear my default')
  })
})

describe('personalDefaultSlotState: which control a field shows', () => {
  const base = {
    allowed: true,
    editable: true,
    loaded: true,
    hasValue: true,
    hasDefault: false,
    isDefault: false,
    applied: false
  }
  it('1. no saved default here, a value: Make default', () => {
    expect(personalDefaultSlotState(base)).toBe('offer')
  })
  it('2. the value is the saved default: Your default + Clear default', () => {
    expect(personalDefaultSlotState({ ...base, hasDefault: true, isDefault: true })).toBe('saved')
  })
  it('3. a saved default but another value: Update default + Clear default', () => {
    expect(personalDefaultSlotState({ ...base, hasDefault: true })).toBe('update')
  })
  it('4. a saved default and an empty field: Your default + Clear default, no Update', () => {
    expect(personalDefaultSlotState({ ...base, hasDefault: true, hasValue: false })).toBe(
      'saved-empty'
    )
  })
  it('prefilled on a new record: ONE control (Your default · Undo · Clear default)', () => {
    const applied = { ...base, hasDefault: true, isDefault: true, applied: true }
    expect(personalDefaultSlotState(applied)).toBe('applied')
    expect(personalDefaultSlotState({ ...applied, editable: false })).toBe('applied')
    // Its saved default cleared: the value is just a value again.
    expect(personalDefaultSlotState({ ...applied, hasDefault: false, isDefault: false })).toBe(
      'offer'
    )
  })
  it('keeps the slot (nothing to click) while the field is empty or defaults are loading', () => {
    expect(personalDefaultSlotState({ ...base, hasValue: false })).toBe('reserve')
    expect(personalDefaultSlotState({ ...base, loaded: false })).toBe('reserve')
  })
  it('renders nothing when the layout does not allow it or the field is not editable', () => {
    expect(personalDefaultSlotState({ ...base, allowed: false })).toBeNull()
    expect(personalDefaultSlotState({ ...base, editable: false })).toBeNull()
    expect(personalDefaultSlotState({ ...base, editable: false, hasDefault: true })).toBeNull()
  })
})

describe('Make default (the visible control)', () => {
  const make = () => host.querySelector<HTMLButtonElement>('[data-personal-default-make]')
  const row: SavedDefault = {
    id: 7,
    field: 'ship_to',
    value: 100,
    context: { zone: 2, region: 10 },
    updated_at: '2026-10-20'
  }

  it('shows on an allowed, editable field with a value, without hover', async () => {
    await mount({ field: 'ship_to', draft: FULL, allowed: ['ship_to'], editable: true })
    expect(make()?.textContent).toBe('Make default')
    expect(make()?.getAttribute('aria-label')).toBe('Make this your default for Ship to')
    expect(make()?.getAttribute('data-tip')).toBeTruthy()
    expect(make()?.hasAttribute('title')).toBe(false)
    expect(make()?.getAttribute('aria-haspopup')).toBe('dialog')
  })
  it('is absent when not allowed or not editable; an empty field keeps an empty slot', async () => {
    await mount({ field: 'ship_to', draft: FULL, allowed: [], editable: true })
    expect(host.querySelector('[data-personal-default-slot]')).toBeNull()
    act(() => root.unmount())
    root = createRoot(host)
    await mount({ field: 'ship_to', draft: FULL, allowed: ['ship_to'], editable: false })
    expect(host.querySelector('[data-personal-default-slot]')).toBeNull()
    act(() => root.unmount())
    root = createRoot(host)
    await mount({ field: 'ship_to', draft: { zone: 2 }, allowed: ['ship_to'], editable: true })
    const slot = host.querySelector('[data-personal-default-slot]')
    expect(slot).not.toBeNull()
    expect(slot?.querySelector('button')).toBeNull()
    expect(slot?.getAttribute('aria-hidden')).toBe('true')
  })
  it('says Your default instead when the value already is the saved default here', async () => {
    saved = [row]
    await mount({ field: 'ship_to', draft: FULL, allowed: ['ship_to'], editable: true })
    expect(make()).toBeNull()
    expect(host.querySelector('[data-personal-default-saved]')?.textContent).toContain(
      'Your default'
    )
    const clear = host.querySelector('[data-personal-default-clear]')
    expect(clear?.textContent).toBe('Clear default')
    expect(clear?.getAttribute('aria-label')).toBe(
      'Clear your saved default for Ship to (the field keeps its value)'
    )
    expect(host.querySelector('[data-personal-default-update]')).toBeNull()
  })
  it('offers Make default when the only saved default is for another context', async () => {
    saved = [{ ...row, context: { zone: 9, region: 10 } }]
    await mount({ field: 'ship_to', draft: FULL, allowed: ['ship_to'], editable: true })
    expect(make()).not.toBeNull()
  })

  it('asks inline with the same line as the menu, then saves child + allowed parents', async () => {
    await mount({
      field: 'ship_to',
      draft: FULL,
      allowed: ['ship_to', 'region', 'zone'],
      editable: true
    })
    await click(make() ?? undefined)
    expect(writes()).toHaveLength(0)
    expect(document.querySelector('[data-personal-default-confirm] p')?.textContent).toBe(
      'Save Zone 2 · Boston · Cambridge as your defaults?'
    )
    expect(make()?.getAttribute('aria-expanded')).toBe('true')
    // Focus is inside the confirm (Save once the labels resolved).
    expect(document.activeElement).toBe(button('Save'))
    await click(button('Save'))
    expect(writes().map((r) => r._body?.field)).toEqual(['ship_to', 'zone', 'region'])
    expect(toastMock.success).toHaveBeenCalledWith(
      'Saved Zone 2 · Boston · Cambridge as your defaults'
    )
    expect(document.querySelector('[data-field-context-menu]')).toBeNull()
    // The value is now the default: the control turns into the calm state.
    expect(make()).toBeNull()
    expect(host.querySelector('[data-personal-default-saved]')).not.toBeNull()
  })
  it('Escape cancels without saving and focus goes back to the button', async () => {
    await mount({ field: 'ship_to', draft: FULL, allowed: ['ship_to'], editable: true })
    const btn = make()
    btn?.focus()
    await click(btn ?? undefined)
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await flush()
    expect(document.querySelector('[data-field-context-menu]')).toBeNull()
    expect(writes()).toHaveLength(0)
    expect(document.activeElement).toBe(btn)
    expect(btn?.getAttribute('aria-expanded')).toBe('false')
  })
  it('a second click on the button closes the confirm', async () => {
    await mount({ field: 'ship_to', draft: FULL, allowed: ['ship_to'], editable: true })
    const btn = make() ?? undefined
    await act(async () => {
      btn?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      btn?.click()
    })
    await flush()
    expect(document.querySelector('[data-personal-default-confirm]')).not.toBeNull()
    await act(async () => {
      btn?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      btn?.click()
    })
    expect(document.querySelector('[data-field-context-menu]')).toBeNull()
  })
  it('with the ⋯ menu open, Make default switches it to the confirm', async () => {
    await open({ field: 'ship_to', draft: FULL, allowed: ['ship_to'], editable: true })
    expect(items()).toContain('Save as my default')
    const btn = make() ?? undefined
    await act(async () => {
      btn?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      btn?.click()
    })
    await flush()
    expect(document.querySelector('[data-personal-default-confirm]')).not.toBeNull()
    expect(btn?.getAttribute('aria-expanded')).toBe('true')
  })
  it('Saving… while the write runs; the server message on refusal', async () => {
    failWith = 'That field cannot carry a default'
    await mount({ field: 'ship_to', draft: FULL, allowed: ['ship_to'], editable: true })
    await click(make() ?? undefined)
    const save = button('Save')
    await act(async () => save?.click())
    expect(save?.textContent).toBe('Saving…')
    await flush()
    expect(toastMock.error).toHaveBeenCalledWith('That field cannot carry a default')
    expect(make()).not.toBeNull()
  })
  it('inside a modal sheet the confirm portals into the hosting [role=dialog]', async () => {
    await mount({
      field: 'ship_to',
      draft: FULL,
      allowed: ['ship_to'],
      editable: true,
      inDialog: true
    })
    await click(make() ?? undefined)
    const panel = document.querySelector<HTMLElement>('[data-field-context-menu]')
    expect(panel?.parentElement).toBe(host.querySelector('[data-testid=sheet]'))
  })
  it('Clear on Your default deletes it, toasts with Undo, and offers Make default again', async () => {
    saved = [row]
    await mount({ field: 'ship_to', draft: FULL, allowed: ['ship_to'], editable: true })
    await click(host.querySelector<HTMLElement>('[data-personal-default-clear]') ?? undefined)
    expect(writes().map((r) => [r._method, r._path])).toEqual([
      ['DELETE', '/field-defaults/mine/7']
    ])
    const [text, opts] = toastMock.success.mock.calls[0] as [
      string,
      { action: { label: string; onClick: () => void } }
    ]
    expect(text).toBe('Your default was cleared')
    expect(opts.action.label).toBe('Undo')
    expect(make()).not.toBeNull()
    await act(async () => opts.action.onClick())
    await flush()
    expect(writes().find((r) => r._method === 'PUT')?._body).toEqual({
      collection: 'orders',
      field: 'ship_to',
      value: 100,
      context: { zone: 2, region: 10 }
    })
    expect(make()).toBeNull()
  })
})

describe('Update default / Clear default (the visible control)', () => {
  const row: SavedDefault = {
    id: 7,
    field: 'ship_to',
    value: 101,
    context: { zone: 2, region: 10 },
    updated_at: '2026-10-20'
  }
  const update = () => host.querySelector<HTMLButtonElement>('[data-personal-default-update]')
  const clear = () => host.querySelector<HTMLButtonElement>('[data-personal-default-clear]')

  it('a saved default with another value: Update default and Clear default, both visible', async () => {
    saved = [row]
    await mount({ field: 'ship_to', draft: FULL, allowed: ['ship_to'], editable: true })
    expect(update()?.textContent).toBe('Update default')
    expect(update()?.getAttribute('aria-haspopup')).toBe('dialog')
    expect(clear()?.textContent).toBe('Clear default')
    expect(host.querySelector('[data-personal-default-make]')).toBeNull()
  })
  it('Update asks inline, then replaces that default in place (PUT, same context)', async () => {
    saved = [row]
    await mount({
      field: 'ship_to',
      draft: FULL,
      allowed: ['ship_to', 'region', 'zone'],
      editable: true
    })
    await click(update() ?? undefined)
    expect(writes()).toHaveLength(0)
    const panel = document.querySelector('[data-field-context-menu]')
    expect(panel?.getAttribute('aria-label')).toBe('Update my default')
    expect(document.querySelector('[data-personal-default-confirm] p')?.textContent).toBe(
      'Update your default for Zone 2 · Boston to Cambridge?'
    )
    expect(update()?.getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(button('Update'))
    await click(button('Update'))
    // One write: the same slot (its context), the new value. Parents are not re-saved.
    expect(writes().map((r) => [r._method, r._body])).toEqual([
      [
        'PUT',
        { collection: 'orders', field: 'ship_to', value: 100, context: { zone: 2, region: 10 } }
      ]
    ])
    expect(toastMock.success).toHaveBeenCalledWith(
      'Updated your default for Zone 2 · Boston to Cambridge'
    )
    expect(update()).toBeNull()
    expect(host.querySelector('[data-personal-default-saved]')).not.toBeNull()
  })
  it('Update shows the server message when refused', async () => {
    saved = [row]
    failWith = 'Cambridge is not available to you'
    await mount({ field: 'ship_to', draft: FULL, allowed: ['ship_to'], editable: true })
    await click(update() ?? undefined)
    await click(button('Update'))
    expect(toastMock.error).toHaveBeenCalledWith('Cambridge is not available to you')
  })
  it('Clear default from Update state deletes it (DELETE) and offers Make default', async () => {
    saved = [row]
    await mount({ field: 'ship_to', draft: FULL, allowed: ['ship_to'], editable: true })
    await click(clear() ?? undefined)
    expect(writes().map((r) => [r._method, r._path])).toEqual([
      ['DELETE', '/field-defaults/mine/7']
    ])
    expect(toastMock.success.mock.calls[0]?.[0]).toBe('Your default was cleared')
    expect(host.querySelector('[data-personal-default-make]')).not.toBeNull()
  })
  it('a saved default and an empty field: Your default + Clear default, no Update', async () => {
    saved = [row]
    await mount({
      field: 'ship_to',
      draft: { zone: 2, region: 10 },
      allowed: ['ship_to'],
      editable: true
    })
    expect(host.querySelector('[data-personal-default-saved]')?.textContent).toContain(
      'Your default'
    )
    expect(update()).toBeNull()
    expect(clear()?.getAttribute('aria-label')).toBe('Clear your saved default for Ship to')
    await click(clear() ?? undefined)
    expect(writes().map((r) => r._method)).toEqual(['DELETE'])
    expect(host.querySelector('[data-personal-default-slot] button')).toBeNull()
  })
  it('every action is a real button with a data-tip and no title', async () => {
    saved = [row]
    await mount({ field: 'ship_to', draft: FULL, allowed: ['ship_to'], editable: true })
    const btns = [
      ...host.querySelectorAll<HTMLButtonElement>('[data-personal-default-slot] button')
    ]
    expect(btns.length).toBe(2)
    for (const b of btns) {
      expect(b.type).toBe('button')
      expect(b.getAttribute('data-tip')).toBeTruthy()
      expect(b.hasAttribute('title')).toBe(false)
      // 20px box, 24px hit area.
      expect(b.className.split(/\s+/)).toEqual(
        expect.arrayContaining(['relative', 'h-5', 'before:-inset-y-0.5'])
      )
    }
  })
})

describe('responsive: compact steps, touch targets, the confirm on a phone', () => {
  const row: SavedDefault = {
    id: 7,
    field: 'ship_to',
    value: 100,
    context: { zone: 2, region: 10 },
    updated_at: '2026-10-20'
  }
  it('the width steps follow the field (container query on the label row), injected once', async () => {
    saved = [row]
    await mount({ field: 'ship_to', draft: FULL, allowed: ['ship_to'], editable: true })
    const styles = document.querySelectorAll('#nvr-personal-default-css')
    expect(styles).toHaveLength(1)
    expect(PERSONAL_DEFAULT_CSS).toContain('[data-pd-row]{container-type:inline-size')
    expect(PERSONAL_DEFAULT_CSS).toMatch(/@container nvrpd \(max-width: 319px\)/)
    expect(PERSONAL_DEFAULT_CSS).toMatch(/@container nvrpd \(max-width: 191px\)/)
    // Touch: 20px + 16 up + 8 down = 44px tall hit area.
    expect(PERSONAL_DEFAULT_CSS).toContain(
      '@media (hover: none) and (pointer: coarse){\n[data-pd-row] [data-pd-action]::before{top:-16px;bottom:-8px}'
    )
  })
  it('when words fold to icons nothing loses its name: icon twins, aria-labels, sr-only status', async () => {
    saved = [row]
    await mount({ field: 'ship_to', draft: FULL, allowed: ['ship_to'], editable: true })
    const slot = host.querySelector('[data-personal-default-slot]')
    for (const b of slot?.querySelectorAll<HTMLButtonElement>('button') ?? []) {
      expect(b.getAttribute('aria-label')).toBeTruthy()
      expect(b.getAttribute('data-tip')).toBeTruthy()
      expect(b.hasAttribute('data-pd-action')).toBe(true)
      // A folding word always has an icon left to show.
      if (b.querySelector('[data-pd-label]'))
        expect(b.querySelector('svg:not([data-pd-icon]), [data-pd-icon]')).not.toBeNull()
    }
    const status = slot?.querySelector('[data-personal-default-saved]')
    expect(status?.querySelector('.sr-only')?.textContent).toBe('Your default')
    expect(status?.querySelector('[data-pd-label]')?.getAttribute('aria-hidden')).toBe('true')
    expect(status?.getAttribute('data-tip')).toBeTruthy()
  })
  it('on a narrow screen the confirm is never wider than the screen less 16px', async () => {
    const was = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 200 })
    try {
      await mount({ field: 'ship_to', draft: FULL, allowed: ['ship_to'], editable: true })
      await click(host.querySelector<HTMLElement>('[data-personal-default-make]') ?? undefined)
      const panel = document.querySelector<HTMLElement>('[data-field-context-menu]')
      expect(panel?.style.width).toBe('184px')
      expect(panel?.style.maxWidth).toBe('calc(100vw - 16px)')
      expect(Number.parseFloat(panel?.style.left ?? '0')).toBeGreaterThanOrEqual(8)
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: was })
    }
  })
  it('a long value wraps anywhere, clamps at 4 lines and keeps the whole line on a tip', async () => {
    await mount({ field: 'ship_to', draft: FULL, allowed: ['ship_to'], editable: true })
    await click(host.querySelector<HTMLElement>('[data-personal-default-make]') ?? undefined)
    const p = document.querySelector<HTMLElement>('[data-personal-default-confirm] p')
    expect(p?.className).toContain('line-clamp-4')
    expect(p?.className).toContain('[overflow-wrap:anywhere]')
  })
})

describe('Make default fix round 1', () => {
  const row: SavedDefault = {
    id: 7,
    field: 'ship_to',
    value: 101,
    context: { zone: 2, region: 10 },
    updated_at: '2026-10-20'
  }
  const q = (sel: string) => host.querySelector<HTMLElement>(sel)
  const iconOf = (el: HTMLElement | null) => el?.querySelector('svg')?.getAttribute('class') ?? ''

  it('Make, Update and the status each have their own icon', async () => {
    await mount({ field: 'ship_to', draft: FULL, allowed: ['ship_to'], editable: true })
    expect(iconOf(q('[data-personal-default-make]'))).toContain('lucide-user-round-plus')
    act(() => root.unmount())
    root = createRoot(host)
    saved = [row]
    await mount({ field: 'ship_to', draft: FULL, allowed: ['ship_to'], editable: true })
    expect(iconOf(q('[data-personal-default-update]'))).toContain('lucide-user-round-pen')
    act(() => root.unmount())
    root = createRoot(host)
    saved = [row]
    await mount({
      field: 'ship_to',
      draft: { zone: 2, region: 10 },
      allowed: ['ship_to'],
      editable: true
    })
    const status = iconOf(q('[data-personal-default-saved]'))
    expect(status).toMatch(/lucide-user-round(?!-)/)
    expect(status).not.toMatch(/plus|pen/)
  })

  it('Make, Update and Clear default are not tab stops (⋯ is the keyboard way in)', async () => {
    await mount({ field: 'ship_to', draft: FULL, allowed: ['ship_to'], editable: true })
    expect(q('[data-personal-default-make]')?.tabIndex).toBe(-1)
    act(() => root.unmount())
    root = createRoot(host)
    saved = [row]
    await mount({ field: 'ship_to', draft: FULL, allowed: ['ship_to'], editable: true })
    expect(q('[data-personal-default-update]')?.tabIndex).toBe(-1)
    expect(q('[data-personal-default-clear]')?.tabIndex).toBe(-1)
    expect(q('[data-personal-default-update]')?.getAttribute('aria-label')).toBeTruthy()
  })

  it('the ⋯ menu says what the control says: Update my default replaces that default', async () => {
    saved = [row]
    await open({ field: 'ship_to', draft: FULL, allowed: ['ship_to'], editable: true })
    expect(items()).toContain('Update my default')
    expect(items()).not.toContain('Save as my default')
    expect(items()).toContain('Clear my default')
    await click(item('Update my default'))
    expect(document.querySelector('[data-personal-default-confirm] p')?.textContent).toBe(
      'Update your default for Zone 2 · Boston to Cambridge?'
    )
    await click(button('Update'))
    expect(writes().map((r) => [r._method, r._body])).toEqual([
      [
        'PUT',
        { collection: 'orders', field: 'ship_to', value: 100, context: { zone: 2, region: 10 } }
      ]
    ])
  })

  it('the value IS the default: the menu offers only Clear my default', async () => {
    saved = [{ ...row, value: 100 }]
    await open({ field: 'ship_to', draft: FULL, allowed: ['ship_to'], editable: true })
    expect(items()).toContain('Clear my default')
    expect(items()).not.toContain('Save as my default')
    expect(items()).not.toContain('Update my default')
  })

  it('a failed read: Make default on a value, and no empty reserved box on an empty field', async () => {
    getFails = true
    await mount({ field: 'ship_to', draft: FULL, allowed: ['ship_to'], editable: true })
    expect(q('[data-personal-default-make]')).not.toBeNull()
    act(() => root.unmount())
    root = createRoot(host)
    await mount({ field: 'ship_to', draft: { zone: 2 }, allowed: ['ship_to'], editable: true })
    expect(q('[data-personal-default-slot]')).toBeNull()
  })

  it('touch sizes and reserves are owned rules a host class cannot beat; the menu injects them too', async () => {
    expect(PERSONAL_DEFAULT_CSS).toContain(
      '[data-personal-default-confirm] button{height:2.75rem;padding-inline:.875rem}'
    )
    expect(PERSONAL_DEFAULT_CSS).toContain('button[data-field-menu-trigger]{opacity:1}')
    expect(PERSONAL_DEFAULT_CSS).toContain(
      '[data-personal-default-slot][data-pd-new]{min-width:16rem}'
    )
    await mount({ field: 'ship_to', draft: FULL, allowed: ['ship_to'], editable: true })
    expect(q('[data-personal-default-slot]')?.hasAttribute('data-pd-new')).toBe(true)
    document.getElementById('nvr-personal-default-css')?.remove()
    await act(async () => {
      host
        .querySelector('[data-testid=row]')
        ?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    })
    expect(document.getElementById('nvr-personal-default-css')).not.toBeNull()
  })
})

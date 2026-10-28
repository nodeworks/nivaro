// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../context'
import type { SavedDefault } from '../../lib/personal-defaults'
import { useFieldContextMenu } from './FieldAffordances'
import type { CascadeRule } from './helpers'
import type { CMSField } from './types'
import { PersonalDefaultsContext, usePersonalDefaults } from './usePersonalDefaults'

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
  const { onContextMenu, menu, openFrom, hasFieldItems } = useFieldContextMenu({
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

async function open(props: React.ComponentProps<typeof Harness>) {
  const client = {
    request: vi.fn(async (cmd: Req) => {
      requests.push(cmd)
      const m = cmd._method ?? 'GET'
      if (m === 'GET') return { data: saved }
      if (failWith)
        throw Object.assign(new Error('boom'), { response: { data: { error: failWith } } })
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

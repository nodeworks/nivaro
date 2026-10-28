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

function Harness({
  field,
  draft,
  allowed,
  editable
}: {
  field: string
  draft: Record<string, unknown>
  allowed: string[]
  editable: boolean
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
    valueLabel: (_f, v) => LABELS[String(v)] ?? String(v)
  })
  return (
    <PersonalDefaultsContext.Provider value={pd.context}>
      <Row field={field} draft={draft} editable={editable} />
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
  const { onContextMenu, menu } = useFieldContextMenu({
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
    expect(puts.map((r) => r._body?.field)).toEqual(['zone', 'ship_to'])
    expect(puts[1]._body).toMatchObject({
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
    expect(group?.getAttribute('role')).toBe('group')
    expect(group?.getAttribute('aria-label')).toBeTruthy()
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

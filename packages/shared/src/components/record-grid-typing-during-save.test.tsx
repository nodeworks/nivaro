// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../context'
import { MatrixEditor } from './MatrixEditor'
import { RecordGridEditor } from './RecordGridEditor'
import { settleDraftAfterSave, settleEditsAfterSave } from './record-grid-guard'

// B5 review (realtime gaps R1/E11): a cell typed while a multi-row save was in flight was wiped
// when the save finished — the grids kept only the conflicting rows' drafts.

vi.mock('./item-edit/RelationCombobox', () => ({
  RelationCombobox: ({
    collection,
    onChange
  }: {
    collection: string
    onChange: (v: unknown) => void
  }) => (
    <button type='button' data-pick={collection} onClick={() => onChange(2026)}>
      pick
    </button>
  )
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Cmd = { _method: string; _path: string; _params?: Record<string, unknown>; _body?: unknown }

let root: Root | null = null
let host: HTMLDivElement | null = null
afterEach(() => {
  if (root) act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
})

/** A client whose first PATCH waits until released. */
function holdingClient(items: Record<string, Array<Record<string, unknown>>>) {
  const calls: Cmd[] = []
  let release: () => void = () => {}
  let held = false
  const request = vi.fn(async (cmd: Cmd) => {
    calls.push(cmd)
    if (cmd._path === '/revisions/latest') return { data: {} }
    if (cmd._method === 'PATCH' || cmd._method === 'POST') {
      if (!held) {
        held = true
        await new Promise<void>((r) => {
          release = r
        })
      }
      return { data: {} }
    }
    const m = /^\/items\/([^/]+)$/.exec(cmd._path)
    if (cmd._method === 'GET' && m) return { data: items[m[1]] ?? [] }
    return { data: null }
  })
  return { client: { request } as never, calls, release: () => release() }
}

function mount(node: React.ReactNode, client: never) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  act(() =>
    root?.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client}>{node}</NivaroProvider>
      </QueryClientProvider>
    )
  )
}

const wait = async (ok: () => boolean) => {
  for (let i = 0; i < 100 && !ok(); i++) await act(() => new Promise((r) => setTimeout(r, 15)))
}
const typeInto = (el: HTMLInputElement, value: string) =>
  act(() => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    set?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
const button = (text: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as
    | HTMLButtonElement
    | undefined
const inputs = () => [...document.querySelectorAll('input')] as HTMLInputElement[]

describe('settle helpers', () => {
  it('clear only the cells whose sent value is still in the draft', () => {
    expect(
      settleDraftAfterSave(
        { r1: { a: '5', b: '9' }, r2: { a: '7' }, r3: { a: '1' } },
        { r1: { a: '5' }, r2: { a: '6' }, r3: { a: '0' } },
        new Set(['r3'])
      )
    ).toEqual({ r1: { b: '9' }, r2: { a: '7' }, r3: { a: '1' } })
    expect(settleEditsAfterSave({ x: '5', y: '3', z: '1' }, { x: '5', y: '2' }, new Set())).toEqual(
      { y: '3', z: '1' }
    )
  })
})

describe('typing while a save is in flight survives the save', () => {
  it('FlatGrid', async () => {
    const { client, calls, release } = holdingClient({ fc: [{ id: 1, a: 1, b: 2 }] })
    mount(
      <RecordGridEditor config={{ collection: 'fc', columns: [{ field: 'a' }, { field: 'b' }] }} />,
      client
    )
    await wait(() => inputs().length >= 2)
    const [a, b] = inputs()
    await typeInto(a, '5')
    await act(async () => button('Save changes')?.click())
    await wait(() => calls.some((c) => c._method === 'PATCH'))
    await typeInto(b, '9') // typed while the PATCH is out
    await act(async () => release())
    await wait(() => !!document.body.textContent?.includes('Saved'))
    expect(inputs()[1].value).toBe('9')
    expect(calls.find((c) => c._method === 'PATCH')?._body).toEqual({ a: 5 })
  })

  it('BrowseGrid', async () => {
    const { client, calls, release } = holdingClient({
      fc: [{ id: 1, year: 2026, january: 1, february: 2 }]
    })
    mount(
      <RecordGridEditor
        config={{
          collection: 'fc',
          browse: true,
          key_columns: [{ field: 'year', collection: 'years' }],
          month_sets: [{ suffix: '', label: '' }]
        }}
      />,
      client
    )
    await wait(() => !!document.querySelector('[data-pick="years"]'))
    await act(async () =>
      (document.querySelector('[data-pick="years"]') as HTMLButtonElement).click()
    )
    await wait(() => inputs().length >= 2)
    const [jan, feb] = inputs()
    await typeInto(jan, '5')
    await act(async () => button('Save changes')?.click())
    await wait(() => calls.some((c) => c._method === 'PATCH'))
    await typeInto(feb, '9')
    await act(async () => release())
    await wait(() => !!document.body.textContent?.includes('Saved'))
    act(() => inputs()[1].focus())
    expect(inputs()[1].value).toBe('9')
  })

  it('MatrixEditor', async () => {
    const { client, calls, release } = holdingClient({
      opts: [
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B' }
      ],
      alloc: [
        { id: 10, project: 1, category: 'a', amount: 5 },
        { id: 11, project: 1, category: 'b', amount: 7 }
      ],
      projects: [{ id: 1, name: 'P1' }]
    })
    mount(
      <MatrixEditor
        config={{
          target_collection: 'alloc',
          option_collection: 'opts',
          key_field: 'category',
          value_field: 'amount',
          scope_fields: [{ field: 'project', collection: 'projects' }]
        }}
        initialScope={{ project: 1 }}
        lockScope
      />,
      client
    )
    await wait(() => inputs().length >= 2)
    const [ia, ib] = inputs()
    await typeInto(ia, '50')
    await act(async () => button('Save changes')?.click())
    await wait(() => calls.some((c) => c._method === 'PATCH'))
    await typeInto(ib, '70')
    await act(async () => release())
    await wait(() => !!document.body.textContent?.includes('Saved'))
    expect(inputs()[1].value).toBe('70')
    expect(inputs()[0].value).toBe('')
  })
})

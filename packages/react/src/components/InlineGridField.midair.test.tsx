// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Army 4 H4/M1 (twin of @nivaro/shared line-midair): a staged line edit's
// PATCH carries the line's revision from the READ that showed it.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Cmd = { _method: string; _path: string; _params?: Record<string, unknown>; _body?: unknown }
const s = vi.hoisted(() => ({
  calls: [] as Cmd[],
  latest: {} as Record<string, number | null>,
  patchError: null as unknown,
  flush: null as null | (() => Promise<void>)
}))
const client = {
  request: vi.fn(async (cmd: Cmd) => {
    s.calls.push(cmd)
    if (cmd._path === '/field-config/lines')
      return {
        data: [{ field: 'note', label: 'Note', type: 'string', interface: null, note: null }]
      }
    if (cmd._path === '/items/lines' && cmd._method === 'GET')
      return { data: [{ id: 7, note: 'a', workflow: 1 }] }
    if (cmd._path === '/revisions/latest') {
      const ids = String(cmd._params?.items).split(',')
      return {
        data: Object.fromEntries(ids.filter((i) => i in s.latest).map((i) => [i, s.latest[i]]))
      }
    }
    if (cmd._method === 'PATCH' && s.patchError) throw s.patchError
    return { data: {} }
  })
}
vi.mock('../context', () => ({
  useOptionalNivaroClient: () => client,
  useGridFlush: () => ({
    register: (_k: string, fn: () => Promise<void>) => {
      s.flush = fn
    },
    unregister: () => {}
  })
}))

import { InlineGridField } from './InlineGridField'

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  s.calls = []
  s.latest = { '7': 40 }
  s.patchError = null
  s.flush = null
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const field = {
  field: 'lines',
  label: 'Lines',
  relation: { relatedCollection: 'lines', manyField: 'workflow' }
} as never

const settle = async () => {
  for (let i = 0; i < 5; i++) await act(async () => {})
}

async function editNote(value: string) {
  const input = host.querySelector('input[data-nf-grid-cell]') as HTMLInputElement
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  set?.call(input, value)
  await act(async () => {
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('InlineGridField line base revision', () => {
  it('sends the base taken when the rows were read', async () => {
    act(() => root.render(<InlineGridField field={field} itemId={1} />))
    await settle()
    // Someone else saves after the read: the base must stay the read's.
    s.latest['7'] = 41
    await editNote('b')
    await settle()
    await act(async () => {
      await s.flush?.()
    })
    const p = s.calls.find((c) => c._method === 'PATCH')
    expect(p?._body).toEqual({ note: 'b', _base_revision: 40 })
  })

  it('a base the read missed is fetched before the write', async () => {
    s.latest = {}
    act(() => root.render(<InlineGridField field={field} itemId={1} />))
    await settle()
    s.latest['7'] = 55
    await editNote('c')
    await settle()
    await act(async () => {
      await s.flush?.()
    })
    const p = s.calls.find((c) => c._method === 'PATCH')
    expect(p?._body).toEqual({ note: 'c', _base_revision: 55 })
  })

  it('a 409 fails the save loudly and re-reads the rows', async () => {
    act(() => root.render(<InlineGridField field={field} itemId={1} />))
    await settle()
    await editNote('d')
    await settle()
    s.patchError = { response: { status: 409, data: { code: 'MIDAIR_COLLISION' } } }
    const reads = s.calls.filter((c) => c._path === '/items/lines' && c._method === 'GET').length
    let thrown: unknown = null
    await act(async () => {
      await s.flush?.().catch((e) => {
        thrown = e
      })
    })
    expect(thrown).toBe(s.patchError)
    expect(s.calls.filter((c) => c._path === '/items/lines' && c._method === 'GET').length).toBe(
      reads + 1
    )
  })
})

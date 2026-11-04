// @vitest-environment jsdom
import type { NivaroClient } from '@nivaro/sdk'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../context'
import {
  TransitionRequirementsDialog,
  type TransitionRequirementsPayload
} from './TransitionRequirementsDialog'

// The requirements dialog's saves name the move they are for, so a record
// locked against edits still takes the values its own move asks for (the
// server checks the move, api services/requirement-writes.ts).

type Cmd = { _method: string; _path: string; _headers?: Record<string, string> }

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.replaceChildren()
})

const payload: TransitionRequirementsPayload = [
  {
    type: 'child_fields',
    collection: 'lines',
    fk_field: 'parent',
    title: 'Req IDs',
    fields: [{ field: 'req_no', label: 'Req ID', type: 'string' }],
    display_fields: [],
    rows: [{ id: 7, label: 'Line 1', complete: false, values: { req_no: null }, display: {} }],
    prefill_values: { req_no: 'R-100' }
  }
]

async function submit(transitionId?: string) {
  const calls: Cmd[] = []
  const client = {
    url: '',
    getToken: () => null,
    request: vi.fn(async (cmd: Cmd) => {
      calls.push(cmd)
      return { data: {} }
    })
  } as unknown as NivaroClient
  const onSubmitted = vi.fn()
  act(() =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <NivaroProvider client={client}>
          <TransitionRequirementsDialog
            payload={payload}
            transitionId={transitionId}
            onSubmitted={onSubmitted}
            onClose={() => undefined}
          />
        </NivaroProvider>
      </QueryClientProvider>
    )
  )
  const button = [...document.querySelectorAll('button')].find(
    (b) => b.textContent === 'Submit'
  ) as HTMLButtonElement
  await act(async () => {
    button.click()
  })
  expect(onSubmitted).toHaveBeenCalled()
  return calls.filter((c) => c._method === 'PATCH')
}

describe('TransitionRequirementsDialog saves', () => {
  it("send the move's id with each value saved", async () => {
    const patches = await submit('T-FUSION')
    expect(patches).toHaveLength(1)
    expect(patches[0]._path).toBe('/items/lines/7')
    expect(patches[0]._headers).toEqual({ 'x-nivaro-requirements-for': 'T-FUSION' })
  })

  it('send no header when the host names no move', async () => {
    const patches = await submit()
    expect(patches).toHaveLength(1)
    expect(patches[0]._headers).toBeUndefined()
  })
})

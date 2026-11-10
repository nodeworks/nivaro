// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../context'
import { BulkRestrictedScopes, pickBulkDimension } from './BulkRestrictedScopes'

// Rob 2026-11-10: bulk add / remove people's restricted zones — pick, Preview
// (nothing saved), Apply.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Cmd = { _method: string; _path: string; _body?: Record<string, unknown> }

const DIMS = [
  {
    id: 2,
    name: 'region',
    label: 'Region',
    target_collection: 'regions',
    display_field: 'short_name'
  },
  {
    id: 1,
    name: 'division',
    label: 'Zone',
    target_collection: 'divisions',
    display_field: 'short_name'
  }
]
const ZONES = [
  { id: 2, short_name: 'Zone 1' },
  { id: 3, short_name: 'Zone 2' }
]

let root: Root
let host: HTMLDivElement
let calls: Cmd[] = []
const onDone = vi.fn()

function answer(preview: boolean) {
  return {
    data: {
      preview,
      label: 'Zone',
      op: 'add',
      rows: [
        {
          user_id: 'u1',
          name: 'Pat Lee',
          before_labels: ['Zone 1'],
          after_labels: ['Zone 1', 'Zone 2'],
          status: 'change'
        },
        {
          user_id: 'u2',
          name: 'Sam Fox',
          before_labels: [],
          after_labels: [],
          status: 'unchanged',
          reason: 'No zone restriction — already sees every zone'
        }
      ],
      counts: { change: 1, unchanged: 1, refused: 0, not_found: 0, failed: 0 }
    }
  }
}

async function settle(until?: () => boolean) {
  for (let i = 0; i < 60; i++) {
    await act(async () => await new Promise((r) => setTimeout(r, 5)))
    if (until?.()) return
  }
}

beforeEach(async () => {
  calls = []
  onDone.mockClear()
  const client = {
    request: vi.fn(async (cmd: Cmd) => {
      calls.push(cmd)
      if (cmd._path === '/scope-dimensions') return { data: DIMS }
      if (cmd._path.startsWith('/items/divisions')) return { data: ZONES }
      if (cmd._path === '/user-scopes/bulk') return answer(cmd._body?.preview === true)
      throw new Error(`unexpected ${cmd._path}`)
    })
  }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <NivaroProvider client={client as never}>
          <BulkRestrictedScopes userIds={['u1', 'u2']} onDone={onDone} />
        </NivaroProvider>
      </QueryClientProvider>
    )
  })
  await settle(() => host.textContent?.includes('Zone 2') ?? false)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const click = async (el: Element | null | undefined) => {
  expect(el).toBeTruthy()
  await act(async () => (el as HTMLElement).click())
}
const button = (text: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith(text))

describe('BulkRestrictedScopes', () => {
  it('defaults to the zone dimension', () => {
    expect(pickBulkDimension(DIMS as never)?.name).toBe('division')
    expect(host.textContent).toContain('Restricted zones · 2 people')
  })

  it('Preview saves nothing; Apply sends the same change for real', async () => {
    expect((host.querySelector('[data-bulk-scope-preview]') as HTMLButtonElement).disabled).toBe(
      true
    )
    await click(button('Zone 2'))
    await click(host.querySelector('[data-bulk-scope-preview]'))
    await settle(() => !!host.querySelector('[data-bulk-scope-row]'))
    const bulk = calls.filter((c) => c._path === '/user-scopes/bulk')
    expect(bulk).toHaveLength(1)
    expect(bulk[0]._body).toMatchObject({
      user_ids: ['u1', 'u2'],
      dimension: 'division',
      op: 'add',
      values: [3],
      preview: true,
      allow_empty: false
    })
    expect(host.querySelector('[data-bulk-scope-row="change"]')?.textContent).toContain(
      'Zone 1, Zone 2'
    )
    expect(host.querySelector('[data-bulk-scope-row="unchanged"]')?.textContent).toContain(
      'already sees every zone'
    )
    const apply = host.querySelector('[data-bulk-scope-apply]') as HTMLButtonElement
    expect(apply.textContent).toContain('Apply to 1 person')
    await click(apply)
    await settle(() => onDone.mock.calls.length > 0)
    const real = calls.filter((c) => c._path === '/user-scopes/bulk')[1]
    expect(real._body).toMatchObject({ preview: false, values: [3], op: 'add' })
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('changing the pick or the action drops a stale preview', async () => {
    await click(button('Zone 2'))
    await click(host.querySelector('[data-bulk-scope-preview]'))
    await settle(() => !!host.querySelector('[data-bulk-scope-row]'))
    await click(button('Remove'))
    expect(host.querySelector('[data-bulk-scope-row]')).toBeNull()
    expect((host.querySelector('[data-bulk-scope-apply]') as HTMLButtonElement).disabled).toBe(true)
  })
})

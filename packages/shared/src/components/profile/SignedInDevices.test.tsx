// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../context'
import { SignedInDevices } from './SignedInDevices'

// Profile → Signed-in phones: every phone signed in to a Nivaro app (GET /auth/devices, or
// /users/:id/devices on an admin's view of someone else), the calling phone marked, and a
// two-step Sign out per row that ends that phone's sign-in and drops the row.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Cmd = { _method: string; _path: string }

const PHONES = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    client_name: 'Nivaro',
    device_name: 'Rob’s iPhone',
    platform: 'ios',
    created_at: '2026-10-30T15:00:00.000Z',
    last_used_at: '2026-11-01T14:00:00.000Z',
    current: true
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    client_name: 'Nivaro',
    device_name: null,
    platform: 'android',
    created_at: '2026-10-20T15:00:00.000Z',
    last_used_at: null,
    current: false
  }
]

let root: Root
let host: HTMLDivElement
let calls: Cmd[] = []
let phones: typeof PHONES = PHONES
let failDelete = false

async function settle(until?: () => boolean) {
  for (let i = 0; i < 60; i++) {
    await act(async () => await new Promise((r) => setTimeout(r, 5)))
    if (until?.()) return
  }
}

async function mount(userId?: string) {
  const client = {
    request: vi.fn(async (cmd: Cmd) => {
      calls.push(cmd)
      if (cmd._method === 'DELETE') {
        if (failDelete) {
          throw Object.assign(new Error('Request failed with status code 503'), {
            status: 503,
            response: {
              status: 503,
              data: { error: 'Could not sign that phone out. Try again.' }
            }
          })
        }
        return { ok: true }
      }
      return { data: phones }
    })
  }
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client as never}>
          <SignedInDevices userId={userId} />
        </NivaroProvider>
      </QueryClientProvider>
    )
  })
  await settle(
    () => !!host.querySelector('[data-device-row]') || !!host.querySelector('[data-devices-empty]')
  )
  return client
}

const rowEl = (id: string) => host.querySelector<HTMLElement>(`[data-device-row="${id}"]`)
const click = async (el: Element | null | undefined) => {
  expect(el).toBeTruthy()
  await act(async () => (el as HTMLElement).click())
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  calls = []
  phones = PHONES
  failDelete = false
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('SignedInDevices', () => {
  it('lists the caller own phones and marks the one making the call', async () => {
    await mount()
    expect(calls[0]).toMatchObject({ _method: 'GET', _path: '/auth/devices' })
    expect(host.querySelectorAll('[data-device-row]')).toHaveLength(2)
    const current = rowEl(PHONES[0].id)
    expect(current?.querySelector('[data-device-name]')?.textContent).toBe('Rob’s iPhone')
    expect(current?.querySelector('[data-device-current]')?.textContent).toBe('This phone')
    // No device name: the platform names it, never an id.
    const other = rowEl(PHONES[1].id)
    expect(other?.querySelector('[data-device-name]')?.textContent).toBe('Android phone')
    expect(other?.querySelector('[data-device-current]')).toBeNull()
    expect(host.textContent).not.toContain(PHONES[1].id)
  })

  it('offers no Sign out on the phone making the call: the app signs itself out', async () => {
    await mount()
    const current = rowEl(PHONES[0].id)
    expect(current?.querySelector('[data-device-sign-out]')).toBeNull()
    expect(current?.querySelector('button')).toBeNull()
    expect(current?.querySelector('[data-device-sign-out-in-app]')?.textContent).toBe(
      'Sign out from the app'
    )
    expect(rowEl(PHONES[1].id)?.querySelector('[data-device-sign-out] button')).toBeTruthy()
  })

  it('signs a phone out after the second press and drops its row', async () => {
    await mount()
    const button = rowEl(PHONES[1].id)?.querySelector('[data-device-sign-out] button')
    await click(button)
    // First press only arms it.
    expect(calls.some((c) => c._method === 'DELETE')).toBe(false)
    await click(button)
    await settle(() => !rowEl(PHONES[1].id))
    expect(calls).toContainEqual(
      expect.objectContaining({ _method: 'DELETE', _path: `/auth/devices/${PHONES[1].id}` })
    )
    expect(rowEl(PHONES[1].id)).toBeNull()
    expect(rowEl(PHONES[0].id)).toBeTruthy()
  })

  it('keeps the row when the sign-out fails', async () => {
    failDelete = true
    await mount()
    const button = rowEl(PHONES[1].id)?.querySelector('[data-device-sign-out] button')
    await click(button)
    await click(button)
    await settle()
    expect(rowEl(PHONES[1].id)).toBeTruthy()
  })

  it('reads and signs out another person phones on the admin routes', async () => {
    const userId = '33333333-3333-4333-8333-333333333333'
    await mount(userId)
    expect(calls[0]).toMatchObject({ _method: 'GET', _path: `/users/${userId}/devices` })
    const button = rowEl(PHONES[1].id)?.querySelector('[data-device-sign-out] button')
    await click(button)
    await click(button)
    await settle(() => !rowEl(PHONES[1].id))
    expect(calls).toContainEqual(
      expect.objectContaining({
        _method: 'DELETE',
        _path: `/users/${userId}/devices/${PHONES[1].id}`
      })
    )
  })

  it('says so when no phone is signed in', async () => {
    phones = []
    await mount()
    expect(host.querySelector('[data-devices-empty]')?.textContent).toContain('No phones signed in')
  })
})

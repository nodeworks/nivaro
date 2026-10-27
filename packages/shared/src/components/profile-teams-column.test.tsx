// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../context'
import { DeliveryChips } from './notifications/DeliveryChips'
import { NotificationRulesCard } from './ProfileView'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Cmd = { _method: string; _path: string; _body?: any }

let root: Root
let host: HTMLDivElement
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

async function settle(until: () => boolean) {
  for (let i = 0; i < 80 && !until(); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
  }
}

async function mount(me: Record<string, unknown>, failDelete = false) {
  const calls: Cmd[] = []
  const client = {
    request: vi.fn(async (cmd: Cmd) => {
      calls.push(cmd)
      if (failDelete && cmd._method === 'DELETE') throw new Error('nope')
      if (cmd._method === 'GET' && cmd._path === '/users/me') return { data: me }
      return { data: cmd._method === 'GET' ? [] : {} }
    })
  }
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client as never}>
          <NotificationRulesCard />
        </NivaroProvider>
      </QueryClientProvider>
    )
  })
  await settle(() => !!host.querySelector('table'))
  return calls
}

const boxes = () =>
  Array.from(host.querySelectorAll<HTMLInputElement>('input[data-notify-channel$=":teams"]'))

describe('Profile → Teams column', () => {
  it('no Teams column when the bot is off', async () => {
    await mount({ preferences: {}, teams_available: false, teams_link: null })
    expect(host.querySelector('[data-teams-column]')).toBeNull()
    expect(boxes()).toHaveLength(0)
  })

  it('toggles disabled until connected, with a Connect Teams button', async () => {
    await mount({ preferences: {}, teams_available: true, teams_link: null })
    await settle(() => !!host.querySelector('[data-teams-column]'))
    expect(host.querySelector('[data-teams-connect]')?.textContent).toBe('Connect Teams')
    expect(boxes().length).toBeGreaterThan(0)
    expect(boxes().every((b) => b.disabled)).toBe(true)
  })

  it('toggle writes matrix[cat].teams', async () => {
    const calls = await mount({
      preferences: { notification_prefs: { teams_muted_until: '2099-01-01T00:00:00Z' } },
      teams_available: true,
      teams_link: { status: 'active', linked_at: '2026-10-27T12:00:00Z' }
    })
    await settle(() => boxes().length > 0)
    expect(host.textContent).toContain('Connected')
    const box = boxes()[0]
    expect(box.disabled).toBe(false)
    expect(box.checked).toBe(false)
    const cat = (box.dataset.notifyChannel as string).split(':')[0]
    await act(async () => box.click())
    await settle(() => calls.some((c) => c._method === 'PATCH'))
    const patchCall = calls.find(
      (c) => c._method === 'PATCH' && c._path === '/users/me/preferences'
    )
    expect(patchCall?._body.notification_prefs.matrix[cat].teams).toBe(true)
    // a save must not wipe a mute set from the bot
    expect(patchCall?._body.notification_prefs.teams_muted_until).toBe('2099-01-01T00:00:00Z')
  })
})

describe('Teams disconnect', () => {
  it('a failed disconnect shows an error', async () => {
    const calls = await mount(
      { preferences: {}, teams_available: true, teams_link: { status: 'active', linked_at: null } },
      true
    )
    await settle(() => !!host.querySelector('[data-teams-connected] button'))
    const btn = () => host.querySelector('[data-teams-connected] button') as HTMLButtonElement
    await act(async () => btn().click())
    await act(async () => btn().click())
    await settle(() => !!host.querySelector('[data-teams-disconnect-error]'))
    expect(calls.some((c) => c._method === 'DELETE')).toBe(true)
    expect(host.querySelector('[data-teams-disconnect-error]')?.textContent).toContain(
      'Could not disconnect Teams'
    )
  })
})

describe('Delivery chips → Teams', () => {
  it('renders a Teams chip with the server status', async () => {
    await act(async () =>
      root.render(
        <DeliveryChips
          delivery={{ inapp: { status: 'delivered' }, teams: { status: 'not_connected' } }}
        />
      )
    )
    expect(host.textContent).toContain('Teams · not connected')
    await act(async () =>
      root.render(
        <DeliveryChips delivery={{ inapp: { status: 'delivered' }, teams: { status: 'sent' } }} />
      )
    )
    expect(host.textContent).toContain('Teams')
    expect(host.textContent).not.toContain('Teams ·')
  })
})

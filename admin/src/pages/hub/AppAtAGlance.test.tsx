import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { AppShortcuts } from './AppAtAGlance'
import type { HubAppFull, HubEnvironment } from './hub-api'

const env = (id: number, key: string, position: number) =>
  ({ id, app_id: 4, key, position, status: 'ok' }) as HubEnvironment
const app = { id: 4, key: 'orders', name: 'Orders portal' } as HubAppFull

function mount(envs: HubEnvironment[], admin = true) {
  return render(
    <MemoryRouter>
      <QueryClientProvider client={new QueryClient()}>
        <AppShortcuts app={app} envs={envs} isAdmin={admin} />
      </QueryClientProvider>
    </MemoryRouter>
  )
}

describe('AppShortcuts', () => {
  it('every link opens its page on this app: none promises the app and opens unfiltered', () => {
    mount([env(10, 'staging', 1), env(11, 'production', 2)])
    const nav = screen.getByRole('navigation', { name: 'More about Orders portal' })
    const hrefs = Object.fromEntries(
      [...nav.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href')])
    )
    expect(hrefs).toEqual({
      Releases: '/hub/releases?app=4',
      'Smoke checks': '/hub/smoke?env=11',
      'Config promotion': '/hub/config?app=4',
      'Versions and uptime': '/hub/fleet?app=4',
      Health: '/hub/health?app=4',
      Issues: '/hub/issues?app=4',
      Incidents: '/hub/incidents?app=4',
      // Per-environment pages open on the last environment of the chain.
      Backups: '/hub/data?env=11',
      Usage: '/hub/usage?env=11',
      Costs: '/hub/costs?app=4',
      'On-call': '/hub/on-call?app=4'
    })
    for (const href of Object.values(hrefs)) expect(href).toMatch(/\?(app=4|env=11)$/)
  })

  it('an owner is not linked to pages only administrators can use', () => {
    mount([env(10, 'staging', 1), env(11, 'production', 2)], false)
    const nav = screen.getByRole('navigation', { name: 'More about Orders portal' })
    const labels = [...nav.querySelectorAll('a')].map((a) => a.textContent)
    expect(labels).not.toContain('Config promotion')
    expect(labels).not.toContain('Backups')
    expect(labels).toEqual(
      expect.arrayContaining(['Releases', 'Smoke checks', 'Health', 'Issues', 'Usage', 'Costs'])
    )
  })
})

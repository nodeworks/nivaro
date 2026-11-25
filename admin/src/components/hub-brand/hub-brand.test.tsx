// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyHubProduct } from '@/lib/hub-product'
import { trackLabel } from '@/pages/hub/HubPromotePanel'
import { envTone, isProductionEnv } from './env-tone'
import { HubEnvTag, HubStatusDot, ProductionGuard } from './HubBits'
import { envAbbrev, groupByApp, healthOf } from './HubFleetStrip'
import { HubRunTimeline, type RunStep } from './HubRunTimeline'
import { systemItems } from './HubTopBar'
import { routeExists, sectionActive, visibleSections } from './hub-sections'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

function render(node: ReactNode) {
  act(() => {
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>{node}</MemoryRouter>
      </QueryClientProvider>
    )
  })
  return host
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  act(() => applyHubProduct(false))
})

const STEPS: RunStep[] = [
  { key: 'plan', label: 'Plan', state: 'done' },
  { key: 'deploy', label: 'Deploy', state: 'running' },
  { key: 'check', label: 'Check', state: 'pending' }
]

describe('Hub-only pieces render nothing without hub_only', () => {
  it('env tag, production guard, run timeline: invisible on a regular install', () => {
    const el = render(
      <>
        <HubEnvTag envKey='production' />
        <ProductionGuard envKey='production' what='promotion'>
          <p id='inside'>panel</p>
        </ProductionGuard>
        <HubRunTimeline steps={STEPS} live />
      </>
    )
    expect(el.querySelector('[data-env-chip]')).toBeNull()
    expect(el.querySelector('[data-prod-guard]')).toBeNull()
    expect(el.querySelector('[data-hub-run-timeline]')).toBeNull()
    // The guarded panel itself still renders, unwrapped.
    expect(el.querySelector('#inside')?.parentElement).toBe(el)
  })

  it('…and appear once the standalone Hub look is on', () => {
    act(() => applyHubProduct(true))
    const el = render(
      <>
        <HubEnvTag envKey='prod-eu' />
        <ProductionGuard envKey='production' what='promotion'>
          <p id='inside'>panel</p>
        </ProductionGuard>
        <ProductionGuard envKey='staging'>
          <p id='staging-inside'>panel</p>
        </ProductionGuard>
        <HubRunTimeline steps={STEPS} live what='Promotion' />
      </>
    )
    expect(el.querySelector('[data-env-chip="production"]')?.textContent).toBe('Prod')
    expect(el.querySelector('[data-prod-guard] #inside')).not.toBeNull()
    // Only production gets the frame.
    expect(el.querySelector('#staging-inside')?.closest('[data-prod-guard]')).toBeNull()
    const tl = el.querySelector('[data-hub-run-timeline]')
    expect(tl?.getAttribute('aria-label')).toBe('Promotion: step 2 of 3, Deploy — running')
    expect(tl?.querySelector('[data-hub-live]')).not.toBeNull()
  })

  it('a status dot always renders (it is only placed in Hub-only components)', () => {
    const el = render(<HubStatusDot health='down' />)
    expect(el.querySelector('[data-hub-health="down"]')).not.toBeNull()
  })
})

describe('environment colours (one helper)', () => {
  it('reads the tone from the environment key, whole words only', () => {
    expect(envTone('production')).toBe('production')
    expect(envTone('prod-eu')).toBe('production')
    expect(envTone('Live')).toBe('production')
    expect(envTone('products')).toBe('other')
    expect(envTone('pre-prod')).toBe('staging')
    expect(envTone('staging')).toBe('staging')
    expect(envTone('uat')).toBe('staging')
    expect(envTone('dev')).toBe('development')
    expect(envTone('test')).toBe('development')
    expect(envTone('training')).toBe('other')
    expect(envTone(null)).toBe('other')
    expect(isProductionEnv('PRD')).toBe(true)
    expect(isProductionEnv('staging')).toBe(false)
  })
})

describe('run timeline labels', () => {
  it('names each promotion step briefly', () => {
    expect(trackLabel({ key: 'push-1', phase: 'push', component: 'api', label: '' })).toBe(
      'Merge api'
    )
    expect(
      trackLabel({ key: 'deploy-1', phase: 'deploy', component: 'web', label: '' }, true)
    ).toBe('Redeploy web')
    expect(trackLabel({ key: 'verify', phase: 'verify', component: null, label: '' })).toBe('Check')
  })
})

describe('top bar sections and fleet strip', () => {
  it('hides a section whose route this build does not have', () => {
    const paths = new Set(['/hub', '/hub/shared'])
    expect(visibleSections(paths).map((s) => s.label)).toEqual(['Apps', 'Shared', 'Settings'])
    expect(routeExists('/hub/fleet', paths)).toBe(false)
    expect(routeExists('/settings', paths)).toBe(true)
  })

  it('Apps lights up on its own tabs, Shared on its own', () => {
    const [apps] = visibleSections(new Set(['/hub']))
    expect(sectionActive(apps, '/hub')).toBe(true)
    expect(sectionActive(apps, '/hub/drivers')).toBe(true)
    expect(sectionActive(apps, '/hub/shared')).toBe(false)
  })

  it('System lists the other pages once, never a Hub page or a section', () => {
    const Icon = () => null
    const items = [
      { icon: Icon, label: 'Overview', to: '/' },
      { icon: Icon, label: 'Apps', to: '/hub' },
      { icon: Icon, label: 'Users', to: '/users' },
      { icon: Icon, label: 'Settings', to: '/settings' },
      { icon: Icon, label: 'Users', to: '/users' }
    ]
    expect(systemItems(items, visibleSections(new Set(['/hub']))).map((i) => i.to)).toEqual([
      '/',
      '/users'
    ])
  })

  it('groups the strip by app and maps state to health', () => {
    const e = (id: number, app: number, key: string, state: 'ok' | 'unreachable') => ({
      env_id: id,
      env_key: key,
      app_id: app,
      app_key: `a${app}`,
      app_name: `A${app}`,
      state,
      version: null,
      checked_at: null
    })
    const g = groupByApp([
      e(1, 1, 'production', 'ok'),
      e(2, 1, 'staging', 'ok'),
      e(3, 2, 'dev', 'unreachable')
    ])
    expect(g.map((x) => [x.app_key, x.envs.length])).toEqual([
      ['a1', 2],
      ['a2', 1]
    ])
    expect(healthOf('ok')).toBe('ok')
    expect(healthOf('link_refused')).toBe('warn')
    expect(healthOf('unreachable')).toBe('down')
    expect(healthOf('unknown')).toBe('unknown')
    expect(envAbbrev('production')).toBe('prd')
    expect(envAbbrev('staging')).toBe('stg')
    expect(envAbbrev('qa-east')).toBe('qae')
  })
})

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
import { activeSection, sectionAllowed, visibleSections } from './hub-sections'
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
    // The guarded panel itself still renders, in a plain wrapper with no class or style.
    const wrap = el.querySelector('#inside')?.parentElement as HTMLElement
    expect(wrap.getAttribute('class')).toBeNull()
    expect(wrap.getAttribute('style')).toBeNull()
    expect(wrap.hasAttribute('data-prod-guard')).toBe(false)
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
  const admin = {
    permitted: new Set(['/', '/hub', '/users', '/settings']),
    disabled: new Set<string>()
  }

  it('shows the Apps hub groups as the sections, each opening on its first page', () => {
    const sections = visibleSections(admin)
    expect(sections.map((s) => s.label)).toEqual([
      'Apps',
      'Deploys',
      'Hosting',
      'Databases',
      'Domains',
      'Messaging',
      'Monitoring',
      'Costs',
      'Access'
    ])
    expect(sections.find((s) => s.key === 'domains')).toMatchObject({
      title: 'Domains, DNS and certificates',
      to: '/hub/domains'
    })
    expect(sections.find((s) => s.key === 'hosting')?.pages.map((p) => p.label)).toEqual([
      'Hosts & regions',
      'Deploy locations',
      'Shared deployments',
      'Capacity',
      'Scaling',
      'Storage',
      'Cloud accounts'
    ])
  })

  it('follows the role like the sidebar did: a non-admin owner sees only what they may open', () => {
    // Their role's ui_permissions hide every Hosting page but Storage, and all of Access.
    const owner = {
      permitted: new Set(['/', '/hub']),
      disabled: new Set([
        '/hub/hosts',
        '/hub/drivers',
        '/hub/shared',
        '/hub/capacity',
        '/hub/scale',
        '/hub/cloud',
        '/hub/people',
        '/hub/signin',
        '/hub/access',
        '/hub/secrets',
        '/hub/connections',
        '/hub/audit'
      ])
    }
    const sections = visibleSections(owner)
    expect(sections.some((s) => s.key === 'access')).toBe(false)
    // A section links to the first page they may open, and lists only those.
    expect(sections.find((s) => s.key === 'hosting')).toMatchObject({
      to: '/hub/storage',
      pages: [{ label: 'Storage', to: '/hub/storage' }]
    })
    expect(sectionAllowed('/settings', owner)).toBe(false)
    expect(sectionAllowed('/hub/shared', owner)).toBe(false)
    expect(sectionAllowed('/hub/storage', owner)).toBe(true)
    // Without the Apps entry in their nav, no Hub section shows at all.
    const none = { permitted: new Set(['/']), disabled: new Set<string>() }
    expect(visibleSections(none)).toEqual([])
  })

  it('an app owner is offered no admin-only page, and no home that holds nothing else', () => {
    const owner = { ...admin, admin: false }
    const sections = visibleSections(owner)
    const pages = (key: string) => sections.find((s) => s.key === key)?.pages.map((p) => p.label)
    expect(pages('apps')).toEqual([
      'Apps',
      'Usage',
      'Dependencies',
      'App services',
      'Clone & retire'
    ])
    expect(pages('deploys')).toEqual([
      'Releases',
      'Change calendar',
      'Smoke checks',
      'Extensions',
      'Code & pipelines'
    ])
    // Hosting keeps what an owner can read; it opens on the first of those.
    expect(sections.find((s) => s.key === 'hosting')).toMatchObject({
      to: '/hub/storage',
      pages: [
        expect.objectContaining({ label: 'Storage' }),
        expect.objectContaining({ label: 'Cloud accounts' })
      ]
    })
    expect(pages('databases')).toEqual(['Databases'])
    expect(pages('access')).toEqual(['Sign-in', 'Access reviews'])
    const all = sections.flatMap((s) => s.pages.map((p) => p.to))
    for (const to of [
      '/hub/templates',
      '/hub/targets',
      '/hub/config',
      '/hub/hosts',
      '/hub/drivers',
      '/hub/shared',
      '/hub/capacity',
      '/hub/scale',
      '/hub/data',
      '/hub/people',
      '/hub/secrets',
      '/hub/connections',
      '/hub/audit'
    ]) {
      expect(all, to).not.toContain(to)
      expect(sectionAllowed(to, owner), to).toBe(false)
    }
    // An administrator, and a person the app does not know yet, see the whole map.
    expect(visibleSections({ ...admin, admin: true })).toEqual(visibleSections(admin))
  })

  it('lights the section a page lives in, and none on a System page', () => {
    const sections = visibleSections(admin)
    expect(activeSection(sections, '/hub')?.label).toBe('Apps')
    expect(activeSection(sections, '/hub/drivers')?.label).toBe('Hosting')
    expect(activeSection(sections, '/hub/shared')?.label).toBe('Hosting')
    expect(activeSection(sections, '/hub/domains')?.label).toBe('Domains')
    expect(activeSection(sections, '/hub/connections')?.label).toBe('Access')
    expect(activeSection(sections, '/users')).toBeNull()
  })

  it('System lists the other pages once, never a Hub page', () => {
    const Icon = () => null
    const items = [
      { icon: Icon, label: 'Overview', to: '/' },
      { icon: Icon, label: 'Apps', to: '/hub' },
      { icon: Icon, label: 'Users', to: '/users' },
      { icon: Icon, label: 'Settings', to: '/settings' },
      { icon: Icon, label: 'Users', to: '/users' }
    ]
    expect(systemItems(items).map((i) => i.to)).toEqual(['/', '/users', '/settings'])
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

import { describe, expect, it } from 'vitest'
import {
  ACTIVITY_HUB,
  APPS_HUB,
  AUTOMATIONS_HUB,
  allowedHubTabs,
  DATA_INTEGRITY_HUB,
  HUB_PATHS,
  HUB_REDIRECTS,
  HUBS,
  hubForPath,
  hubPageForEveryone,
  hubSearchPages,
  hubTabGroup,
  isPathDisabled
} from './hubs'

describe('hub registry', () => {
  it('finds the hub tab for a path, and nothing for a detail route', () => {
    expect(hubForPath('/flows/rules')?.tab.label).toBe('Rules')
    expect(hubForPath('/flows')?.tab.label).toBe('Flows')
    expect(hubForPath('/flows/rules/')?.tab.label).toBe('Rules')
    expect(hubForPath('/flows/123')).toBeNull()
    expect(hubForPath('/activity/42')).toBeNull()
  })

  it('groups the Apps hub pages into homes named for what they hold, every page in exactly one', () => {
    // The homes share their names with the provider groups (api providers/categories.ts), so an
    // outside account or resource shows beside the Hub's own things of the same kind.
    expect(APPS_HUB.groups?.map((g) => [g.label, g.tabs])).toEqual([
      ['Apps', ['', 'usage', 'dependencies', 'services', 'templates', 'targets', 'lifecycle']],
      ['Deploys', ['releases', 'changes', 'smoke', 'extensions', 'config', 'code']],
      ['Hosting', ['hosts', 'drivers', 'shared', 'capacity', 'scale', 'storage', 'cloud']],
      ['Databases', ['databases', 'data']],
      ['Domains', ['domains']],
      ['Messaging', ['messaging', 'on-call']],
      ['Monitoring', ['fleet', 'health', 'issues', 'incidents', 'status', 'security', 'ask']],
      ['Costs', ['costs']],
      ['Access', ['people', 'signin', 'access', 'secrets', 'connections', 'audit']]
    ])
    const grouped = APPS_HUB.groups?.flatMap((g) => g.tabs) ?? []
    expect(grouped).toEqual(APPS_HUB.tabs.map((t) => t.path))
    expect(new Set(grouped).size).toBe(grouped.length)
    // No home holds more than seven pages: one strip always reads.
    expect(Math.max(...(APPS_HUB.groups ?? []).map((g) => g.tabs.length))).toBeLessThanOrEqual(7)
    expect(hubTabGroup(APPS_HUB, 'smoke')?.label).toBe('Deploys')
    expect(hubTabGroup(APPS_HUB, 'domains')?.title).toBe('Domains, DNS and certificates')
    expect(hubTabGroup(APPS_HUB, 'nope')).toBeNull()
    // Every other hub keeps its one strip.
    expect(HUBS.filter((h) => h.groups).map((h) => h.base)).toEqual(['/hub'])
    // Every page is described and searchable by more than its own name.
    for (const t of APPS_HUB.tabs) {
      expect(t.hint, t.path).toBeTruthy()
      expect(t.keywords, t.path).toBeTruthy()
    }
  })

  it('never moved a Hub page off its path: old links and ui_permissions keys still hold', () => {
    // Every path the Hub answered on before the 2026-11-27 navigation redesign.
    const before = [
      '',
      'releases',
      'changes',
      'smoke',
      'extensions',
      'config',
      'shared',
      'capacity',
      'scale',
      'hosts',
      'drivers',
      'connections',
      'databases',
      'data',
      'storage',
      'fleet',
      'health',
      'usage',
      'dependencies',
      'issues',
      'incidents',
      'on-call',
      'status',
      'people',
      'signin',
      'access',
      'security',
      'secrets',
      'audit',
      'targets',
      'templates',
      'lifecycle',
      'costs',
      'ask'
    ]
    for (const p of before) {
      const path = p ? `/hub/${p}` : '/hub'
      expect(hubForPath(path)?.hub, path).toBe(APPS_HUB)
      // Its own path is its permission key: a role that hid it still hides it.
      expect(isPathDisabled(path, new Set([path])), path).toBe(true)
    }
    // Shared infra merged into Outside accounts: the old path redirects there.
    const map = Object.fromEntries(HUB_REDIRECTS.map((r) => [r.from, r.to]))
    expect(map['/hub/shared-infra']).toBe('/hub/connections')
    expect(HUB_PATHS.has('/hub/shared-infra')).toBe(false)
  })

  it('marks the pages only administrators can use, and leaves them out of an owner\u2019s search', () => {
    expect(APPS_HUB.tabs.filter((t) => t.adminOnly).map((t) => t.path)).toEqual([
      'templates',
      'targets',
      'config',
      'hosts',
      'drivers',
      'shared',
      'capacity',
      'scale',
      'data',
      'people',
      'secrets',
      'connections',
      'audit'
    ])
    expect(hubPageForEveryone('/hub/databases')).toBe(true)
    expect(hubPageForEveryone('/hub/data')).toBe(false)
    expect(hubPageForEveryone('/users')).toBe(true)
    const owner = hubSearchPages(APPS_HUB, { admin: false }).map((p) => p.path)
    expect(owner).toContain('/hub/domains')
    expect(owner).not.toContain('/hub/connections')
    expect(hubSearchPages(APPS_HUB, { admin: true })).toHaveLength(APPS_HUB.tabs.length)
    expect(hubSearchPages(APPS_HUB)).toHaveLength(APPS_HUB.tabs.length)
  })

  it('finds Hub pages by what they hold, not only by their name', () => {
    const pages = hubSearchPages(APPS_HUB)
    const find = (q: string) =>
      pages.filter((p) => `${p.label} ${p.keywords}`.toLowerCase().includes(q)).map((p) => p.path)
    expect(find('dns')).toContain('/hub/domains')
    expect(find('certificate')).toContain('/hub/domains')
    expect(find('postgres')).toContain('/hub/databases')
    expect(find('slack')).toContain('/hub/messaging')
    expect(find('github')).toContain('/hub/code')
    expect(find('auth0')).toContain('/hub/signin')
    expect(find('sentry')).toContain('/hub/security')
    expect(find('budget')).toContain('/hub/costs')
    expect(find('aws')).toContain('/hub/cloud')
    expect(pages.find((p) => p.path === '/hub/domains')?.label).toBe(
      'Domains & certificates · Domains, DNS and certificates'
    )
  })

  it('has unique tab paths across every hub', () => {
    const all = HUBS.flatMap((h) => h.tabs.map((t) => (t.path ? `${h.base}/${t.path}` : h.base)))
    expect(new Set(all).size).toBe(all.length)
    expect(HUB_PATHS.size).toBe(all.length)
  })

  it('redirects old paths onto their tab, except one that is itself a hub path now', () => {
    const map = Object.fromEntries(HUB_REDIRECTS.map((r) => [r.from, r.to]))
    expect(map['/rules']).toBe('/flows/rules')
    expect(map['/field-watches']).toBe('/alerts/watches')
    expect(map['/background-jobs']).toBe('/jobs')
    // /reports was the audit report; it is the Reports hub now, so it is not redirected.
    expect(map['/reports']).toBeUndefined()
    expect(HUB_REDIRECTS.every((r) => !HUB_PATHS.has(r.from))).toBe(true)
  })

  it('judges a hub tab by its old path, so one tab can be hidden alone', () => {
    const disabled = new Set(['/rules'])
    expect(isPathDisabled('/flows/rules', disabled)).toBe(true)
    expect(isPathDisabled('/flows', disabled)).toBe(false)
    expect(allowedHubTabs(AUTOMATIONS_HUB, disabled).map((t) => t.label)).toEqual([
      'Flows',
      'Tests',
      'Dead letters'
    ])
  })

  it('no longer lets a hub base hide the other tabs, but still hides its detail routes', () => {
    const disabled = new Set(['/flows'])
    expect(isPathDisabled('/flows', disabled)).toBe(true)
    expect(isPathDisabled('/flows/rules', disabled)).toBe(false)
    expect(isPathDisabled('/flows/123', disabled)).toBe(true)
  })

  it('keeps the audit report behind the old /reports key', () => {
    const disabled = new Set(['/reports'])
    expect(isPathDisabled('/activity/audit', disabled)).toBe(true)
    expect(isPathDisabled('/reports', disabled)).toBe(false)
    expect(allowedHubTabs(ACTIVITY_HUB, disabled).some((t) => t.path === 'audit')).toBe(false)
  })

  it('keeps every Data Integrity tab behind the old page path', () => {
    expect(hubForPath('/data-integrity/orphans')?.tab.label).toBe('Orphans')
    expect(hubForPath('/data-integrity')?.tab.label).toBe('Form conformance')
    // A role that hid the old page still has the whole hub hidden.
    expect(allowedHubTabs(DATA_INTEGRITY_HUB, new Set(['/data-integrity']))).toEqual([])
    expect(isPathDisabled('/data-integrity/orphans', new Set(['/data-integrity']))).toBe(true)
  })
})

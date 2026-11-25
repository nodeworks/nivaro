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

  it('groups the Apps hub tabs into seven sections, every tab in exactly one', () => {
    // 36 tabs in one strip did not read (design pass 2): the strip shows the groups, then the
    // open group's tabs. The tab list itself follows the group order.
    expect(APPS_HUB.groups?.map((g) => [g.label, g.tabs])).toEqual([
      ['Apps', ['']],
      ['Deploy', ['releases', 'changes', 'smoke', 'extensions', 'config']],
      ['Run', ['shared', 'capacity', 'scale', 'hosts', 'drivers']],
      ['Data', ['databases', 'data', 'storage']],
      [
        'Watch',
        ['fleet', 'health', 'usage', 'dependencies', 'issues', 'incidents', 'on-call', 'status']
      ],
      ['People & access', ['people', 'signin', 'access', 'security', 'secrets', 'audit']],
      ['Build', ['targets', 'templates', 'lifecycle', 'costs', 'ask']]
    ])
    const grouped = APPS_HUB.groups?.flatMap((g) => g.tabs) ?? []
    expect(grouped).toEqual(APPS_HUB.tabs.map((t) => t.path))
    expect(new Set(grouped).size).toBe(grouped.length)
    expect(hubTabGroup(APPS_HUB, 'smoke')?.label).toBe('Deploy')
    expect(hubTabGroup(APPS_HUB, 'nope')).toBeNull()
    // The tabs the standalone Hub's top bar also links.
    expect(APPS_HUB.tabs.filter((t) => t.topBar).map((t) => t.path)).toEqual([
      'shared',
      'fleet',
      'people'
    ])
    // Every other hub keeps its one strip.
    expect(HUBS.filter((h) => h.groups).map((h) => h.base)).toEqual(['/hub'])
    expect(hubForPath('/hub/access')?.tab.label).toBe('Access')
    expect(hubForPath('/hub/security')?.tab.label).toBe('Security')
    expect(hubForPath('/hub/signin')?.tab.label).toBe('Sign-in')
    expect(hubForPath('/hub/releases')?.tab.label).toBe('Releases')
    expect(hubForPath('/hub/config')?.tab.label).toBe('Config')
    expect(hubForPath('/hub/secrets')?.tab.label).toBe('Secrets')
    expect(hubForPath('/hub/fleet')?.tab.label).toBe('Fleet')
    expect(hubForPath('/hub/audit')?.tab.label).toBe('Audit')
    expect(hubForPath('/hub/health')?.tab.label).toBe('Health')
    expect(hubForPath('/hub/ask')?.tab.label).toBe('Ask the Hub')
    expect(hubForPath('/hub/on-call')?.tab.label).toBe('On-call')
    expect(hubForPath('/hub/people')?.tab.label).toBe('People')
    expect(hubForPath('/hub/targets')?.tab.label).toBe('Targets')
    expect(hubForPath('/hub/shared')?.tab.label).toBe('Shared deployments')
    expect(hubForPath('/hub/capacity')?.tab.label).toBe('Capacity')
    expect(hubForPath('/hub/scale')?.tab.label).toBe('Scaling')
    expect(hubForPath('/hub/data')?.tab.label).toBe('Backups & data')
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

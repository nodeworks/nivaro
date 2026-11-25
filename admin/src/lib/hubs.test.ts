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

  it('gives Hub targets their own tab between Drivers and Databases (P3-29)', () => {
    // Phase 7's Sign-in tab follows them (phases 3 + 7 merged); phase 6's Shared deployments
    // comes right after Apps (Task 17), Capacity right after it (Hub capacity).
    expect(APPS_HUB.tabs.map((t) => t.label)).toEqual([
      'Apps',
      'Shared deployments',
      'Capacity',
      'Scaling',
      'Drivers',
      'Targets',
      'Templates',
      'Databases',
      'Backups & data',
      'Sign-in',
      'Releases',
      // Hub ops (enhancements 10, 20, 19) come last, then People (hub-enh/people).
      'Issues',
      'Storage',
      'Secrets',
      'Fleet',
      'Audit',
      'People'
    ])
    expect(hubForPath('/hub/signin')?.tab.label).toBe('Sign-in')
    expect(hubForPath('/hub/releases')?.tab.label).toBe('Releases')
    expect(hubForPath('/hub/secrets')?.tab.label).toBe('Secrets')
    expect(hubForPath('/hub/fleet')?.tab.label).toBe('Fleet')
    expect(hubForPath('/hub/audit')?.tab.label).toBe('Audit')
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

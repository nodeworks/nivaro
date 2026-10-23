import { describe, expect, it } from 'vitest'
import {
  ACTIVITY_HUB,
  AUTOMATIONS_HUB,
  allowedHubTabs,
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
})

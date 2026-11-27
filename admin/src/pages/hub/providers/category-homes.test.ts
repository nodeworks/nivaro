import { describe, expect, it } from 'vitest'
import { APPS_HUB, HUB_PATHS, hubTabGroup } from '@/lib/hubs'
import { CATEGORY_HOMES, categoriesAt, homeOfCategory, providerIn } from './category-homes'
import type { ProviderInfo, ProviderTypes } from './providers-api'

const provider = (key: string, category: string, types: Array<[string, string?]>): ProviderInfo =>
  ({
    key,
    label: key,
    category,
    connection: { fields: [] },
    types: types.map(([k, c]) => ({ key: k, label: k, category: c }))
  }) as never

describe('category homes', () => {
  it('gives every provider group a Hub page that exists', () => {
    for (const [key, home] of Object.entries(CATEGORY_HOMES)) {
      expect(HUB_PATHS.has(home.path), `${key} → ${home.path}`).toBe(true)
      // The home says the page's own name, so a link reads like the navigation.
      const tab = APPS_HUB.tabs.find((t) => `/hub/${t.path}` === home.path)
      expect(tab?.label, key).toBe(home.page)
    }
  })

  it('puts each kind in the section of the same name', () => {
    const section = (key: string) =>
      hubTabGroup(APPS_HUB, homeOfCategory(key).path.replace('/hub/', ''))?.key
    expect(section('code')).toBe('deploys')
    expect(section('hosting')).toBe('hosting')
    expect(section('data')).toBe('databases')
    expect(section('domains')).toBe('domains')
    expect(section('messaging')).toBe('messaging')
    expect(section('monitoring')).toBe('monitoring')
    expect(section('costs')).toBe('costs')
    expect(section('identity')).toBe('access')
  })

  it('sends a group the Hub does not know to App services', () => {
    expect(homeOfCategory('erp').path).toBe('/hub/services')
    const t = {
      risk_flags: [],
      categories: [{ key: 'ai', label: 'AI' }],
      providers: [provider('acme', 'erp', [['acme.ledger']])]
    } as unknown as ProviderTypes
    const here = categoriesAt('/hub/services', t)
    expect(here).toEqual(expect.arrayContaining(['payments', 'ai', 'media', 'other', 'erp']))
    expect(here).not.toContain('data')
  })

  it('shows a provider where its own job is, and wherever a kind of thing it holds is', () => {
    const aws = provider('aws', 'hosting', [
      ['aws.vpc', 'hosting'],
      ['aws.rds_instance', 'data'],
      ['aws.route53_zone', 'domains']
    ])
    const neon = provider('neon', 'data', [['neon.project', 'data']])
    expect(providerIn(aws, new Set(['data']))).toBe(true)
    expect(providerIn(aws, new Set(['domains']))).toBe(true)
    expect(providerIn(aws, new Set(['messaging']))).toBe(false)
    expect(providerIn(neon, new Set(['data']))).toBe(true)
    expect(providerIn(neon, new Set(['hosting']))).toBe(false)
  })
})

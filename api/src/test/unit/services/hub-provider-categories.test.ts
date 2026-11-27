import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  PROVIDER_CATEGORIES,
  providerCategoryOf,
  resourceTypeCategory
} from '../../../services/hub/providers/categories.js'
import { CORE_PROVIDERS } from '../../../services/hub/providers/index.js'

describe('provider groups', () => {
  it('places every core provider in a known group other than Other', () => {
    const known = new Set(PROVIDER_CATEGORIES.map((c) => c.key))
    const loose = CORE_PROVIDERS.map((p) => [p.key, providerCategoryOf(p)] as const).filter(
      ([, c]) => !known.has(c) || c === 'other'
    )
    expect(loose, 'add the provider to CORE_CATEGORY in providers/categories.ts').toEqual([])
  })

  it("an adapter's own group wins; a bad key falls back", () => {
    expect(providerCategoryOf({ key: 'github', category: 'ai' })).toBe('ai')
    expect(providerCategoryOf({ key: 'my-erp', category: 'erp' })).toBe('erp')
    expect(providerCategoryOf({ key: 'my-erp', category: 'Not A Key!' })).toBe('other')
    expect(providerCategoryOf({ key: 'my-erp' })).toBe('other')
  })

  it('a renamed group key still lands in its new group', () => {
    expect(providerCategoryOf({ key: 'my-chat', category: 'chat' })).toBe('messaging')
  })

  it('places a resource type by its own job, else by its provider', () => {
    expect(resourceTypeCategory('aws.rds_instance', 'hosting')).toBe('data')
    expect(resourceTypeCategory('aws.route53_record', 'hosting')).toBe('domains')
    expect(resourceTypeCategory('aws.acm_certificate', 'hosting')).toBe('domains')
    expect(resourceTypeCategory('aws.ses_identity', 'hosting')).toBe('messaging')
    expect(resourceTypeCategory('azure.sql_database', 'hosting')).toBe('data')
    expect(resourceTypeCategory('aws.budget', 'hosting')).toBe('costs')
    expect(resourceTypeCategory('aws.ec2_instance', 'hosting')).toBe('hosting')
    expect(resourceTypeCategory('cloudflare.dns_record', 'domains')).toBe('domains')
    expect(resourceTypeCategory('neon.database', 'data')).toBe('data')
  })

  it('every type placement names a known group and a real core type', () => {
    const known = new Set(PROVIDER_CATEGORIES.map((c) => c.key))
    const types = CORE_PROVIDERS.flatMap((p) => p.types.map((t) => t.key))
    for (const p of CORE_PROVIDERS)
      for (const t of p.types)
        expect(known.has(resourceTypeCategory(t.key, providerCategoryOf(p))), t.key).toBe(true)
    // Each core job the homes promise has at least one type in it.
    for (const job of ['data', 'domains', 'messaging', 'code', 'hosting', 'identity', 'costs'])
      expect(
        CORE_PROVIDERS.some((p) =>
          p.types.some((t) => resourceTypeCategory(t.key, providerCategoryOf(p)) === job)
        ),
        job
      ).toBe(true)
    expect(types.length).toBeGreaterThan(0)
  })

  it('names the admin\u2019s Hub homes with the same words (one word, one thing)', () => {
    // The Hub's navigation homes (admin lib/hubs.ts group titles) and the provider groups are
    // one vocabulary: rename a group here and the home of that kind must be renamed with it.
    const hubs = readFileSync(
      join(import.meta.dirname, '../../../../../admin/src/lib/hubs.ts'),
      'utf8'
    )
    const titles = new Set([...hubs.matchAll(/title: '([^']+)'/g)].map((m) => m[1]))
    const label = (key: string) => PROVIDER_CATEGORIES.find((c) => c.key === key)?.label
    for (const key of ['code', 'hosting', 'data', 'domains', 'messaging', 'monitoring'])
      expect(titles.has(label(key) as string), `${key}: ${label(key)}`).toBe(true)
    // Costs is a home of one page, named by its label alone.
    expect(hubs).toContain(`label: '${label('costs')}'`)
  })

  it('lists Other last', () => {
    expect(PROVIDER_CATEGORIES.at(-1)?.key).toBe('other')
  })
})

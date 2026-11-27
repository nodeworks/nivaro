/**
 * What a provider — and each kind of thing it holds — is for. ONE vocabulary for the whole Hub:
 * the provider picker groups by it, the admin's navigation homes are named by it (admin
 * pages/hub/providers/category-homes.ts maps each key to its page), and an app's outside
 * resources are grouped by it. Change a label here and it changes everywhere.
 *
 * An adapter names its own group with `ProviderAdapter.category`; core adapters that do not are
 * placed by CORE_CATEGORY below. A key not in PROVIDER_CATEGORIES (an extension's own group) is
 * kept as given and shown after the known groups; no group at all = 'other'.
 *
 * A provider that does several jobs (AWS: servers, databases, DNS, mail) is placed by its main
 * job, and each of its resource TYPES by its own (resourceTypeCategory, TYPE_CATEGORY below):
 * an RDS instance sits with Databases, a Route 53 zone with Domains, wherever the account is.
 */

export interface ProviderCategory {
  key: string
  label: string
}

/** The known groups, in the order pickers show them. */
export const PROVIDER_CATEGORIES: readonly ProviderCategory[] = Object.freeze([
  { key: 'code', label: 'Code and deploys' },
  { key: 'hosting', label: 'Hosting and servers' },
  { key: 'data', label: 'Databases and caches' },
  { key: 'domains', label: 'Domains, DNS and certificates' },
  { key: 'identity', label: 'Sign-in and identity' },
  { key: 'messaging', label: 'Messaging and alerts' },
  { key: 'monitoring', label: 'Monitoring and security' },
  { key: 'costs', label: 'Costs' },
  { key: 'payments', label: 'Payments' },
  { key: 'ai', label: 'AI' },
  { key: 'media', label: 'Calls and video' },
  { key: 'other', label: 'Other' }
])

const CORE_CATEGORY: Readonly<Record<string, string>> = Object.freeze({
  github: 'code',
  gitlab: 'code',
  dockerhub: 'code',
  expo: 'code',
  vercel: 'code',
  jira: 'code',
  aws: 'hosting',
  azure: 'hosting',
  portainer: 'hosting',
  neon: 'data',
  upstash: 'data',
  'redis-cloud': 'data',
  cloudflare: 'domains',
  namecheap: 'domains',
  acme: 'domains',
  auth0: 'identity',
  entra: 'identity',
  sendgrid: 'messaging',
  mailgun: 'messaging',
  twilio: 'messaging',
  firebase: 'messaging',
  slack: 'messaging',
  teams: 'messaging',
  pagerduty: 'messaging',
  sentry: 'monitoring',
  snyk: 'monitoring',
  stripe: 'payments',
  anthropic: 'ai',
  openai: 'ai',
  livekit: 'media'
})

const CATEGORY_KEY = /^[a-z][a-z0-9-]{1,30}$/

/** Group keys that were renamed: an adapter still naming the old one lands in the new one. */
const CATEGORY_ALIAS: Readonly<Record<string, string>> = Object.freeze({ chat: 'messaging' })

/** The group key of one adapter: its own `category`, else the core placement, else 'other'. */
export function providerCategoryOf(adapter: { key: string; category?: string }): string {
  const own = typeof adapter.category === 'string' ? adapter.category.trim().toLowerCase() : ''
  if (own && CATEGORY_KEY.test(own)) return CATEGORY_ALIAS[own] ?? own
  return CORE_CATEGORY[adapter.key] ?? 'other'
}

/**
 * Resource types whose job differs from their provider's main one. Keys are type keys; a key
 * ending in `*` matches by prefix. Everything else follows its provider.
 */
const TYPE_CATEGORY: ReadonlyArray<readonly [string, string]> = Object.freeze([
  ['aws.rds_*', 'data'],
  ['aws.route53_*', 'domains'],
  ['aws.acm_certificate', 'domains'],
  ['aws.domain', 'domains'],
  ['aws.ses_*', 'messaging'],
  ['aws.sns_*', 'messaging'],
  ['aws.ecr_*', 'code'],
  ['aws.budget', 'costs'],
  ['aws.cost_allocation_tag', 'costs'],
  ['azure.sql_*', 'data'],
  ['azure.budget', 'costs'],
  ['cloudflare.tunnel*', 'hosting'],
  ['cloudflare.access_*', 'identity'],
  ['cloudflare.r2_bucket', 'hosting'],
  ['cloudflare.worker_*', 'hosting'],
  ['cloudflare.waf_custom_rule', 'monitoring'],
  ['vercel.domain', 'domains'],
  ['portainer.registry', 'code'],
  ['anthropic.spend_limit', 'costs']
] as const)

/** The group key of one resource type: its own placement, else its provider's group. */
export function resourceTypeCategory(typeKey: string, providerCategory: string): string {
  for (const [pattern, category] of TYPE_CATEGORY) {
    if (pattern.endsWith('*') ? typeKey.startsWith(pattern.slice(0, -1)) : typeKey === pattern)
      return category
  }
  return providerCategory
}

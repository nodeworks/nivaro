/**
 * What a provider is for, so pickers can group them ("Databases and caches", "AI", …).
 *
 * An adapter names its own group with `ProviderAdapter.category`; core adapters that do not are
 * placed by CORE_CATEGORY below. A key not in PROVIDER_CATEGORIES (an extension's own group) is
 * kept as given and shown after the known groups; no group at all = 'other'.
 */

export interface ProviderCategory {
  key: string
  label: string
}

/** The known groups, in the order pickers show them. */
export const PROVIDER_CATEGORIES: readonly ProviderCategory[] = Object.freeze([
  { key: 'code', label: 'Code and builds' },
  { key: 'hosting', label: 'Cloud and hosting' },
  { key: 'data', label: 'Databases and caches' },
  { key: 'domains', label: 'Domains, DNS and certificates' },
  { key: 'identity', label: 'Sign-in and identity' },
  { key: 'messaging', label: 'Email, SMS and push' },
  { key: 'chat', label: 'Chat and work tracking' },
  { key: 'monitoring', label: 'Monitoring and security' },
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
  aws: 'hosting',
  azure: 'hosting',
  vercel: 'hosting',
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
  slack: 'chat',
  teams: 'chat',
  jira: 'chat',
  sentry: 'monitoring',
  pagerduty: 'monitoring',
  snyk: 'monitoring',
  stripe: 'payments',
  anthropic: 'ai',
  openai: 'ai',
  livekit: 'media'
})

const CATEGORY_KEY = /^[a-z][a-z0-9-]{1,30}$/

/** The group key of one adapter: its own `category`, else the core placement, else 'other'. */
export function providerCategoryOf(adapter: { key: string; category?: string }): string {
  const own = typeof adapter.category === 'string' ? adapter.category.trim().toLowerCase() : ''
  if (own && CATEGORY_KEY.test(own)) return own
  return CORE_CATEGORY[adapter.key] ?? 'other'
}

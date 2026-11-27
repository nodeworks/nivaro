import type { ProviderInfo, ProviderTypes } from './providers-api'

/**
 * Where each kind of outside thing lives in the Hub. The keys are the provider groups of
 * api services/hub/providers/categories.ts (PROVIDER_CATEGORIES); each names the Hub page that
 * is the home of that kind, beside the Hub's own things of the same kind. There is no provider
 * silo: an RDS instance is on Databases, a Route 53 zone on Domains, a Slack channel on
 * Messaging. Labels come from the API (`categories`), never from here.
 */
export interface CategoryHome {
  /** The Hub page that is home to this kind. */
  path: string
  /** The page's name, as the navigation shows it. */
  page: string
  /** The button that connects an account there ("Connect a DNS provider"). */
  connect: string
  /** What the accounts of this kind are called together. */
  accounts: string
  /** One provider of the kind, for sentences ("No DNS provider connected yet"). */
  noun: string
  /** Examples, for the empty state. */
  examples: string
}

const SERVICES: CategoryHome = {
  path: '/hub/services',
  page: 'App services',
  connect: 'Connect a service',
  accounts: 'Service accounts',
  noun: 'service',
  examples: 'Stripe, Anthropic, OpenAI or LiveKit'
}

export const CATEGORY_HOMES: Readonly<Record<string, CategoryHome>> = Object.freeze({
  code: {
    path: '/hub/code',
    page: 'Code & pipelines',
    connect: 'Connect a code host',
    accounts: 'Code hosts, registries and build services',
    noun: 'code host',
    examples: 'GitHub, GitLab, Vercel, Expo or Docker Hub'
  },
  hosting: {
    path: '/hub/cloud',
    page: 'Cloud accounts',
    connect: 'Connect a cloud account',
    accounts: 'Cloud and hosting accounts',
    noun: 'cloud account',
    examples: 'AWS, Azure or Portainer'
  },
  data: {
    path: '/hub/databases',
    page: 'Databases',
    connect: 'Connect a database provider',
    accounts: 'Database and cache providers',
    noun: 'database provider',
    examples: 'Neon, AWS (RDS), Azure (Azure SQL), Upstash or Redis Cloud'
  },
  domains: {
    path: '/hub/domains',
    page: 'Domains & certificates',
    connect: 'Connect a DNS provider',
    accounts: 'Registrars, DNS and certificate providers',
    noun: 'DNS provider',
    examples: 'Cloudflare, AWS (Route 53), Namecheap or Let’s Encrypt'
  },
  identity: {
    path: '/hub/signin',
    page: 'Sign-in',
    connect: 'Connect an identity provider',
    accounts: 'Identity providers',
    noun: 'identity provider',
    examples: 'Microsoft Entra ID or Auth0'
  },
  messaging: {
    path: '/hub/messaging',
    page: 'Channels & routes',
    connect: 'Connect a messaging service',
    accounts: 'Chat, email, SMS and paging services',
    noun: 'messaging service',
    examples: 'Slack, Teams, PagerDuty, SendGrid or Twilio'
  },
  monitoring: {
    path: '/hub/security',
    page: 'Security',
    connect: 'Connect a monitoring service',
    accounts: 'Error tracking and code scanning',
    noun: 'monitoring service',
    examples: 'Sentry or Snyk'
  },
  costs: {
    path: '/hub/costs',
    page: 'Costs',
    connect: 'Connect a cloud account',
    accounts: 'Accounts with budgets',
    noun: 'account',
    examples: 'AWS or Azure'
  },
  payments: SERVICES,
  ai: SERVICES,
  media: SERVICES,
  other: SERVICES
})

/** The home of a group key; a group the Hub does not know (an extension's own) = App services. */
export const homeOfCategory = (key: string): CategoryHome => CATEGORY_HOMES[key] ?? SERVICES

/** Every group key whose home is `path` (App services: payments, AI, media, other and unknown). */
export function categoriesAt(path: string, t: ProviderTypes | undefined): string[] {
  const keys = new Set<string>(Object.keys(CATEGORY_HOMES))
  for (const c of t?.categories ?? []) keys.add(c.key)
  for (const p of t?.providers ?? []) {
    keys.add(p.category || 'other')
    for (const ty of p.types) if (ty.category) keys.add(ty.category)
  }
  return [...keys].filter((k) => homeOfCategory(k).path === path)
}

/**
 * Does this provider belong in a home of these groups? Yes when its own group is one of them, or
 * when it holds a kind of thing that is (AWS on Databases: it holds RDS).
 */
export function providerIn(p: ProviderInfo, groups: ReadonlySet<string>): boolean {
  if (groups.has(p.category || 'other')) return true
  return p.types.some((t) => groups.has(t.category ?? p.category ?? 'other'))
}

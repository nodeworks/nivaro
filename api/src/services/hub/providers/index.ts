import { auth0Provider } from './auth0/index.js'
import { awsProvider } from './aws/adapter.js'
import { cloudflareProvider } from './cloudflare/index.js'
import { dockerhubAdapter } from './dockerhub/index.js'
import { entraAdapter } from './entra/index.js'
import { expoAdapter } from './expo/index.js'
import { githubAdapter } from './github/index.js'
import { gitlabAdapter } from './gitlab/index.js'
import { neonAdapter } from './neon/index.js'
import { redisCloudAdapter } from './redis-cloud/index.js'
import { getProvider, registerProvider } from './registry.js'
import { sentryAdapter } from './sentry/index.js'
import { slackAdapter } from './slack/index.js'
import type { ProviderAdapter } from './types.js'
import { upstashAdapter } from './upstash/index.js'
import { vercelAdapter } from './vercel/index.js'

/**
 * Hub third-party providers: the framework's entry point. Core adapters are listed in
 * CORE_PROVIDERS (each adapter task appends ONE line: its import above and its entry below);
 * `ensureCoreProviders()` registers any that are not registered yet (Hub boot, and tests after
 * `resetProvidersForTest()`).
 */

export const CORE_PROVIDERS: ProviderAdapter[] = [
  // github, aws, vercel, auth0, expo adapters are appended here.
  auth0Provider,
  awsProvider,
  cloudflareProvider,
  dockerhubAdapter,
  entraAdapter,
  expoAdapter,
  githubAdapter,
  sentryAdapter,
  slackAdapter,
  redisCloudAdapter,
  upstashAdapter,
  neonAdapter,
  gitlabAdapter,
  vercelAdapter
]

/** Registers every core adapter that is not registered yet. Safe to call more than once. */
export function ensureCoreProviders(): void {
  for (const adapter of CORE_PROVIDERS) if (!getProvider(adapter.key)) registerProvider(adapter)
}

export * from './context.js'
export * from './provider-fetch.js'
export * from './registry.js'
export * from './types.js'

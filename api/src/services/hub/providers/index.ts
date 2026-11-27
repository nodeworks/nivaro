import { acmeAdapter } from './acme/index.js'
import { anthropicAdapter } from './anthropic/index.js'
import { auth0Provider } from './auth0/index.js'
import { awsProvider } from './aws/adapter.js'
import { cloudflareProvider } from './cloudflare/index.js'
import { dockerhubAdapter } from './dockerhub/index.js'
import { entraAdapter } from './entra/index.js'
import { expoAdapter } from './expo/index.js'
import { firebaseAdapter } from './firebase/index.js'
import { githubAdapter } from './github/index.js'
import { gitlabAdapter } from './gitlab/index.js'
import { jiraAdapter } from './jira/index.js'
import { livekitAdapter } from './livekit/index.js'
import { mailgunAdapter } from './mailgun/index.js'
import { neonAdapter } from './neon/index.js'
import { openaiAdapter } from './openai/index.js'
import { pagerdutyAdapter } from './pagerduty/index.js'
import { portainerAdapter } from './portainer/index.js'
import { redisCloudAdapter } from './redis-cloud/index.js'
import { getProvider, registerProvider } from './registry.js'
import { sendgridAdapter } from './sendgrid/index.js'
import { sentryAdapter } from './sentry/index.js'
import { slackAdapter } from './slack/index.js'
import { snykAdapter } from './snyk/index.js'
import { stripeAdapter } from './stripe/index.js'
import { teamsAdapter } from './teams/index.js'
import { twilioAdapter } from './twilio/index.js'
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
  acmeAdapter,
  anthropicAdapter,
  auth0Provider,
  awsProvider,
  cloudflareProvider,
  dockerhubAdapter,
  entraAdapter,
  expoAdapter,
  githubAdapter,
  jiraAdapter,
  livekitAdapter,
  firebaseAdapter,
  mailgunAdapter,
  sendgridAdapter,
  sentryAdapter,
  snykAdapter,
  twilioAdapter,
  stripeAdapter,
  slackAdapter,
  teamsAdapter,
  redisCloudAdapter,
  upstashAdapter,
  neonAdapter,
  openaiAdapter,
  gitlabAdapter,
  pagerdutyAdapter,
  portainerAdapter,
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

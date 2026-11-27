import { awsProvider } from './aws/adapter.js'
import { getProvider, registerProvider } from './registry.js'
import type { ProviderAdapter } from './types.js'

/**
 * Hub third-party providers: the framework's entry point. Core adapters are listed in
 * CORE_PROVIDERS (each adapter task appends ONE line: its import above and its entry below);
 * `ensureCoreProviders()` registers any that are not registered yet (Hub boot, and tests after
 * `resetProvidersForTest()`).
 */

export const CORE_PROVIDERS: ProviderAdapter[] = [
  // github, aws, vercel, auth0, expo adapters are appended here.
  awsProvider
]

/** Registers every core adapter that is not registered yet. Safe to call more than once. */
export function ensureCoreProviders(): void {
  for (const adapter of CORE_PROVIDERS) if (!getProvider(adapter.key)) registerProvider(adapter)
}

export * from './context.js'
export * from './provider-fetch.js'
export * from './registry.js'
export * from './types.js'

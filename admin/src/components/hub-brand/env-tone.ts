/**
 * Environment colours of the standalone Hub — ONE helper every Hub screen uses (chips, row
 * stripes, plan headers, deploy history, the fleet strip). An environment is named by its key
 * (free text: "production", "prod", "staging", "uat", "dev"…); the tone is read from that name.
 *
 * The colours themselves live in hub-brand.css as --hub-env-<tone> (light and dark), so they
 * only exist in Hub mode: a regular install that renders `data-env-tone` sees nothing.
 */

export type EnvTone = 'production' | 'staging' | 'development' | 'other'

const PRODUCTION = /^(prod|production|prd|live|main|master)$/
const STAGING = /^(stag|stage|staging|stg|uat|preprod|qa|acceptance)$/
const DEVELOPMENT = /^(dev|devel|develop|development|test|testing|sandbox|local|preview|demo)$/

/**
 * The tone of an environment key. Whole words only: "prod-eu" is production, "products" is not,
 * "pre-prod" is staging.
 */
export function envTone(key: string | null | undefined): EnvTone {
  const words = String(key ?? '')
    .toLowerCase()
    .replace(/pre[-_ ]?prod(uction)?/g, 'preprod')
    .split(/[^a-z]+/)
    .filter(Boolean)
  if (words.some((w) => PRODUCTION.test(w))) return 'production'
  if (words.some((w) => STAGING.test(w))) return 'staging'
  if (words.some((w) => DEVELOPMENT.test(w))) return 'development'
  return 'other'
}

export const ENV_TONE_LABEL: Record<EnvTone, string> = {
  production: 'Production',
  staging: 'Staging',
  development: 'Development',
  other: 'Other'
}

/** The CSS colour of a tone (a var only defined in Hub mode; falls back to slate). */
export function envToneColor(tone: EnvTone): string {
  return `var(--hub-env-${tone}, #64748b)`
}

/** An action on this environment needs the production guard (red-orange frame + typed confirm). */
export function isProductionEnv(key: string | null | undefined): boolean {
  return envTone(key) === 'production'
}

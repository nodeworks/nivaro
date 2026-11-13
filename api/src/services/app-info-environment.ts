/** Which environment this instance is (production, staging, …) — shared by app-info and the
 *  environment notice. */
type AppEnvironment = 'production' | 'staging' | 'development' | 'test' | 'other'

export function appEnvironment(env: NodeJS.ProcessEnv = process.env): AppEnvironment {
  const v = (env.NIVARO_ENVIRONMENT ?? '').trim().toLowerCase()
  if (v) {
    return v === 'production' || v === 'staging' || v === 'development' || v === 'test'
      ? v
      : 'other'
  }
  // army7 b10: staging runs NODE_ENV=production and told apps it was production.
  // With no NIVARO_ENVIRONMENT, an instance named for an environment
  // (NIVARO_INSTANCE=staging) says which one it is before NODE_ENV does.
  const named = INSTANCE_ENVIRONMENTS[(env.NIVARO_INSTANCE ?? '').trim().toLowerCase()]
  if (named) return named
  return env.NODE_ENV === 'production' ? 'production' : 'development'
}

const INSTANCE_ENVIRONMENTS: Record<string, AppEnvironment> = {
  production: 'production',
  prod: 'production',
  staging: 'staging',
  stage: 'staging',
  development: 'development',
  dev: 'development',
  test: 'test'
}

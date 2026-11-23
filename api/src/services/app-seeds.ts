/**
 * Per-app seeds (Hub shared deployments). A registration that writes its rows into the database
 * at boot — an extension's payload templates — writes nothing on a shared deployment, where boot
 * runs outside any app (the db proxy answers nothing there). Such a registration also registers a
 * seed here; services/tenancy/app-migrations.ts runs every seed inside each app when the app
 * joins this process (a stored `ok` adopted) and after each per-app migrate, with the seed's own
 * idempotence (the same writes a self-hosted boot makes). A failed seed is logged and never fails
 * the app's migration.
 */

/** Registered by code at boot (name → seed); the same for every app. */
const seeds = new Map<string, () => Promise<unknown>>()

/** Registers (or replaces) the seed `name`. It runs inside the app it seeds. */
export function registerAppSeed(name: string, fn: () => Promise<unknown>): void {
  seeds.set(name, fn)
}

/** Runs every seed in the current app. Answers the names that failed. */
export async function runAppSeeds(): Promise<string[]> {
  const failed: string[] = []
  for (const [name, fn] of seeds) {
    try {
      await fn()
    } catch (err) {
      failed.push(name)
      // biome-ignore lint/suspicious/noConsole: an operator must see a failed seed in the server log
      console.warn(
        `[app-seeds] ${name} failed: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }
  return failed
}

/** Names of the registered seeds (readiness, tests). */
export function appSeedNames(): string[] {
  return [...seeds.keys()]
}

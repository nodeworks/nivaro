import { db } from '../../../db/index.js'
import type { FreezeRefusal } from './freeze.js'

/**
 * Hub enhancement 47: nothing starts on a retired app. An archived environment, or any
 * environment of an app the retirement wizard archived (nivaro_hub_apps.archived_at), refuses
 * every start with 409 ENV_ARCHIVED — promote, Apply now, schedules, train steps, moves, shared
 * upgrades, config and extension promotion, scaling, restart. It is judged inside freezeRefusal
 * (so every start the freeze engine gates gets it at once) and by the few starts that are not
 * freeze-gated (restart). The retirement's own steps (action `retire`) are not judged: they
 * archive the app themselves.
 *
 * A shared deployment's upgrade names no environment: an archived app on it (none should remain:
 * the retirement takes its environments off the deployment) never holds the upgrade back.
 *
 * Not a security control: when the rows cannot be read the check passes (the freeze read beside
 * it fails closed on its own).
 */

export const ENV_ARCHIVED = 'ENV_ARCHIVED'

function refusal(what: string, appId: number | null): FreezeRefusal {
  return {
    status: 409,
    code: ENV_ARCHIVED,
    message: `${what} is retired (archived): nothing is deployed, moved, scaled or restarted there any more.`,
    freeze: { id: 0, name: 'Retired', app_id: appId, ends_at: new Date().toISOString() }
  }
}

/** The refusal for a start on an archived environment / an archived app's environment, else null. */
export async function archivedRefusal(o: {
  appIds?: number[]
  envId?: number | null
}): Promise<FreezeRefusal | null> {
  try {
    if (o.envId != null) {
      const env = (await db('nivaro_hub_environments as e')
        .leftJoin('nivaro_hub_apps as a', 'a.id', 'e.app_id')
        .where('e.id', o.envId)
        .first('e.key', 'e.status', 'e.app_id', 'a.key as app_key', 'a.archived_at')) as
        | Record<string, unknown>
        | undefined
      if (env && (String(env.status ?? '') === 'archived' || env.archived_at != null))
        return refusal(
          `${String(env.app_key ?? 'The app')} · ${String(env.key ?? 'this environment')}`,
          env.app_id == null ? null : Number(env.app_id)
        )
    }
    const ids = (o.appIds ?? []).filter((n) => Number.isSafeInteger(n) && n > 0)
    if (ids.length) {
      const app = (await db('nivaro_hub_apps')
        .whereIn('id', ids)
        .whereNotNull('archived_at')
        .first('id', 'key')) as { id: number; key: string } | undefined
      if (app) return refusal(String(app.key), Number(app.id))
    }
  } catch {
    return null
  }
  return null
}

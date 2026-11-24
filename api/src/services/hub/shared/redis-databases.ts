import { config } from '../../../config.js'
import { db } from '../../../db/index.js'
import { openStackSecrets, stackSettingsFromRow } from '../docker/stack-settings.js'
import { redisIdentity } from '../move/gather.js'
import { sharedStackSettings } from './stack-render.js'
import { sharedFromRow } from './store.js'
import { openSharedSecrets } from './upgrade-plan.js'

/**
 * One stack, one Redis database. A Nivaro process keeps most Redis keys without the channel prefix
 * (the cron leader lease, locks, caches, an app's keys on a shared deployment), so two stacks on
 * one Redis database collide whatever their REDIS_CHANNEL_PREFIX: one stack's cron leader stops
 * the other's jobs, and an app on two shared deployments (a move's copy) shares its keys across
 * both. The shared upgrade plan refuses an external REDIS_URL that another stack the Hub runs uses
 * (REDIS_DB_SHARED). Bundled Redis is each stack's own and never compared.
 * Hosts are compared as written: a name and an IP address of one server count as two.
 *
 * Names only leave here: never an address or a password.
 */

/** The other Hub-run stacks (shared deployments, Docker environments) whose external Redis is the
 *  database `url` names. Empty when `url` is unreadable. A stack whose secrets cannot be opened
 *  is left out (the Hub cannot tell; the move plan warns REDIS_UNVERIFIED for those). */
export async function stacksOnRedisDatabase(
  url: string | null | undefined,
  exceptSharedId: number
): Promise<string[]> {
  const want = redisIdentity(url)
  if (!want) return []
  const names: string[] = []
  // The Hub's own Redis: its cron leader lease and locks would collide with the stack's.
  if (redisIdentity(config.REDIS_URL) === want) names.push('the Nivaro Hub itself')

  const shared = (await db('nivaro_hub_shared_deployments').whereNot({ id: exceptSharedId })) as Array<
    Record<string, unknown>
  >
  for (const row of shared) {
    const s = sharedFromRow(row)
    if (s.mode !== 'docker' || s.status === 'retired') continue
    if (sharedStackSettings(s).redis !== 'external') continue
    const other = openSharedSecrets((row.secrets as string | null | undefined) ?? null).REDIS_URL
    if (redisIdentity(other) === want) names.push(`shared deployment ${s.name}`)
  }

  const stacks = (await db('nivaro_hub_stack_settings as s')
    .leftJoin('nivaro_hub_environments as e', 'e.id', 's.environment_id')
    .leftJoin('nivaro_hub_apps as a', 'a.id', 'e.app_id')
    .where('s.redis', 'external')
    .select('s.*', 'e.key as env_key', 'e.status as env_status', 'a.name as app_name')) as Array<
    Record<string, unknown>
  >
  for (const row of stacks) {
    if (row.env_status === 'retired') continue
    const st = stackSettingsFromRow(row)
    let other = st.settings.REDIS_URL
    if (!other) {
      try {
        other = openStackSecrets(st).REDIS_URL
      } catch {
        continue
      }
    }
    if (redisIdentity(other) !== want) continue
    const app = typeof row.app_name === 'string' && row.app_name ? row.app_name : 'an app'
    const env = typeof row.env_key === 'string' && row.env_key ? row.env_key : `#${st.environment_id}`
    names.push(`${app} ${env}`)
  }
  return names.sort()
}

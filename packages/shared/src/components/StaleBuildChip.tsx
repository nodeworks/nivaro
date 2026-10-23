import { cn } from '../lib/utils'

/**
 * One app a person still has open on an old build (#1048). `/presence/online` sends these to
 * administrators only, and only for people with at least one old tab — everyone else gets no
 * field, so this renders nothing for them.
 */
export interface StaleBuild {
  app: string
  /** The build the tab runs; null when the build is current but it loaded before the API update. */
  build: string | null
  current_build: string | null
  reason: 'build' | 'api'
  tabs: number
}

function line(b: StaleBuild): string {
  const tabs = `${b.tabs} tab${b.tabs === 1 ? '' : 's'}`
  if (b.reason === 'api') return `${b.app}: loaded before the API update (${tabs})`
  return `${b.app}: ${b.build ?? 'unknown build'}${b.current_build ? ` — current is ${b.current_build}` : ''} (${tabs})`
}

/** "Old build" pill beside a name in an online list; nothing when every tab is current. */
export function StaleBuildChip({
  builds,
  className
}: {
  builds: StaleBuild[] | null | undefined
  className?: string
}) {
  if (!builds?.length) return null
  const tip = `Needs a reload — running an old version\n${builds.map(line).join('\n')}\nForce client refresh → Old versions on /realtime reloads them.`
  return (
    <span
      className={cn(
        'ml-1.5 rounded-full bg-rose-500/10 px-1.5 py-px text-[10px] font-medium text-rose-700 dark:text-rose-300',
        className
      )}
      data-stale-build={builds.map((b) => b.app).join(',')}
      data-tip={tip}
    >
      Old build
      <span className='sr-only'>: needs a reload — {builds.map(line).join('; ')}</span>
    </span>
  )
}

import { Fragment, type ReactNode } from 'react'
import { useHubProductFlag } from '@/lib/hub-product'
import { cn } from '@/lib/utils'
import { type EnvTone, envTone } from './env-tone'

/** The chip says the tone in one short word; the full name is the environment key beside it. */
const ENV_CHIP_WORD: Record<EnvTone, string> = {
  production: 'Prod',
  staging: 'Staging',
  development: 'Dev',
  other: 'Other'
}

/**
 * Small Hub-mode pieces existing Hub screens drop in. Each renders NOTHING (or its children
 * unchanged) unless the standalone Hub look is on, so a Hub that also holds app data, and every
 * regular install, keeps its screens exactly as they were.
 */

/** "PROD" / "STAGING" tag beside an environment name, in the environment's colour. */
export function HubEnvTag({
  envKey,
  className
}: {
  envKey: string | null | undefined
  className?: string
}) {
  const on = useHubProductFlag()
  if (!on) return null
  return <EnvChip tone={envTone(envKey)} className={className} />
}

export function EnvChip({ tone, className }: { tone: EnvTone; className?: string }) {
  return (
    <span
      data-env-chip={tone}
      className={cn(
        'hub-env-chip inline-flex shrink-0 items-center rounded-[4px] px-1.5 py-px text-[9.5px] font-semibold uppercase leading-[1.5] tracking-[0.06em]',
        className
      )}
    >
      {ENV_CHIP_WORD[tone]}
    </span>
  )
}

/** Health dot, large and unmistakable: green / amber / red / grey, plus a pulse while live. */
export type HubHealth = 'ok' | 'warn' | 'down' | 'unknown'

export function HubStatusDot({
  health,
  size = 10,
  pulse = false,
  className
}: {
  health: HubHealth
  size?: number
  /** Only while something is actually running (motion-reduce turns it off). */
  pulse?: boolean
  className?: string
}) {
  return (
    <span
      aria-hidden
      data-hub-health={health}
      data-hub-pulse={pulse ? '' : undefined}
      className={cn('hub-status-dot relative inline-block shrink-0 rounded-full', className)}
      style={{ width: size, height: size }}
    />
  )
}

/**
 * The production guard: in Hub mode an action that targets production sits in a red-orange
 * frame with a "Production" header line. Children render as they are; outside Hub mode (or for
 * any other environment) the wrapper adds nothing visible.
 */
export function ProductionGuard({
  envKey,
  children,
  what
}: {
  envKey: string | null | undefined
  children: ReactNode
  /** "promote", "move", "apply"… for the header line. */
  what?: string
}) {
  const on = useHubProductFlag()
  const guarded = on && envTone(envKey) === 'production'
  // One stable wrapper: the panel inside (a typed confirmation, a plan) is never remounted when
  // the frame comes or goes. Unguarded it is a plain block with no style (a parent's space-y
  // margin lands on it exactly as it did on the panel).
  return (
    <div
      data-prod-guard={guarded ? '' : undefined}
      className={guarded ? 'hub-prod-guard' : undefined}
    >
      {guarded && (
        <p key='head' className='hub-prod-guard-head'>
          Production
          {envKey && envKey.toLowerCase() !== 'production' ? ` · ${envKey}` : ''}
          {what ? ` — this ${what} reaches live users` : ''}
        </p>
      )}
      <Fragment key='body'>{children}</Fragment>
    </div>
  )
}

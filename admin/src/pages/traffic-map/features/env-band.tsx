import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { FrozenSnapshot } from './snapshots'

/**
 * #2242 — a colour band and the environment's name across the top of the map, so two maps open
 * side by side (production and staging) are never mistaken for each other. The name comes from
 * the Environments registry when this instance is listed there, else from NIVARO_INSTANCE; the
 * tier (production / staging / development / other) picks the colour. A frozen snapshot prints
 * the environment it was taken in. Answers nothing (and shows nothing) in cloud mode.
 */
interface Env {
  instance: string
  name: string
  tier: 'production' | 'staging' | 'development' | 'other'
}

const TIER_WORD: Record<string, string> = {
  production: 'Production',
  staging: 'Staging',
  development: 'Development',
  other: 'Environment'
}
/** Band colours per tier, from the page tokens (light and dark both come from there). */
const TIER_STYLE: Record<string, { bg: string; fg: string; line: string }> = {
  production: {
    bg: 'color-mix(in srgb, var(--tm-error) 16%, var(--tm-card))',
    fg: 'var(--tm-error-ink)',
    line: 'color-mix(in srgb, var(--tm-error) 50%, transparent)'
  },
  staging: {
    bg: 'color-mix(in srgb, var(--tm-update) 16%, var(--tm-card))',
    fg: 'var(--tm-update)',
    line: 'color-mix(in srgb, var(--tm-update) 50%, transparent)'
  },
  development: {
    bg: 'color-mix(in srgb, var(--tm-create) 16%, var(--tm-card))',
    fg: 'var(--tm-create)',
    line: 'color-mix(in srgb, var(--tm-create) 50%, transparent)'
  },
  other: {
    bg: 'var(--tm-accent-soft)',
    fg: 'var(--tm-accent-ink)',
    line: 'color-mix(in srgb, var(--tm-accent) 50%, transparent)'
  }
}

export function EnvironmentBand({
  frozen,
  loadingFrozen = false
}: {
  frozen: FrozenSnapshot | null
  /** A snapshot link is still loading: show nothing rather than this machine's environment. */
  loadingFrozen?: boolean
}) {
  const q = useQuery({
    queryKey: ['traffic-map', 'environment'],
    queryFn: async () => (await api.get('/traffic-map/environment')).data.data as Env,
    staleTime: 5 * 60_000,
    retry: false
  })
  // A frozen view says where it was taken; one without that (older snapshots) says nothing
  // rather than guess from the environment of the machine looking at it.
  const snapEnv = frozen?.snapshot.environment
  const env: { name: string; tier: string } | null = loadingFrozen
    ? null
    : frozen
      ? snapEnv
        ? { name: snapEnv.name, tier: snapEnv.tier }
        : null
      : q.data
        ? { name: q.data.name, tier: q.data.tier }
        : null
  if (!env) return null
  const style = TIER_STYLE[env.tier] ?? TIER_STYLE.other
  const word = TIER_WORD[env.tier] ?? TIER_WORD.other
  return (
    <div
      role='status'
      id='tm-env-band'
      data-tm-env={env.tier}
      className='flex shrink-0 items-center gap-2 border-b px-6 py-1 text-[12.5px]'
      style={{ background: style.bg, color: style.fg, borderBottomColor: style.line }}
    >
      <span className='font-semibold'>{env.name}</span>
      <span className='opacity-80'>
        {frozen
          ? `· snapshot from this ${word.toLowerCase()} environment`
          : `· ${word.toLowerCase()} environment`}
      </span>
    </div>
  )
}

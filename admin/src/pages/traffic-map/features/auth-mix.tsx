import { useTrafficMap } from '../context'
import { fmtCount } from '../EventTicker'
import { Section } from '../Inspector'
import { inspectorPanels } from '../registry/inspectorPanels'
import { register } from '../registry/registry'
import { stripTiles } from '../registry/stripTiles'
import type { Lane, Selection } from '../types'
import { LANE_LABEL } from '../types'
import { inPage, useEntityDetail, useLens } from './b1-shared'

/**
 * #1137 — how requests signed in, per lane and entity: session / token / API key / masquerade /
 * simulated key / none. A strip tile flags any lane where tokens and API keys carry most of the
 * traffic (an integration or a script, not people in a browser); the inspector shows the split.
 */
export const AUTH_MIX_TAP = 'auth-mix'
export const AUTH_METHODS = [
  'session',
  'token',
  'api_key',
  'masquerade',
  'key_sim',
  'none'
] as const
export const AUTH_LABEL: Record<(typeof AUTH_METHODS)[number], string> = {
  session: 'session',
  token: 'token',
  api_key: 'API key',
  masquerade: 'masquerade',
  key_sim: 'simulated key',
  none: 'none'
}
const AUTH_COLOR: Record<(typeof AUTH_METHODS)[number], string> = {
  session: 'var(--tm-read)',
  token: 'var(--tm-update)',
  api_key: 'var(--tm-create)',
  masquerade: 'var(--tm-error)',
  key_sim: 'var(--tm-delete)',
  none: 'var(--tm-line)'
}
/** A lane is "machine-driven" when tokens + API keys carry at least this share… */
export const MACHINE_SHARE = 0.5
/** …of at least this many requests in the window. */
export const MACHINE_MIN = 20

/** Lanes whose traffic is mostly tokens / API keys, busiest share first. */
export function machineLanes(
  lanes: Record<string, number[]>
): Array<{ lane: string; share: number; n: number }> {
  const out: Array<{ lane: string; share: number; n: number }> = []
  for (const [lane, s] of Object.entries(lanes)) {
    const n = s.reduce((a, b) => a + b, 0)
    if (n < MACHINE_MIN) continue
    const share = (s[1] + s[2]) / n
    if (share >= MACHINE_SHARE) out.push({ lane, share, n })
  }
  return out.sort((a, b) => b.share - a.share)
}

export function MixBar({ mix, id }: { mix: number[]; id?: string }) {
  const n = mix.reduce((a, b) => a + b, 0)
  if (!n) return null
  return (
    <div className='grid gap-1' id={id}>
      <div
        className='flex h-1.5 overflow-hidden rounded-sm bg-[var(--tm-line-2)]'
        aria-hidden='true'
      >
        {AUTH_METHODS.map((m, i) =>
          mix[i] ? (
            <i
              key={m}
              className='block h-full'
              style={{ width: `${(100 * mix[i]) / n}%`, background: AUTH_COLOR[m] }}
            />
          ) : null
        )}
      </div>
      <div className='flex flex-wrap gap-x-2.5 gap-y-0.5 text-[11.5px] text-[var(--tm-fg-2)]'>
        {AUTH_METHODS.map((m, i) =>
          mix[i] ? (
            <span key={m} className='inline-flex items-center gap-1 tabular-nums' data-tm-auth={m}>
              <span
                className='h-1.5 w-1.5 rounded-full'
                style={{ background: AUTH_COLOR[m] }}
                aria-hidden='true'
              />
              {AUTH_LABEL[m]} {Math.round((100 * mix[i]) / n)}%
            </span>
          ) : null
        )}
      </div>
    </div>
  )
}

function AuthMixTile() {
  const { data } = useLens<{ lanes: Record<string, number[]>; total: number[] }>(AUTH_MIX_TAP)
  const total = data?.total ?? []
  const n = total.reduce((a, b) => a + b, 0)
  const flagged = machineLanes(data?.lanes ?? {})
  return (
    <div className='min-w-0 bg-[var(--tm-card)] px-3.5 pb-2.5 pt-2.5' id='tm-strip-auth'>
      <div className='text-[12px] font-medium text-[var(--tm-muted)]'>Signed in by</div>
      {n ? (
        <div className='mt-1.5'>
          <MixBar mix={total} />
          {flagged.length ? (
            <p
              className='mt-1 truncate text-[11.5px] text-[var(--tm-update)]'
              data-tm-auth-flag={flagged[0].lane}
            >
              {flagged
                .slice(0, 2)
                .map(
                  (f) =>
                    `${LANE_LABEL[f.lane as Lane] ?? f.lane} ${Math.round(f.share * 100)}% tokens`
                )
                .join(' · ')}
            </p>
          ) : null}
        </div>
      ) : (
        <div className='mt-1 text-[22px] font-semibold leading-tight'>—</div>
      )}
    </div>
  )
}

function AuthMixPanel({ sel }: { sel: Selection }) {
  const { model } = useTrafficMap()
  const lens = useLens<{ lanes: Record<string, number[]> }>(AUTH_MIX_TAP)
  const detail = useEntityDetail(sel.kind === 'entity' ? sel.id : null)
  const mix =
    sel.kind === 'lane'
      ? lens.data?.lanes[sel.id]
      : ((detail?.[AUTH_MIX_TAP] ?? model.entityMeta(sel.id)?.ext?.[AUTH_MIX_TAP]) as
          | number[]
          | undefined)
  if (!mix?.some((v) => v > 0)) return null
  return (
    <Section title='Signed in by'>
      <MixBar mix={mix} id='tm-auth-mix' />
      <p className='mt-1 text-[11.5px] text-[var(--tm-muted)]'>
        {fmtCount(mix.reduce((a, b) => a + b, 0))} requests in the window
      </p>
    </Section>
  )
}

register(stripTiles, { id: 'auth-mix', order: 10, Component: inPage(AuthMixTile) })
register(inspectorPanels, {
  id: 'auth-mix',
  order: 25,
  applies: (sel) => sel.kind === 'entity' || sel.kind === 'lane',
  Component: inPage(AuthMixPanel)
})

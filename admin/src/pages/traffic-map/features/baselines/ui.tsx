/**
 * Small pieces the baseline features share: tone chips on the --tm-* tokens (light and dark
 * follow the theme) and the live figures of a map node in the shape the scorers take.
 */
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import type { TrafficModel } from '../../model'
import { nodeBadges } from '../../registry/canvasLayers'
import type { Selection } from '../../types'
import { type Health, healthScore, type KeyBands, type Level } from './score'
import { bandsFor } from './store'

export type Tone = 'good' | 'warn' | 'bad' | 'muted'
const TONE_VAR: Record<Tone, string> = {
  good: 'var(--tm-create)',
  warn: 'var(--tm-update)',
  bad: 'var(--tm-error)',
  muted: 'var(--tm-muted)'
}

/** A small tinted chip: tint 12%, border 45%, text mixed toward the foreground. */
export function ToneChip({
  tone,
  children,
  tip,
  className,
  id
}: {
  tone: Tone
  children: ReactNode
  tip?: string
  className?: string
  id?: string
}) {
  const c = TONE_VAR[tone]
  return (
    <span
      id={id}
      data-tip={tip}
      data-tm-tone={tone}
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-px text-[11px] font-medium tabular-nums leading-tight',
        className
      )}
      style={{
        background:
          tone === 'muted' ? 'var(--tm-card-2)' : `color-mix(in srgb, ${c} 12%, transparent)`,
        border: `1px solid color-mix(in srgb, ${c} 45%, var(--tm-line))`,
        color: tone === 'muted' ? 'var(--tm-fg-2)' : `color-mix(in srgb, ${c} 72%, var(--tm-fg))`
      }}
    >
      {children}
    </span>
  )
}

export const LEVEL_TEXT: Record<Level, string> = {
  unknown: 'no normal yet',
  normal: 'normal',
  elevated: 'above normal',
  high: 'far above normal',
  low: 'below normal'
}
export function levelTone(l: Level): Tone {
  return l === 'high'
    ? 'bad'
    : l === 'elevated' || l === 'low'
      ? 'warn'
      : l === 'normal'
        ? 'good'
        : 'muted'
}
export function LevelChip({ level, tip }: { level: Level; tip?: string }) {
  return (
    <ToneChip tone={levelTone(level)} tip={tip}>
      {LEVEL_TEXT[level]}
    </ToneChip>
  )
}

/** Live figures of an entity over the window, with its bands. */
export function entityLive(
  m: TrafficModel,
  key: string,
  win: number
): { req: number; errors: number; p95: number; windowS: number; bands: KeyBands | undefined } {
  const s = m.entitySum(key, win)
  return {
    req: s[0] ?? 0,
    errors: s[5] ?? 0,
    p95: m.entityP95(key),
    windowS: win,
    bands: bandsFor('entity', key)
  }
}

/** Pool level and event-loop p99 of this API process from the newest frame (else the snapshot). */
export function saturationOf(m: TrafficModel): { pool: 'ok' | 'warn' | 'error'; loopP99: number } {
  const pool = (m.frameExt.pool ?? m.snapshotExt.pool) as { level?: string } | undefined
  const nhFrame = m.frameExt['node-health'] as { loop_p99?: number } | undefined
  const nhSnap = m.snapshotExt['node-health'] as { loop?: { p99?: number } } | undefined
  const level = pool?.level === 'error' || pool?.level === 'warn' ? pool.level : 'ok'
  return { pool: level, loopP99: nhFrame?.loop_p99 ?? nhSnap?.loop?.p99 ?? 0 }
}

/** Badges other detectors put on the node (the baseline's own surge pill is not a finding). */
export function findingsOf(
  key: string,
  m: TrafficModel
): Array<{ tone: 'warn' | 'error' | 'info'; text: string }> {
  const out: Array<{ tone: 'warn' | 'error' | 'info'; text: string }> = []
  for (const b of nodeBadges) {
    if (b.id === BASELINE_BADGE_ID) continue
    try {
      const v = b.badge(key, m)
      if (v) out.push(v)
    } catch {
      /* a broken detector adds nothing */
    }
  }
  return out
}
export const BASELINE_BADGE_ID = 'baseline-surge'

/** #2144 — the health score of one entity node right now. */
export function entityHealth(m: TrafficModel, key: string, win: number): Health {
  const live = entityLive(m, key, win)
  return healthScore({ ...live, ...saturationOf(m), findings: findingsOf(key, m) })
}

export function isEntity(sel: Selection): boolean {
  return sel.kind === 'entity' && !sel.id.includes('/__')
}

export const fmtNum = (v: number) =>
  !Number.isFinite(v)
    ? '—'
    : v <= 0
      ? '0'
      : v >= 100
        ? Math.round(v).toLocaleString()
        : v >= 10
          ? v.toFixed(0)
          : v >= 1
            ? v.toFixed(1)
            : v.toFixed(2)

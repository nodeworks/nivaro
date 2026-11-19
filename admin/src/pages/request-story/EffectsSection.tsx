/**
 * What the request wrote and set off — writes, pipeline moves, flows, partner pushes and calls,
 * people told, emails — in time order, nested under the step that caused them; plus the live
 * updates it sent. Every row opens its leaf.
 */
import {
  ArrowRightLeft,
  Bell,
  Circle,
  Mail,
  PencilLine,
  PlugZap,
  Radio,
  RotateCcw,
  Send,
  Workflow
} from 'lucide-react'
import { type ComponentType, type ReactNode, useMemo, useState } from 'react'
import { cn } from '@/lib/utils'
import {
  EFFECT_GROUP_LABEL,
  type EffectNode,
  effectCounts,
  effectSentence,
  fmtMs,
  fmtOffset,
  type Leaf,
  nestEffects
} from './logic'
import type { EffectKind, Labels, Story, StoryEffect } from './types'
import { Hint, LeafRow, Panel, Section, TonePill } from './ui'

export const EFFECT_ICON: Record<EffectKind, ComponentType<{ className?: string }>> = {
  write: PencilLine,
  transition: ArrowRightLeft,
  flow: Workflow,
  push: Send,
  attempt: RotateCcw,
  call: PlugZap,
  notify: Bell,
  mail: Mail,
  other: Circle
}

/** The quiet second line of an effect row. */
function effectNote(e: StoryEffect): string | null {
  const f = e.facts
  if (e.failed && e.reason) return e.reason
  switch (e.kind) {
    case 'write': {
      const names = (f.fields ?? []).map((x) => x.label)
      if (names.length === 0) return e.who ? `by ${e.who}` : null
      const shown = names.slice(0, 4).join(', ')
      return names.length > 4 ? `${shown} +${names.length - 4}` : shown
    }
    case 'notify': {
      const ch = (f.channels ?? []).map((c) => c.channel)
      return [ch.join(', '), f.category].filter(Boolean).join(' · ') || null
    }
    case 'call':
      return [f.method, f.url].filter(Boolean).join(' ') || null
    case 'push':
      return f.attempts != null
        ? `${f.attempts} ${f.attempts === 1 ? 'attempt' : 'attempts'}`
        : null
    case 'mail':
      return f.template ? `template ${f.template}` : null
    default:
      return null
  }
}

/** The right-hand fact: a status where there is one, else the time it took. */
function effectBadge(e: StoryEffect) {
  const f = e.facts
  if (e.kind === 'call' && f.http_status != null)
    return (
      <TonePill tone={f.http_status >= 500 ? 'bad' : f.http_status >= 400 ? 'warn' : 'ok'}>
        {f.http_status}
        {f.duration_ms != null && <span className='font-normal'>{fmtMs(f.duration_ms)}</span>}
      </TonePill>
    )
  if (e.failed) return <TonePill tone='bad'>Failed</TonePill>
  if (f.status && ['push', 'flow', 'mail'].includes(e.kind))
    return <TonePill tone='muted'>{f.status}</TonePill>
  return null
}

export function EffectsSection({
  story,
  labels,
  leaf,
  onOpen
}: {
  story: Story
  labels: Labels | null
  leaf: Leaf | null
  onOpen: (l: Leaf) => void
}) {
  const effects = story.effects ?? []
  const counts = useMemo(() => effectCounts(effects), [effects])
  const [kind, setKind] = useState<EffectKind | null>(null)
  const nodes = useMemo(() => {
    const all = nestEffects(effects)
    if (!kind) return all
    return all.filter((n) => n.effect.kind === kind).map((n): EffectNode => ({ ...n, depth: 0 }))
  }, [effects, kind])
  const failed = effects.filter((e) => e.failed).length

  const body =
    story.sources.chain === 'none' ? (
      <Hint className='px-4 py-3'>
        This request carries no chain id, so what it wrote and set off cannot be joined to it.
      </Hint>
    ) : effects.length === 0 ? (
      <Hint className='px-4 py-3'>
        It wrote no records and set nothing off — no pipeline moves, flows, partner calls,
        notifications or emails.
      </Hint>
    ) : (
      <ol className='m-0 list-none divide-y divide-slate-100 p-0 dark:divide-border'>
        {nodes.map(({ effect: e, depth }) => {
          const Icon = EFFECT_ICON[e.kind]
          const note = effectNote(e)
          return (
            <li key={e.key}>
              <LeafRow
                list='effect'
                selected={leaf?.type === 'effect' && leaf.key === e.key}
                onOpen={() => onOpen({ type: 'effect', key: e.key })}
                className='grid grid-cols-[60px_minmax(0,1fr)_auto] items-start gap-3 px-4 py-2'
              >
                <span className='pt-px text-right font-mono text-[11px] tabular-nums text-slate-400 dark:text-muted-foreground'>
                  {fmtOffset(e.offset_ms)}
                </span>
                <span
                  className='flex min-w-0 items-start gap-2'
                  style={{ paddingLeft: `${Math.min(depth, 4) * 18}px` }}
                >
                  <Icon
                    className={cn(
                      'mt-0.5 h-3.5 w-3.5 shrink-0',
                      e.failed
                        ? 'text-red-600 dark:text-red-400'
                        : 'text-slate-400 dark:text-muted-foreground'
                    )}
                    aria-hidden
                  />
                  <span className='min-w-0'>
                    <span
                      className={cn(
                        'block text-[12.5px] leading-snug',
                        e.failed
                          ? 'text-red-800 dark:text-red-300'
                          : 'text-slate-900 dark:text-foreground'
                      )}
                    >
                      {effectSentence(e, labels)}
                    </span>
                    {note && (
                      <span className='mt-0.5 block truncate text-[11.5px] text-slate-500 dark:text-muted-foreground'>
                        {note}
                      </span>
                    )}
                  </span>
                </span>
                <span className='flex items-center gap-1.5 pt-px'>{effectBadge(e)}</span>
              </LeafRow>
            </li>
          )
        })}
      </ol>
    )

  return (
    <Section
      id='effects'
      title='What it wrote and set off'
      count={effects.length || undefined}
      aside={
        failed > 0 ? (
          <span className='font-medium text-red-700 dark:text-red-400'>{failed} failed</span>
        ) : null
      }
    >
      {counts.length > 1 && (
        <fieldset className='m-0 mb-2 flex min-w-0 flex-wrap gap-1.5 border-0 p-0'>
          <legend className='sr-only'>Show only</legend>
          <FilterChip active={kind == null} onClick={() => setKind(null)}>
            All <span className='tabular-nums opacity-70'>{effects.length}</span>
          </FilterChip>
          {counts.map((c) => (
            <FilterChip
              key={c.kind}
              active={kind === c.kind}
              onClick={() => setKind(kind === c.kind ? null : c.kind)}
            >
              {EFFECT_GROUP_LABEL[c.kind]} <span className='tabular-nums opacity-70'>{c.n}</span>
            </FilterChip>
          ))}
        </fieldset>
      )}
      <Panel>{body}</Panel>
    </Section>
  )
}

function FilterChip({
  active,
  onClick,
  children
}: {
  active: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type='button'
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-[12px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50',
        active
          ? 'border-nvr-cyan/50 bg-nvr-cyan/10 font-medium text-slate-900 dark:text-foreground'
          : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50 dark:border-border dark:bg-card dark:text-muted-foreground dark:hover:bg-muted'
      )}
    >
      {children}
    </button>
  )
}

export function LiveSection({
  story,
  leaf,
  onOpen
}: {
  story: Story
  leaf: Leaf | null
  onOpen: (l: Leaf) => void
}) {
  if (story.emits.length === 0) return null
  const n = story.emits.reduce((s, e) => s + e.n, 0)
  return (
    <Section id='live' title='Live updates it sent' count={n}>
      <Panel>
        <ul className='m-0 list-none divide-y divide-slate-100 p-0 dark:divide-border'>
          {story.emits.map((e) => (
            <li key={e.event}>
              <LeafRow
                list='emit'
                selected={leaf?.type === 'emit' && leaf.event === e.event}
                onOpen={() => onOpen({ type: 'emit', event: e.event })}
                className='flex items-center gap-2.5 px-4 py-2 text-[12.5px]'
              >
                <Radio className='h-3.5 w-3.5 shrink-0 text-slate-400' aria-hidden />
                <span className='min-w-0 flex-1 truncate font-mono text-[12px] text-slate-800 dark:text-foreground'>
                  {e.event}
                </span>
                <span className='tabular-nums text-slate-500 dark:text-muted-foreground'>
                  ×{e.n}
                </span>
              </LeafRow>
            </li>
          ))}
        </ul>
      </Panel>
    </Section>
  )
}

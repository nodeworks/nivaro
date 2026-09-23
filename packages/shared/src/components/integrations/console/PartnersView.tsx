import { useMemo, useState } from 'react'
import { cn } from '../../../lib/utils'
import { usePartners } from './api'
import { fmtMs, fmtPct, HEALTH, HealthPill, HourlyBars, PartnerFlags } from './PartnerBits'
import { PartnerDetail } from './PartnerDetail'
import { agoText, exactTime, TONE_TEXT, type Tone } from './tone'
import type { PartnerCard } from './types'

function Figure({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className='min-w-0'>
      <dt className='truncate text-[11px] text-muted-foreground'>{label}</dt>
      <dd className='mt-0.5 text-[14px] font-semibold tabular-nums text-foreground'>
        {value}
        {sub && <span className='ml-1 text-[11px] font-normal text-muted-foreground'>{sub}</span>}
      </dd>
    </div>
  )
}

function obligationsLine(o: PartnerCard['obligations']): { text: string; tone: Tone } {
  const bad: string[] = []
  if (o.missing) bad.push(`${o.missing} missing`)
  if (o.overdue) bad.push(`${o.overdue} overdue`)
  if (o.failed) bad.push(`${o.failed} failed`)
  if (bad.length) return { text: bad.join(' · '), tone: o.missing ? 'negative' : 'warning' }
  const any = o.sent + o.pending
  if (!any) return { text: 'None tracked', tone: 'neutral' }
  return { text: `${o.sent} sent${o.pending ? ` · ${o.pending} pending` : ''}`, tone: 'neutral' }
}

function PartnerTile({ card, onOpen }: { card: PartnerCard; onOpen: () => void }) {
  const obl = obligationsLine(card.obligations)
  return (
    <button
      type='button'
      onClick={onOpen}
      data-ic-partner={card.id}
      aria-label={`${card.name}: ${HEALTH[card.health].word}. Open details`}
      className='flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-card p-4 text-left transition-colors hover:border-foreground/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
    >
      <div className='flex w-full items-start justify-between gap-2'>
        <div className='min-w-0'>
          <p className='truncate text-[13.5px] font-semibold text-foreground'>{card.name}</p>
          {/* Reserve the flag line so every card's figures start level. */}
          <div className='mt-1 min-h-[18px]'>
            <PartnerFlags card={card} />
          </div>
        </div>
        <HealthPill health={card.health} />
      </div>
      <dl className='grid w-full grid-cols-4 gap-2'>
        <Figure label='Success 24h' value={fmtPct(card.success_pct24)} />
        <Figure label='7 days' value={fmtPct(card.success_pct7d)} />
        <Figure label='Typical' value={fmtMs(card.p50_ms)} />
        <Figure label='Slow (p95)' value={fmtMs(card.p95_ms)} />
      </dl>
      <HourlyBars hourly={card.hourly} className='w-full' />
      <div className='w-full space-y-1 text-[12px]'>
        <p className='flex gap-1.5 text-muted-foreground'>
          <span className='w-[88px] shrink-0'>Last success</span>
          <span className='text-foreground' data-tip={exactTime(card.last_ok_at)}>
            {agoText(card.last_ok_at)}
          </span>
          <span className='ml-auto tabular-nums'>
            {card.calls24} call{card.calls24 === 1 ? '' : 's'} in 24h
          </span>
        </p>
        <p className='flex min-w-0 gap-1.5 text-muted-foreground'>
          <span className='w-[88px] shrink-0'>Last failure</span>
          {card.last_fail_at ? (
            <span className='min-w-0 truncate' data-tip={card.last_fail_reason ?? undefined}>
              <span className='text-foreground' data-tip={exactTime(card.last_fail_at)}>
                {agoText(card.last_fail_at)}
              </span>
              {card.last_fail_reason && (
                <span className={TONE_TEXT.negative}> — {card.last_fail_reason}</span>
              )}
            </span>
          ) : (
            <span className='text-foreground'>none in 7 days</span>
          )}
        </p>
      </div>
      <div className='mt-auto flex w-full items-center justify-between gap-2 border-t border-border pt-2.5 text-[11.5px]'>
        <span className='truncate text-muted-foreground'>
          {card.owner ? (
            <>
              Owner <span className='text-foreground'>{card.owner.name}</span>
            </>
          ) : (
            'No owner set'
          )}
        </span>
        <span className='shrink-0 text-muted-foreground' data-ic-obligations>
          Obligations{' '}
          <span
            className={cn(
              'font-medium',
              obl.tone === 'neutral' ? 'text-foreground' : TONE_TEXT[obl.tone]
            )}
          >
            {obl.text}
          </span>
        </span>
      </div>
    </button>
  )
}

export interface PartnersViewProps {
  /** Detail sheet open on this partner (controlled by the frame). */
  openId?: number | null
  onOpenChange?: (id: number | null) => void
}

export function PartnersView({ openId, onOpenChange }: PartnersViewProps = {}) {
  const { data, isLoading, isError } = usePartners()
  const partners = useMemo(
    () =>
      [...(data?.partners ?? [])].sort(
        (a, b) => HEALTH[a.health].order - HEALTH[b.health].order || a.name.localeCompare(b.name)
      ),
    [data]
  )
  // Controlled when the frame passes onOpenChange; self-contained otherwise.
  const [localId, setLocalId] = useState<number | null>(null)
  const controlled = onOpenChange != null
  const openedId = controlled ? (openId ?? null) : localId
  const open = (id: number | null) => (controlled ? onOpenChange?.(id) : setLocalId(id))

  if (isLoading) {
    return (
      <div className='space-y-4' aria-busy>
        <div className='h-[58px] animate-pulse rounded-lg bg-[hsl(var(--nvr-skeleton))]' />
        <div className='grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3'>
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className='h-[272px] animate-pulse rounded-lg bg-[hsl(var(--nvr-skeleton))]'
            />
          ))}
        </div>
      </div>
    )
  }
  if (isError || !data) {
    return <p className={cn('text-[12.5px]', TONE_TEXT.negative)}>Couldn't load partner health.</p>
  }
  const s = data.summary
  return (
    <div className='space-y-4' data-ic-partners>
      <dl className='grid grid-cols-3 divide-x divide-border overflow-hidden rounded-lg border border-border bg-card'>
        <div className='px-4 py-2.5'>
          <dt className='text-[11.5px] text-muted-foreground'>Calls in the last 24 hours</dt>
          <dd className='text-[18px] font-semibold tabular-nums text-foreground'>
            {s.calls24.toLocaleString()}
          </dd>
        </div>
        <div className='px-4 py-2.5'>
          <dt className='text-[11.5px] text-muted-foreground'>Succeeded</dt>
          <dd className='text-[18px] font-semibold tabular-nums text-foreground'>
            {fmtPct(s.success_pct24)}
          </dd>
        </div>
        <div className='px-4 py-2.5'>
          <dt className='text-[11.5px] text-muted-foreground'>Partners needing attention</dt>
          <dd
            className={cn(
              'text-[18px] font-semibold tabular-nums',
              s.not_healthy > 0 ? TONE_TEXT.negative : 'text-foreground'
            )}
          >
            {s.not_healthy}
            <span className='ml-1.5 text-[12px] font-normal text-muted-foreground'>
              of {partners.length}
            </span>
          </dd>
        </div>
      </dl>
      {partners.length === 0 ? (
        <div className='rounded-lg border border-border bg-card px-5 py-6'>
          <p className='text-[14px] font-semibold text-foreground'>No partners connected yet</p>
          <p className='mt-1 text-[12.5px] text-muted-foreground'>
            Each external system you connect gets a health card here — success rate, speed and the
            last thing that went wrong.
          </p>
        </div>
      ) : (
        <div className='grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3'>
          {partners.map((p) => (
            <PartnerTile key={p.id} card={p} onOpen={() => open(p.id)} />
          ))}
        </div>
      )}
      {openedId != null && <PartnerDetail apiId={openedId} onClose={() => open(null)} />}
    </div>
  )
}

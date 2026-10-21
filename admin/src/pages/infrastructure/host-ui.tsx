import type { ReactNode } from 'react'
import {
  Banner,
  Chip,
  Code,
  HostBlock,
  type Tone as KitTone,
  LoadError,
  NotConnected,
  StatStrip,
  TabSkeleton
} from './ui'

/** Bits shared by the Hosts, Reboot and Logs tabs (#2829 #2831 #2836 #2837). */

export type Tone = 'ok' | 'warning' | 'critical' | 'unknown'

const KIT: Record<Tone, KitTone> = { ok: 'ok', warning: 'warn', critical: 'bad', unknown: 'muted' }

export function ToneChip({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <Chip tone={KIT[tone]} icon>
      {children}
    </Chip>
  )
}

/** A tinted one-line statement (the verdict of a section), with an icon. */
export function ToneBanner({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <Banner tone={KIT[tone]}>{children}</Banner>
}

/** One host's block on a tab: name, a status on the right, then the body. */
export function HostSection({
  host,
  aside,
  children
}: {
  host: string
  aside?: ReactNode
  children: ReactNode
}) {
  return (
    <HostBlock host={host} aside={aside}>
      <div className='space-y-3'>{children}</div>
    </HostBlock>
  )
}

/** Key/value figures with 1px dividers (the counts strip). */
export function MetaGrid({
  items
}: {
  items: Array<{ label: string; value: ReactNode; tone?: Tone; mono?: boolean }>
}) {
  return (
    <StatStrip
      min={150}
      items={items.map((it) => ({
        label: it.label,
        value: it.value,
        mono: it.mono,
        tone: it.tone && it.tone !== 'ok' ? KIT[it.tone] : undefined,
        tip: typeof it.value === 'string' && it.value.length > 14 ? it.value : undefined
      }))}
    />
  )
}

/** What a tab shows while it loads. */
export const HostSkeletons = TabSkeleton

export function TabError({ what, onRetry }: { what: string; onRetry?: () => void }) {
  return <LoadError what={what} onRetry={onRetry} />
}

/** Host facts are missing for this host (the collector is not installed or not shipping). */
export function FactsNotCollected({ compact, title }: { compact?: boolean; title?: string }) {
  if (compact) return <Chip tone='muted'>Host facts not collected</Chip>
  return (
    <div className='rounded-lg border border-dashed border-slate-300 bg-white px-4 py-3 text-[12px] text-slate-600 dark:border-border dark:bg-card dark:text-muted-foreground'>
      <p className='font-medium text-slate-800 dark:text-foreground'>
        {title ?? 'Host facts are not collected on this host'}
      </p>
      <p className='mt-0.5 max-w-prose leading-5'>
        Install{' '}
        <code className='rounded bg-slate-100 px-1 py-0.5 font-mono text-[11px] dark:bg-muted'>
          deploy/host-facts/nivaro-host-facts.sh
        </code>{' '}
        on the host with its systemd timer (or run it as a container — no sudo needed), set{' '}
        <code className='rounded bg-slate-100 px-1 py-0.5 font-mono text-[11px] dark:bg-muted'>
          NIVARO_HOST_NAME
        </code>{' '}
        to this host's name, and point node_exporter's textfile collector at its folder. The README
        beside the script has the steps.
      </p>
    </div>
  )
}

export function StoreNotConfigured() {
  return (
    <NotConnected title='The telemetry store is not configured'>
      Host facts and growth figures come from the telemetry store. Set{' '}
      <Code>TELEMETRY_STORE_URL</Code> and a read token on this instance.
    </NotConnected>
  )
}

/** "3 days", "5 hours", "12 minutes" — for ages and durations. */
export function duration(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000))
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`
  const h = Math.round(m / 60)
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'}`
  const d = Math.round(h / 24)
  return `${d} day${d === 1 ? '' : 's'}`
}

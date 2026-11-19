/**
 * The verdict: what happened in one sentence (who, what, the answer, how long), when and where,
 * why it failed when it did, and the figures — each a jump to its section.
 */
import { AlertTriangle, ChevronRight, GitBranch, Radar } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { cn, formatRelative } from '@/lib/utils'
import {
  fmtClock,
  fmtMs,
  type Leaf,
  readableError,
  statusMeaning,
  statusText,
  statusTone,
  trafficMapPath
} from './logic'
import type { Story } from './types'
import { CopyText, MethodTag, StatusPill, TONE_TEXT } from './ui'

/** "Saved workflow 85607" from the server headline, or null when it only says METHOD path. */
function actionOf(story: Story): string | null {
  const first = story.headline.split(' · ')[0]?.replace(/ — failed \d+$/, '') ?? ''
  const r = story.request
  if (!first || (r && first === `${r.method} ${r.path}`) || /^Request\b/.test(first)) return null
  return first.charAt(0).toLowerCase() + first.slice(1)
}

function jump(id: string) {
  document
    .getElementById(`rs-section-${id}`)
    ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

export function Verdict({
  story,
  onOpen,
  onShowPath
}: {
  story: Story
  onOpen: (l: Leaf) => void
  onShowPath: (() => void) | null
}) {
  const r = story.request
  const status = story.status
  const failed = (status ?? 0) >= 400
  const action = actionOf(story)
  const who = story.caller?.label ?? story.who ?? 'Someone'
  const effects = story.effects ?? []
  const count = (k: string) => effects.filter((e) => e.kind === k).length
  const writes = count('write')
  const calls = count('call') + count('push')
  const told = story.notified
  const live = story.emits.reduce((n, e) => n + e.n, 0)
  const t = story.trace

  return (
    <header className='grid gap-3' data-request-story-headline=''>
      <div className='flex flex-wrap items-center gap-2'>
        <StatusPill status={status} />
        {r && <MethodTag method={r.method} />}
        <code className='min-w-0 break-all font-mono text-[12.5px] text-slate-700 dark:text-slate-300'>
          {r?.route.replace(/^[A-Z]+ /, '') ?? story.route ?? 'Route unknown'}
        </code>
        <div className='ml-auto flex items-center gap-1'>
          <CopyText value={window.location.href} label='Copy a link to this view' />
          {onShowPath && (
            <button
              type='button'
              onClick={onShowPath}
              className='inline-flex h-7 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2 text-[12px] text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:border-border dark:bg-card dark:text-slate-300 dark:hover:bg-muted'
            >
              <GitBranch className='h-3.5 w-3.5' aria-hidden />
              Event path
            </button>
          )}
          <Link
            to={trafficMapPath(story.request_id)}
            className='inline-flex h-7 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2 text-[12px] text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:border-border dark:bg-card dark:text-slate-300 dark:hover:bg-muted'
          >
            <Radar className='h-3.5 w-3.5' aria-hidden />
            Traffic Map
          </Link>
        </div>
      </div>

      <h2 className='m-0 max-w-[80ch] text-[18px] font-semibold leading-snug tracking-[-0.01em] text-slate-900 dark:text-foreground'>
        {story.caller ? (
          <button
            type='button'
            onClick={() => onOpen({ type: 'caller' })}
            className='rounded text-left underline decoration-slate-300 decoration-1 underline-offset-[5px] hover:decoration-nvr-cyan focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:decoration-slate-600'
          >
            {who}
          </button>
        ) : (
          who
        )}{' '}
        {action ?? (r ? `sent ${r.method} ${r.path}` : 'sent this request')}
        <span className={cn('font-normal', TONE_TEXT[statusTone(status)])}>
          {' '}
          — {status ? `${status} ${statusText(status)}` : 'no answer kept'}
        </span>
        {story.total_ms != null && (
          <span className='font-normal text-slate-500 dark:text-muted-foreground'>
            {' '}
            in {fmtMs(story.total_ms)}
          </span>
        )}
      </h2>

      <p className='m-0 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-slate-500 dark:text-muted-foreground'>
        {r?.started_at && (
          <span>
            <span className='text-slate-700 dark:text-slate-300'>{fmtClock(r.started_at)}</span> ·{' '}
            {formatRelative(r.started_at)}
          </span>
        )}
        {r?.instance && <span>served by {r.instance}</span>}
        <span className='inline-flex items-center gap-0.5'>
          <span className='font-mono text-[11.5px]'>{story.request_id}</span>
          <CopyText value={story.request_id} label='Copy the request id' />
        </span>
      </p>

      {failed && (
        <button
          type='button'
          onClick={() => onOpen({ type: 'error' })}
          className={cn(
            'group flex w-full max-w-[96ch] items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50',
            statusTone(status) === 'bad'
              ? 'border-red-200 bg-red-50 hover:bg-red-100/70 dark:border-red-500/30 dark:bg-red-500/10 dark:hover:bg-red-500/15'
              : 'border-amber-200 bg-amber-50 hover:bg-amber-100/70 dark:border-amber-500/30 dark:bg-amber-500/10 dark:hover:bg-amber-500/15'
          )}
        >
          <AlertTriangle
            className={cn('mt-0.5 h-4 w-4 shrink-0', TONE_TEXT[statusTone(status)])}
            aria-hidden
          />
          <span className='min-w-0 flex-1'>
            <span className='block text-[12.5px] font-medium text-slate-900 dark:text-foreground'>
              {statusMeaning(status)}
            </span>
            {r?.error && (
              <span className='mt-0.5 block truncate text-[12px] text-slate-600 dark:text-slate-400'>
                {readableError(r.error)}
              </span>
            )}
          </span>
          <span className='flex shrink-0 items-center gap-0.5 self-center text-[12px] font-medium text-slate-700 dark:text-slate-300'>
            Why it failed
            <ChevronRight
              className='h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5'
              aria-hidden
            />
          </span>
        </button>
      )}

      <ul
        aria-label='In figures'
        className='m-0 grid list-none grid-cols-2 gap-x-5 gap-y-3 border-y border-slate-200 p-0 py-2.5 sm:flex sm:flex-wrap sm:items-stretch sm:gap-x-0 sm:gap-y-2 dark:border-border'
      >
        <Figure label='took' value={fmtMs(story.total_ms)} onClick={() => jump('time')} />
        {t && (
          <Figure
            label={`SQL · ${t.queries} ${t.queries === 1 ? 'statement' : 'statements'}`}
            value={fmtMs(t.sql_ms)}
            onClick={() => jump('sql')}
          />
        )}
        {t && (
          <Figure
            label={story.hooks.length === 1 ? 'hook' : 'hooks'}
            value={String(story.hooks.length)}
            onClick={() => jump('time')}
          />
        )}
        <Figure
          label={writes === 1 ? 'record written' : 'records written'}
          value={String(writes)}
          onClick={() => jump('effects')}
        />
        {calls > 0 && (
          <Figure
            label={calls === 1 ? 'partner call' : 'partner calls'}
            value={String(calls)}
            onClick={() => jump('effects')}
          />
        )}
        <Figure
          label={told === 1 ? 'person notified' : 'people notified'}
          value={String(told)}
          onClick={() => jump('effects')}
        />
        {live > 0 && (
          <Figure
            label={live === 1 ? 'live update' : 'live updates'}
            value={String(live)}
            onClick={() => jump('live')}
          />
        )}
      </ul>
    </header>
  )
}

function Figure({
  label,
  value,
  onClick
}: {
  label: string
  value: ReactNode
  onClick: () => void
}) {
  return (
    <li className='sm:border-r sm:border-slate-200 sm:pr-5 sm:last:border-r-0 sm:[&:not(:first-child)]:pl-5 dark:sm:border-border'>
      <button
        type='button'
        onClick={onClick}
        className='group grid rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50'
      >
        <span className='text-[16px] font-semibold tabular-nums leading-tight text-slate-900 group-hover:text-sky-700 dark:text-foreground dark:group-hover:text-nvr-cyan'>
          {value}
        </span>
        <span className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>{label}</span>
      </button>
    </li>
  )
}

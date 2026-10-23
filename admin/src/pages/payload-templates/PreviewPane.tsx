import { AlertCircle, AlertTriangle, Ban, KeyRound, RefreshCw } from 'lucide-react'
import { type ReactNode, useMemo } from 'react'
import { Link } from 'react-router'
import { cn } from '@/lib/utils'
import { type DraftBody, errorMessage, type Problem, usePreview } from './api'
import { RecordPicker } from './RecordPicker'

export type PreviewView = 'draft' | 'live' | 'diff'

export interface PreviewPaneProps {
  templateKey: string
  /** The editor's current (possibly unsaved) draft; null = the stored draft. */
  draft: { mode: DraftBody['mode']; body: DraftBody['body'] } | null
  recordId: string | null
  onRecordChange: (id: string) => void
  view: PreviewView
  onViewChange?: (v: PreviewView) => void
  /** The template's collection — names the record picker. */
  collection?: string
  /** Published version number, null when nothing is live (Live/Diff then explain that). */
  liveVersion?: number | null
  /** External API id — a missing-secret problem links to its Body secrets card. */
  externalApiId?: number | null
}

const SECRET_RE = /⟦nvr-secret:([^⟧]*)⟧/

// ─── JSON rendering ──────────────────────────────────────────────────────────

const TOKEN_RE =
  /("(?:[^"\\]|\\.)*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g

/** One pretty-printed JSON line with keys, strings, literals and secret placeholders styled. */
function JsonLine({ line }: { line: string }) {
  const parts: ReactNode[] = []
  let last = 0
  for (const m of line.matchAll(TOKEN_RE)) {
    const at = m.index ?? 0
    if (at > last) parts.push(line.slice(last, at))
    if (m[1] && m[2]) {
      parts.push(
        <span key={at} className='text-slate-900 dark:text-slate-100'>
          {m[1]}
        </span>,
        <span key={`${at}:`}>{m[2]}</span>
      )
    } else if (m[1]) {
      const secret = SECRET_RE.exec(m[1])
      parts.push(
        secret ? (
          <span
            key={at}
            className='rounded bg-slate-100 px-1 text-slate-700 dark:bg-muted dark:text-slate-200'
            data-tip={`Body secret “${secret[1]}” — filled in only when the request is sent`}
          >
            <KeyRound className='mr-1 inline h-3 w-3 -translate-y-px text-slate-400' />
            {m[1]}
          </span>
        ) : (
          <span key={at} className='text-sky-800 dark:text-sky-300'>
            {m[1]}
          </span>
        )
      )
    } else if (m[3]) {
      parts.push(
        <span key={at} className='text-violet-700 dark:text-violet-300'>
          {m[3]}
        </span>
      )
    } else if (m[4]) {
      parts.push(
        <span key={at} className='text-amber-800 dark:text-amber-300'>
          {m[4]}
        </span>
      )
    }
    last = at + m[0].length
  }
  if (last < line.length) parts.push(line.slice(last))
  return <>{parts}</>
}

function pretty(body: unknown): string {
  if (typeof body === 'string') return body
  try {
    return JSON.stringify(body, null, 2) ?? 'null'
  } catch {
    return String(body)
  }
}

function JsonView({ body }: { body: unknown }) {
  const lines = useMemo(() => pretty(body).split('\n'), [body])
  return (
    <pre
      className='whitespace-pre-wrap break-words font-mono text-[12px] leading-[1.6] text-slate-500 dark:text-slate-400'
      data-payload-json
    >
      {lines.map((l, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional
        <div key={i}>
          <JsonLine line={l} />
        </div>
      ))}
    </pre>
  )
}

// ─── Line diff (live → draft) ────────────────────────────────────────────────

type DiffLine = { kind: 'same' | 'add' | 'del'; text: string }

const DIFF_CAP = 3000

/** Line LCS diff of two pretty-printed bodies; null when either is too large to diff here. */
export function lineDiff(a: string, b: string): DiffLine[] | null {
  const x = a.split('\n')
  const y = b.split('\n')
  if (x.length > DIFF_CAP || y.length > DIFF_CAP) return null
  const n = x.length
  const m = y.length
  const w = m + 1
  const t = new Uint32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      t[i * w + j] =
        x[i] === y[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1])
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      out.push({ kind: 'same', text: x[i] })
      i++
      j++
    } else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) out.push({ kind: 'del', text: x[i++] })
    else out.push({ kind: 'add', text: y[j++] })
  }
  while (i < n) out.push({ kind: 'del', text: x[i++] })
  while (j < m) out.push({ kind: 'add', text: y[j++] })
  return out
}

function DiffView({ live, draft, version }: { live: unknown; draft: unknown; version: number }) {
  const a = useMemo(() => pretty(live), [live])
  const b = useMemo(() => pretty(draft), [draft])
  const lines = useMemo(() => lineDiff(a, b), [a, b])
  if (a === b) {
    return (
      <p className='text-[12.5px] text-slate-500 dark:text-muted-foreground'>
        No difference — the draft sends the same body as live v{version} for this record.
      </p>
    )
  }
  if (!lines) {
    return (
      <p className='text-[12.5px] text-slate-500 dark:text-muted-foreground'>
        These bodies are too long to compare line by line here. Switch to Draft or Live to read each
        one.
      </p>
    )
  }
  return (
    <div>
      <p className='mb-2 flex items-center gap-3 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
        <span>
          <span className='font-mono text-red-600 dark:text-red-400'>−</span> live v{version}
        </span>
        <span>
          <span className='font-mono text-emerald-700 dark:text-emerald-400'>+</span> draft
        </span>
      </p>
      <pre className='whitespace-pre-wrap break-words font-mono text-[12px] leading-[1.6]'>
        {lines.map((l, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are positional
            key={i}
            className={cn(
              'flex gap-2 rounded-sm px-1',
              l.kind === 'add' &&
                'bg-emerald-50 text-emerald-900 dark:bg-emerald-500/10 dark:text-emerald-200',
              l.kind === 'del' && 'bg-red-50 text-red-900 dark:bg-red-500/10 dark:text-red-200',
              l.kind === 'same' && 'text-slate-500 dark:text-slate-400'
            )}
            data-diff={l.kind}
          >
            <span className='w-3 shrink-0 select-none text-center opacity-70'>
              {l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ''}
            </span>
            <span className='min-w-0 flex-1'>{l.text}</span>
          </div>
        ))}
      </pre>
    </div>
  )
}

// ─── States ──────────────────────────────────────────────────────────────────

function BodySkeleton() {
  return (
    <div className='space-y-2' aria-hidden data-payload-preview-loading>
      {[72, 48, 64, 40, 56, 32, 60].map((w, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton
          key={i}
          className='h-3 animate-pulse rounded bg-[hsl(var(--nvr-skeleton))]'
          style={{ width: `${w}%`, marginLeft: i === 0 || i === 6 ? 0 : 16 }}
        />
      ))}
    </div>
  )
}

function ErrorState({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <div className='rounded-md border border-red-200 bg-red-50 px-3 py-2.5 text-[12.5px] text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200'>
      <p className='font-medium'>The preview could not render.</p>
      <p className='mt-0.5'>{errorMessage(error)}</p>
      <button
        type='button'
        onClick={onRetry}
        className='mt-2 inline-flex items-center gap-1 text-[12px] font-medium underline underline-offset-2'
      >
        <RefreshCw className='h-3 w-3' />
        Try again
      </button>
    </div>
  )
}

function ProblemsList({
  problems,
  externalApiId
}: {
  problems: Problem[]
  externalApiId?: number | null
}) {
  if (!problems.length) return null
  const errors = problems.filter((p) => p.severity === 'error').length
  return (
    <section
      className='border-b border-slate-200 px-4 py-3 dark:border-border'
      aria-label='Problems'
      data-payload-problems
    >
      <p className='mb-1.5 text-[12px] font-medium text-slate-700 dark:text-slate-200'>
        {errors > 0
          ? `${errors} ${errors === 1 ? 'problem' : 'problems'} would stop this push`
          : `${problems.length} ${problems.length === 1 ? 'warning' : 'warnings'}`}
      </p>
      <ul className='max-h-40 space-y-1 overflow-y-auto'>
        {problems.map((p) => {
          const missingSecret = /not a body secret/i.test(p.message)
          return (
            <li
              key={`${p.field_id}:${p.path}:${p.message}`}
              className='flex gap-2 text-[12px] leading-snug'
            >
              {p.severity === 'error' ? (
                <AlertCircle className='mt-px h-3.5 w-3.5 shrink-0 text-red-600 dark:text-red-400' />
              ) : (
                <AlertTriangle className='mt-px h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400' />
              )}
              <span className='min-w-0 text-slate-700 dark:text-slate-200'>
                {p.path && (
                  <span className='mr-1.5 font-mono text-[11.5px] text-slate-500 dark:text-slate-400'>
                    {p.path}
                  </span>
                )}
                {p.message}
                {missingSecret && externalApiId != null && (
                  <>
                    {' '}
                    <Link
                      to={`/external-apis/${externalApiId}#body-secrets`}
                      className='font-medium text-slate-900 underline underline-offset-2 dark:text-foreground'
                    >
                      Add it under Body secrets
                    </Link>
                  </>
                )}
              </span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

const VIEWS: { v: PreviewView; label: string }[] = [
  { v: 'draft', label: 'Draft' },
  { v: 'live', label: 'Live' },
  { v: 'diff', label: 'Diff' }
]

/**
 * The right-hand preview: a real record rendered through the draft (as edited,
 * unsaved included), the live version, or the difference between the two.
 * The server renders; the client never evaluates a template.
 */
export function PreviewPane({
  templateKey,
  draft,
  recordId,
  onRecordChange,
  view,
  onViewChange,
  collection = 'record',
  liveVersion = null,
  externalApiId = null
}: PreviewPaneProps) {
  const hasLive = liveVersion != null
  const draftQ = usePreview(templateKey, {
    which: 'draft',
    recordId,
    draft: draft as DraftBody | null,
    enabled: view !== 'live'
  })
  const liveQ = usePreview(templateKey, {
    which: 'published',
    recordId,
    enabled: hasLive && view !== 'draft'
  })
  const main = view === 'live' ? liveQ : draftQ
  const result = main.data
  const problems = view === 'diff' ? (draftQ.data?.problems ?? []) : (result?.problems ?? [])
  const skipped = view === 'diff' ? draftQ.data?.skipped : result?.skipped

  let body: ReactNode
  if (!recordId) {
    body = (
      <p className='text-[12.5px] text-slate-500 dark:text-muted-foreground'>
        Pick a {collection} record to see the body it would send.
      </p>
    )
  } else if (view !== 'draft' && !hasLive) {
    body = (
      <p className='text-[12.5px] text-slate-500 dark:text-muted-foreground'>
        Nothing is live yet — pushes using this payload fail until a version is published.
      </p>
    )
  } else if (view === 'diff') {
    if (draftQ.isError || liveQ.isError)
      body = (
        <ErrorState
          error={draftQ.error ?? liveQ.error}
          onRetry={() => {
            void draftQ.refetch()
            void liveQ.refetch()
          }}
        />
      )
    else if (!draftQ.data || !liveQ.data) body = <BodySkeleton />
    else
      body = <DiffView live={liveQ.data.body} draft={draftQ.data.body} version={liveVersion ?? 0} />
  } else if (main.isError) {
    body = <ErrorState error={main.error} onRetry={() => void main.refetch()} />
  } else if (!result) {
    body = <BodySkeleton />
  } else {
    body = <JsonView body={result.body} />
  }

  const refreshing = (view === 'live' ? liveQ : draftQ).isFetching && !!result

  return (
    <div className='flex min-h-0 flex-1 flex-col' data-payload-preview>
      <div className='flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-4 py-2.5 dark:border-border dark:bg-card'>
        <RecordPicker
          templateKey={templateKey}
          collection={collection}
          value={recordId}
          onChange={onRecordChange}
        />
        <div
          className='inline-flex shrink-0 rounded-md border border-slate-200 p-0.5 dark:border-border'
          role='tablist'
          aria-label='Preview view'
        >
          {VIEWS.map(({ v, label }) => {
            const off = v !== 'draft' && !hasLive
            return (
              <span
                key={v}
                role='presentation'
                data-tip={off ? 'Nothing is published yet' : undefined}
              >
                <button
                  type='button'
                  role='tab'
                  aria-selected={view === v}
                  disabled={off}
                  onClick={() => onViewChange?.(v)}
                  className={cn(
                    'rounded px-2.5 py-1 text-[12px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan disabled:cursor-not-allowed disabled:opacity-40',
                    view === v
                      ? 'bg-slate-100 text-slate-900 dark:bg-muted dark:text-foreground'
                      : 'text-slate-500 hover:text-slate-800 dark:text-muted-foreground dark:hover:text-foreground'
                  )}
                  data-preview-view={v}
                >
                  {label}
                </button>
              </span>
            )
          })}
        </div>
      </div>

      {skipped && (
        <div
          className='flex shrink-0 gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2.5 text-[12.5px] text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200'
          role='status'
          data-payload-skipped
        >
          <Ban className='mt-0.5 h-3.5 w-3.5 shrink-0' />
          <p>
            <span className='font-medium'>This record wouldn't send this.</span> {skipped}
          </p>
        </div>
      )}

      <ProblemsList problems={problems} externalApiId={externalApiId} />

      <div className='relative min-h-[240px] flex-1 overflow-y-auto px-4 py-3'>
        {refreshing && (
          <span className='absolute right-3 top-2 text-[11px] text-slate-400' aria-live='polite'>
            Updating…
          </span>
        )}
        {body}
        {view === 'live' && result?.version != null && (
          <p className='mt-3 text-[11.5px] text-slate-400'>Live v{result.version}</p>
        )}
      </div>
    </div>
  )
}

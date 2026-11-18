import {
  TrackerChip as GitlabChip,
  signalSentence,
  toastError,
  useLiveOps,
  useTopicPresence
} from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowDown,
  ArrowUp,
  Check,
  Copy,
  ExternalLink,
  PlayCircle,
  RotateCcw,
  UserPlus,
  X
} from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { ExplainButton } from '@/components/explain-button'
import { MonCombobox } from '@/components/filter-combobox'
import { IssueComments } from '@/components/issue-comments'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { cn, formatRelative } from '@/lib/utils'
import { SeverityLabel, SourceTag, StatusBadge } from './badges'
import { IssueGitlabSection } from './GitlabSection'
import { parseIssueTitle } from './issue-title'
import { notesOnServerChange } from './notes-sync'
import { Section } from './section'
import {
  type CmsUser,
  type Issue,
  lastSeen,
  personName,
  SEVERITIES,
  statusLabel,
  userLabel
} from './types'

interface LiveOccurrence {
  route: string
  source: string
  user_id: string | null
  build: string | null
  count: number
  at: number
}

/** The next steps a person takes from each status — the first is the primary one. */
const NEXT_STEPS: Record<string, Array<{ to: string; label: string }>> = {
  open: [
    { to: 'resolved', label: 'Resolve' },
    { to: 'in_progress', label: 'Start work' },
    { to: 'closed', label: 'Close issue' }
  ],
  in_progress: [
    { to: 'resolved', label: 'Resolve' },
    { to: 'open', label: 'Back to open' },
    { to: 'closed', label: 'Close issue' }
  ],
  resolved: [
    { to: 'open', label: 'Reopen' },
    { to: 'closed', label: 'Close issue' }
  ],
  closed: [{ to: 'open', label: 'Reopen' }]
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type='button'
      className='inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(
          () => {
            setDone(true)
            setTimeout(() => setDone(false), 1500)
          },
          () => toast.error('Could not copy — select the text instead')
        )
      }}
      aria-label={label}
    >
      {done ? <Check className='h-3 w-3' /> : <Copy className='h-3 w-3' />}
      {done ? 'Copied' : 'Copy'}
    </button>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className='min-w-0 bg-white px-3 py-2 dark:bg-card'>
      <dt className='text-[11px] text-muted-foreground'>{label}</dt>
      <dd className='mt-0.5 truncate text-[12.5px] text-slate-800 dark:text-foreground'>
        {children}
      </dd>
    </div>
  )
}

export function IssueDetailPanel({
  issue,
  users,
  onClose,
  onPrev,
  onNext,
  position
}: {
  issue: Issue
  users: CmsUser[]
  onClose: () => void
  onPrev?: () => void
  onNext?: () => void
  /** "3 of 72" — where this issue sits in the list. */
  position?: string
}) {
  const qc = useQueryClient()
  const { user: me } = useAuth()
  const isAdmin = !!me?.is_admin
  const savedNotes = issue.resolution_notes ?? ''
  const [notes, setNotes] = useState(savedNotes)
  // R4 — a newer saved copy that arrived while the box held unsaved typing.
  const [theirNotes, setTheirNotes] = useState<string | null>(null)
  const notesRef = useRef(notes)
  notesRef.current = notes
  const notesBaseRef = useRef({ id: issue.id, saved: savedNotes })
  const notesSentRef = useRef<string | null>(null)
  // #1882 — "Kim is looking at this": the others who have this issue open right now.
  const presence = useTopicPresence(`issue-view:${issue.id}`, me?.id)

  // The saved notes moved (another admin's save, or this box's own): re-copy them only when the
  // box holds no unsaved typing — otherwise keep the typing and offer theirs (R4).
  useEffect(() => {
    const base = notesBaseRef.current
    notesBaseRef.current = { id: issue.id, saved: savedNotes }
    if (base.id !== issue.id) {
      notesSentRef.current = null
      setNotes(savedNotes)
      setTheirNotes(null)
      return
    }
    if (base.saved === savedNotes) return
    const next = notesOnServerChange(notesRef.current, base.saved, savedNotes, notesSentRef.current)
    setNotes(next.draft)
    setTheirNotes(next.theirs)
  }, [issue.id, savedNotes])

  // Full row (the list omits the screenshot blob).
  const { data: full } = useQuery({
    queryKey: ['issue-full', issue.id],
    queryFn: () =>
      api
        .get<{ data: Issue & { details?: string | null; screenshot?: string | null } }>(
          `/issues/${issue.id}`
        )
        .then((r) => r.data.data),
    staleTime: 60_000,
    // While its GitLab issue is being created, look again until the link lands.
    refetchInterval: (q) =>
      q.state.data?.tracker_pending?.some((p) => p.op === 'create' && p.status !== 'dead')
        ? 4000
        : false
  })

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['issues'] })
    void qc.invalidateQueries({ queryKey: ['issues-summary'] })
    void qc.invalidateQueries({ queryKey: ['issue-full'] })
  }
  const patchMut = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch(`/issues/${issue.id}`, body),
    onSuccess: (_r, body) => {
      refresh()
      if ('status' in body)
        toast.success(`Marked ${statusLabel(String(body.status)).toLowerCase()}`)
      else if ('assigned_to' in body) toast.success(body.assigned_to ? 'Assigned' : 'Unassigned')
      else if ('severity' in body) toast.success('Severity changed')
      else toast.success('Saved')
    },
    onError: (err) => toastError(err, 'Could not update the issue')
  })

  // Live hits of THIS issue (admin room), plus the stored tail (last 50, 30 days).
  const [live, setLive] = useState<LiveOccurrence[]>([])
  useEffect(() => setLive([]), [issue.id])
  const { data: stored = [] } = useQuery<LiveOccurrence[]>({
    queryKey: ['issue-occurrences', issue.id],
    queryFn: () =>
      api
        .get<{
          data: Array<{
            occurred_at: string
            user_id: string | null
            route: string | null
            build: string | null
            source: string | null
          }>
        }>(`/issues/${issue.id}/occurrences`)
        .then((r) =>
          r.data.data.map((o) => ({
            route: o.route ?? '',
            source: o.source ?? '',
            user_id: o.user_id,
            build: o.build,
            count: 0,
            at: new Date(o.occurred_at).getTime()
          }))
        ),
    enabled: isAdmin,
    staleTime: 30_000,
    retry: false
  })
  useLiveOps(
    `issue:${issue.id}`,
    (d) => {
      const o = d.occurrence as Omit<LiveOccurrence, 'at'> | undefined
      if (!o) return
      setLive((cur) => [{ ...o, at: Number(d.at) || Date.now() }, ...cur].slice(0, 25))
    },
    { debounceMs: 0 }
  )
  const hits = [
    ...live,
    ...stored.filter(
      (o) => !live.some((l) => l.at >= o.at - 1000 && l.at <= o.at + 1000 && l.route === o.route)
    )
  ].slice(0, 50)
  const timesSeen = live[0]?.count ?? full?.occurrence_count ?? issue.occurrence_count ?? 1

  const parsed = parseIssueTitle(issue.title)
  const details = full?.details ?? issue.details ?? null
  const technical = [parsed.technical, details].filter(Boolean).join('\n\n')
  const replayId = issue.recording_id ?? full?.recording_id
  const replayOffset = issue.recording_offset_ms ?? full?.recording_offset_ms
  const raiserName = personName(issue.raised_by_name, issue.raised_by_email)
  const mine = !!me?.id && issue.assigned_to?.toLowerCase() === me.id.toLowerCase()
  const userOptions = users.map((u) => ({ value: u.id, label: userLabel(u) }))
  const steps = NEXT_STEPS[issue.status] ?? NEXT_STEPS.open
  // The single read carries the GitLab detail (admins: examples + waiting changes).
  const withGitlab = full ? { ...issue, ...full } : issue
  const tracker = withGitlab.tracker ?? null

  return (
    <div
      className='flex min-h-0 flex-1 flex-col bg-slate-50 dark:bg-background'
      data-issue-detail={issue.id}
    >
      {/* Header */}
      <div className='shrink-0 border-b border-slate-200 bg-white px-5 pb-3 pt-3 dark:border-border dark:bg-card'>
        <div className='flex items-center gap-2'>
          <span className='font-mono text-[11px] text-muted-foreground'>#{issue.id}</span>
          <StatusBadge status={issue.status} />
          <SeverityLabel severity={issue.severity} />
          <SourceTag source={issue.source ?? parsed.source} />
          <GitlabChip tracker={tracker} />
          <span className='ml-auto flex items-center gap-0.5'>
            {position && (
              <span className='mr-1 text-[11px] tabular-nums text-muted-foreground'>
                {position}
              </span>
            )}
            <Button
              variant='ghost'
              size='icon'
              className='h-7 w-7'
              disabled={!onPrev}
              onClick={onPrev}
              aria-label='Previous issue (k)'
              data-tip='Previous (k)'
            >
              <ArrowUp className='h-3.5 w-3.5' />
            </Button>
            <Button
              variant='ghost'
              size='icon'
              className='h-7 w-7'
              disabled={!onNext}
              onClick={onNext}
              aria-label='Next issue (j)'
              data-tip='Next (j)'
            >
              <ArrowDown className='h-3.5 w-3.5' />
            </Button>
            <Button
              variant='ghost'
              size='icon'
              className='h-7 w-7'
              onClick={onClose}
              aria-label='Close (Esc)'
              data-tip='Close (Esc)'
            >
              <X className='h-3.5 w-3.5' />
            </Button>
          </span>
        </div>
        <h2 className='mt-2 text-[16px] font-semibold leading-snug tracking-[-0.01em] text-slate-900 [text-wrap:pretty] dark:text-foreground'>
          {parsed.headline}
        </h2>
        {parsed.where && (
          <p className='mt-0.5 break-all font-mono text-[11.5px] text-muted-foreground'>
            {parsed.where}
          </p>
        )}
        {presence.viewers.length > 0 && (
          <p
            className='mt-2 flex items-center gap-1.5 text-[12px] text-sky-700 dark:text-sky-300'
            data-issue-viewing
          >
            <span className='h-1.5 w-1.5 shrink-0 rounded-full bg-sky-500' />
            {signalSentence(
              presence.viewers.map((v) => v.name),
              'looking at this'
            )}
          </p>
        )}

        {/* Next steps */}
        <div className='mt-3 flex flex-wrap items-center gap-2' data-issue-actions>
          {steps.map((s, i) => (
            <Button
              key={s.to}
              size='sm'
              variant={i === 0 ? 'default' : 'outline'}
              className='h-7 gap-1.5 text-[12px]'
              disabled={patchMut.isPending}
              onClick={() => patchMut.mutate({ status: s.to })}
              data-issue-step={s.to}
            >
              {s.to === 'open' ? <RotateCcw className='h-3.5 w-3.5' /> : null}
              {s.to === 'resolved' ? <Check className='h-3.5 w-3.5' /> : null}
              {s.label}
            </Button>
          ))}
          <span className='mx-1 h-5 w-px bg-slate-200 dark:bg-border' aria-hidden />
          <label className='flex items-center gap-1.5 text-[11.5px] text-muted-foreground'>
            Owner
            <span className='w-48'>
              <MonCombobox
                value={issue.assigned_to ?? ''}
                onChange={(v) => patchMut.mutate({ assigned_to: v || null })}
                options={[{ value: '', label: 'No one' }, ...userOptions]}
                placeholder='No one'
                className='h-7 w-full'
              />
            </span>
          </label>
          {!mine && me?.id && (
            <Button
              size='sm'
              variant='ghost'
              className='h-7 gap-1 text-[12px]'
              disabled={patchMut.isPending}
              onClick={() => patchMut.mutate({ assigned_to: me.id })}
            >
              <UserPlus className='h-3.5 w-3.5' />
              Take it
            </Button>
          )}
          <label className='flex items-center gap-1.5 text-[11.5px] text-muted-foreground'>
            Severity
            <span className='w-28'>
              <MonCombobox
                value={issue.severity}
                onChange={(v) => v && v !== issue.severity && patchMut.mutate({ severity: v })}
                options={SEVERITIES.map((s) => ({
                  value: s,
                  label: s.charAt(0).toUpperCase() + s.slice(1)
                }))}
                className='h-7 w-full'
              />
            </span>
          </label>
        </div>
      </div>

      {/* Body */}
      <div className='min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4'>
        <dl className='grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 sm:grid-cols-3 dark:border-border dark:bg-border'>
          <Fact label='Times seen'>
            <span className='tabular-nums' data-issue-occurrences={timesSeen}>
              {timesSeen}
            </span>
          </Fact>
          <Fact label='Last seen'>{formatRelative(lastSeen(full ?? issue))}</Fact>
          <Fact label='First seen'>{formatRelative(issue.created_at)}</Fact>
          <Fact label='Raised by'>{raiserName ?? 'The system'}</Fact>
          <Fact label='Record'>
            {issue.collection ? (
              issue.item ? (
                <Link
                  to={`/collections/${issue.collection}/${issue.item}`}
                  className='inline-flex items-center gap-1 font-mono text-[12px] text-nvr-navy underline-offset-2 hover:underline dark:text-nvr-cyan'
                >
                  {issue.collection}/{issue.item}
                  <ExternalLink className='h-3 w-3' />
                </Link>
              ) : (
                <span className='font-mono text-[12px]'>{issue.collection}</span>
              )
            ) : (
              <span className='text-muted-foreground'>None</span>
            )}
          </Fact>
        </dl>

        {(replayId || isAdmin) && (
          <div className='flex flex-wrap items-center gap-2'>
            {replayId && (
              <Link
                to={`/analytics/replays?recording=${replayId}${replayOffset != null ? `&t=${replayOffset}` : ''}`}
                className='inline-flex h-7 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 text-[12px] font-medium text-slate-800 hover:bg-slate-50 dark:border-border dark:bg-card dark:text-foreground dark:hover:bg-muted'
              >
                <PlayCircle className='h-3.5 w-3.5 text-nvr-navy dark:text-nvr-cyan' />
                Watch the replay
                <span className='font-normal text-muted-foreground'>
                  {replayOffset != null ? 'from the error' : 'last minute before it'}
                </span>
              </Link>
            )}
            <ExplainButton kind='issue' params={{ id: issue.id }} label='Explain this issue' />
          </div>
        )}

        <IssueGitlabSection issue={withGitlab} onChanged={refresh} />

        {technical && (
          <Section
            title='Technical details'
            action={
              <CopyButton
                text={`${issue.title}\n\n${details ?? ''}`.trim()}
                label='Copy technical details'
              />
            }
          >
            <pre className='max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-slate-700 dark:text-slate-300'>
              {technical}
            </pre>
          </Section>
        )}

        {isAdmin && hits.length > 0 && (
          <Section title={`Recent occurrences · ${hits.length}`}>
            <ul
              className='-mx-4 -my-3 divide-y divide-slate-100 dark:divide-border/60'
              data-issue-live-occurrences
            >
              {hits.map((o) => {
                const who = o.user_id
                  ? users.find((u) => u.id.toLowerCase() === o.user_id?.toLowerCase())
                  : null
                return (
                  <li
                    key={`${o.at}-${o.count}-${o.route}`}
                    className='grid grid-cols-[88px_minmax(0,140px)_minmax(0,1fr)_auto] items-center gap-3 px-4 py-1.5 text-[12px]'
                  >
                    <time
                      className='tabular-nums text-muted-foreground'
                      dateTime={new Date(o.at).toISOString()}
                    >
                      {formatRelative(new Date(o.at).toISOString())}
                    </time>
                    <span className='truncate font-medium'>
                      {who ? userLabel(who) : o.user_id ? 'Another person' : 'Not signed in'}
                    </span>
                    <span className='truncate font-mono text-[11px] text-muted-foreground'>
                      {o.route}
                    </span>
                    {o.build ? (
                      <span className='rounded bg-slate-100 px-1.5 font-mono text-[10.5px] text-slate-600 dark:bg-muted dark:text-muted-foreground'>
                        {o.build}
                      </span>
                    ) : (
                      <span />
                    )}
                  </li>
                )
              })}
            </ul>
          </Section>
        )}

        {full?.screenshot && (
          <Section title='Screenshot'>
            <a href={full.screenshot} target='_blank' rel='noreferrer' className='block'>
              <img
                src={full.screenshot}
                alt='The page when the issue was reported'
                className='max-h-72 rounded-md border border-slate-200 dark:border-border'
              />
            </a>
          </Section>
        )}

        <Section title='Comments'>
          {/* Replay notes copied onto this issue land here (#1363). */}
          <IssueComments
            issueId={issue.id}
            emptyText='No comments yet.'
            sharedWithGitlab={!!tracker}
          />
        </Section>

        <Section
          title='Resolution notes'
          action={
            <Button
              variant='outline'
              size='sm'
              className='h-6 px-2 text-[11px]'
              disabled={patchMut.isPending || notes === savedNotes}
              onClick={() => {
                notesSentRef.current = notes
                setTheirNotes(null)
                patchMut.mutate({ resolution_notes: notes || null })
              }}
            >
              Save notes
            </Button>
          }
        >
          <Textarea
            value={notes}
            onChange={(e) => {
              setNotes(e.target.value)
              if (e.target.value === theirNotes) setTheirNotes(null)
            }}
            placeholder='What caused it, and what fixed it?'
            className={cn('min-h-[72px] text-[12.5px]')}
            aria-label='Resolution notes'
          />
          {theirNotes != null && (
            <div
              data-notes-remote-change=''
              role='status'
              className='mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-sky-300 bg-sky-50 px-3 py-1.5 text-[11.5px] text-sky-900 dark:border-sky-500/40 dark:bg-sky-500/10 dark:text-sky-100'
            >
              <span className='min-w-0 flex-1'>
                Someone saved new notes while you were typing.{' '}
                <span className='line-clamp-2 break-words text-sky-800/80 dark:text-sky-100/75'>
                  {theirNotes ? `Saved now: “${theirNotes}”` : 'Saved now: no notes.'}
                </span>
              </span>
              <button
                type='button'
                onClick={() => {
                  setNotes(theirNotes)
                  setTheirNotes(null)
                }}
                data-notes-remote-take
                className='rounded-md bg-nvr-cyan px-2 py-0.5 text-[11px] font-semibold text-white hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan focus-visible:ring-offset-1'
              >
                Take theirs
              </button>
              <button
                type='button'
                onClick={() => setTheirNotes(null)}
                data-notes-remote-keep
                data-tip='Keep your text; Save notes then writes it over theirs'
                className='rounded-md border border-sky-300 px-2 py-0.5 text-[11px] font-medium hover:bg-sky-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:border-sky-500/40 dark:hover:bg-sky-500/15'
              >
                Keep mine
              </button>
            </div>
          )}
        </Section>
      </div>
    </div>
  )
}

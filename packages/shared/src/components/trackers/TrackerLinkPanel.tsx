import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query'
import { ExternalLink, Gitlab, Link2, RefreshCw, Sparkles } from 'lucide-react'
import { type MouseEvent, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useNavigation, useNivaroClient } from '../../context'
import { useDebounced } from '../../hooks/useDebounced'
import { del, get, post } from '../../lib/commands'
import { toastError } from '../../lib/error-toast'
import { useUnsavedWork } from '../../lib/unsaved-work'
import { cn, formatRelative } from '../../lib/utils'
import { AiMarkdown } from '../ai/AiMarkdown'
import { ErrorNotice } from '../ErrorNotice'
import { ConfirmButton } from '../profile/primitives'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Skeleton } from '../ui/skeleton'
import { TrackerChip } from './TrackerChip'
import { LabelPicker, PickList } from './TrackerPickers'
import {
  alwaysLabels,
  connectionForUrl,
  type GitlabLabel,
  type GitlabProject,
  type GitlabUser,
  joinedViaLabel,
  memberName,
  OP_WORDS,
  percent,
  type SimilarCandidate,
  safeHref,
  sourceBody,
  stateWord,
  type TemplateSample,
  type TrackerChipData,
  type TrackerConnectionInfo,
  type TrackerLink,
  type TrackerMember,
  type TrackerPending,
  type TrackerSourceRef,
  type TrackerSyncLike
} from './tracker-model'
import { trackerQueryKeys } from './use-tracker-link'

const PRIMARY = 'h-7 gap-1.5 bg-nvr-cyan text-[12px] text-white hover:bg-nvr-cyan/90'
const QUIET_BTN =
  'inline-flex h-7 items-center gap-1 rounded-md border border-slate-200 bg-white px-2 text-[12px] font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan disabled:opacity-50 dark:border-border dark:bg-card dark:text-foreground dark:hover:bg-muted'
const ARMED = 'border-red-300 text-red-700 dark:border-red-500/50 dark:text-red-300'
const FIELD_LABEL = 'text-[11.5px] text-slate-600 dark:text-muted-foreground'
const TEXTAREA =
  'min-h-[72px] w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-[12.5px] text-slate-900 outline-none placeholder:text-slate-400 focus:border-nvr-cyan focus:ring-2 focus:ring-nvr-cyan/20 dark:text-slate-100'
const ALERT =
  'flex flex-wrap items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200'

const KIND_NOUN: Record<TrackerSourceRef['kind'], string> = {
  issue: 'issue-log entry',
  ticket: 'request',
  record: 'record'
}

export type TrackerPanelMode = 'idle' | 'create' | 'link'

export interface TrackerLinkPanelProps {
  source: TrackerSourceRef
  /** Administrators get every tool; others create / link in the default project only. */
  admin: boolean
  /** Connections this person may create / link on (never empty when the panel shows). */
  connections: TrackerConnectionInfo[]
  /** Administrators: the whole link when linked. */
  link: TrackerLink | null
  /** Everyone else: the chip when linked. */
  chip?: TrackerChipData | null
  /** Issue log (admin detail): the examples on the GitLab issue and the changes not sent yet. */
  members?: TrackerMember[]
  membersTotal?: number
  pending?: TrackerPending[]
  /** Issue log: a rule suggested this one for GitLab (its id). */
  suggestedRule?: number | null
  /** A create was asked for here and its GitLab issue has not shown up yet. */
  creating?: boolean
  /** Asked for over 2 minutes ago and still not there (no longer asking on its own). */
  slow?: boolean
  /** After `slow`: ask again. */
  onCheckAgain?: () => void
  /** The labels the connection always adds for this source (shown as fixed in the form). */
  fixedLabels?: (sync: TrackerSyncLike | undefined) => string[]
  /** The source's own title: the title box's fallback when the template preview can't be read. */
  sourceTitle?: string | null
  /** Open straight on create / link (a record's ⋯ menu); Cancel then calls onClose. */
  initialMode?: TrackerPanelMode
  onClose?: () => void
  /** A create was queued (the host waits for the GitLab issue). */
  onCreated?: () => void
  onChanged: () => void
}

/**
 * The GitLab panel: create a GitLab issue from an issue-log entry, a support ticket or a record,
 * link one that already exists, and — administrators — read it back, resync, unlink and manage
 * the examples on it. One panel for the issue log (admin), tickets and records (admin and every
 * portal). Content only: the host gives it its frame (a section, a sheet block, a popover).
 *
 * Non-admins only ever get what the server lets them do (routes/trackers.ts trackerSourceRoutes):
 * create in the connection's default project with a title, a description and extra labels, or
 * link a non-confidential issue of that project. Similar issues, projects, assignees, resync,
 * unlink and examples are administrators' only — not offered, never read.
 */
export function TrackerLinkPanel(props: TrackerLinkPanelProps) {
  const { admin, link, chip, pending = [], onChanged } = props
  const [mode, setMode] = useState<TrackerPanelMode>(props.initialMode ?? 'idle')
  const createPending = pending.find((p) => p.op === 'create' && p.status !== 'dead')
  const closeOr = (m: TrackerPanelMode) => () => {
    if (props.initialMode && props.initialMode !== 'idle' && props.onClose) props.onClose()
    else setMode(m)
  }
  const done = (created: boolean) => () => {
    if (created) props.onCreated?.()
    onChanged()
    if (props.initialMode && props.initialMode !== 'idle' && props.onClose) props.onClose()
    else setMode('idle')
  }

  return (
    <div data-tracker-panel={link || chip ? 'linked' : 'unlinked'} className='space-y-3'>
      {admin && link ? (
        <LinkedView {...props} link={link} />
      ) : chip ? (
        <PersonLinked chip={chip} />
      ) : createPending || props.creating ? (
        <p
          className='flex flex-wrap items-center gap-2 text-[12.5px] text-slate-700 dark:text-foreground'
          role='status'
          data-gitlab-creating
        >
          <RefreshCw className='h-3.5 w-3.5 animate-spin text-muted-foreground' aria-hidden />
          Creating the GitLab issue…
          {createPending && createPending.attempts > 0 && createPending.last_error && (
            <span className='text-muted-foreground'>
              Trying again {formatRelative(createPending.next_attempt_at ?? '')}
            </span>
          )}
        </p>
      ) : mode === 'create' ? (
        <CreatePanel {...props} onCancel={closeOr('idle')} onDone={done(true)} />
      ) : mode === 'link' ? (
        <LinkExistingPanel {...props} onCancel={closeOr('idle')} onDone={done(false)} />
      ) : (
        <>
          {props.slow && <Stalled onCheckAgain={props.onCheckAgain} />}
          <Unlinked
            {...props}
            onCreate={() => setMode('create')}
            onLink={() => setMode('link')}
            onQuickCreated={done(true)}
          />
        </>
      )}
      {admin && <PendingChanges pending={pending} onChanged={onChanged} />}
    </div>
  )
}

/** Asked for over 2 minutes ago and still not in GitLab: say so and offer to look again. */
function Stalled({ onCheckAgain }: { onCheckAgain?: () => void }) {
  return (
    <div
      role='status'
      data-gitlab-stalled
      className='flex flex-wrap items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200'
    >
      <span className='min-w-0 flex-1'>
        GitLab has not answered yet. The issue shows here once it is made; if it does not, create it
        again.
      </span>
      {onCheckAgain && (
        <button type='button' className={QUIET_BTN} onClick={onCheckAgain}>
          <RefreshCw className='h-3 w-3' aria-hidden />
          Check again
        </button>
      )}
    </div>
  )
}

// ── Linked, as a non-admin reads it ─────────────────────────────────────────

function PersonLinked({ chip }: { chip: TrackerChipData }) {
  const href = safeHref(chip.web_url)
  return (
    <p className='flex flex-wrap items-center gap-2 text-[12.5px] text-slate-700 dark:text-foreground'>
      <TrackerChip tracker={chip} />
      <span>In GitLab as issue #{chip.iid}.</span>
      {href && (
        <a
          href={href}
          target='_blank'
          rel='noreferrer noopener'
          className='inline-flex items-center gap-1 font-medium text-nvr-navy hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:text-nvr-cyan'
        >
          Open in GitLab
          <ExternalLink className='h-3 w-3' aria-hidden />
        </a>
      )}
    </p>
  )
}

// ── Not linked ──────────────────────────────────────────────────────────────

function Unlinked({
  source,
  admin,
  connections,
  suggestedRule,
  onCreate,
  onLink,
  onQuickCreated
}: TrackerLinkPanelProps & {
  onCreate: () => void
  onLink: () => void
  onQuickCreated: () => void
}) {
  const client = useNivaroClient()
  const ruleId = admin ? (suggestedRule ?? null) : null
  const rules = useQuery({
    queryKey: trackerQueryKeys.rules(),
    queryFn: () =>
      client
        .request<{ data: Array<{ id: number; name: string; connection: number }> }>(
          get('/trackers/rules')
        )
        .then((r) => r.data ?? []),
    enabled: ruleId != null,
    staleTime: 60_000
  })
  const rule = rules.data?.find((r) => r.id === ruleId)
  // The suggesting rule's own connection (never simply the first one), and only while that
  // connection still takes this kind; until the rule is read the button waits.
  const ruleConn = rule ? connections.find((c) => c.id === rule.connection) : undefined
  // One-click create from a rule's suggestion: the rule already judged it, nothing to prefill.
  // The rule's own action (labels, templates, assignees, project, type) makes the issue: the
  // server reads it from `rule` and counts it toward the rule's caps.
  const quick = useMutation({
    mutationFn: () =>
      client.request(
        post('/trackers/links', {
          ...sourceBody(source),
          connection: ruleConn?.id ?? 0,
          rule: ruleId
        })
      ),
    onSuccess: () => {
      toast.success('Sending to GitLab')
      onQuickCreated()
    },
    onError: (err) => toastError(err, 'Could not create the GitLab issue')
  })
  return (
    <div className='space-y-3'>
      {ruleId != null && (
        <div
          className='flex flex-wrap items-center gap-2 rounded-md border border-nvr-cyan/30 bg-nvr-cyan/[0.06] px-3 py-2 text-[12.5px] text-slate-800 dark:text-foreground'
          data-gitlab-suggested
        >
          <Sparkles className='h-3.5 w-3.5 shrink-0 text-nvr-navy dark:text-nvr-cyan' aria-hidden />
          <span className='min-w-0 flex-1'>
            Suggested for GitLab
            {rule?.name ? (
              <>
                {' '}
                by the rule <span className='font-medium'>{rule.name}</span>
              </>
            ) : null}
            .
          </span>
          <Button
            size='sm'
            className={PRIMARY}
            disabled={quick.isPending || quick.isSuccess || !ruleConn}
            data-tip={
              rule && !ruleConn
                ? "The rule's connection is paused or no longer takes issue-log entries"
                : undefined
            }
            onClick={() => quick.mutate()}
          >
            {quick.isPending ? 'Sending…' : 'Create it'}
          </Button>
        </div>
      )}
      <p className='text-[12.5px] text-muted-foreground'>
        Not in GitLab yet. Create a GitLab issue from this {KIND_NOUN[source.kind]}, or link one
        that already exists.
      </p>
      <div className='flex flex-wrap gap-2'>
        <Button
          size='sm'
          className={ruleId != null ? 'h-7 gap-1.5 text-[12px]' : PRIMARY}
          variant={ruleId != null ? 'outline' : 'default'}
          onClick={onCreate}
          aria-label='Create GitLab issue'
        >
          <Gitlab className='h-3.5 w-3.5' aria-hidden />
          Create GitLab issue
        </Button>
        <Button size='sm' variant='outline' className='h-7 gap-1.5 text-[12px]' onClick={onLink}>
          <Link2 className='h-3.5 w-3.5' aria-hidden />
          Link existing
        </Button>
      </div>
    </div>
  )
}

function ConnectionPick({
  connections,
  value,
  onChange
}: {
  connections: TrackerConnectionInfo[]
  value: number
  onChange: (id: number) => void
}) {
  if (connections.length < 2) return null
  return (
    <div className='space-y-1'>
      <p className={FIELD_LABEL}>Connection</p>
      <PickList
        ariaLabel='GitLab connection'
        placeholder='Choose a connection'
        value={[value]}
        options={connections.map((c) => ({ value: c.id, label: c.name }))}
        onChange={(v) => v[0] && onChange(v[0])}
      />
    </div>
  )
}

// ── Create (administrators: similar candidates first) ──────────────────────

function CreatePanel(props: TrackerLinkPanelProps & { onCancel: () => void; onDone: () => void }) {
  const { source, admin, connections, onCancel } = props
  const client = useNivaroClient()
  const [connectionId, setConnectionId] = useState(connections[0]?.id ?? 0)
  const conn = connections.find((c) => c.id === connectionId) ?? connections[0]
  const [createAnyway, setCreateAnyway] = useState(false)

  const similar = useQuery({
    queryKey: trackerQueryKeys.similar(source.kind, source.id, conn?.id ?? 0),
    queryFn: () =>
      client
        .request<{ data: SimilarCandidate[] }>(
          post('/trackers/links/similar', { ...sourceBody(source), connection: conn?.id ?? 0 })
        )
        .then((r) => r.data ?? []),
    enabled: admin && !!conn,
    retry: false,
    staleTime: 60_000
  })

  const join = useMutation({
    mutationFn: (c: SimilarCandidate) =>
      client.request(
        post('/trackers/links/join', {
          ...sourceBody(source),
          connection: conn?.id ?? 0,
          ...(c.link_id ? { link: c.link_id } : { project_id: c.project_id, iid: c.iid }),
          score: c.score
        })
      ),
    onSuccess: (_r, c) => {
      toast.success(`Added as an example of #${c.iid}`)
      props.onChanged()
      onCancel()
    },
    onError: (err) => toastError(err, 'Could not add it to that GitLab issue')
  })

  const candidates = similar.data ?? []
  const showCandidates = admin && !createAnyway && candidates.length > 0

  return (
    <div className='space-y-3' data-gitlab-create>
      <ConnectionPick
        connections={connections}
        value={connectionId}
        onChange={(id) => {
          setConnectionId(id)
          setCreateAnyway(false)
        }}
      />
      {admin && similar.isLoading ? (
        <div className='space-y-2' aria-live='polite'>
          <p className='text-[12px] text-muted-foreground'>
            Looking for GitLab issues like this one…
          </p>
          <Skeleton className='h-9 w-full' />
        </div>
      ) : showCandidates ? (
        <div className='space-y-2'>
          <ul className='space-y-1.5' aria-label='GitLab issues like this one'>
            {candidates.map((c) => {
              const href = safeHref(c.web_url)
              return (
                <li
                  key={`${c.project_id}:${c.iid}`}
                  className='flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 dark:border-border dark:bg-muted/30'
                >
                  <p className='min-w-0 flex-1 text-[12.5px] text-slate-800 dark:text-foreground'>
                    Looks like{' '}
                    {href ? (
                      <a
                        href={href}
                        target='_blank'
                        rel='noreferrer noopener'
                        className='font-medium tabular-nums text-nvr-navy hover:underline dark:text-nvr-cyan'
                      >
                        #{c.iid}
                      </a>
                    ) : (
                      <span className='font-medium tabular-nums'>#{c.iid}</span>
                    )}{' '}
                    (<span className='tabular-nums'>{percent(c.score)}</span>)
                    <span className='block truncate text-[12px] text-muted-foreground'>
                      {c.title}
                    </span>
                  </p>
                  <Button
                    size='sm'
                    variant='outline'
                    className='h-7 text-[12px]'
                    disabled={join.isPending}
                    onClick={() => join.mutate(c)}
                    aria-label={`Add as example of #${c.iid}`}
                  >
                    Add as example
                  </Button>
                </li>
              )
            })}
          </ul>
          <div className='flex flex-wrap justify-end gap-2'>
            <Button variant='ghost' size='sm' className='h-7 text-[12px]' onClick={onCancel}>
              Cancel
            </Button>
            <Button
              variant='outline'
              size='sm'
              className='h-7 text-[12px]'
              onClick={() => setCreateAnyway(true)}
            >
              Create new anyway
            </Button>
          </div>
        </div>
      ) : conn ? (
        admin ? (
          <AdminCreateForm key={conn.id} {...props} conn={conn} />
        ) : (
          <PersonCreateForm key={conn.id} {...props} conn={conn} />
        )
      ) : null}
    </div>
  )
}

function FixedLabels({ labels }: { labels: string[] }) {
  if (!labels.length) return null
  return (
    <p className='flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground'>
      <span className='mr-0.5'>Always added by the connection:</span>
      {labels.map((l) => (
        <span
          key={l}
          className='rounded border border-slate-200 bg-slate-50 px-1.5 py-px text-[11px] text-slate-700 dark:border-border dark:bg-muted/40 dark:text-slate-200'
        >
          {l}
        </span>
      ))}
    </p>
  )
}

function FormButtons({
  pending,
  onCancel,
  label
}: {
  pending: boolean
  onCancel: () => void
  label: string
}) {
  return (
    <div className='flex justify-end gap-2'>
      <Button
        type='button'
        variant='ghost'
        size='sm'
        className='h-7 text-[12px]'
        onClick={onCancel}
      >
        Cancel
      </Button>
      <Button type='submit' size='sm' className={PRIMARY} disabled={pending}>
        {pending ? 'Sending…' : label}
      </Button>
    </div>
  )
}

/** The kinds the server can render a template preview for (POST /trackers/rules/sample). */
const SAMPLE_KINDS = new Set(['issue', 'ticket'])

function AdminCreateForm({
  source,
  conn,
  fixedLabels,
  sourceTitle,
  onCancel,
  onDone
}: TrackerLinkPanelProps & {
  conn: TrackerConnectionInfo
  onCancel: () => void
  onDone: () => void
}) {
  const client = useNivaroClient()
  const hasSample = SAMPLE_KINDS.has(source.kind)
  const sample = useQuery({
    queryKey: trackerQueryKeys.sample(source.kind, source.id),
    queryFn: () =>
      client
        .request<{ data: TemplateSample }>(
          post('/trackers/rules/sample', { applies_to: source.kind, source_id: source.id })
        )
        .then((r) => r.data),
    enabled: hasSample,
    retry: false,
    staleTime: 60_000
  })
  const [title, setTitle] = useState<string | null>(null)
  const shownTitle = title ?? sample.data?.title ?? (sample.isError ? (sourceTitle ?? '') : '')
  const [description, setDescription] = useState('')
  useUnsavedWork(description.trim() !== '', 'GitLab issue description')
  const [projectId, setProjectId] = useState(0)
  const [extraLabels, setExtraLabels] = useState<string[]>([])
  const [assignees, setAssignees] = useState<number[]>([])
  const fixed = useMemo(
    () => (fixedLabels ? fixedLabels(conn.sync) : alwaysLabels(conn.sync)),
    [fixedLabels, conn.sync]
  )
  const tokenSet = conn.token_set !== false

  const [projectSearch, setProjectSearch] = useState('')
  const projectQ = useDebounced(projectSearch, 250)
  const projects = useQuery({
    queryKey: trackerQueryKeys.projects(conn.id, projectQ),
    queryFn: () =>
      client
        .request<{ data: GitlabProject[] }>(
          get(`/trackers/${conn.id}/projects`, { search: projectQ })
        )
        .then((r) => r.data),
    enabled: tokenSet,
    placeholderData: keepPreviousData,
    staleTime: 60_000
  })
  const [paths, setPaths] = useState<Map<number, string>>(() => new Map())
  const projectOptions = [
    {
      value: 0,
      label: conn.default_project_path
        ? `Default project (${conn.default_project_path})`
        : 'Default project'
    },
    ...(projects.data ?? []).map((p) => ({ value: p.id, label: p.path_with_namespace }))
  ]
  if (projectId && !projectOptions.some((o) => o.value === projectId))
    projectOptions.push({ value: projectId, label: paths.get(projectId) ?? `Project ${projectId}` })

  // The labels of the project the issue goes to (the picked one, else the default).
  const labelProject = projectId || conn.default_project_id || null
  const labels = useQuery({
    queryKey: trackerQueryKeys.labels(conn.id, labelProject),
    queryFn: () =>
      client
        .request<{ data: GitlabLabel[] }>(
          get(`/trackers/${conn.id}/labels`, projectId ? { project: projectId } : undefined)
        )
        .then((r) => r.data),
    enabled: tokenSet && labelProject != null,
    staleTime: 60_000,
    retry: false
  })

  const assigneeProject = projectId || conn.default_project_id || 0
  const [userSearch, setUserSearch] = useState('')
  const userQ = useDebounced(userSearch, 250)
  const users = useQuery({
    queryKey: trackerQueryKeys.users(conn.id, assigneeProject, userQ),
    queryFn: () =>
      client
        .request<{ data: GitlabUser[] }>(
          get(`/trackers/${conn.id}/users`, { search: userQ, project: assigneeProject })
        )
        .then((r) => r.data),
    enabled: tokenSet && assigneeProject > 0,
    placeholderData: keepPreviousData,
    staleTime: 60_000
  })
  const [userNames, setUserNames] = useState<Map<number, string>>(() => new Map())
  useEffect(() => {
    if (!users.data?.length) return
    setUserNames((m) => {
      const next = new Map(m)
      for (const u of users.data) next.set(u.id, `${u.name} (@${u.username})`)
      return next
    })
  }, [users.data])
  const userOptions = [
    ...(users.data ?? []).map((u) => ({ value: u.id, label: `${u.name} (@${u.username})` })),
    ...assignees
      .filter((id) => !(users.data ?? []).some((u) => u.id === id))
      .map((id) => ({ value: id, label: userNames.get(id) ?? `User ${id}` }))
  ]

  const create = useMutation({
    mutationFn: () =>
      client.request(
        post('/trackers/links', {
          ...sourceBody(source),
          connection: conn.id,
          ...(projectId ? { project_id: projectId } : {}),
          overrides: {
            ...(shownTitle.trim() ? { title: shownTitle.trim() } : {}),
            ...(!hasSample && description.trim() ? { description: description.trim() } : {}),
            labels: extraLabels,
            assignee_ids: assignees
          }
        })
      ),
    onSuccess: () => {
      toast.success('Sending to GitLab')
      onDone()
    },
    onError: (err) => toastError(err, 'Could not create the GitLab issue')
  })

  const labelHint = !labelProject
    ? 'Pick a project, or set a default one on the connection, to list its labels. You can still type one.'
    : labels.isError
      ? 'GitLab did not list the labels. You can still type one.'
      : null
  const idBase = `gitlab-${source.kind}-${source.id}`

  return (
    <form
      className='space-y-3'
      onSubmit={(e) => {
        e.preventDefault()
        if (!create.isPending) create.mutate()
      }}
    >
      <div className='grid gap-3 sm:grid-cols-2'>
        <div className='space-y-1 sm:col-span-2'>
          <label htmlFor={`${idBase}-title`} className={FIELD_LABEL}>
            Title
          </label>
          {hasSample && sample.isLoading && title === null ? (
            <Skeleton className='h-8 w-full' />
          ) : (
            <Input
              id={`${idBase}-title`}
              aria-label='GitLab issue title'
              value={shownTitle}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={hasSample ? undefined : 'Leave empty for the standard title'}
              maxLength={255}
              className='h-8 text-[12.5px]'
            />
          )}
        </div>
        <div className='space-y-1'>
          <p className={FIELD_LABEL}>Project</p>
          <PickList
            ariaLabel='GitLab project'
            placeholder='Default project'
            value={[projectId]}
            options={projectOptions}
            onSearch={setProjectSearch}
            loading={projects.isFetching}
            emptyText='No project matches.'
            onChange={(v) => {
              const next = v[0] ?? 0
              const p = projects.data?.find((x) => x.id === next)
              if (p) setPaths((m) => new Map(m).set(p.id, p.path_with_namespace))
              setProjectId(next)
              setAssignees([])
            }}
          />
        </div>
        <div className='space-y-1'>
          <p className={FIELD_LABEL}>Assignees</p>
          <PickList
            multi
            ariaLabel='GitLab assignees'
            placeholder='No one'
            value={assignees}
            options={userOptions}
            onSearch={setUserSearch}
            loading={users.isFetching}
            emptyText={assigneeProject ? 'No one matches.' : 'Choose a project first.'}
            onChange={setAssignees}
          />
        </div>
        <div className='space-y-1 sm:col-span-2'>
          <p className={FIELD_LABEL}>Labels</p>
          <FixedLabels labels={fixed} />
          <LabelPicker
            multi
            labels={labels.data}
            unavailable={labelHint}
            ariaLabel='More GitLab labels'
            placeholder='Add labels'
            value={extraLabels}
            onChange={setExtraLabels}
          />
        </div>
      </div>
      {hasSample ? (
        <div className='space-y-1'>
          <p className={FIELD_LABEL}>Description (made from the {KIND_NOUN[source.kind]})</p>
          <div className='max-h-56 overflow-auto rounded-md border border-slate-200 bg-slate-50 px-3 py-2 dark:border-border dark:bg-muted/30'>
            {sample.isLoading ? (
              <div className='space-y-1.5'>
                <Skeleton className='h-3 w-4/5' />
                <Skeleton className='h-3 w-3/5' />
              </div>
            ) : sample.isError ? (
              <ErrorNotice error={sample.error} what='the description preview' />
            ) : (
              <AiMarkdown
                content={sample.data?.body ?? ''}
                autolink={false}
                className='text-[12px] text-slate-800 dark:text-slate-100'
              />
            )}
          </div>
        </div>
      ) : (
        <DescriptionBox
          id={`${idBase}-description`}
          value={description}
          onChange={setDescription}
          noun={KIND_NOUN[source.kind]}
        />
      )}
      <FormButtons pending={create.isPending} onCancel={onCancel} label='Create in GitLab' />
    </form>
  )
}

function DescriptionBox({
  id,
  value,
  onChange,
  noun
}: {
  id: string
  value: string
  onChange: (v: string) => void
  noun: string
}) {
  return (
    <div className='space-y-1'>
      <label htmlFor={id} className={FIELD_LABEL}>
        Description
      </label>
      <textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        maxLength={20_000}
        placeholder={`Leave empty to send the ${noun}'s details`}
        className={TEXTAREA}
      />
      <p className='text-[11px] text-muted-foreground'>
        A link back to this {noun} is always added.
      </p>
    </div>
  )
}

/**
 * A non-admin's create: the connection's default project only, with a title, a description and
 * extra labels (all optional) — exactly what the server takes from them (personOverrides).
 */
function PersonCreateForm({
  source,
  conn,
  onCancel,
  onDone
}: TrackerLinkPanelProps & {
  conn: TrackerConnectionInfo
  onCancel: () => void
  onDone: () => void
}) {
  const client = useNivaroClient()
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [labels, setLabels] = useState<string[]>([])
  useUnsavedWork(
    title.trim() !== '' || description.trim() !== '',
    'GitLab issue title and description'
  )
  const create = useMutation({
    mutationFn: () => {
      const overrides: Record<string, unknown> = {}
      if (title.trim()) overrides.title = title.trim()
      if (description.trim()) overrides.description = description.trim()
      if (labels.length) overrides.labels = labels
      return client.request(
        post('/trackers/links', {
          ...sourceBody(source),
          connection: conn.id,
          ...(Object.keys(overrides).length ? { overrides } : {})
        })
      )
    },
    onSuccess: () => {
      toast.success('Sending to GitLab')
      onDone()
    },
    onError: (err) => toastError(err, 'Could not create the GitLab issue')
  })
  const idBase = `gitlab-${source.kind}-${source.id}`
  return (
    <form
      className='space-y-3'
      onSubmit={(e) => {
        e.preventDefault()
        if (!create.isPending) create.mutate()
      }}
    >
      {conn.default_project_path && (
        <p className='text-[12px] text-muted-foreground'>
          Goes to <span className='font-mono text-[11.5px]'>{conn.default_project_path}</span>.
        </p>
      )}
      <div className='space-y-1'>
        <label htmlFor={`${idBase}-title`} className={FIELD_LABEL}>
          Title
        </label>
        <Input
          id={`${idBase}-title`}
          aria-label='GitLab issue title'
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder='Leave empty for the standard title'
          maxLength={255}
          className='h-8 text-[12.5px]'
        />
      </div>
      <DescriptionBox
        id={`${idBase}-description`}
        value={description}
        onChange={setDescription}
        noun={KIND_NOUN[source.kind]}
      />
      <div className='space-y-1'>
        <p className={FIELD_LABEL}>Labels (optional)</p>
        <LabelPicker
          multi
          labels={undefined}
          unavailable='Type a label name. The connection adds its own labels too.'
          ariaLabel='GitLab labels'
          placeholder='Add labels'
          value={labels}
          onChange={setLabels}
        />
      </div>
      <FormButtons pending={create.isPending} onCancel={onCancel} label='Create in GitLab' />
    </form>
  )
}

// ── Link existing ───────────────────────────────────────────────────────────

function LinkExistingPanel({
  source,
  admin,
  connections,
  onCancel,
  onDone
}: TrackerLinkPanelProps & { onCancel: () => void; onDone: () => void }) {
  const client = useNivaroClient()
  const [url, setUrl] = useState('')
  const [connectionId, setConnectionId] = useState(connections[0]?.id ?? 0)
  // A pasted URL picks the connection on the same host (administrators know the hosts).
  useEffect(() => {
    const match = connectionForUrl(url, connections)
    if (match) setConnectionId(match.id)
  }, [url, connections])
  const conn = connections.find((c) => c.id === connectionId) ?? connections[0]
  const linkMut = useMutation({
    mutationFn: () =>
      client.request(
        post('/trackers/links/existing', {
          ...sourceBody(source),
          connection: connectionId,
          url: url.trim()
        })
      ),
    onSuccess: () => {
      toast.success('Linked to GitLab')
      onDone()
    },
    onError: (err) => toastError(err, 'Could not link that GitLab issue')
  })
  const id = `gitlab-url-${source.kind}-${source.id}`
  const placeholder = admin
    ? `${conn?.base_url ?? 'https://gitlab.example.com'}/group/project/-/issues/482`
    : `https://…/${conn?.default_project_path ?? 'group/project'}/-/issues/482`
  return (
    <form
      className='space-y-2'
      onSubmit={(e) => {
        e.preventDefault()
        if (url.trim() && !linkMut.isPending) linkMut.mutate()
      }}
    >
      <label htmlFor={id} className={FIELD_LABEL}>
        Link of the GitLab issue
      </label>
      <Input
        id={id}
        autoFocus
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder={placeholder}
        className='h-8 font-mono text-[12px]'
      />
      {!admin && (
        <p className='text-[11px] text-muted-foreground'>
          {conn?.default_project_path
            ? `An issue in ${conn.default_project_path} that is not confidential.`
            : "An issue in the connection's project that is not confidential."}
        </p>
      )}
      <ConnectionPick connections={connections} value={connectionId} onChange={setConnectionId} />
      <div className='flex justify-end gap-2'>
        <Button
          type='button'
          variant='ghost'
          size='sm'
          className='h-7 text-[12px]'
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          type='submit'
          size='sm'
          className={PRIMARY}
          disabled={!url.trim() || linkMut.isPending}
        >
          {linkMut.isPending ? 'Linking…' : 'Link'}
        </Button>
      </div>
    </form>
  )
}

// ── Linked (administrators) ────────────────────────────────────────────────

/** DELETE route that takes a source off its GitLab issue. */
const unlinkPath = (kind: string, id: string) =>
  kind === 'issue'
    ? `/trackers/links/issue/${encodeURIComponent(id)}`
    : `/trackers/links/source/${kind}/${encodeURIComponent(id)}`

function LinkedView(props: TrackerLinkPanelProps & { link: TrackerLink }) {
  const { source, link, onChanged } = props
  const client = useNivaroClient()
  const href = safeHref(link.web_url)
  const resync = useMutation({
    mutationFn: () => client.request(post(`/trackers/links/${link.id}/resync`)),
    onSuccess: () => {
      toast.success('Read again from GitLab')
      onChanged()
    },
    onError: (err) => {
      toastError(err, 'GitLab did not answer')
      onChanged()
    }
  })
  const unlink = useMutation({
    mutationFn: () => client.request(del(unlinkPath(source.kind, source.id))),
    onSuccess: () => {
      toast.success('Unlinked from GitLab')
      onChanged()
    },
    onError: (err) => toastError(err, 'Could not unlink it')
  })
  const move = useMutation({
    mutationFn: (issueId: number) =>
      client.request(
        post('/trackers/links/move-to-new', { issue: issueId, connection: link.connection })
      ),
    onSuccess: () => {
      toast.success('Opening a new GitLab issue for it')
      onChanged()
    },
    onError: (err) => toastError(err, 'Could not move it to a new GitLab issue')
  })
  const busy = resync.isPending || unlink.isPending || move.isPending
  const closed = link.remote_state === 'closed'
  // Move to a new GitLab issue: the route moves issue-log entries only.
  const others = source.kind === 'issue' && link.sources.length > 1

  return (
    <div className='space-y-3'>
      <div className='space-y-1'>
        <p className='flex flex-wrap items-baseline gap-x-2 gap-y-0.5'>
          {href ? (
            <a
              href={href}
              target='_blank'
              rel='noreferrer noopener'
              className='inline-flex min-w-0 items-baseline gap-1.5 text-[13px] font-medium text-slate-900 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:text-foreground'
            >
              <span className='tabular-nums text-muted-foreground'>#{link.iid}</span>
              <span className='min-w-0 [text-wrap:pretty]'>{link.remote_title}</span>
              <ExternalLink className='h-3 w-3 shrink-0 self-center text-muted-foreground' />
            </a>
          ) : (
            <span className='text-[13px] font-medium'>
              #{link.iid} {link.remote_title}
            </span>
          )}
        </p>
        <p className='flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-muted-foreground'>
          <span
            className={cn(
              'rounded border px-1.5 py-px text-[10.5px] font-medium',
              closed
                ? 'border-slate-300 text-slate-600 dark:border-border dark:text-muted-foreground'
                : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
            )}
          >
            {stateWord(link.remote_state)}
          </span>
          <span className='font-mono'>{link.project_path}</span>
          {link.milestone && <span>Milestone {link.milestone}</span>}
          {link.assignees.map((a) => (
            <span key={a}>@{a}</span>
          ))}
        </p>
        {link.labels.length > 0 && (
          <p className='flex flex-wrap gap-1 pt-0.5'>
            {link.labels.map((l) => (
              <span
                key={l}
                className='rounded border border-slate-200 bg-slate-50 px-1.5 py-px text-[11px] text-slate-700 dark:border-border dark:bg-muted/40 dark:text-slate-200'
              >
                {l}
              </span>
            ))}
          </p>
        )}
      </div>

      {link.sync_error && (
        <div role='alert' className={ALERT}>
          <span className='min-w-0 flex-1'>
            <span className='font-medium'>Could not read it from GitLab. </span>
            <span className='break-words'>{link.sync_error}</span>
          </span>
          <button
            type='button'
            className={QUIET_BTN}
            disabled={busy}
            onClick={() => resync.mutate()}
          >
            <RefreshCw className={cn('h-3 w-3', resync.isPending && 'animate-spin')} />
            Retry
          </button>
        </div>
      )}

      <div className='flex flex-wrap gap-2'>
        {!link.sync_error && (
          <button
            type='button'
            className={QUIET_BTN}
            disabled={busy}
            onClick={() => resync.mutate()}
          >
            <RefreshCw className={cn('h-3 w-3', resync.isPending && 'animate-spin')} />
            Resync
          </button>
        )}
        {others && (
          <ConfirmButton
            className={QUIET_BTN}
            armedClassName={ARMED}
            disabled={busy}
            onConfirm={() => move.mutate(Number(source.id))}
            title='Move to a new GitLab issue'
            confirmLabel='Open a new one for it?'
          >
            Move to a new GitLab issue
          </ConfirmButton>
        )}
        <ConfirmButton
          className={QUIET_BTN}
          armedClassName={ARMED}
          disabled={busy}
          onConfirm={() => unlink.mutate()}
          title='Unlink from GitLab'
          confirmLabel='Unlink? GitLab keeps its issue'
        >
          Unlink
        </ConfirmButton>
      </div>

      <Examples {...props} onMove={(id) => move.mutate(id)} />
    </div>
  )
}

/** The other things on the GitLab issue (the issue log names them; tickets/records list them). */
function examplesOf(
  source: TrackerSourceRef,
  link: TrackerLink,
  members: TrackerMember[] | undefined
): TrackerMember[] {
  const all =
    members ??
    link.sources.map((s) => ({
      kind: s.kind,
      id: s.id,
      title: null,
      status: null,
      joined_via: '',
      joined_at: null
    }))
  return all.filter((m) => !(m.kind === source.kind && String(m.id) === String(source.id)))
}

function Examples({
  source,
  link,
  members,
  membersTotal,
  onChanged,
  onMove
}: TrackerLinkPanelProps & { link: TrackerLink; onMove: (issueId: number) => void }) {
  const client = useNivaroClient()
  const nav = useNavigation()
  const list = examplesOf(source, link, members)
  const total = Math.max(
    list.length,
    membersTotal != null ? membersTotal - 1 : link.sources.length - 1
  )
  const remove = useMutation({
    mutationFn: (m: { kind: string; id: string }) => client.request(del(unlinkPath(m.kind, m.id))),
    onSuccess: () => {
      toast.success('Removed from this GitLab issue')
      onChanged()
    },
    onError: (err) => toastError(err, 'Could not remove it')
  })
  if (!list.length) return null
  const issueHref = (id: string) => {
    const path = `/issues/${encodeURIComponent(id)}`
    return nav.consoleUrl ? nav.consoleUrl(path) : path
  }
  const openIssue = (e: MouseEvent, id: string) => {
    // The admin app (no consoleUrl): stay in the app. Other hosts follow their console link.
    if (nav.consoleUrl || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
    e.preventDefault()
    nav.navigate(`/issues/${encodeURIComponent(id)}`)
  }
  return (
    <div className='space-y-1.5 border-t border-slate-100 pt-3 dark:border-border/60'>
      <p className='text-[12px] font-medium text-slate-700 dark:text-foreground'>
        Examples on this GitLab issue
        <span className='ml-1 font-normal tabular-nums text-muted-foreground'>{total}</span>
      </p>
      <ul
        aria-label='Examples on this GitLab issue'
        className='divide-y divide-slate-100 rounded-md border border-slate-200 dark:divide-border/60 dark:border-border'
      >
        {list.map((m) => {
          const name = memberName(m)
          const href = m.kind === 'issue' ? issueHref(m.id) : null
          return (
            <li
              key={`${m.kind}:${m.id}`}
              className='group flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 text-[12px]'
            >
              <span className='min-w-0 flex-1'>
                {href ? (
                  <a
                    href={href}
                    onClick={(e) => openIssue(e, m.id)}
                    className='block truncate text-slate-800 hover:underline dark:text-foreground'
                  >
                    <span className='mr-1 font-mono text-[11px] text-muted-foreground'>
                      #{m.id}
                    </span>
                    {name}
                  </a>
                ) : (
                  <span className='block truncate text-slate-800 dark:text-foreground'>{name}</span>
                )}
                {(m.joined_via || m.score != null || m.joined_at) && (
                  <span className='text-[11px] text-muted-foreground'>
                    {m.joined_via ? joinedViaLabel(m.joined_via) : ''}
                    {m.score != null && (
                      <span className='tabular-nums'>
                        {m.joined_via ? ' · ' : ''}
                        {percent(m.score)} match
                      </span>
                    )}
                    {m.joined_at ? ` · ${formatRelative(m.joined_at)}` : ''}
                  </span>
                )}
              </span>
              <span className='flex shrink-0 gap-1'>
                {m.kind === 'issue' && (
                  <ConfirmButton
                    className={QUIET_BTN}
                    armedClassName={ARMED}
                    disabled={remove.isPending}
                    onConfirm={() => onMove(Number(m.id))}
                    title={`Move #${m.id} to a new GitLab issue`}
                    confirmLabel='Open a new one?'
                  >
                    Move to new
                  </ConfirmButton>
                )}
                <ConfirmButton
                  className={QUIET_BTN}
                  armedClassName={ARMED}
                  disabled={remove.isPending}
                  onConfirm={() => remove.mutate(m)}
                  title={`Remove ${name} from this GitLab issue`}
                  confirmLabel='Remove?'
                >
                  Remove
                </ConfirmButton>
              </span>
            </li>
          )
        })}
      </ul>
      {total > list.length && (
        <p className='text-[11px] text-muted-foreground'>
          Showing the newest {list.length} of {total}.
        </p>
      )}
    </div>
  )
}

// ── Waiting / failed changes (administrators) ──────────────────────────────

function PendingChanges({
  pending,
  onChanged
}: {
  pending: TrackerPending[]
  onChanged: () => void
}) {
  const client = useNivaroClient()
  const dead = pending.filter((p) => p.status === 'dead')
  const waiting = pending.filter((p) => p.status !== 'dead' && p.op !== 'create')
  const retry = useMutation({
    mutationFn: (id: number) => client.request(post(`/trackers/outbox/${id}/retry`)),
    onSuccess: () => {
      toast.success('Trying again')
      onChanged()
    },
    onError: (err) => toastError(err, 'Could not try it again')
  })
  if (!dead.length && !waiting.length) return null
  return (
    <div className='space-y-1.5 border-t border-slate-100 pt-3 dark:border-border/60'>
      {waiting.length > 0 && (
        <p className='text-[11.5px] text-muted-foreground'>
          {waiting.length} change{waiting.length === 1 ? '' : 's'} waiting to be sent to GitLab.
        </p>
      )}
      {dead.map((p) => (
        <div key={p.id} role='alert' className={ALERT}>
          <span className='min-w-0 flex-1'>
            <span className='font-medium'>
              Gave up: {OP_WORDS[p.op] ?? p.op} ({p.attempts} tries).{' '}
            </span>
            {p.last_error && <span className='break-words'>{p.last_error}</span>}
          </span>
          <button
            type='button'
            className={QUIET_BTN}
            disabled={retry.isPending}
            onClick={() => retry.mutate(p.id)}
          >
            <RefreshCw className='h-3 w-3' />
            Retry
          </button>
        </div>
      ))}
    </div>
  )
}

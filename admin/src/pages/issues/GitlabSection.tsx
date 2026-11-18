import { AiMarkdown, ConfirmButton, ErrorNotice, toastError } from '@nivaro/shared'
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query'
import { ExternalLink, Gitlab, Link2, RefreshCw, Sparkles } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { cn, formatRelative } from '@/lib/utils'
import {
  fetchGitlabUsers,
  fetchLabels,
  fetchProjects,
  fetchRules,
  type TemplateSample,
  type TrackerConnection,
  trackerKeys
} from '../issue-trackers/api'
import { LabelPicker } from '../issue-trackers/LabelPicker'
import { useDebounced } from '../issue-trackers/RulePreview'
import { PickList } from '../issue-trackers/rule-fields'
import {
  connectionLabelsFor,
  type IssueTrackerFields,
  isLink,
  issueGitlabKeys,
  joinedViaLabel,
  percent,
  type SimilarCandidate,
  safeHref,
  stateWord,
  type TrackerLink,
  type TrackerPending,
  useIssueGitlab
} from './gitlab'
import { Section } from './section'
import type { Issue } from './types'

type GitlabIssue = Issue & IssueTrackerFields

const PRIMARY = 'h-7 gap-1.5 bg-nvr-cyan text-[12px] text-white hover:bg-nvr-cyan/90'
const QUIET_BTN =
  'inline-flex h-7 items-center gap-1 rounded-md border border-slate-200 bg-white px-2 text-[12px] font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan disabled:opacity-50 dark:border-border dark:bg-card dark:text-foreground dark:hover:bg-muted'
const ARMED = 'border-red-300 text-red-700 dark:border-red-500/50 dark:text-red-300'

const OP_WORDS: Record<string, string> = {
  create: 'Create the GitLab issue',
  note: 'Post a note',
  state: 'Change its state',
  labels: 'Change its labels',
  comment: 'Send a comment'
}

/**
 * The issue detail panel's GitLab section — administrators only, and only while GitLab sync is on
 * with at least one active connection that takes issue-log entries (useIssueGitlab). Everyone else
 * sees the chip in the header and the comment notice/badges.
 */
export function IssueGitlabSection({
  issue,
  onChanged
}: {
  issue: GitlabIssue
  onChanged: () => void
}) {
  const gate = useIssueGitlab()
  if (!gate.adminTools) return null
  return <GitlabSection issue={issue} connections={gate.connections} onChanged={onChanged} />
}

function GitlabSection({
  issue,
  connections,
  onChanged
}: {
  issue: GitlabIssue
  connections: TrackerConnection[]
  onChanged: () => void
}) {
  const link = isLink(issue.tracker) ? issue.tracker : null
  const pending = issue.tracker_pending ?? []
  // The detail panel is keyed by issue: a new issue starts idle.
  const [mode, setMode] = useState<'idle' | 'create' | 'link'>('idle')
  const conn = (link && connections.find((c) => c.id === link.connection)) || connections[0]
  const creating = pending.find((p) => p.op === 'create' && p.status !== 'dead')

  return (
    <Section
      title={
        <>
          <Gitlab className='h-3.5 w-3.5 text-orange-600 dark:text-orange-400' aria-hidden />
          GitLab
        </>
      }
      action={
        connections.length > 1 && conn ? (
          <span className='text-[11px] text-muted-foreground'>{conn.name}</span>
        ) : undefined
      }
      data-issue-gitlab={link ? 'linked' : 'unlinked'}
    >
      {link ? (
        <LinkedView issue={issue} link={link} onChanged={onChanged} />
      ) : creating ? (
        <p className='flex items-center gap-2 text-[12.5px] text-slate-700 dark:text-foreground'>
          <RefreshCw className='h-3.5 w-3.5 animate-spin text-muted-foreground' aria-hidden />
          Creating the GitLab issue…
          {creating.attempts > 0 && creating.last_error && (
            <span className='text-muted-foreground'>
              Trying again {formatRelative(creating.next_attempt_at ?? '')}
            </span>
          )}
        </p>
      ) : mode === 'create' ? (
        <CreatePanel
          issue={issue}
          connections={connections}
          onCancel={() => setMode('idle')}
          onDone={() => {
            setMode('idle')
            onChanged()
          }}
        />
      ) : mode === 'link' ? (
        <LinkExistingPanel
          issue={issue}
          connections={connections}
          onCancel={() => setMode('idle')}
          onDone={() => {
            setMode('idle')
            onChanged()
          }}
        />
      ) : (
        <Unlinked
          issue={issue}
          connection={conn}
          onCreate={() => setMode('create')}
          onLink={() => setMode('link')}
          onChanged={onChanged}
        />
      )}
      <PendingChanges pending={pending} onChanged={onChanged} />
    </Section>
  )
}

// ── Not linked ──────────────────────────────────────────────────────────────

function Unlinked({
  issue,
  connection,
  onCreate,
  onLink,
  onChanged
}: {
  issue: GitlabIssue
  connection: TrackerConnection | undefined
  onCreate: () => void
  onLink: () => void
  onChanged: () => void
}) {
  const ruleId = issue.tracker_suggested_rule ?? null
  const rules = useQuery({
    queryKey: trackerKeys.rules(),
    queryFn: fetchRules,
    enabled: ruleId != null,
    staleTime: 60_000
  })
  const ruleName = rules.data?.find((r) => r.id === ruleId)?.name
  // One-click create from a rule's suggestion: the rule already judged it, nothing to prefill.
  const quick = useMutation({
    mutationFn: () =>
      api.post('/trackers/links', { issue: issue.id, connection: connection?.id ?? 0 }),
    onSuccess: () => {
      toast.success('Sending to GitLab')
      onChanged()
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
            {ruleName ? (
              <>
                {' '}
                by the rule <span className='font-medium'>{ruleName}</span>
              </>
            ) : null}
            .
          </span>
          <Button
            size='sm'
            className={PRIMARY}
            disabled={quick.isPending || !connection}
            onClick={() => quick.mutate()}
          >
            {quick.isPending ? 'Sending…' : 'Create it'}
          </Button>
        </div>
      )}
      <p className='text-[12.5px] text-muted-foreground'>
        Not in GitLab yet. Create a GitLab issue from it, or link one that already exists.
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

// ── Create (similar candidates first) ──────────────────────────────────────

function CreatePanel({
  issue,
  connections,
  onCancel,
  onDone
}: {
  issue: GitlabIssue
  connections: TrackerConnection[]
  onCancel: () => void
  onDone: () => void
}) {
  const [connectionId, setConnectionId] = useState(connections[0]?.id ?? 0)
  const conn = connections.find((c) => c.id === connectionId) ?? connections[0]
  const [createAnyway, setCreateAnyway] = useState(false)

  const similar = useQuery({
    queryKey: issueGitlabKeys.similar(issue.id, conn?.id ?? 0, null),
    queryFn: () =>
      api
        .post<{ data: SimilarCandidate[] }>('/trackers/links/similar', {
          issue: issue.id,
          connection: conn?.id ?? 0
        })
        .then((r) => r.data.data ?? []),
    enabled: !!conn,
    retry: false,
    staleTime: 60_000
  })

  const join = useMutation({
    mutationFn: (c: SimilarCandidate) =>
      api.post('/trackers/links/join', {
        issue: issue.id,
        connection: conn?.id ?? 0,
        ...(c.link_id ? { link: c.link_id } : { project_id: c.project_id, iid: c.iid }),
        score: c.score
      }),
    onSuccess: (_r, c) => {
      toast.success(`Added as an example of #${c.iid}`)
      onDone()
    },
    onError: (err) => toastError(err, 'Could not add it to that GitLab issue')
  })

  const candidates = similar.data ?? []
  const showCandidates = !createAnyway && candidates.length > 0

  return (
    <div className='space-y-3' data-gitlab-create>
      {connections.length > 1 && (
        <div className='space-y-1'>
          <p className='text-[11.5px] text-slate-600 dark:text-muted-foreground'>Connection</p>
          <PickList
            ariaLabel='GitLab connection'
            placeholder='Choose a connection'
            value={[connectionId]}
            options={connections.map((c) => ({ value: c.id, label: c.name }))}
            onChange={(v) => {
              if (v[0]) setConnectionId(v[0])
              setCreateAnyway(false)
            }}
          />
        </div>
      )}
      {similar.isLoading ? (
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
        <CreateForm key={conn.id} issue={issue} conn={conn} onCancel={onCancel} onDone={onDone} />
      ) : null}
    </div>
  )
}

function CreateForm({
  issue,
  conn,
  onCancel,
  onDone
}: {
  issue: GitlabIssue
  conn: TrackerConnection
  onCancel: () => void
  onDone: () => void
}) {
  const sample = useQuery({
    queryKey: issueGitlabKeys.sample(issue.id),
    queryFn: () =>
      api
        .post<{ data: TemplateSample }>('/trackers/rules/sample', {
          applies_to: 'issue',
          source_id: String(issue.id)
        })
        .then((r) => r.data.data),
    retry: false,
    staleTime: 60_000
  })
  const [title, setTitle] = useState<string | null>(null)
  const shownTitle = title ?? sample.data?.title ?? (sample.isError ? issue.title : '')
  const [projectId, setProjectId] = useState(0)
  const [extraLabels, setExtraLabels] = useState<string[]>([])
  const [assignees, setAssignees] = useState<number[]>([])
  const fixedLabels = useMemo(() => connectionLabelsFor(issue, conn.sync), [issue, conn.sync])

  const [projectSearch, setProjectSearch] = useState('')
  const projectQ = useDebounced(projectSearch, 250)
  const projects = useQuery({
    queryKey: trackerKeys.projects(conn.id, projectQ),
    queryFn: () => fetchProjects(conn.id, projectQ),
    enabled: conn.token_set,
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

  const labelProject = conn.default_project_id
  const labels = useQuery({
    queryKey: trackerKeys.labels(conn.id, labelProject),
    queryFn: () => fetchLabels(conn.id),
    enabled: conn.token_set && labelProject != null,
    staleTime: 60_000,
    retry: false
  })

  const assigneeProject = projectId || conn.default_project_id || 0
  const [userSearch, setUserSearch] = useState('')
  const userQ = useDebounced(userSearch, 250)
  const users = useQuery({
    queryKey: trackerKeys.users(conn.id, assigneeProject, userQ),
    queryFn: () => fetchGitlabUsers(conn.id, assigneeProject, userQ),
    enabled: conn.token_set && assigneeProject > 0,
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
      api.post('/trackers/links', {
        issue: issue.id,
        connection: conn.id,
        ...(projectId ? { project_id: projectId } : {}),
        overrides: {
          ...(shownTitle.trim() ? { title: shownTitle.trim() } : {}),
          labels: extraLabels,
          assignee_ids: assignees
        }
      }),
    onSuccess: () => {
      toast.success('Sending to GitLab')
      onDone()
    },
    onError: (err) => toastError(err, 'Could not create the GitLab issue')
  })

  const labelHint = !conn.default_project_id
    ? 'Set a default project on the connection to list its labels. You can still type one.'
    : labels.isError
      ? 'GitLab did not list the labels. You can still type one.'
      : null

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
          <label
            htmlFor={`gitlab-title-${issue.id}`}
            className='text-[11.5px] text-slate-600 dark:text-muted-foreground'
          >
            Title
          </label>
          {sample.isLoading && title === null ? (
            <Skeleton className='h-8 w-full' />
          ) : (
            <Input
              id={`gitlab-title-${issue.id}`}
              aria-label='GitLab issue title'
              value={shownTitle}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={255}
              className='h-8 text-[12.5px]'
            />
          )}
        </div>
        <div className='space-y-1'>
          <p className='text-[11.5px] text-slate-600 dark:text-muted-foreground'>Project</p>
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
          <p className='text-[11.5px] text-slate-600 dark:text-muted-foreground'>Assignees</p>
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
          <p className='text-[11.5px] text-slate-600 dark:text-muted-foreground'>Labels</p>
          {fixedLabels.length > 0 && (
            <p className='flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground'>
              <span className='mr-0.5'>Always added by the connection:</span>
              {fixedLabels.map((l) => (
                <span
                  key={l}
                  className='rounded border border-slate-200 bg-slate-50 px-1.5 py-px text-[11px] text-slate-700 dark:border-border dark:bg-muted/40 dark:text-slate-200'
                >
                  {l}
                </span>
              ))}
            </p>
          )}
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
      <div className='space-y-1'>
        <p className='text-[11.5px] text-slate-600 dark:text-muted-foreground'>
          Description (made from the issue)
        </p>
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
        <Button type='submit' size='sm' className={PRIMARY} disabled={create.isPending}>
          {create.isPending ? 'Sending…' : 'Create in GitLab'}
        </Button>
      </div>
    </form>
  )
}

// ── Link existing ───────────────────────────────────────────────────────────

function LinkExistingPanel({
  issue,
  connections,
  onCancel,
  onDone
}: {
  issue: GitlabIssue
  connections: TrackerConnection[]
  onCancel: () => void
  onDone: () => void
}) {
  const [url, setUrl] = useState('')
  const [connectionId, setConnectionId] = useState(connections[0]?.id ?? 0)
  // A pasted URL picks the connection on the same host.
  useEffect(() => {
    try {
      const host = new URL(url.trim()).host.toLowerCase()
      const match = connections.find((c) => {
        try {
          return new URL(c.base_url).host.toLowerCase() === host
        } catch {
          return false
        }
      })
      if (match) setConnectionId(match.id)
    } catch {
      // not a URL yet
    }
  }, [url, connections])
  const linkMut = useMutation({
    mutationFn: () =>
      api.post('/trackers/links/existing', {
        issue: issue.id,
        connection: connectionId,
        url: url.trim()
      }),
    onSuccess: () => {
      toast.success('Linked to GitLab')
      onDone()
    },
    onError: (err) => toastError(err, 'Could not link that GitLab issue')
  })
  return (
    <form
      className='space-y-2'
      onSubmit={(e) => {
        e.preventDefault()
        if (url.trim() && !linkMut.isPending) linkMut.mutate()
      }}
    >
      <label
        htmlFor={`gitlab-url-${issue.id}`}
        className='text-[11.5px] text-slate-600 dark:text-muted-foreground'
      >
        Link of the GitLab issue
      </label>
      <Input
        id={`gitlab-url-${issue.id}`}
        autoFocus
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder={`${connections[0]?.base_url ?? 'https://gitlab.example.com'}/group/project/-/issues/482`}
        className='h-8 font-mono text-[12px]'
      />
      {connections.length > 1 && (
        <PickList
          ariaLabel='GitLab connection'
          placeholder='Choose a connection'
          value={[connectionId]}
          options={connections.map((c) => ({ value: c.id, label: c.name }))}
          onChange={(v) => v[0] && setConnectionId(v[0])}
        />
      )}
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

// ── Linked ──────────────────────────────────────────────────────────────────

function LinkedView({
  issue,
  link,
  onChanged
}: {
  issue: GitlabIssue
  link: TrackerLink
  onChanged: () => void
}) {
  const href = safeHref(link.web_url)
  const resync = useMutation({
    mutationFn: () => api.post(`/trackers/links/${link.id}/resync`),
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
    mutationFn: () => api.delete(`/trackers/links/issue/${issue.id}`),
    onSuccess: () => {
      toast.success('Unlinked from GitLab')
      onChanged()
    },
    onError: (err) => toastError(err, 'Could not unlink it')
  })
  const move = useMutation({
    mutationFn: (issueId: number) =>
      api.post('/trackers/links/move-to-new', { issue: issueId, connection: link.connection }),
    onSuccess: () => {
      toast.success('Opening a new GitLab issue for it')
      onChanged()
    },
    onError: (err) => toastError(err, 'Could not move it to a new GitLab issue')
  })
  const busy = resync.isPending || unlink.isPending || move.isPending
  const closed = link.remote_state === 'closed'
  const others = link.sources.length > 1

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
        <div
          role='alert'
          className='flex flex-wrap items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200'
        >
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
            onConfirm={() => move.mutate(issue.id)}
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

      <Examples issue={issue} link={link} onMove={(id) => move.mutate(id)} onChanged={onChanged} />
    </div>
  )
}

function Examples({
  issue,
  link,
  onMove,
  onChanged
}: {
  issue: GitlabIssue
  link: TrackerLink
  onMove: (issueId: number) => void
  onChanged: () => void
}) {
  const members = (issue.tracker_members ?? []).filter(
    (m) => !(m.kind === 'issue' && Number(m.id) === issue.id)
  )
  const total = Math.max(0, (issue.tracker_members_total ?? link.sources.length) - 1)
  const remove = useMutation({
    mutationFn: (m: { kind: string; id: string }) =>
      m.kind === 'issue'
        ? api.delete(`/trackers/links/issue/${m.id}`)
        : api.delete(`/trackers/links/source/${m.kind}/${encodeURIComponent(m.id)}`),
    onSuccess: () => {
      toast.success('Removed from this GitLab issue')
      onChanged()
    },
    onError: (err) => toastError(err, 'Could not remove it')
  })
  if (!members.length) return null
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
        {members.map((m) => {
          const name =
            m.kind === 'issue'
              ? m.title || `Issue #${m.id}`
              : m.kind === 'ticket'
                ? `Support request #${m.id}`
                : `Record ${m.id}`
          return (
            <li
              key={`${m.kind}:${m.id}`}
              className='group flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 text-[12px]'
            >
              <span className='min-w-0 flex-1'>
                {m.kind === 'issue' ? (
                  <Link
                    to={`/issues/${m.id}`}
                    className='block truncate text-slate-800 hover:underline dark:text-foreground'
                  >
                    <span className='mr-1 font-mono text-[11px] text-muted-foreground'>
                      #{m.id}
                    </span>
                    {name}
                  </Link>
                ) : (
                  <span className='block truncate text-slate-800 dark:text-foreground'>{name}</span>
                )}
                <span className='text-[11px] text-muted-foreground'>
                  {joinedViaLabel(m.joined_via)}
                  {m.joined_at ? ` · ${formatRelative(m.joined_at)}` : ''}
                </span>
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
      {total > members.length && (
        <p className='text-[11px] text-muted-foreground'>
          Showing the newest {members.length} of {total}.
        </p>
      )}
    </div>
  )
}

// ── Waiting / failed changes ────────────────────────────────────────────────

function PendingChanges({
  pending,
  onChanged
}: {
  pending: TrackerPending[]
  onChanged: () => void
}) {
  const dead = pending.filter((p) => p.status === 'dead')
  const waiting = pending.filter((p) => p.status !== 'dead' && p.op !== 'create')
  const retry = useMutation({
    mutationFn: (id: number) => api.post(`/trackers/outbox/${id}/retry`),
    onSuccess: () => {
      toast.success('Trying again')
      onChanged()
    },
    onError: (err) => toastError(err, 'Could not try it again')
  })
  if (!dead.length && !waiting.length) return null
  return (
    <div className='mt-3 space-y-1.5 border-t border-slate-100 pt-3 dark:border-border/60'>
      {waiting.length > 0 && (
        <p className='text-[11.5px] text-muted-foreground'>
          {waiting.length} change{waiting.length === 1 ? '' : 's'} waiting to be sent to GitLab.
        </p>
      )}
      {dead.map((p) => (
        <div
          key={p.id}
          role='alert'
          className='flex flex-wrap items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200'
        >
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

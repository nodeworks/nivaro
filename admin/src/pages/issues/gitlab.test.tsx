import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IssueComments } from '@/components/issue-comments'
import { api } from '@/lib/api'
import type { SyncOptions, TrackerConnection } from '../issue-trackers/api'
import { GitlabChip } from './GitlabBits'
import { GitlabBulkCreate } from './GitlabBulk'
import { IssueGitlabSection } from './GitlabSection'
import { connectionLabelsFor, summarizeBulk, useIssueGitlab } from './gitlab'
import type { Issue } from './types'

const auth = vi.hoisted(() => ({ admin: true }))
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: { id: 'me', is_admin: auth.admin } })
}))

const get = api.get as unknown as ReturnType<typeof vi.fn<(...args: any[]) => any>>
const post = api.post as unknown as ReturnType<typeof vi.fn<(...args: any[]) => any>>

const conn = (over: Partial<TrackerConnection> = {}): TrackerConnection =>
  ({
    id: 3,
    name: 'GitLab',
    provider: 'gitlab',
    base_url: 'https://gitlab.example.com',
    default_project_id: 12,
    default_project_path: 'team/app',
    is_active: true,
    status: 'ok',
    token_set: true,
    sync: {
      sources: { issue: true, ticket: false, record: false },
      labels: {
        always: ['nivaro'],
        by_severity: { high: ['sev::high'] },
        by_source: {},
        on_example: []
      },
      priority_map: {},
      lane_map: {}
    } as unknown as SyncOptions,
    ...over
  }) as TrackerConnection

const ISSUE: Issue = {
  id: 41,
  collection: null,
  item: null,
  title: 'Totals do not match the lines',
  severity: 'high',
  status: 'open',
  source: 'manual',
  assigned_to: null,
  raised_by: 'me',
  resolution_notes: null,
  created_at: '2026-11-17T10:00:00.000Z',
  updated_at: '2026-11-17T10:00:00.000Z'
}

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  )
}

type Answers = Record<string, unknown>
function answer(gets: Answers, posts: Answers = {}) {
  get.mockImplementation(async (url: string) => {
    if (url in gets) return { data: { data: gets[url] } }
    return { data: { data: [] } }
  })
  post.mockImplementation(async (url: string) => {
    if (url in posts) return { data: { data: posts[url] } }
    return { data: { data: {} } }
  })
}

const urlsCalled = () => get.mock.calls.map((c) => String(c[0]))

beforeEach(() => {
  vi.clearAllMocks()
  auth.admin = true
})

function GateProbe() {
  const g = useIssueGitlab()
  return <p>{g.adminTools ? 'tools' : g.on ? 'on' : 'off'}</p>
}

describe('feature off hides everything', () => {
  it('no admin tools and no connection read while the feature is off', async () => {
    answer({ '/trackers/feature/public': { enabled: false }, '/trackers': [conn()] })
    wrap(<GateProbe />)
    await screen.findByText('off')
    expect(urlsCalled()).not.toContain('/trackers')
  })

  it('a 404 (cloud: routes not mounted) reads as off', async () => {
    get.mockImplementation(async (url: string) => {
      if (url === '/trackers/feature/public') throw { response: { status: 404 } }
      return { data: { data: [] } }
    })
    wrap(<GateProbe />)
    await screen.findByText('off')
  })

  it('the GitLab section renders nothing while off, even for a linked issue', async () => {
    answer({ '/trackers/feature/public': { enabled: false } })
    const { container } = wrap(<IssueGitlabSection issue={ISSUE} onChanged={() => {}} />)
    await waitFor(() => expect(urlsCalled()).toContain('/trackers/feature/public'))
    expect(container).toBeEmptyDOMElement()
  })

  it('the chip renders nothing without a tracker', () => {
    const { container } = wrap(<GitlabChip tracker={undefined} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('no connection takes issue-log entries: no admin tools', async () => {
    answer({
      '/trackers/feature/public': { enabled: true },
      '/trackers': [
        conn({ sync: { sources: { issue: false } } as unknown as SyncOptions }),
        conn({ id: 4, is_active: false })
      ]
    })
    wrap(<GateProbe />)
    await screen.findByText('on')
  })
})

describe('admin-only GitLab section', () => {
  it('a non-admin never gets the section and never reads the connections', async () => {
    auth.admin = false
    answer({ '/trackers/feature/public': { enabled: true }, '/trackers': [conn()] })
    const { container } = wrap(<IssueGitlabSection issue={ISSUE} onChanged={() => {}} />)
    await waitFor(() => expect(urlsCalled()).toContain('/trackers/feature/public'))
    expect(container).toBeEmptyDOMElement()
    expect(urlsCalled()).not.toContain('/trackers')
  })

  it('an admin sees it with Create and Link existing', async () => {
    answer({ '/trackers/feature/public': { enabled: true }, '/trackers': [conn()] })
    wrap(<IssueGitlabSection issue={ISSUE} onChanged={() => {}} />)
    expect(await screen.findByRole('button', { name: 'Create GitLab issue' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Link existing' })).toBeInTheDocument()
  })

  it('a linked issue shows the mirror and the examples', async () => {
    answer({ '/trackers/feature/public': { enabled: true }, '/trackers': [conn()] })
    const linked = {
      ...ISSUE,
      tracker: {
        id: 7,
        connection: 3,
        web_url: 'https://gitlab.example.com/team/app/-/issues/482',
        project_path: 'team/app',
        iid: 482,
        remote_state: 'opened',
        remote_title: 'Totals wrong',
        labels: ['bug'],
        assignees: ['kim'],
        milestone: 'November',
        created_via: 'manual',
        sync_error: 'GitLab answered 500',
        members: [41, 52],
        sources: [
          { kind: 'issue' as const, id: '41' },
          { kind: 'issue' as const, id: '52' }
        ]
      },
      tracker_members: [
        {
          kind: 'issue' as const,
          id: '52',
          title: 'Same totals again',
          status: 'open',
          joined_via: 'similar',
          joined_at: '2026-11-17T11:00:00.000Z',
          score: 0.912
        }
      ],
      tracker_members_total: 2,
      tracker_pending: []
    }
    wrap(<IssueGitlabSection issue={linked} onChanged={() => {}} />)
    expect(await screen.findByText('Totals wrong')).toBeInTheDocument()
    expect(screen.getByText('bug')).toBeInTheDocument()
    expect(screen.getByText('@kim')).toBeInTheDocument()
    expect(screen.getByText('GitLab answered 500')).toBeInTheDocument()
    const examples = screen.getByRole('list', { name: 'Examples on this GitLab issue' })
    expect(within(examples).getByText('Same totals again')).toBeInTheDocument()
    expect(within(examples).getByText(/^Looked similar/)).toBeInTheDocument()
    expect(within(examples).getByText(/91% match/)).toBeInTheDocument()
  })

  it('one-click "Create it" uses the suggesting rule\'s connection, not the first', async () => {
    answer(
      {
        '/trackers/feature/public': { enabled: true },
        '/trackers': [conn(), conn({ id: 9, name: 'Ops GitLab' })],
        '/trackers/rules': [{ id: 4, name: 'Spikes', connection: 9 }]
      },
      { '/trackers/links': { outbox_id: 1 } }
    )
    wrap(
      <IssueGitlabSection issue={{ ...ISSUE, tracker_suggested_rule: 4 }} onChanged={() => {}} />
    )
    await screen.findByText('Spikes')
    const createIt = screen.getByRole('button', { name: 'Create it' })
    await waitFor(() => expect(createIt).not.toBeDisabled())
    fireEvent.click(createIt)
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/trackers/links', { issue: 41, connection: 9 })
    )
  })

  it('"Create it" stays disabled until the rule is known', async () => {
    let release: () => void = () => {}
    const rulesGate = new Promise<void>((r) => {
      release = r
    })
    get.mockImplementation(async (url: string) => {
      if (url === '/trackers/feature/public') return { data: { data: { enabled: true } } }
      if (url === '/trackers') return { data: { data: [conn(), conn({ id: 9 })] } }
      if (url === '/trackers/rules') {
        await rulesGate
        return { data: { data: [{ id: 4, name: 'Spikes', connection: 9 }] } }
      }
      return { data: { data: [] } }
    })
    wrap(
      <IssueGitlabSection issue={{ ...ISSUE, tracker_suggested_rule: 4 }} onChanged={() => {}} />
    )
    const createIt = await screen.findByRole('button', { name: 'Create it' })
    expect(createIt).toBeDisabled()
    release()
    await waitFor(() => expect(createIt).not.toBeDisabled())
  })
})

describe('create: similar candidates first', () => {
  const candidate = {
    link_id: 7,
    project_id: 12,
    iid: 482,
    web_url: 'https://gitlab.example.com/team/app/-/issues/482',
    title: 'Totals wrong on PO lines',
    score: 0.912,
    linked: true
  }

  it('shows the look-alike before the form; Add as example joins it', async () => {
    answer(
      { '/trackers/feature/public': { enabled: true }, '/trackers': [conn()] },
      {
        '/trackers/links/similar': [candidate],
        '/trackers/rules/sample': { title: 'T', body: 'B', labels: [] },
        '/trackers/links/join': { link_id: 7 }
      }
    )
    const onChanged = vi.fn()
    wrap(<IssueGitlabSection issue={ISSUE} onChanged={onChanged} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Create GitLab issue' }))
    expect(await screen.findByText(/Looks like/)).toBeInTheDocument()
    expect(screen.getByText('91%')).toBeInTheDocument()
    expect(screen.queryByLabelText('GitLab issue title')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Add as example of #482' }))
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/trackers/links/join', {
        issue: 41,
        connection: 3,
        link: 7,
        score: 0.912
      })
    )
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(post.mock.calls.map((c) => c[0])).not.toContain('/trackers/links')
  })

  it('Create new anyway opens the prefilled form and creates', async () => {
    answer(
      { '/trackers/feature/public': { enabled: true }, '/trackers': [conn()] },
      {
        '/trackers/links/similar': [{ ...candidate, link_id: null, linked: false }],
        '/trackers/rules/sample': {
          title: 'High: Totals do not match',
          body: '**What happened**',
          labels: []
        },
        '/trackers/links': { outbox_id: 9 }
      }
    )
    wrap(<IssueGitlabSection issue={ISSUE} onChanged={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Create GitLab issue' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Create new anyway' }))
    const title = (await screen.findByLabelText('GitLab issue title')) as HTMLInputElement
    await waitFor(() => expect(title.value).toBe('High: Totals do not match'))
    // the connection's labels are shown as fixed
    expect(screen.getByText('nivaro')).toBeInTheDocument()
    expect(screen.getByText('sev::high')).toBeInTheDocument()
    fireEvent.change(title, { target: { value: 'Totals off' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create in GitLab' }))
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/trackers/links', {
        issue: 41,
        connection: 3,
        overrides: { title: 'Totals off', labels: [], assignee_ids: [] }
      })
    )
  })

  it('no candidates: straight to the form', async () => {
    answer(
      { '/trackers/feature/public': { enabled: true }, '/trackers': [conn()] },
      {
        '/trackers/links/similar': [],
        '/trackers/rules/sample': { title: 'T', body: 'B', labels: [] }
      }
    )
    wrap(<IssueGitlabSection issue={ISSUE} onChanged={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Create GitLab issue' }))
    expect(await screen.findByLabelText('GitLab issue title')).toBeInTheDocument()
    expect(screen.queryByText(/Looks like/)).not.toBeInTheDocument()
  })
})

describe('mirrored GitLab comments render through the safe markdown renderer', () => {
  it('an <img onerror> / <script> payload stays inert text; badge + author shown', async () => {
    const payload =
      'Fixed in **main** <img src=x onerror="window.__pwned=1"> <script>window.__pwned=2</script> [x](javascript:alert(1))'
    get.mockImplementation(async () => ({
      data: {
        data: [
          {
            id: 'c1',
            text: payload,
            created_at: '2026-11-17T10:00:00.000Z',
            user: { first_name: 'GitLab', last_name: null, email: 'gitlab-sync@nivaro.local' },
            tracker: { provider: 'gitlab', author: 'Kim Lee' }
          },
          {
            id: 'c2',
            text: 'plain **not bold**',
            created_at: '2026-11-17T10:00:00.000Z',
            user: { first_name: 'Ann', last_name: 'Ray', email: 'ann@example.com' },
            tracker: null
          }
        ]
      }
    }))
    const { container } = wrap(<IssueComments issueId={41} sharedWithGitlab />)
    expect(await screen.findByText('Kim Lee')).toBeInTheDocument()
    expect(screen.getByText('GitLab', { selector: 'span' })).toBeInTheDocument()
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('a[href^="javascript"]')).toBeNull()
    expect(container.querySelector('[onerror]')).toBeNull()
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined()
    // markdown from GitLab renders; the angle-bracket text is shown as text
    expect(container.querySelector('strong')?.textContent).toBe('main')
    expect(container.textContent).toContain('<img src=x onerror=')
    // an ordinary comment stays plain text
    expect(screen.getByText('plain **not bold**')).toBeInTheDocument()
    expect(screen.getByText('Comments here are shared with GitLab.')).toBeInTheDocument()
  })

  it('no notice when the issue is not linked', async () => {
    get.mockResolvedValue({ data: { data: [] } })
    wrap(<IssueComments issueId={41} emptyText='No comments yet.' />)
    await screen.findByText('No comments yet.')
    expect(screen.queryByText(/shared with GitLab/)).not.toBeInTheDocument()
  })
})

describe('bulk create reports per-id outcomes', () => {
  it('sent / already linked / refused with the reason', async () => {
    post.mockImplementation(async (_url: string, body: { dry_run?: boolean }) =>
      body.dry_run
        ? { data: { data: { would_pass_cap: false, results: [] } } }
        : {
            data: {
              data: {
                would_pass_cap: false,
                results: [
                  { issue: 1, ok: true, outbox_id: 11 },
                  { issue: 2, ok: false, code: 'ALREADY_LINKED', error: 'already' },
                  {
                    issue: 3,
                    ok: false,
                    code: 'NO_PROJECT',
                    error: 'Choose a GitLab project — this connection has no default project'
                  }
                ]
              }
            }
          }
    )
    const onDone = vi.fn()
    wrap(<GitlabBulkCreate ids={[1, 2, 3]} connections={[conn()]} onDone={onDone} />)
    fireEvent.click(screen.getByRole('button', { name: 'Create GitLab issues' }))
    const report = await screen.findByRole('status', { name: 'GitLab results' })
    expect(within(report).getByText(/1 sent to GitLab · 1 already linked · 1 refused/)).toBeTruthy()
    expect(within(report).getByText(/#3/)).toBeInTheDocument()
    expect(within(report).getByText(/no default project/)).toBeInTheDocument()
    expect(post).toHaveBeenCalledWith('/trackers/links/bulk', {
      issues: [1, 2, 3],
      connection: 3
    })
    expect(onDone).toHaveBeenCalled()
  })

  it('over the hourly cap asks a second press first', async () => {
    post.mockImplementation(async (_url: string, body: { dry_run?: boolean }) => ({
      data: { data: { would_pass_cap: !!body.dry_run, results: [] } }
    }))
    wrap(<GitlabBulkCreate ids={[1]} connections={[conn()]} onDone={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Create GitLab issues' }))
    const again = await screen.findByRole('button', { name: /create anyway/i })
    expect(post).toHaveBeenCalledTimes(1)
    fireEvent.click(again)
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2))
  })

  it('a changed selection drops the armed second press: a fresh dry run first', async () => {
    post.mockImplementation(async (_url: string, body: { dry_run?: boolean }) => ({
      data: { data: { would_pass_cap: !!body.dry_run, results: [] } }
    }))
    const qc = new QueryClient()
    const ui = (ids: number[]) => (
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <GitlabBulkCreate ids={ids} connections={[conn()]} onDone={() => {}} />
        </MemoryRouter>
      </QueryClientProvider>
    )
    const { rerender } = render(ui([1]))
    fireEvent.click(screen.getByRole('button', { name: 'Create GitLab issues' }))
    await screen.findByRole('button', { name: /create anyway/i })
    rerender(ui([1, 2]))
    expect(screen.queryByRole('button', { name: /create anyway/i })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Create GitLab issues' }))
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2))
    expect(post.mock.calls[1][1]).toEqual({ issues: [1, 2], connection: 3, dry_run: true })
  })

  it('a changed connection drops the armed second press too', async () => {
    const g = globalThis as { ResizeObserver?: unknown }
    g.ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    Element.prototype.scrollIntoView ??= () => {}
    post.mockImplementation(async (_url: string, body: { dry_run?: boolean }) => ({
      data: { data: { would_pass_cap: !!body.dry_run, results: [] } }
    }))
    wrap(
      <GitlabBulkCreate
        ids={[1]}
        connections={[conn(), conn({ id: 9, name: 'Ops GitLab' })]}
        onDone={() => {}}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Create GitLab issues' }))
    await screen.findByRole('button', { name: /create anyway/i })
    fireEvent.click(screen.getByRole('combobox'))
    fireEvent.click(await screen.findByRole('option', { name: 'Ops GitLab' }))
    expect(screen.queryByRole('button', { name: /create anyway/i })).not.toBeInTheDocument()
  })

  it('more than 50 selected: refused before any request', () => {
    const ids = Array.from({ length: 51 }, (_, i) => i + 1)
    wrap(<GitlabBulkCreate ids={ids} connections={[conn()]} onDone={() => {}} />)
    expect(screen.getByRole('button', { name: 'Create GitLab issues' })).toBeDisabled()
  })
})

describe('pure rules', () => {
  it('summarizeBulk groups outcomes', () => {
    expect(
      summarizeBulk([
        { issue: 1, ok: true },
        { issue: 2, ok: false, code: 'ALREADY_LINKED' },
        { issue: 3, ok: false, code: 'SOURCE_OFF', error: 'off' }
      ])
    ).toEqual({ queued: [1], alreadyLinked: [2], refused: [{ issue: 3, reason: 'off' }] })
  })

  it('connectionLabelsFor mirrors the server merge', () => {
    expect(
      connectionLabelsFor(
        { severity: 'error', status: 'open', source: 'Server' },
        {
          labels: {
            always: ['nivaro', 'Bug'],
            by_severity: { high: ['bug'] },
            by_source: { server: ['backend'] },
            on_example: []
          },
          priority_map: { high: 'priority::1' },
          lane_map: { open: 'lane::todo' }
        }
      )
    ).toEqual(['nivaro', 'Bug', 'backend', 'priority::1', 'lane::todo'])
  })
})

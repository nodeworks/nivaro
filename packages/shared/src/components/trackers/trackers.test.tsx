// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ItemEditAuthContext, NivaroProvider } from '../../context'
import { RecordTrackerPopover, TicketTrackerSection } from './SourceTracker'
import { TrackerChip, TrackerChips } from './TrackerChip'
import type { TrackerLink } from './tracker-model'
import { useSourceTracker } from './use-tracker-link'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Cmd = { _method: string; _path: string; _params?: Record<string, unknown>; _body?: any }

let root: Root
let host: HTMLDivElement
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
})

async function settle(until: () => boolean = () => false, rounds = 40) {
  for (let i = 0; i < rounds && !until(); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5))
    })
  }
}

/** A fake API: answers keyed `METHOD path`; a function answer gets the command. */
function fakeClient(answers: Record<string, unknown>) {
  const calls: Cmd[] = []
  const client = {
    request: vi.fn(async (cmd: Cmd) => {
      calls.push(cmd)
      const key = `${cmd._method} ${cmd._path}`
      if (!(key in answers)) return { data: [] }
      const a = answers[key]
      if (a instanceof Error) throw a
      return { data: typeof a === 'function' ? (a as (c: Cmd) => unknown)(cmd) : a }
    })
  }
  return { client, calls, paths: () => calls.map((c) => `${c._method} ${c._path}`) }
}

async function mount(ui: ReactNode, client: unknown, isAdmin = false) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client as never}>
          <ItemEditAuthContext.Provider value={{ isAdmin, userId: 'me' }}>
            {ui}
          </ItemEditAuthContext.Provider>
        </NivaroProvider>
      </QueryClientProvider>
    )
  })
}

const byText = (text: string) =>
  [...document.querySelectorAll<HTMLElement>('button, a, span, p, h3')].find(
    (e) => e.textContent?.trim() === text
  )
const button = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.getAttribute('aria-label') === name || b.textContent?.trim() === name
  )
async function click(el: HTMLElement | undefined) {
  if (!el) throw new Error('nothing to click')
  await act(async () => {
    el.click()
  })
}
async function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement
  const set = Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set
  await act(async () => {
    set?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const LINK: TrackerLink = {
  id: 7,
  connection: 3,
  web_url: 'https://gitlab.example.com/team/app/-/issues/482',
  project_path: 'team/app',
  iid: 482,
  remote_state: 'opened',
  remote_title: 'Printer offline',
  labels: [],
  assignees: [],
  milestone: null,
  created_via: 'manual',
  sync_error: null,
  members: [],
  sources: [{ kind: 'ticket', id: '55' }]
}
const CHIP = { iid: 482, web_url: LINK.web_url, state: 'opened', title: 'My printer' }
const conn = (over: Record<string, unknown> = {}) => ({
  id: 3,
  name: 'GitLab',
  default_project_path: 'team/app',
  default_project_id: 12,
  base_url: 'https://gitlab.example.com',
  token_set: true,
  is_active: true,
  sync: { labels: { always: ['nivaro'] }, ticket_priority_map: { urgent: 'prio::1' } },
  ...over
})

const TICKET = { id: 55, title: 'My printer', priority: 'urgent', status: 'open' }

function TicketHost({ mayCreate }: { mayCreate: boolean }) {
  const t = useSourceTracker({ kind: 'ticket', id: '55' }, { mayCreate })
  return (
    <>
      <div data-header>
        <TrackerChips tracker={t} />
      </div>
      {mayCreate && <TicketTrackerSection tracker={t} ticket={TICKET} />}
    </>
  )
}

describe('TrackerChip states', () => {
  it('open: #482 · open, links to GitLab in a new tab', async () => {
    await mount(<TrackerChip tracker={CHIP} />, fakeClient({}).client)
    const a = document.querySelector<HTMLAnchorElement>('[data-gitlab-chip]')
    expect(a?.tagName).toBe('A')
    expect(a?.getAttribute('href')).toBe(LINK.web_url)
    expect(a?.getAttribute('target')).toBe('_blank')
    expect(a?.dataset.gitlabChipState).toBe('open')
    expect(a?.textContent).toBe('#482·open')
  })

  it('closed: reads closed in the quiet tone', async () => {
    await mount(<TrackerChip tracker={{ ...CHIP, state: 'closed' }} />, fakeClient({}).client)
    const a = document.querySelector<HTMLElement>('[data-gitlab-chip]')
    expect(a?.dataset.gitlabChipState).toBe('closed')
    expect(a?.textContent).toBe('#482·closed')
    expect(a?.className).toContain('text-slate-500')
  })

  it('sync error (an administrator\'s whole link): reads "sync error" and says why', async () => {
    await mount(
      <TrackerChip tracker={{ ...LINK, sync_error: 'GitLab answered 500' }} />,
      fakeClient({}).client
    )
    const a = document.querySelector<HTMLElement>('[data-gitlab-chip]')
    expect(a?.dataset.gitlabChipState).toBe('error')
    expect(a?.textContent).toBe('#482·sync error')
    expect(a?.dataset.tip).toContain('GitLab answered 500')
    expect(a?.className).toContain('text-red-700')
  })

  it('a non-http link never becomes an anchor; no tracker renders nothing', async () => {
    await mount(
      <>
        <TrackerChip tracker={{ ...CHIP, web_url: 'javascript:alert(1)' }} />
        <TrackerChip tracker={null} />
      </>,
      fakeClient({}).client
    )
    expect(document.querySelector('a')).toBeNull()
    expect(document.querySelectorAll('[data-gitlab-chip]')).toHaveLength(1)
  })
})

describe('visibility', () => {
  it('feature off: nothing renders and nothing but the switch is read', async () => {
    const f = fakeClient({
      'GET /trackers/feature/public': { enabled: false },
      'GET /trackers/links/for': [CHIP],
      'GET /trackers/creatable': [conn()]
    })
    await mount(<TicketHost mayCreate />, f.client)
    await settle()
    expect(host.textContent).toBe('')
    expect(f.paths()).toEqual(['GET /trackers/feature/public'])
  })

  it('cloud mode (the routes answer 404) reads as off', async () => {
    const f = fakeClient({
      'GET /trackers/feature/public': Object.assign(new Error('nf'), { status: 404 })
    })
    await mount(<TicketHost mayCreate />, f.client)
    await settle()
    expect(host.textContent).toBe('')
    expect(f.paths()).toEqual(['GET /trackers/feature/public'])
  })

  it('no connection syncs tickets (or none is active): no panel, no chip', async () => {
    const f = fakeClient({
      'GET /trackers/feature/public': { enabled: true },
      'GET /trackers': [
        conn({ sync: { sources: { ticket: false } } }),
        conn({ id: 4, is_active: false })
      ],
      'GET /trackers/links/for': [],
      'GET /trackers/links/source/ticket/55': []
    })
    await mount(<TicketHost mayCreate />, f.client, true)
    await settle(() => f.paths().includes('GET /trackers'))
    await settle()
    expect(document.querySelector('[data-ticket-gitlab]')).toBeNull()
    expect(document.querySelector('[data-gitlab-chip]')).toBeNull()
  })

  it('not allowed to create: no panel, no admin reads — a linked chip still shows', async () => {
    const f = fakeClient({
      'GET /trackers/feature/public': { enabled: true },
      'GET /trackers/creatable': [],
      'GET /trackers/links/for': [CHIP]
    })
    await mount(<TicketHost mayCreate />, f.client)
    await settle(() => !!document.querySelector('[data-gitlab-chip]'))
    expect(document.querySelector('[data-header] [data-gitlab-chip]')).not.toBeNull()
    expect(document.querySelector('[data-ticket-gitlab]')).toBeNull()
    expect(f.paths()).not.toContain('GET /trackers')
    expect(f.paths().some((p) => p.startsWith('GET /trackers/links/source'))).toBe(false)
  })

  it('the requester (may not work it): read-only chip, the connections are never asked', async () => {
    const f = fakeClient({
      'GET /trackers/feature/public': { enabled: true },
      'GET /trackers/links/for': [CHIP]
    })
    await mount(<TicketHost mayCreate={false} />, f.client)
    await settle(() => !!document.querySelector('[data-gitlab-chip]'))
    const chip = document.querySelector<HTMLElement>('[data-gitlab-chip]')
    expect(chip?.getAttribute('aria-label')).toContain('My printer')
    expect(f.paths()).not.toContain('GET /trackers/creatable')
    expect(f.paths()).not.toContain('GET /trackers')
  })
})

describe('a create_roles member on a ticket', () => {
  it('creates in the default project with title, description and labels only', async () => {
    let linked = false
    const f = fakeClient({
      'GET /trackers/feature/public': { enabled: true },
      'GET /trackers/creatable': [{ id: 3, name: 'GitLab', default_project_path: 'team/app' }],
      'GET /trackers/links/for': () => (linked ? [CHIP] : []),
      'POST /trackers/links': { outbox_id: 9 }
    })
    await mount(<TicketHost mayCreate />, f.client)
    await settle(() => !!button('Create GitLab issue'))
    expect(byText('Link existing')).toBeTruthy()
    await click(button('Create GitLab issue'))
    expect(host.textContent).toContain('Goes to team/app.')
    // no similar list, template preview, project, assignee or label reads for non-admins
    for (const p of [
      'POST /trackers/links/similar',
      'POST /trackers/rules/sample',
      'GET /trackers/3/projects',
      'GET /trackers/3/labels',
      'GET /trackers/3/users'
    ])
      expect(f.paths()).not.toContain(p)
    expect(document.querySelector('[aria-label="GitLab project"]')).toBeNull()
    expect(document.querySelector('[aria-label="GitLab assignees"]')).toBeNull()
    await type(document.querySelector('input[aria-label="GitLab issue title"]')!, 'Printer down')
    await type(document.querySelector('textarea')!, 'Third floor')
    await click(button('Create in GitLab'))
    await settle(() => f.paths().includes('POST /trackers/links'))
    const sent = f.calls.find((c) => c._path === '/trackers/links')
    expect(sent?._body).toEqual({
      source_kind: 'ticket',
      source_id: '55',
      connection: 3,
      overrides: { title: 'Printer down', description: 'Third floor' }
    })
    // waits for the GitLab issue, then shows its chip
    await settle(() => host.textContent?.includes('Creating the GitLab issue') ?? false)
    expect(host.textContent).toContain('Creating the GitLab issue')
    // the chip read is asked again every 4 s while it waits
    linked = true
    await settle(() => host.textContent?.includes('In GitLab as issue #482') ?? false, 1400)
    expect(host.textContent).toContain('In GitLab as issue #482')
  }, 15_000)

  it('link existing: says which project, posts the pasted link', async () => {
    const f = fakeClient({
      'GET /trackers/feature/public': { enabled: true },
      'GET /trackers/creatable': [{ id: 3, name: 'GitLab', default_project_path: 'team/app' }],
      'GET /trackers/links/for': [],
      'POST /trackers/links/existing': CHIP
    })
    await mount(<TicketHost mayCreate />, f.client)
    await settle(() => !!button('Link existing'))
    await click(button('Link existing'))
    expect(host.textContent).toContain('An issue in team/app that is not confidential.')
    await type(document.querySelector('input')!, LINK.web_url)
    await click(button('Link'))
    await settle(() => f.paths().includes('POST /trackers/links/existing'))
    expect(f.calls.find((c) => c._path === '/trackers/links/existing')?._body).toEqual({
      source_kind: 'ticket',
      source_id: '55',
      connection: 3,
      url: LINK.web_url
    })
  })
})

describe('an administrator on a ticket', () => {
  it('sees the ticket labels the connection always adds, and similar issues first', async () => {
    const f = fakeClient({
      'GET /trackers/feature/public': { enabled: true },
      'GET /trackers': [conn()],
      'GET /trackers/links/for': [],
      'GET /trackers/links/source/ticket/55': [],
      'POST /trackers/links/similar': [],
      'POST /trackers/rules/sample': { title: 'Support: My printer', body: 'Body', labels: [] }
    })
    await mount(<TicketHost mayCreate />, f.client, true)
    await settle(() => !!button('Create GitLab issue'))
    await click(button('Create GitLab issue'))
    await settle(() => !!document.querySelector('input[aria-label="GitLab issue title"]'))
    await settle(
      () =>
        document.querySelector<HTMLInputElement>('input[aria-label="GitLab issue title"]')
          ?.value === 'Support: My printer'
    )
    expect(f.paths()).toContain('POST /trackers/links/similar')
    expect(f.calls.find((c) => c._path === '/trackers/rules/sample')?._body).toEqual({
      applies_to: 'ticket',
      source_id: '55'
    })
    expect(host.textContent).toContain('Always added by the connection:')
    expect(byText('nivaro')).toBeTruthy()
    expect(byText('prio::1')).toBeTruthy()
  })

  it('a linked ticket: the whole link with Unlink by source, the chip shows its sync error', async () => {
    const f = fakeClient({
      'GET /trackers/feature/public': { enabled: true },
      'GET /trackers': [conn()],
      'GET /trackers/links/for': [{ ...CHIP, connection: 3, title: 'Printer offline' }],
      'GET /trackers/links/source/ticket/55': [{ ...LINK, sync_error: 'GitLab answered 500' }]
    })
    await mount(<TicketHost mayCreate />, f.client, true)
    await settle(() => host.textContent?.includes('Printer offline') ?? false)
    expect(
      document.querySelector<HTMLElement>('[data-header] [data-gitlab-chip]')?.dataset
        .gitlabChipState
    ).toBe('error')
    expect(host.textContent).toContain('Could not read it from GitLab.')
    // Move to a new GitLab issue is for issue-log entries only
    expect(button('Move to a new GitLab issue')).toBeUndefined()
    const unlink = button('Unlink from GitLab')
    await click(unlink)
    await click(button('Unlink? GitLab keeps its issue'))
    await settle(() => f.paths().includes('DELETE /trackers/links/source/ticket/55'))
    expect(f.paths()).toContain('DELETE /trackers/links/source/ticket/55')
  })
})

describe('record popover', () => {
  function RecordHost({ mode }: { mode: 'create' | 'link' | null }) {
    const t = useSourceTracker({ kind: 'record', id: 'orders:7' }, { mayCreate: true })
    return (
      <RecordTrackerPopover
        tracker={t}
        recordId='orders:7'
        recordLabel='Order 7'
        mode={mode}
        anchor={document.body}
        onOpenChange={() => {}}
      />
    )
  }

  it('opens straight on the create form; a record has no template preview', async () => {
    const f = fakeClient({
      'GET /trackers/feature/public': { enabled: true },
      'GET /trackers/creatable': [{ id: 3, name: 'GitLab', default_project_path: 'team/app' }],
      'GET /trackers/links/for': []
    })
    await mount(<RecordHost mode='create' />, f.client)
    await settle(() => !!document.querySelector('[data-record-gitlab="create"]'))
    const pop = document.querySelector('[data-record-gitlab="create"]')
    expect(pop?.textContent).toContain('Create GitLab issue')
    expect(pop?.textContent).toContain('Order 7')
    expect(pop?.querySelector('input[aria-label="GitLab issue title"]')).not.toBeNull()
    expect(f.paths()).not.toContain('POST /trackers/rules/sample')
  })

  it('renders nothing when the person may not create', async () => {
    const f = fakeClient({
      'GET /trackers/feature/public': { enabled: true },
      'GET /trackers/creatable': [],
      'GET /trackers/links/for': []
    })
    await mount(<RecordHost mode='create' />, f.client)
    await settle(() => f.paths().includes('GET /trackers/creatable'))
    await settle()
    expect(document.querySelector('[data-record-gitlab]')).toBeNull()
  })
})

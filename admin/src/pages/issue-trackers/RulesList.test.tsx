import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, type vi } from 'vitest'
import { api } from '@/lib/api'
import type { SyncOptions, TrackerConnection, TrackerRule } from './api'
import { RulesSection } from './RulesList'
import { newRule } from './rule-sentence'

const get = api.get as unknown as ReturnType<typeof vi.fn<(...args: any[]) => any>>
const post = api.post as unknown as ReturnType<typeof vi.fn<(...args: any[]) => any>>
const patch = api.patch as unknown as ReturnType<typeof vi.fn<(...args: any[]) => any>>

const conn = (sources: SyncOptions['sources']): TrackerConnection =>
  ({
    id: 3,
    name: 'GitLab',
    provider: 'gitlab',
    base_url: 'https://gitlab.example.com',
    default_project_id: 12,
    default_project_path: 'group/proj',
    is_active: true,
    status: 'ok',
    token_set: true,
    sync: { sources } as SyncOptions
  }) as TrackerConnection

const stored = (over: Partial<TrackerRule>): TrackerRule => ({
  ...newRule(3, 'issue'),
  id: 1,
  sort: 10,
  connection: 3,
  last_fired_at: null,
  fired_count: 0,
  suppressed_count: 0,
  paused_reason: null,
  created_at: null,
  updated_at: null,
  valid: true,
  ...over
})

const RULES: TrackerRule[] = [
  stored({
    id: 1,
    name: 'Crashes',
    mode: 'create',
    enabled: true,
    fired_count: 4,
    suppressed_count: 2,
    last_fired_at: '2026-11-17T10:00:00.000Z',
    match: { sources: ['crash'], severity_min: 'high' }
  }),
  stored({
    id: 2,
    name: 'Urgent tickets',
    applies_to: 'ticket',
    threshold: { open_minutes: 120 },
    paused_reason: 'GitLab refused the token'
  })
]

function renderIt(c = conn({ issue: true, ticket: true, record: true })) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <RulesSection connections={[c]} current={c} roles={[]} />
      </QueryClientProvider>
    </MemoryRouter>
  )
}

beforeEach(() => {
  get.mockReset()
  post.mockReset()
  patch.mockReset()
  get.mockImplementation(async (url: string) => {
    if (url === '/trackers/rules') return { data: { data: RULES } }
    return { data: { data: [] } }
  })
  post.mockImplementation(async (url: string) => {
    if (url === '/trackers/rules/preview')
      return { data: { data: { would_open: [], held: [], considered: 0, truncated: false } } }
    return { data: { data: { ...RULES[0], id: 9 } } }
  })
})

describe('RulesSection', () => {
  it('lists each rule with its mode, counts, sentence and pause reason', async () => {
    renderIt()
    const list = await screen.findByRole('list', { name: /Rules, in the order/ })
    const rows = within(list).getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(within(rows[0]).getByText('Create')).toBeTruthy()
    expect(within(rows[0]).getByText('4 fired · 2 held back')).toBeTruthy()
    expect(within(rows[0]).getByText(/When a crash with severity ≥ high/)).toBeTruthy()
    expect(within(rows[1]).getByText('Suggest')).toBeTruthy()
    expect(within(rows[1]).getByText('Support tickets')).toBeTruthy()
    expect(within(rows[1]).getByText(/When a support ticket stays open 2 hours/)).toBeTruthy()
    expect(within(rows[1]).getByText(/Paused: GitLab refused the token/)).toBeTruthy()
    expect(within(rows[1]).getByText('Never fired')).toBeTruthy()
  })

  it('switches a rule on from the list', async () => {
    patch.mockResolvedValue({ data: { data: { ...RULES[1], enabled: true } } })
    renderIt()
    fireEvent.click(await screen.findByRole('switch', { name: 'Turn on Urgent tickets' }))
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/trackers/rules/2', { enabled: true }))
  })

  it('a new rule starts off and suggesting, and offers only the kinds that sync', async () => {
    renderIt(conn({ issue: true, ticket: false, record: true }))
    fireEvent.click(await screen.findByRole('button', { name: /New rule/ }))
    expect(screen.queryByRole('radio', { name: 'Support tickets' })).toBeNull()
    expect(screen.getByText('Issue log')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Add rule' }))
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        '/trackers/rules',
        expect.objectContaining({
          applies_to: 'issue',
          enabled: false,
          mode: 'suggest',
          action: expect.objectContaining({ connection: 3 })
        })
      )
    )
  })

  it('offers both kinds when tickets sync, and a ticket rule reads as one', async () => {
    renderIt()
    fireEvent.click(await screen.findByRole('button', { name: /New rule/ }))
    fireEvent.click(screen.getByRole('radio', { name: 'Support tickets' }))
    const builder = screen.getByRole('region', { name: 'New rule' })
    const sentence = within(builder).getByText(
      (_, el) => el?.tagName === 'P' && !!el.textContent?.startsWith('When ')
    )
    expect(sentence.textContent).toMatch(
      /^When a support ticket is raised, suggest an issue in group\/proj\.$/
    )
    // ticket rules show no severity or issue-only conditions
    expect(screen.queryByRole('group', { name: 'Severity at least' })).toBeNull()
    expect(screen.queryByLabelText('Routes')).toBeNull()
    expect(screen.getAllByRole('group', { name: 'Ticket priority' }).length).toBeGreaterThan(0)
  })
})

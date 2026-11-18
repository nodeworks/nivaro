import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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

  it('opens the builder in view with the cursor in its name, and gives focus back on close', async () => {
    const proto = Element.prototype as { scrollIntoView?: (o?: unknown) => void }
    const before = proto.scrollIntoView
    const spy = vi.fn()
    proto.scrollIntoView = spy
    try {
      renderIt()
      const title = await screen.findByRole('button', { name: 'Crashes' })
      fireEvent.click(title)
      const builder = await screen.findByRole('region', { name: 'Edit rule Crashes' })
      expect(spy).toHaveBeenCalledWith(expect.objectContaining({ block: 'start' }))
      expect(document.activeElement).toBe(within(builder).getByDisplayValue('Crashes'))
      fireEvent.click(within(builder).getByRole('button', { name: 'Close the rule' }))
      await waitFor(() =>
        expect(screen.queryByRole('region', { name: 'Edit rule Crashes' })).toBeNull()
      )
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Crashes' }))
    } finally {
      proto.scrollIntoView = before
    }
  })

  it('unsaved edits: another rule asks "Discard changes?" first; the second press opens it', async () => {
    renderIt()
    fireEvent.click(await screen.findByRole('button', { name: 'Crashes' }))
    const builder = await screen.findByRole('region', { name: 'Edit rule Crashes' })
    fireEvent.change(within(builder).getByDisplayValue('Crashes'), {
      target: { value: 'Crashes, renamed' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Urgent tickets' }))
    // still the edited rule, and the row now asks
    expect(screen.getByRole('region', { name: 'Edit rule Crashes' })).toBeTruthy()
    const ask = screen.getByRole('button', { name: /Discard changes and open Urgent tickets/ })
    expect(ask.textContent).toBe('Discard changes?')
    fireEvent.click(ask)
    expect(await screen.findByRole('region', { name: 'Edit rule Urgent tickets' })).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Edit rule Crashes' })).toBeNull()
  })

  it('unsaved edits: the close button and Cancel ask before dropping them', async () => {
    renderIt()
    fireEvent.click(await screen.findByRole('button', { name: 'Crashes' }))
    const builder = await screen.findByRole('region', { name: 'Edit rule Crashes' })
    fireEvent.change(within(builder).getByDisplayValue('Crashes'), { target: { value: 'X' } })
    fireEvent.click(within(builder).getByRole('button', { name: 'Close the rule' }))
    expect(screen.getByRole('region', { name: 'Edit rule Crashes' })).toBeTruthy()
    expect(within(builder).getByRole('button', { name: 'Discard changes?' })).toBeTruthy()
    fireEvent.click(within(builder).getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('region', { name: 'Edit rule Crashes' })).toBeTruthy()
    fireEvent.click(within(builder).getAllByRole('button', { name: 'Discard changes?' })[0])
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Edit rule Crashes' })).toBeNull()
    )
  })

  it('no edits: another rule opens straight away', async () => {
    renderIt()
    fireEvent.click(await screen.findByRole('button', { name: 'Crashes' }))
    await screen.findByRole('region', { name: 'Edit rule Crashes' })
    fireEvent.click(screen.getByRole('button', { name: 'Urgent tickets' }))
    expect(await screen.findByRole('region', { name: 'Edit rule Urgent tickets' })).toBeTruthy()
  })
})

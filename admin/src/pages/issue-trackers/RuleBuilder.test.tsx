import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import type { RuleDraft, SyncOptions, TrackerConnection, TrackerRule } from './api'
import { RuleBuilder } from './RuleBuilder'
import { draftOf, newRule, ruleBody } from './rule-sentence'

const get = api.get as unknown as ReturnType<typeof vi.fn<(...args: any[]) => any>>
const post = api.post as unknown as ReturnType<typeof vi.fn<(...args: any[]) => any>>
const patch = api.patch as unknown as ReturnType<typeof vi.fn<(...args: any[]) => any>>

const CONN = {
  id: 3,
  name: 'GitLab',
  provider: 'gitlab',
  base_url: 'https://gitlab.example.com',
  default_project_id: 12,
  default_project_path: 'group/proj',
  is_active: true,
  status: 'ok',
  token_set: true,
  sync: { sources: { issue: true, ticket: true, record: true } } as SyncOptions
} as TrackerConnection

const DRAFT: RuleDraft = {
  ...newRule(3, 'issue'),
  name: 'Crashes',
  mode: 'create',
  match: { sources: ['crash'], severity_min: 'high' },
  threshold: { hits: { n: 20, window_minutes: 60 }, people: { n: 3, window_minutes: 60 } },
  action: { ...newRule(3, 'issue').action, labels: ['bug'] }
}

const STORED: TrackerRule = {
  ...DRAFT,
  id: 5,
  sort: 10,
  connection: 3,
  last_fired_at: null,
  fired_count: 0,
  suppressed_count: 0,
  paused_reason: null,
  created_at: null,
  updated_at: null,
  valid: true
}

function renderIt(rule: TrackerRule | null, initial: RuleDraft, onDone = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <RuleBuilder
          rule={rule}
          initial={initial}
          connections={[CONN]}
          roles={[]}
          onDone={onDone}
        />
      </QueryClientProvider>
    </MemoryRouter>
  )
  return onDone
}

const sentenceText = () =>
  screen.getByText((_, el) => el?.tagName === 'P' && !!el.textContent?.startsWith('When '))
    .textContent

beforeEach(() => {
  get.mockReset()
  post.mockReset()
  patch.mockReset()
  get.mockImplementation(async (url: string) => {
    if (url === '/trackers/rules/template-vars')
      return { data: { data: [{ name: 'title', description: 'The Nivaro issue title' }] } }
    return { data: { data: [] } }
  })
  post.mockImplementation(async (url: string) => {
    if (url === '/trackers/rules/preview')
      return { data: { data: { would_open: [], held: [], considered: 0, truncated: false } } }
    return { data: { data: STORED } }
  })
})

describe('RuleBuilder', () => {
  it('reads as a sentence whose bold parts edit in place, committing at once', async () => {
    renderIt(STORED, DRAFT)
    expect(sentenceText()).toBe(
      'When a crash with severity ≥ high is seen 20 times by 3 people within 1 hour, open an issue in group/proj labelled bug.'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Severity: high' }))
    const pop = await screen.findByRole('dialog')
    fireEvent.click(within(pop).getByRole('button', { name: 'Critical' }))
    expect(sentenceText()).toMatch(/severity ≥ critical/)
    fireEvent.click(screen.getByRole('button', { name: 'What it does: open an issue' }))
    const pop2 = (await screen.findAllByRole('dialog')).at(-1) as HTMLElement
    fireEvent.click(within(pop2).getByRole('radio', { name: 'Suggest' }))
    expect(sentenceText()).toMatch(/suggest an issue in group\/proj/)
  })

  it('saves the whole rule and shows the server’s problems by section', async () => {
    patch.mockRejectedValue({
      response: {
        status: 400,
        data: {
          code: 'INVALID_RULE',
          errors: [
            {
              path: 'threshold.hits.n',
              message: 'The count must be a whole number from 1 to 100000000.'
            }
          ]
        }
      }
    })
    renderIt(STORED, DRAFT)
    fireEvent.change(screen.getByLabelText('Rule name'), {
      target: { value: 'Crashes in checkout' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save rule' }))
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith(
        '/trackers/rules/5',
        expect.objectContaining({
          name: 'Crashes in checkout',
          mode: 'create',
          applies_to: 'issue'
        })
      )
    )
    const body = patch.mock.calls[0][1]
    expect(body).not.toHaveProperty('fired_count')
    expect(body).not.toHaveProperty('id')
    expect(
      await screen.findByText('The count must be a whole number from 1 to 100000000.')
    ).toBeTruthy()
    expect(screen.getByText('1 thing to fix')).toBeTruthy()
  })

  it('a stored rule cannot be saved unchanged; Cancel closes it', () => {
    const onDone = renderIt(STORED, DRAFT)
    expect((screen.getByRole('button', { name: 'Save rule' }) as HTMLButtonElement).disabled).toBe(
      true
    )
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onDone).toHaveBeenCalledWith(null)
  })

  it('follows an on/off switch flipped in the list while it has no unsaved on/off edit', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = (initial: RuleDraft) => (
      <MemoryRouter>
        <QueryClientProvider client={qc}>
          <RuleBuilder
            rule={STORED}
            initial={initial}
            connections={[CONN]}
            roles={[]}
            onDone={() => {}}
          />
        </QueryClientProvider>
      </MemoryRouter>
    )
    const { rerender } = render(view({ ...DRAFT, enabled: false }))
    const sw = () => screen.getByRole('switch', { name: /^(On|Off)$/ })
    expect(sw().getAttribute('aria-checked')).toBe('false')
    // switched on in the list: the builder follows and has nothing unsaved
    rerender(view({ ...DRAFT, enabled: true }))
    expect(sw().getAttribute('aria-checked')).toBe('true')
    expect(screen.queryByText('Unsaved changes')).toBeNull()
    // switched off here: an unsaved edit, kept as it is
    fireEvent.click(sw())
    expect(sw().getAttribute('aria-checked')).toBe('false')
    expect(screen.getByText('Unsaved changes')).toBeTruthy()
    // the list then switches it off too: nothing left unsaved
    rerender(view({ ...DRAFT, enabled: false }))
    expect(sw().getAttribute('aria-checked')).toBe('false')
    expect(screen.queryByText('Unsaved changes')).toBeNull()
    // and back on from the list: the builder follows again
    rerender(view({ ...DRAFT, enabled: true }))
    expect(sw().getAttribute('aria-checked')).toBe('true')
  })

  it('an "other source" already picked is not added twice', () => {
    renderIt(STORED, DRAFT)
    const other = screen.getAllByLabelText('Other source')[0]
    fireEvent.change(other, { target: { value: 'Crash' } })
    fireEvent.keyDown(other, { key: 'Enter' })
    expect(sentenceText()).toMatch(/^When a crash with/)
    fireEvent.change(other, { target: { value: 'cron' } })
    fireEvent.keyDown(other, { key: 'Enter' })
    expect(sentenceText()).toMatch(/^When a crash or cron issue with/)
  })

  it('warns when the rule is about a kind switched off on the connection', () => {
    const ticket = { ...newRule(3, 'ticket') }
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <MemoryRouter>
        <QueryClientProvider client={qc}>
          <RuleBuilder
            rule={null}
            initial={ticket}
            connections={[
              {
                ...CONN,
                sync: { sources: { issue: true, ticket: false, record: true } } as SyncOptions
              }
            ]}
            roles={[]}
            onDone={() => {}}
          />
        </QueryClientProvider>
      </MemoryRouter>
    )
    expect(screen.getByText(/Support tickets are switched off on this connection/)).toBeTruthy()
  })
})

describe('text match: words, no regular expressions', () => {
  const REGEX_MSG =
    'Regular expressions are not supported in rules — use words, or * as a wildcard.'
  const OLD: TrackerRule = {
    ...STORED,
    enabled: false,
    valid: false,
    errors: [{ path: 'match.text', message: REGEX_MSG }],
    match: {
      ...STORED.match,
      text: { op: 'any', terms: ['timeout|deadlock'], regex: true, in: ['title', 'details'] }
    }
  }

  it('offers no pattern switch and says * is the wildcard', () => {
    renderIt(null, DRAFT)
    expect(screen.queryByRole('switch', { name: 'Patterns' })).toBeNull()
    expect(screen.getByText('Words to look for. Use * as a wildcard.')).toBeTruthy()
  })

  it("a stored regex rule shows the server's refusal on the Match section", () => {
    renderIt(OLD, draftOf(OLD))
    expect(screen.getByText(REGEX_MSG)).toBeTruthy()
  })

  it('the old regex flag is never sent back', () => {
    const body = ruleBody(OLD) as { match: { text: Record<string, unknown> } }
    expect('regex' in body.match.text).toBe(false)
    expect(body.match.text.terms).toEqual(['timeout|deadlock'])
    expect('regex' in (draftOf(OLD).match.text ?? {})).toBe(false)
  })
})

describe('builder footer', () => {
  it('leaves room on the right for the floating report-a-problem button', () => {
    renderIt(STORED, draftOf(STORED))
    const bar = screen.getByRole('button', { name: 'Save rule' }).parentElement
    expect(bar?.className).toContain('pr-16')
  })

  it('names the rule it saves', () => {
    renderIt(STORED, draftOf(STORED))
    const bar = screen.getByRole('button', { name: 'Save rule' }).parentElement as HTMLElement
    expect(within(bar).getByRole('button', { name: /Crashes/ })).toBeTruthy()
  })
})

describe('builder layout', () => {
  it('anchors its sr-only name label inside itself (an unanchored one stretched the page)', () => {
    renderIt(STORED, draftOf(STORED))
    const section = screen.getByRole('region', { name: 'Edit rule Crashes' })
    expect(section.className).toContain('relative')
  })

  it('threshold rows read as a list: ticking Still open after sets 4 hours, unticking clears it', () => {
    renderIt(STORED, DRAFT)
    const box = screen.getByRole('checkbox', { name: 'Still open after' })
    fireEvent.click(box)
    expect(sentenceText()).toMatch(/stays open 4 hours/)
    expect(
      (screen.getByRole('spinbutton', { name: 'Still open after: how long' }) as HTMLInputElement)
        .value
    ).toBe('4')
    fireEvent.click(box)
    expect(sentenceText()).not.toMatch(/stays open/)
    expect(screen.queryByRole('spinbutton', { name: 'Still open after: how long' })).toBeNull()
  })
})

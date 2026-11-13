// @vitest-environment jsdom
import type { NivaroClient } from '@nivaro/sdk'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ItemEditAuthContext, NivaroProvider, useNivaroClient } from '../../context'
import {
  type MoveProblem,
  pendingOptIn,
  problemReason,
  type RunningMove,
  runningMovePoll,
  startedBy,
  startedInBackground
} from './BackgroundMove'
import { PipelinePanel, PipelineTransitionButtons } from './PipelinePanel'

type Cmd = { _method: string; _path: string; _body?: Record<string, unknown> }

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
})

const ME = 'USER-ADA'
const STATES = [
  { id: 'S-WH', key: 'warehouse', label: 'Warehouse', color: null, sort: 1 },
  { id: 'S-ORD', key: 'order', label: 'Order sent', color: null, sort: 2 },
  { id: 'S-NEW', key: 'new', label: 'New', color: null, sort: 0 }
]
const RUN: RunningMove = {
  id: 71,
  transition_id: 't-submit',
  transition_label: 'Submit order',
  started_at: new Date().toISOString(),
  started_by: 'USER-KIM',
  started_by_name: 'Kim Lee',
  mode: 'background'
}
const PROBLEM: MoveProblem = {
  ...RUN,
  result: 'refused',
  reason: 'Submit order: submission failed — HTTP 400: "The project is not valid"',
  finished_at: new Date().toISOString()
}

interface Scene {
  /** The move carries the background mark. */
  marked?: boolean
  running?: RunningMove | null
  problem?: MoveProblem | null
  /** The Progress panel starts open. */
  expanded?: boolean
}
const instance = (s: Scene) => ({
  instance: { id: 'i-1', current_state: 'S-WH', current_state_obj: STATES[0], completed_at: null },
  states: STATES,
  available_transitions: [
    {
      id: 't-submit',
      label: 'Submit order',
      from_state: 'S-WH',
      to_state: 'S-ORD',
      comment_mode: 'none',
      ...(s.marked ? { background: true } : {})
    },
    {
      id: 't-back',
      label: 'Send Back',
      from_state: 'S-WH',
      to_state: 'S-NEW',
      comment_mode: 'none'
    }
  ],
  all_transitions: [],
  history: [],
  binding: { id: 1, template: 'tpl', collection: 'orders', state_field: null },
  ...(s.marked ? { running_move: s.running ?? null, last_move_problem: s.problem ?? null } : {})
})

/**
 * `scene` is what the record's pipeline read answers now; a marked move's POST
 * answers 202 and the read then shows it running (as the server would).
 */
function render(ui: 'header' | 'panel', scene: Scene) {
  const calls: Cmd[] = []
  const now: Scene = { ...scene }
  const client = {
    url: '',
    getToken: () => null,
    request: vi.fn(async (cmd: Cmd) => {
      calls.push(cmd)
      if (cmd._path.endsWith('/approval-brief')) return { data: { lines: [] } }
      // The open panel's own reads (owners, creator): nothing to show.
      if (cmd._path.endsWith('/owners')) return { data: [] }
      if (cmd._path.endsWith('/owners/all') || cmd._path.endsWith('/creator')) return { data: null }
      if (cmd._path.endsWith('/transition') && cmd._method === 'POST') {
        if (cmd._body?.accept_pending === true) {
          now.running = { ...RUN, started_by: ME, started_by_name: 'Ada Park' }
          now.problem = null
          return { data: { background: true, run: now.running } }
        }
        return {
          data: {
            instance: { current_state: 'S-ORD' },
            new_state: { id: 'S-ORD', label: 'Order sent' }
          }
        }
      }
      if (cmd._path.startsWith('/pipelines/instance/') && cmd._method === 'GET')
        return { data: instance(now) }
      return { data: { ok: true } }
    })
  } as unknown as NivaroClient
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  act(() =>
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client}>
          <ItemEditAuthContext.Provider value={{ isAdmin: false, userId: ME }}>
            {ui === 'header' ? (
              <PipelineTransitionButtons collection='orders' item='42' />
            ) : (
              <PipelinePanel collection='orders' item='42' defaultExpanded={scene.expanded} />
            )}
          </ItemEditAuthContext.Provider>
        </NivaroProvider>
      </QueryClientProvider>
    )
  )
  return { calls }
}

/** Holds the record's own read open, as the record form does. */
function Probe() {
  const client = useNivaroClient()
  useQuery({
    queryKey: ['item', 'orders', '42'],
    queryFn: () => client.request({ _method: 'GET', _path: '/items/orders/42' } as never)
  })
  return null
}

const until = async (ok: () => boolean) => {
  for (let i = 0; i < 80 && !ok(); i++) await act(() => new Promise((r) => setTimeout(r, 10)))
}
const posts = (calls: Cmd[]) =>
  calls.filter((c) => c._method === 'POST' && c._path.endsWith('/transition'))
const button = (text: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as
    | HTMLButtonElement
    | undefined
const runningNotice = () => document.querySelector('[data-running-move]') as HTMLElement | null
const problemNotice = () => document.querySelector('[data-move-problem]') as HTMLElement | null
const problemWords = () =>
  document.querySelector('[data-move-problem-reason]') as HTMLElement | null

describe('helpers', () => {
  it('only a move that carries the mark asks to run in the background', () => {
    const moves = [{ id: 'a', background: true }, { id: 'b' }]
    expect(pendingOptIn(moves, 'a')).toEqual({ accept_pending: true })
    expect(pendingOptIn(moves, 'b')).toEqual({})
    expect(pendingOptIn(moves, 'missing')).toEqual({})
    expect(pendingOptIn(null, 'a')).toEqual({})
  })

  it('reads a 202 answer as a run, and a plain answer as a finished move', () => {
    expect(startedInBackground({ data: { background: true, run: RUN } })).toEqual(RUN)
    expect(startedInBackground({ data: { instance: {}, new_state: {} } })).toBeNull()
    expect(startedInBackground(null)).toBeNull()
  })

  it('names who started it', () => {
    expect(startedBy(RUN, ME)).toBe('Started by Kim Lee')
    expect(startedBy({ ...RUN, started_by: 'user-ada' }, ME)).toBe('You started it')
    expect(startedBy({ ...RUN, mode: 'auto', started_by: null, started_by_name: null }, ME)).toBe(
      'Started automatically'
    )
    expect(startedBy({ ...RUN, started_by: null, started_by_name: null }, ME)).toBe('Started')
  })

  it('drops the move’s own name from the front of its reason', () => {
    expect(problemReason(PROBLEM)).toBe('Submission failed — HTTP 400: "The project is not valid"')
    expect(problemReason({ reason: 'Contact email is required', transition_label: 'Submit' })).toBe(
      'Contact email is required'
    )
    expect(problemReason({ reason: null, transition_label: 'Submit' })).toBe('')
  })

  it('an open record asks again only while a move is running on it', () => {
    expect(runningMovePoll({ running_move: RUN })).toBeGreaterThan(0)
    expect(runningMovePoll({ running_move: null })).toBe(false)
    expect(runningMovePoll({})).toBe(false)
    expect(runningMovePoll(undefined)).toBe(false)
  })
})

describe('a move without the mark is sent exactly as before', () => {
  it('the request body carries no accept_pending and the answer is a finished move', async () => {
    const { calls } = render('panel', {})
    await until(() => !!button('Submit order'))
    await act(async () => button('Submit order')?.click())
    await until(() => posts(calls).length > 0)
    expect(posts(calls)[0]._body).toEqual({ transition_id: 't-submit', comment: undefined })
    expect(runningNotice()).toBeNull()
    expect(problemNotice()).toBeNull()
  })
})

describe('the Progress panel: a move that runs in the background', () => {
  it('asks for it with accept_pending, then shows it running instead of holding the click', async () => {
    const { calls } = render('panel', { marked: true })
    await until(() => !!button('Submit order'))
    await act(async () => button('Submit order')?.click())
    await until(() => !!runningNotice())

    expect(posts(calls)).toHaveLength(1)
    expect(posts(calls)[0]._body).toMatchObject({ transition_id: 't-submit', accept_pending: true })
    const notice = runningNotice() as HTMLElement
    expect(notice.getAttribute('role')).toBe('status')
    expect(notice.textContent).toContain('Submit order is running')
    expect(notice.textContent).toContain('You started it')
    // Nothing else can be pressed while it runs.
    expect(button('Submit order')?.disabled).toBe(true)
    expect(button('Send Back')?.disabled).toBe(true)
  })

  it('shows another person’s run to everyone who has the record open', async () => {
    const { calls } = render('panel', { marked: true, running: RUN })
    await until(() => !!runningNotice())
    expect(runningNotice()?.textContent).toContain('Started by Kim Lee')
    expect(button('Submit order')?.disabled).toBe(true)
    await act(async () => button('Submit order')?.click())
    expect(posts(calls)).toHaveLength(0)
  })

  it('shows why the last run did not move the record, and runs it again on Try again', async () => {
    const { calls } = render('panel', { marked: true, problem: PROBLEM })
    await until(() => !!problemNotice())
    const notice = problemNotice() as HTMLElement
    expect(notice.getAttribute('data-move-problem')).toBe('refused')
    expect(notice.textContent).toContain('Submit order did not go through')
    expect(problemWords()?.textContent).toContain('Submission failed')
    expect(notice.textContent).toContain('Started by Kim Lee')
    expect(button('Submit order')?.disabled).toBe(false)

    await act(async () => button('Try again')?.click())
    await until(() => posts(calls).length > 0)
    expect(posts(calls)[0]._body).toMatchObject({ transition_id: 't-submit', accept_pending: true })
    // The new run replaces the old result.
    await until(() => !!runningNotice())
    expect(problemNotice()).toBeNull()
  })

  it('a run that stopped says so in plain words', async () => {
    render('panel', {
      marked: true,
      problem: {
        ...PROBLEM,
        result: 'interrupted',
        reason: 'It stopped before it finished, so the record was not moved.'
      }
    })
    await until(() => !!problemNotice())
    expect(problemNotice()?.textContent).toContain('Submit order stopped before it finished')
    expect(problemNotice()?.textContent).toContain('so the record was not moved')
  })

  it('a failure of ours claims nothing about the record', async () => {
    render('panel', {
      marked: true,
      problem: {
        ...PROBLEM,
        result: 'failed',
        reason: 'Something went wrong while it ran. Open the record to see where it is now.'
      }
    })
    await until(() => !!problemNotice())
    expect(problemNotice()?.textContent).toContain('Submit order ran into a problem.')
    expect(problemNotice()?.textContent).not.toContain('was not moved')
  })

  it('a person the move is not offered to reads the reason without a Try again', async () => {
    render('panel', {
      marked: true,
      problem: { ...PROBLEM, transition_id: 't-someone-elses' }
    })
    await until(() => !!problemNotice())
    expect(button('Try again')).toBeUndefined()
  })
})

describe('when the move ends', () => {
  it('the page reads what it wrote: the record is asked for again, once', async () => {
    const calls: Cmd[] = []
    let running: RunningMove | null = RUN
    const client = {
      url: '',
      getToken: () => null,
      request: vi.fn(async (cmd: Cmd) => {
        calls.push(cmd)
        if (cmd._path.endsWith('/owners/all')) return { data: null }
        if (cmd._path === '/items/orders/42') return { data: { id: 42 } }
        if (cmd._path.startsWith('/pipelines/instance/') && cmd._method === 'GET')
          return { data: instance({ marked: true, running }) }
        return { data: { ok: true } }
      })
    } as unknown as NivaroClient
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    // The record form's own read, as the page holds it.
    const recordReads = () => calls.filter((c) => c._path === '/items/orders/42').length
    act(() =>
      root.render(
        <QueryClientProvider client={qc}>
          <NivaroProvider client={client}>
            <Probe />
            <PipelinePanel collection='orders' item='42' />
          </NivaroProvider>
        </QueryClientProvider>
      )
    )
    await until(() => !!runningNotice() && recordReads() > 0)
    const before = recordReads()
    // While it runs the record is left alone.
    await act(() => new Promise((r) => setTimeout(r, 40)))
    expect(recordReads()).toBe(before)

    // The run ends; the panel's next read no longer carries it.
    running = null
    await act(async () => {
      await qc.invalidateQueries({ queryKey: ['pipeline-instance', 'orders', '42'] })
    })
    await until(() => !runningNotice() && recordReads() === before + 1)
    expect(runningNotice()).toBeNull()
    expect(recordReads()).toBe(before + 1)
    expect(button('Submit order')?.disabled).toBe(false)
  })
})

describe('the header buttons', () => {
  it('ask for a marked move the same way and wait while it runs', async () => {
    const { calls } = render('header', { marked: true })
    await until(() => !!button('Submit order'))
    await act(async () => button('Submit order')?.click())
    await until(() => posts(calls).length > 0)
    expect(posts(calls)[0]._body).toMatchObject({ accept_pending: true })
    await until(() => button('Submit order')?.disabled === true)
    expect(button('Send Back')?.disabled).toBe(true)
    // The move that is running says so on its own button.
    expect(button('Submit order')?.getAttribute('data-move-running')).toBe('true')
  })

  it('are held while someone else’s run is on the record', async () => {
    const { calls } = render('header', { marked: true, running: RUN })
    await until(() => button('Submit order')?.disabled === true)
    await act(async () => button('Submit order')?.click())
    expect(posts(calls)).toHaveLength(0)
  })
})

// Design review round 1 (held to item 3's findings): the reason a run left is
// the refusal's own text, straight from the server. What a person reads goes
// through the same reader every other error does.
describe('the reason a run did not go through', () => {
  it('never shows a status line: what it means is read, the text itself is kept for support', async () => {
    render('panel', { marked: true, problem: PROBLEM })
    await until(() => !!problemNotice())
    expect(problemWords()?.textContent).toContain('Submission failed')
    expect(problemWords()?.textContent).not.toMatch(/HTTP|400/)
    const details = problemNotice()?.querySelector('[data-error-details]')
    expect(details?.textContent).toContain('Details for support')
    expect(details?.querySelector('[data-error-copy]')).not.toBeNull()
  })

  it('shows plain words as they are, with nothing folded away', async () => {
    render('panel', {
      marked: true,
      problem: { ...PROBLEM, reason: 'Submit order: contact email is required' }
    })
    await until(() => !!problemNotice())
    expect(problemWords()?.textContent).toBe('Contact email is required')
    expect(problemNotice()?.querySelector('[data-error-details]')).toBeNull()
  })

  it('shows no words at all for text that is only the database’s', async () => {
    render('panel', {
      marked: true,
      problem: { ...PROBLEM, result: 'failed', reason: "Invalid column name 'vendor_site'." }
    })
    await until(() => !!problemNotice())
    expect(problemWords()).toBeNull()
    expect(problemNotice()?.textContent).not.toContain('vendor_site')
    expect(problemNotice()?.textContent).toContain('Submit order ran into a problem.')
    expect(problemNotice()?.querySelector('[data-error-details]')).not.toBeNull()
  })

  it('has a tip only when the words are cut', async () => {
    render('panel', { marked: true, problem: PROBLEM })
    await until(() => !!problemWords())
    // Nothing is cut here (jsdom lays nothing out): repeating the words on hover is noise.
    expect(problemWords()?.hasAttribute('data-tip')).toBe(false)
  })
})

describe('the Progress panel, open: what holds the moves sits with them', () => {
  it('the running row is directly above the buttons, as its own card', async () => {
    render('panel', { marked: true, running: RUN, expanded: true })
    await until(() => !!runningNotice() && !!button('Submit order'))
    expect(document.querySelectorAll('[data-running-move]')).toHaveLength(1)
    expect(runningNotice()?.nextElementSibling).toBe(button('Submit order')?.parentElement)
    expect(runningNotice()?.className).toContain('rounded-lg')
    expect(runningNotice()?.className).not.toContain('border-t')
  })

  it('so is the last run’s problem, with its Try again', async () => {
    render('panel', { marked: true, problem: PROBLEM, expanded: true })
    await until(() => !!problemNotice() && !!button('Submit order'))
    expect(problemNotice()?.nextElementSibling).toBe(button('Submit order')?.parentElement)
    expect(problemNotice()?.className).toContain('rounded-lg')
    expect(button('Try again')).toBeDefined()
  })

  it('folded, both stay under the header', async () => {
    render('panel', { marked: true, running: RUN })
    await until(() => !!runningNotice())
    expect(runningNotice()?.className).toContain('border-t')
    expect(runningNotice()?.className).not.toContain('rounded-lg')
  })
})

describe('the header buttons, held by a run', () => {
  it('say why on hover: a disabled button cannot', async () => {
    render('header', { marked: true, running: RUN })
    await until(() => button('Submit order')?.disabled === true)
    const row = button('Submit order')?.closest('[data-tip]')
    expect(row?.getAttribute('data-tip')).toBe(
      'Submit order is running. Other moves wait until it finishes.'
    )
  })

  it('say nothing of the kind when no run holds them', async () => {
    render('header', { marked: true })
    await until(() => !!button('Submit order'))
    expect(button('Submit order')?.closest('[data-tip]')).toBeNull()
  })
})

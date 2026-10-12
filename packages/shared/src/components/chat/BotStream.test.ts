import { describe, expect, it } from 'vitest'
import { applyBotStreamEvent, type BotStreamEvent, type LiveBotAnswer } from './BotStream'

const ME = 'AAAAAAAA-0000-4000-8000-000000000001'
const OTHER = 'BBBBBBBB-0000-4000-8000-000000000002'

function ev(over: Partial<BotStreamEvent>): BotStreamEvent {
  return {
    stream_id: 's1',
    seq: 1,
    room: 'ch:ops',
    asker: ME,
    audience: 'room',
    phase: 'start',
    ...over
  }
}

function run(events: Array<Partial<BotStreamEvent>>, me: string | null = ME): LiveBotAnswer | null {
  let live: LiveBotAnswer | null = null
  for (const e of events) live = applyBotStreamEvent(live, ev(e), me)
  return live
}

describe('applyBotStreamEvent', () => {
  it('appends deltas within a round and restarts the text on a new round', () => {
    const live = run([
      { phase: 'start' },
      { phase: 'delta', text: 'Let me ', round: 0 },
      { phase: 'delta', text: 'check.', round: 0 },
      { phase: 'status', text: 'Looking that up…' },
      { phase: 'delta', text: 'It is ', round: 1 },
      { phase: 'delta', text: 'approved.', round: 1 }
    ])
    expect(live?.text).toBe('It is approved.')
    expect(live?.status).toBeNull()
    expect(live?.mine).toBe(true)
  })

  it('a room answer disappears at end (the real message replaces it)', () => {
    expect(run([{ phase: 'start' }, { phase: 'delta', text: 'x' }, { phase: 'end' }])).toBeNull()
  })

  it('moving private hides the bubble from everyone but the asker', () => {
    const steps: Array<Partial<BotStreamEvent>> = [
      { phase: 'start' },
      { phase: 'delta', text: 'Checking', round: 0 },
      { phase: 'private' }
    ]
    expect(run(steps, OTHER)).toBeNull()
    const mine = run(steps, ME)
    expect(mine?.private).toBe(true)
    const done = applyBotStreamEvent(
      mine,
      ev({ phase: 'end', audience: 'private', private_room: 'dm:A:B', text: 'Answer' }),
      ME
    )
    expect(done).toMatchObject({ done: true, privateRoom: 'dm:A:B', text: 'Answer' })
  })

  it('only the asker gets Stop (mine)', () => {
    expect(run([{ phase: 'start' }], OTHER)?.mine).toBe(false)
    expect(run([{ phase: 'start' }], null)?.mine).toBe(false)
  })

  it('an end for another stream leaves the current one alone', () => {
    const live = run([{ phase: 'start' }, { phase: 'delta', text: 'a' }])
    expect(applyBotStreamEvent(live, ev({ stream_id: 's2', phase: 'end' }), ME)).toBe(live)
  })
})

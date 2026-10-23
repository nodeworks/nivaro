import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const navigate = vi.hoisted(() => vi.fn())
vi.mock('react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router')>()),
  useNavigate: () => navigate
}))

// The real player loads rrweb and the API; the window is what is under test.
vi.mock('./index', () => ({
  ReplayPlayer: (p: {
    recordingId: string
    startAt: number
    controlsRef?: { current: unknown }
  }) => {
    if (p.controlsRef) p.controlsRef.current = { getTime: () => 42_000 }
    return <div data-testid='player' data-recording={p.recordingId} data-start={p.startAt} />
  }
}))

import { FloatingReplayHost, nearestCorner } from './FloatingReplay'
import {
  dockFloatingReplay,
  floatReplay,
  getDockRequest,
  getFloatingReplay,
  RESUME_LEAD_MS,
  resetFloatingReplay,
  resumeStartAt
} from './floating-store'

function mount() {
  return render(
    <div>
      <FloatingReplayHost />
    </div>
  )
}

afterEach(() => {
  resetFloatingReplay()
  navigate.mockReset()
})

describe('floating store', () => {
  it('floats, then docks back with the playhead', () => {
    floatReplay({ recording: { id: 'R1' }, title: 'Ann', at: 10_000, live: false })
    expect(getFloatingReplay()?.recording.id).toBe('R1')
    expect(dockFloatingReplay(12_000)).toEqual({ recording: { id: 'R1' }, at: 12_000 })
    expect(getFloatingReplay()).toBeNull()
    expect(getDockRequest()).toEqual({ recording: { id: 'R1' }, at: 12_000 })
  })

  it('docking with nothing floating is a no-op', () => {
    expect(dockFloatingReplay(1)).toBeNull()
    expect(getDockRequest()).toBeNull()
  })

  it('resumes where it was (the player opens 5 s before startAt)', () => {
    expect(resumeStartAt(10_000)).toBe(10_000 + RESUME_LEAD_MS)
    expect(resumeStartAt(-3)).toBe(RESUME_LEAD_MS)
  })
})

describe('nearestCorner', () => {
  const vp = { width: 1000, height: 800 }
  it('picks the corner by the window centre', () => {
    expect(nearestCorner({ left: 700, top: 600, width: 200, height: 100 }, vp)).toBe('br')
    expect(nearestCorner({ left: 10, top: 600, width: 200, height: 100 }, vp)).toBe('bl')
    expect(nearestCorner({ left: 700, top: 10, width: 200, height: 100 }, vp)).toBe('tr')
    expect(nearestCorner({ left: 10, top: 10, width: 200, height: 100 }, vp)).toBe('tl')
  })
})

describe('FloatingReplayHost', () => {
  it('renders nothing while no replay floats', () => {
    mount()
    expect(document.querySelector('[data-replay-floating]')).toBeNull()
  })

  it('portals a dock-aware window to body that resumes at the hand-off', () => {
    floatReplay({ recording: { id: 'R1' }, title: 'Ann Lee', at: 30_000, live: false })
    const { container } = mount()
    const win = document.querySelector('[data-replay-floating]') as HTMLElement
    expect(win).not.toBeNull()
    expect(container.contains(win)).toBe(false)
    expect(win.parentElement).toBe(document.body)
    expect(win.hasAttribute('data-nvr-dock-aware')).toBe(true)
    expect(screen.getByText('Ann Lee')).toBeTruthy()
    expect(screen.getByTestId('player').dataset.start).toBe(String(30_000 + RESUME_LEAD_MS))
  })

  it('closing hands the replay back to the replays page at the current moment', () => {
    floatReplay({ recording: { id: 'R1' }, title: 'Ann', at: 30_000, live: false })
    mount()
    act(() => {
      fireEvent.click(document.querySelector('[data-replay-float-close]') as HTMLElement)
    })
    expect(navigate).toHaveBeenCalledWith('/analytics/replays')
    expect(getDockRequest()).toEqual({ recording: { id: 'R1' }, at: 42_000 })
    expect(document.querySelector('[data-replay-floating]')).toBeNull()
  })

  it('stop closes it without going anywhere', () => {
    floatReplay({ recording: { id: 'R1' }, title: 'Ann', at: 0, live: false })
    mount()
    act(() => {
      fireEvent.click(document.querySelector('[data-replay-float-stop]') as HTMLElement)
    })
    expect(navigate).not.toHaveBeenCalled()
    expect(getDockRequest()).toBeNull()
    expect(document.querySelector('[data-replay-floating]')).toBeNull()
  })
})

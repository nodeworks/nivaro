// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, createElement, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NavigationContext } from '../../../context'
import type { HelpVideoDto } from '../types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type RecProps = {
  open: boolean
  videoId?: string
  onClose: () => void
  onDone: (v: HelpVideoDto) => void
}
let recorder: RecProps | null = null
let mounts = 0
vi.mock('./HelpVideoRecorder', async () => {
  const { useEffect } = await import('react')
  return {
    RECORD_UNSUPPORTED: 'unsupported',
    canRecord: () => true,
    HelpVideoRecorder: (p: RecProps) => {
      recorder = p
      useEffect(() => {
        mounts++
        return () => {
          mounts--
        }
      }, [])
      return null
    }
  }
})

const { HelpVideoRecordingProvider, useHelpVideoRecording } = await import(
  './HelpVideoRecordingProvider'
)

let api: ReturnType<typeof useHelpVideoRecording> | null = null
function Caller() {
  api = useHelpVideoRecording()
  return createElement('div', null, api.fallback)
}

const video = { id: 'vid1' } as HelpVideoDto

function mount(tree: (qc: QueryClient, navigate: (p: string) => void) => ReactNode) {
  const qc = new QueryClient()
  const invalidate = vi.spyOn(qc, 'invalidateQueries')
  const navigate = vi.fn()
  const el = document.createElement('div')
  const root = createRoot(el)
  const render = (t: ReactNode) =>
    act(() => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: qc },
          createElement(NavigationContext.Provider, { value: { navigate } }, t)
        )
      )
    })
  render(tree(qc, navigate))
  return { render, navigate, invalidate, unmount: () => act(() => root.unmount()) }
}

afterEach(() => {
  recorder = null
  api = null
  mounts = 0
})

describe('HelpVideoRecordingProvider', () => {
  it('keeps the recorder mounted when the caller unmounts mid-recording', () => {
    const h = mount(() =>
      createElement(
        HelpVideoRecordingProvider,
        null,
        createElement('main', null, createElement(Caller))
      )
    )
    act(() => {
      api?.start({})
    })
    expect(recorder?.open).toBe(true)
    // A route change: the caller's screen goes, the provider stays.
    h.render(createElement(HelpVideoRecordingProvider, null, createElement('main')))
    expect(recorder?.open).toBe(true)
    expect(mounts).toBe(1)
  })

  it('opens the editor when the caller is gone, and reloads an open editor on a re-record', () => {
    const onDone = vi.fn()
    function Starter() {
      api = useHelpVideoRecording()
      return null
    }
    const h = mount(() =>
      createElement(
        HelpVideoRecordingProvider,
        null,
        createElement('main', null, createElement(Starter))
      )
    )
    act(() => {
      api?.start({ videoId: 'v9', onDone })
    })
    h.render(createElement(HelpVideoRecordingProvider, null, createElement('main')))
    act(() => {
      recorder?.onDone(video)
      recorder?.onClose() // the limit notice calls onDone, then onClose
    })
    expect(onDone).not.toHaveBeenCalled()
    expect(h.navigate).toHaveBeenCalledWith('/help-videos?edit=vid1')
    const keys = h.invalidate.mock.calls.map((c) => (c[0] as { queryKey: unknown[] }).queryKey)
    expect(keys).toContainEqual(['help-videos'])
    expect(keys).toContainEqual(['help-video-draft', 'v9'])
    expect(recorder?.open).toBe(false)
  })

  it('calls the caller when it is still mounted', () => {
    const onDone = vi.fn()
    function Starter() {
      api = useHelpVideoRecording()
      return null
    }
    const h = mount(() => createElement(HelpVideoRecordingProvider, null, createElement(Starter)))
    act(() => {
      api?.start({ onDone })
    })
    act(() => recorder?.onDone(video))
    expect(onDone).toHaveBeenCalledWith(video)
    expect(h.navigate).not.toHaveBeenCalled()
  })

  it('refuses a second start while one is active', () => {
    mount(() => createElement(HelpVideoRecordingProvider, null, createElement(Caller)))
    let first = false
    let second = true
    act(() => {
      first = api?.start({}) ?? false
    })
    act(() => {
      second = api?.start({}) ?? true
    })
    expect(first).toBe(true)
    expect(second).toBe(false)
    expect(api?.active).toBe(true)
  })
})

describe('without a provider', () => {
  it('renders a local recorder that ends with the caller', () => {
    const onDone = vi.fn()
    const h = mount(() => createElement(Caller))
    expect(recorder).toBeNull()
    act(() => {
      api?.start({ onDone })
    })
    expect(recorder?.open).toBe(true)
    expect(mounts).toBe(1)
    act(() => recorder?.onDone(video))
    expect(onDone).toHaveBeenCalledWith(video)
    act(() => recorder?.onClose())
    expect(mounts).toBe(0)
    h.unmount()
  })
})

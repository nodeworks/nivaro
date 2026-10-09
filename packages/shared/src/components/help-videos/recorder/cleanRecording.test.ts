// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  beginCleanRecording,
  CLEAN_PREF_KEY,
  isCleanRecording,
  readCleanPref,
  resetCleanRecordingForTests,
  setRecordingSelf,
  useCleanScreen,
  useIsRecordingSelf,
  writeCleanPref
} from './cleanRecording'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const attr = () => document.documentElement.getAttribute('data-nvr-recording-clean')

afterEach(() => {
  resetCleanRecordingForTests()
  window.localStorage.clear()
  vi.restoreAllMocks()
})

describe('clean recording mode', () => {
  it('sets the attribute while held and clears it when the last holder releases', () => {
    expect(attr()).toBeNull()
    const a = beginCleanRecording()
    const b = beginCleanRecording()
    expect(attr()).toBe('1')
    a()
    a() // a second release of the same holder changes nothing
    expect(isCleanRecording()).toBe(true)
    b()
    expect(isCleanRecording()).toBe(false)
    expect(attr()).toBeNull()
  })

  it('a component holding it releases on unmount', () => {
    const el = document.createElement('div')
    const root = createRoot(el)
    const Holder = ({ on }: { on: boolean }) => {
      useCleanScreen(on)
      return null
    }
    act(() => root.render(createElement(Holder, { on: true })))
    expect(attr()).toBe('1')
    act(() => root.render(createElement(Holder, { on: false })))
    expect(attr()).toBeNull()
    act(() => root.render(createElement(Holder, { on: true })))
    expect(attr()).toBe('1')
    act(() => root.unmount())
    expect(attr()).toBeNull()
  })

  it('swaps only the signed-in person', () => {
    const seen: Record<string, boolean> = {}
    const Probe = ({ id }: { id: string }) => {
      seen[id] = useIsRecordingSelf(id)
      return null
    }
    const el = document.createElement('div')
    const root = createRoot(el)
    const render = () =>
      act(() =>
        root.render(
          createElement('div', null, [
            createElement(Probe, { key: 'me', id: 'abc-1' }),
            createElement(Probe, { key: 'other', id: 'xyz-2' })
          ])
        )
      )
    act(() => setRecordingSelf('ABC-1'))
    render()
    expect(seen).toEqual({ 'abc-1': false, 'xyz-2': false })
    let release = () => {}
    act(() => {
      release = beginCleanRecording()
    })
    expect(seen).toEqual({ 'abc-1': true, 'xyz-2': false })
    act(() => release())
    expect(seen['abc-1']).toBe(false)
    act(() => root.unmount())
  })

  it('the setup choice defaults on and is remembered per browser', () => {
    expect(readCleanPref()).toBe(true)
    writeCleanPref(false)
    expect(window.localStorage.getItem(CLEAN_PREF_KEY)).toBe('0')
    expect(readCleanPref()).toBe(false)
    writeCleanPref(true)
    expect(readCleanPref()).toBe(true)
  })

  it('blocked storage reads as on and never throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(readCleanPref()).toBe(true)
    expect(() => writeCleanPref(false)).not.toThrow()
  })
})

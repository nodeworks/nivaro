import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  dismissAutofillRun,
  getAutofillRun,
  getAutofillRuns,
  hydrateAutofillRuns,
  resetAutofillRuns,
  setAutofillRunPresented,
  startAutofillRun,
  subscribeAutofillRuns
} from './autofill-runs'

const cfg = { apiBase: '/api', authHeaders: {}, credentials: 'include' as const }

/** A poll stand-in the test drives by hand. */
function fakePoll() {
  const handlers: any[] = []
  const stop = vi.fn()
  const poll = vi.fn((opts: any) => {
    handlers.push(opts)
    return stop
  })
  return { poll, stop, last: () => handlers[handlers.length - 1] }
}

const storage = new Map<string, string>()
;(globalThis as any).sessionStorage = {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => storage.set(k, v),
  removeItem: (k: string) => storage.delete(k)
}

afterEach(() => {
  resetAutofillRuns()
  storage.clear()
})

describe('autofill runs store', () => {
  it('starts a run once and walks it reading → ready', () => {
    const { poll, last } = fakePoll()
    const seen: string[] = []
    const off = subscribeAutofillRuns(() => seen.push(getAutofillRun('a')?.status ?? '-'))
    startAutofillRun(cfg, { id: 'a', collection: 'workflows', documentName: 'sow.pdf' }, { poll })
    startAutofillRun(cfg, { id: 'a', collection: 'workflows' }, { poll })
    expect(poll).toHaveBeenCalledTimes(1)
    expect(getAutofillRuns()).toHaveLength(1)
    last().onDone({ fields: [] })
    last().onSettled()
    expect(getAutofillRun('a')).toMatchObject({ status: 'ready', proposal: { fields: [] } })
    expect(seen).toContain('ready')
    off()
  })

  it('takes the document name from the server only when the caller had none', () => {
    const { poll, last } = fakePoll()
    startAutofillRun(cfg, { id: 'b', collection: 'workflows' }, { poll })
    last().onRunning('from-server.pdf')
    expect(getAutofillRun('b')?.documentName).toBe('from-server.pdf')
    startAutofillRun(cfg, { id: 'c', collection: 'workflows', documentName: 'mine.pdf' }, { poll })
    last().onRunning('other.pdf')
    expect(getAutofillRun('c')?.documentName).toBe('mine.pdf')
  })

  it('records a failure and lets a form mark a run presented', () => {
    const { poll, last } = fakePoll()
    startAutofillRun(cfg, { id: 'd', collection: 'workflows' }, { poll })
    last().onError('Scanned PDF')
    expect(getAutofillRun('d')).toMatchObject({ status: 'failed', error: 'Scanned PDF' })
    setAutofillRunPresented('d', true)
    expect(getAutofillRun('d')?.presented).toBe(true)
  })

  it('dismiss stops the poll and drops the run', () => {
    const { poll, stop } = fakePoll()
    startAutofillRun(cfg, { id: 'e', collection: 'workflows' }, { poll })
    dismissAutofillRun('e')
    expect(stop).toHaveBeenCalledTimes(1)
    expect(getAutofillRuns()).toHaveLength(0)
  })
})

describe('autofill runs persistence', () => {
  it('re-watches the runs a previous page load stored, and forgets dismissed ones', () => {
    const { poll } = fakePoll()
    startAutofillRun(cfg, { id: 'p1', collection: 'workflows', documentName: 'a.pdf' }, { poll })
    startAutofillRun(cfg, { id: 'p2', collection: 'workflows', documentName: 'b.pdf' }, { poll })
    dismissAutofillRun('p2')
    // a fresh module state (reload) — runs are gone from memory, not from storage
    const kept = storage.get('nvr:autofill-runs')
    resetAutofillRuns()
    storage.set('nvr:autofill-runs', kept ?? '')
    expect(getAutofillRuns()).toHaveLength(0)
    const fresh = fakePoll()
    ;(globalThis as any).fetch = vi.fn()
    hydrateAutofillRuns(cfg)
    expect(getAutofillRuns().map((r) => [r.id, r.documentName])).toEqual([['p1', 'a.pdf']])
    void fresh
  })
})

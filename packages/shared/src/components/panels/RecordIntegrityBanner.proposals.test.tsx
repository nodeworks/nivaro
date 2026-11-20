// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ItemEditAuthContext, NivaroProvider } from '../../context'
import { findingKey, RecordIntegrityBanner } from './RecordIntegrityBanner'

// Prod 2026-11-19, workflow 372498: five findings shared one field and rule ("Line N: Category
// is empty"), so their proposals shared one cache entry and the open picker was tracked by list
// position — after fixing Line 1 the next finding showed Line 1's proposals, and every Apply
// answered 409 (53 times in a day).
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), info: vi.fn(), error: vi.fn() })
}))

let root: Root | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
})

const tick = async () => {
  for (let i = 0; i < 10; i++) await act(async () => new Promise((r) => setTimeout(r, 0)))
}

const finding = (n: number) => ({
  field: 'workflow_lines',
  rule: 'row-input',
  message: `Line ${n}: Category is empty`,
  fixable: true
})

type Cmd = { _method: string; _path: string; _body?: { message?: string } }

async function render(fix: (cmd: Cmd) => Promise<unknown>) {
  const proposalAsks: string[] = []
  const client = {
    url: 'http://test',
    getToken: () => null,
    request: vi.fn(async (cmd: Cmd) => {
      if (cmd._method === 'GET' && cmd._path.startsWith('/config-conformance/record/'))
        return { data: { enabled: true, findings: [finding(1), finding(2)] } }
      if (cmd._path.endsWith('/proposals')) {
        const msg = String(cmd._body?.message ?? '')
        proposalAsks.push(msg)
        const line = msg.split(':')[0]
        return {
          data: {
            proposals: [
              {
                id: `p-${line}-${proposalAsks.length}`,
                kind: 'derive',
                label: `${line}: set Category → Installation - Labor`,
                writes: [],
                preview: []
              }
            ]
          }
        }
      }
      if (cmd._path.endsWith('/fix')) return fix(cmd)
      return { data: [] }
    })
  }
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () =>
    root?.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client as never}>
          <ItemEditAuthContext.Provider value={{ isAdmin: true } as never}>
            <RecordIntegrityBanner collection='workflows' itemId='372498' />
          </ItemEditAuthContext.Provider>
        </NivaroProvider>
      </QueryClientProvider>
    )
  )
  await tick()
  const click = async (el: Element | null | undefined) => {
    expect(el).toBeTruthy()
    await act(async () => (el as HTMLElement).click())
    await tick()
  }
  const buttons = () => [...host.querySelectorAll('button')]
  const byText = (t: string) => buttons().filter((b) => b.textContent?.trim() === t)
  await click(byText('View')[0])
  return { host, click, byText, proposalAsks, client }
}

describe('integrity proposals per finding', () => {
  it('each finding of one field and rule gets its own proposals', async () => {
    const r = await render(async () => ({ data: { applied: 1, failed: [], undo: [] } }))
    await r.click(r.byText('Fix…')[0])
    expect(r.host.querySelector('[data-integrity-proposals]')?.textContent).toContain('Line 1:')
    await r.click(r.byText('Close')[0])
    await r.click(r.byText('Fix…')[1])
    const picker = r.host.querySelector('[data-integrity-proposals]')?.textContent ?? ''
    expect(picker).toContain('Line 2:')
    expect(picker).not.toContain('Line 1:')
    expect(r.proposalAsks).toEqual(['Line 1: Category is empty', 'Line 2: Category is empty'])
  })

  it('a 409 on apply reloads the proposals and says so', async () => {
    const r = await render(async () => {
      throw Object.assign(new Error('That proposal is no longer valid'), { status: 409 })
    })
    await r.click(r.byText('Fix…')[1])
    await r.click(r.host.querySelector('[data-integrity-apply]'))
    expect(r.proposalAsks).toEqual(['Line 2: Category is empty', 'Line 2: Category is empty'])
    expect(r.host.textContent).toContain('suggestions were refreshed')
  })

  it('findingKey tells same-field findings apart', () => {
    expect(findingKey(finding(1))).not.toBe(findingKey(finding(2)))
  })
})

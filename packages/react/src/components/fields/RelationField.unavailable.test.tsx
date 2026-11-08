// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../context'
import { RelationField } from './RelationField'

// army9 review M7: a workflow whose project is now outside the person's zones
// showed the bare project number. The value stays, labelled in words.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

async function render(readById: (id: string) => Promise<unknown>) {
  const client = {
    url: 'http://test',
    getToken: () => null,
    request: vi.fn(async (cmd: { _path: string }) => {
      const one = /^\/items\/projects\/(.+)$/.exec(cmd._path)
      if (one) return readById(one[1])
      return { data: [{ id: 7887, name: '201943 - 26-WEST-POWER' }] }
    })
  }
  await act(async () =>
    root.render(
      <NivaroProvider client={client as never}>
        <RelationField
          field={
            {
              field: 'project',
              fieldType: 'relation-m2o',
              relation: { relatedCollection: 'projects', displayTemplate: '{{name}}' }
            } as never
          }
          value={8161}
          onChange={() => {}}
          error={undefined}
          disabled={false}
          readOnly={false}
        />
      </NivaroProvider>
    )
  )
  for (let i = 0; i < 10; i++) await act(async () => new Promise((r) => setTimeout(r, 0)))
}

describe('RelationField value outside the listed options', () => {
  it('a project the reader cannot open reads "Not available to you", never its number', async () => {
    await render(async () => {
      throw Object.assign(new Error('Forbidden'), { status: 403, response: { status: 403 } })
    })
    const select = host.querySelector('select') as HTMLSelectElement
    expect(select.value).toBe('8161')
    expect(select.selectedOptions[0]?.textContent).toBe('Not available to you')
    expect(host.textContent).not.toContain('8161')
  })

  it('a readable value beyond the first page shows its own label', async () => {
    await render(async () => ({ data: { id: 8161, name: '201979 - PN-PNR-METROE' } }))
    const select = host.querySelector('select') as HTMLSelectElement
    expect(select.selectedOptions[0]?.textContent).toBe('201979 - PN-PNR-METROE')
  })
})

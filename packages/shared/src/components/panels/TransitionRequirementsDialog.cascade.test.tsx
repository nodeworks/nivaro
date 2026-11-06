// @vitest-environment jsdom
import type { NivaroClient } from '@nivaro/sdk'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../context'
import {
  requirementOptionFilter,
  TransitionRequirementsDialog,
  type TransitionRequirementsPayload
} from './TransitionRequirementsDialog'

// army5 b01-N2: the Submit dialog's Category picker was not narrowed by the
// line grid's cascade (project → category) — every category was offered.

type Cmd = { _method: string; _path: string; _params?: Record<string, unknown> }

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
  document.body.replaceChildren()
})

const projectFilter = {
  _exists_junction: {
    table: 'categories_projects',
    self_fk: 'categories_id',
    filter_fk: 'projects_id',
    value: 42
  }
}

describe('requirementOptionFilter', () => {
  it('no narrowing → undefined', () => {
    expect(requirementOptionFilter({})).toBeUndefined()
  })
  it('the server-resolved grid filter alone', () => {
    expect(requirementOptionFilter({ option_filter: projectFilter })).toEqual(projectFilter)
  })
  it("ANDs the grid filter with the field's own cascade built from the row", () => {
    expect(
      requirementOptionFilter(
        {
          option_filter: projectFilter,
          cascade_filters: [{ parent_field: 'zone', filter_column: 'zone' }]
        },
        { zone: 3 }
      )
    ).toEqual({ _and: [projectFilter, { zone: { _eq: 3 } }] })
  })
  it('a cascade whose parent is empty on the row adds nothing', () => {
    expect(
      requirementOptionFilter(
        { cascade_filters: [{ parent_field: 'zone', filter_column: 'zone' }] },
        {}
      )
    ).toBeUndefined()
  })
})

describe('TransitionRequirementsDialog row picker (army5 b01-N2)', () => {
  it("the options read carries the grid's cascade filter", async () => {
    const calls: Cmd[] = []
    const client = {
      url: '',
      getToken: () => null,
      request: vi.fn(async (cmd: Cmd) => {
        calls.push(cmd)
        if (cmd._path === '/collections/categories')
          return { data: { display_template: '{{name}}' } }
        if (cmd._path === '/items/categories') return { data: [{ id: 57, name: 'Equipment' }] }
        return { data: {} }
      })
    } as unknown as NivaroClient
    const payload: TransitionRequirementsPayload = [
      {
        type: 'child_fields',
        collection: 'workflow_line_items',
        fk_field: 'workflow',
        title: 'Every line needs a Category before Submit',
        fields: [
          {
            field: 'category',
            label: 'Category',
            type: 'integer',
            kind: 'm2o',
            related_collection: 'categories',
            option_filter: projectFilter
          }
        ],
        display_fields: [],
        rows: [{ id: 1, label: 'Line 1', complete: false, values: { category: null }, display: {} }]
      }
    ]
    act(() =>
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <NivaroProvider client={client}>
            <TransitionRequirementsDialog
              payload={payload}
              transitionId='T'
              onSubmitted={vi.fn()}
              onClose={() => undefined}
            />
          </NivaroProvider>
        </QueryClientProvider>
      )
    )
    for (let i = 0; i < 20; i++)
      await act(async () => {
        await new Promise((r) => setTimeout(r, 5))
      })
    const read = calls.find((c) => c._path === '/items/categories')
    expect(read).toBeTruthy()
    expect(JSON.parse(String(read?._params?.filter))).toEqual(projectFilter)
  })
})

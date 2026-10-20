// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../context'
import { UnsavedInspector } from './ItemEditForm'
import type { CMSField, CMSRelation } from './item-edit/types'

// The unsaved-changes popover names what changed the way people read it: a
// related record's label (never its internal id), a choice's text, and the
// records a staged link adds — not "4 relation link(s) staged".
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ROWS: Record<string, Record<string, unknown>> = {
  'project_types/12': { id: 12, name: 'National TPS' },
  'projects/7906': { id: 7906, code: 'P-7906', title: 'Data Center Refresh' },
  'zones/3': { id: 3, name: 'Zone 3' },
  'zones/4': { id: 4, name: 'Zone 4' }
}
const TEMPLATES: Record<string, string> = {
  project_types: '{{name}}',
  projects: '{{code}} · {{title}}',
  zones: '{{name}}'
}

const fields = [
  { field: 'project_type', label: 'Project Type', type: 'integer' },
  { field: 'project', label: 'Project', type: 'integer' },
  {
    field: 'priority',
    label: 'Priority',
    type: 'string',
    options: JSON.stringify({ choices: [{ text: '$t:high_priority', value: 'high' }] })
  },
  { field: 'zones', label: 'Zones', type: 'alias' }
] as unknown as CMSField[]

const relations = [
  {
    id: 1,
    many_collection: 'workflows',
    many_field: 'project_type',
    one_collection: 'project_types'
  },
  { id: 2, many_collection: 'workflows', many_field: 'project', one_collection: 'projects' },
  // M2M: workflows.zones → workflows_zones → zones
  {
    id: 3,
    many_collection: 'workflows_zones',
    many_field: 'workflows_id',
    one_collection: 'workflows',
    one_field: 'zones',
    junction_field: 'zones_id'
  },
  {
    id: 4,
    many_collection: 'workflows_zones',
    many_field: 'zones_id',
    one_collection: 'zones',
    junction_field: 'workflows_id'
  }
] as unknown as CMSRelation[]

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

async function mount() {
  const client = {
    request: vi.fn(async (cmd: { _path: string }) => {
      const col = cmd._path.match(/^\/collections\/([^/]+)$/)
      if (col) return { data: { display_template: TEMPLATES[col[1]] ?? null } }
      const item = cmd._path.match(/^\/items\/(.+)$/)
      if (item) return { data: ROWS[item[1]] ?? null }
      return { data: null }
    })
  }
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client as never}>
          <UnsavedInspector
            open
            onClose={() => {}}
            collection='workflows'
            relations={relations}
            fieldConfig={fields}
            draft={{ project_type: 12, project: 7906, priority: 'high' }}
            initial={{ project_type: null, project: null, priority: null }}
            m2mLinks={new Map([['zones', [3, 4]]])}
            m2mUnlinks={new Map()}
            pendingRowCount={0}
            pendingDeleteCount={0}
          />
        </NivaroProvider>
      </QueryClientProvider>
    )
  })
  // labels settle once both the row and the collection's display template have loaded
  for (let i = 0; i < 40 && !host.textContent?.includes('P-7906'); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
  }
}

describe('UnsavedInspector', () => {
  it('shows related records by label, choices by text, staged links by name', async () => {
    await mount()
    const text = host.textContent ?? ''
    expect(text).toContain('National TPS')
    expect(text).toContain('P-7906 · Data Center Refresh')
    expect(text).toContain('High Priority')
    expect(text).toContain('Zones')
    expect(text).toContain('Zone 3')
    expect(text).toContain('Zone 4')
    // before: "empty 12" / "empty 7906"
    expect(text).not.toContain('empty 12')
    expect(text).not.toContain('empty 7906')
    expect(text).not.toContain('relation link')
  })
})

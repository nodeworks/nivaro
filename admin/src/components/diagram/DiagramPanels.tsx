import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { api } from '@/lib/api'
import { buildFlowDiagram, type FlowOp } from '@/lib/diagram/flow-diagram'
import type { Diagram } from '@/lib/diagram/layout'
import { buildPipelineDiagram, type PipelineDiagramInput } from '@/lib/diagram/pipeline-diagram'
import { DiagramOutline } from './DiagramOutline'
import { DiagramViewer, useNarrow } from './DiagramViewer'

function Shell({
  diagram,
  title,
  filename,
  empty,
  emptyAt = 0
}: {
  diagram: Diagram
  title: string
  filename: string
  empty: string
  emptyAt?: number
}) {
  const narrow = useNarrow()
  if (diagram.nodes.length <= emptyAt) {
    return (
      <div className='flex flex-1 items-center justify-center p-8 text-[13px] text-slate-400'>
        {empty}
      </div>
    )
  }
  return narrow ? (
    <DiagramOutline diagram={diagram} />
  ) : (
    <DiagramViewer diagram={diagram} title={title} filename={filename} />
  )
}

/** Read-only diagram of a pipeline template. Fetches its own data. */
export function PipelineDiagram({ templateId }: { templateId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['diagram-pipeline', templateId],
    queryFn: async () => {
      const [tpl, splits, roles] = await Promise.all([
        api.get(`/pipelines/${templateId}`).then((r) => r.data.data),
        api
          .get(`/workflows/templates/${templateId}/splits`)
          .then((r) => r.data.data ?? [])
          .catch(() => []),
        api
          .get('/roles')
          .then((r) => r.data.data ?? [])
          .catch(() => [])
      ])
      const roleNames: Record<string, string> = {}
      for (const r of roles as Array<{ id: string; name: string }>) roleNames[String(r.id)] = r.name
      return {
        name: (tpl?.name as string) ?? 'pipeline',
        input: {
          states: tpl?.states ?? [],
          transitions: tpl?.transitions ?? [],
          splits,
          roleNames
        } as PipelineDiagramInput
      }
    }
  })
  const diagram = useMemo(() => (data ? buildPipelineDiagram(data.input) : null), [data])
  if (isLoading || !diagram) {
    return <div className='p-8 text-[13px] text-slate-400'>Loading diagram…</div>
  }
  return (
    <Shell
      diagram={diagram}
      title={`${data?.name} pipeline diagram`}
      filename={`pipeline-${templateId}`}
      empty='This pipeline has no steps yet.'
    />
  )
}

/** Read-only diagram of a flow. */
export function FlowDiagram({
  flowId,
  name,
  trigger,
  triggerOptions,
  operations
}: {
  flowId: string
  name: string
  trigger: string
  triggerOptions: Record<string, unknown> | null
  operations: FlowOp[]
}) {
  const { data: apiNames } = useQuery({
    queryKey: ['diagram-api-names'],
    queryFn: () =>
      api
        .get('/external-apis')
        .then((r) => {
          const out: Record<string, string> = {}
          for (const a of (r.data.data ?? []) as Array<{ id: number | string; name: string }>)
            out[String(a.id)] = a.name
          return out
        })
        .catch(() => ({}) as Record<string, string>),
    staleTime: 60_000
  })
  const diagram = useMemo(
    () =>
      buildFlowDiagram({
        trigger,
        trigger_options: triggerOptions,
        operations,
        apiNames
      }),
    [trigger, triggerOptions, operations, apiNames]
  )
  return (
    <Shell
      diagram={diagram}
      title={`${name} flow diagram`}
      filename={`flow-${flowId}`}
      empty='This flow has no steps yet.'
      emptyAt={1}
    />
  )
}

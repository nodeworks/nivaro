import { useQuery } from '@tanstack/react-query'
import { cn } from '../../../lib/utils'
import { SimpleSelect } from '../../ui/SimpleSelect'
import { inputBase, tintCard } from '../panel-style'
import { useEditorApi } from './editor-api'

export function RoleConditionRow({
  roleIds,
  onRoleIdsChange
}: {
  roleIds: string[]
  onRoleIdsChange: (ids: string[]) => void
}) {
  const api = useEditorApi()
  const { data: rolesData } = useQuery<Array<{ id: string; name: string }>>({
    queryKey: ['roles-list-for-lock'],
    queryFn: () => api.get('/roles').then((r) => r.data.data),
    staleTime: 60_000
  })
  const roles = rolesData ?? []
  return (
    <div className={cn(tintCard, 'space-y-1 px-2.5 py-2')}>
      {roles.length === 0 && <p className='text-[12px] text-slate-500'>No roles found.</p>}
      {roles.map((r) => (
        <label
          key={r.id}
          className='flex items-center gap-1.5 text-[12px] cursor-pointer select-none'
        >
          <input
            type='checkbox'
            checked={roleIds.includes(r.id)}
            onChange={(e) => {
              if (e.target.checked) onRoleIdsChange([...roleIds, r.id])
              else onRoleIdsChange(roleIds.filter((id) => id !== r.id))
            }}
            className='rounded'
          />
          <span className='text-slate-700 dark:text-foreground'>{r.name}</span>
        </label>
      ))}
    </div>
  )
}

export function PipelineStateConditionRow({
  collection,
  pipelineId,
  stateKeys,
  onPipelineChange,
  onStateKeysChange
}: {
  collection?: string
  pipelineId?: string
  stateKeys: string[]
  onPipelineChange: (id: string | undefined) => void
  onStateKeysChange: (keys: string[]) => void
}) {
  const api = useEditorApi()
  const { data: pipelinesData } = useQuery<
    Array<{ id: string; name: string; collections: string[] }>
  >({
    queryKey: ['pipelines-list-for-lock'],
    queryFn: () => api.get('/pipelines').then((r) => r.data.data),
    staleTime: 60_000
  })
  const bound = (pipelinesData ?? []).filter(
    (p) => !collection || p.collections.includes(collection)
  )

  const { data: pipelineDetail } = useQuery<{
    states: Array<{ id: string; key: string; label: string; color?: string }>
  }>({
    queryKey: ['pipeline-detail-lock', pipelineId],
    queryFn: () => api.get(`/pipelines/${pipelineId}`).then((r) => r.data.data),
    staleTime: 60_000,
    enabled: !!pipelineId
  })
  const states = pipelineDetail?.states ?? []

  return (
    <div className='space-y-1.5'>
      <div data-setting='field.lock_conditions.pipeline_id'>
        <SimpleSelect
          value={pipelineId ?? ''}
          onChange={(v) => onPipelineChange(v || undefined)}
          className={cn(inputBase, 'focus:ring-0 focus:ring-offset-0')}
          options={[
            { value: '', label: '— Select pipeline —' },
            ...bound.map((p) => ({ value: p.id, label: p.name }))
          ]}
        />
      </div>
      {bound.length === 0 && (
        <p className='text-[12px] text-slate-500'>No pipelines bound to this collection.</p>
      )}
      {!pipelineId && (
        <p className='text-[12px] text-slate-500'>Pick a pipeline to choose its states.</p>
      )}
      {pipelineId && states.length > 0 && (
        <div
          className={cn(tintCard, 'space-y-1 px-2.5 py-2')}
          data-setting='field.lock_conditions.state_keys'
        >
          {states.map((s) => (
            <label
              key={s.key}
              className='flex items-center gap-1.5 text-[12px] cursor-pointer select-none'
            >
              <input
                type='checkbox'
                checked={stateKeys.includes(s.key)}
                onChange={(e) => {
                  if (e.target.checked) onStateKeysChange([...stateKeys, s.key])
                  else onStateKeysChange(stateKeys.filter((k) => k !== s.key))
                }}
                className='rounded'
              />
              <span className='text-slate-700 dark:text-foreground'>{s.label}</span>
            </label>
          ))}
        </div>
      )}
      {pipelineId && states.length === 0 && (
        <p className='text-[12px] text-slate-500'>No states defined for this pipeline.</p>
      )}
    </div>
  )
}

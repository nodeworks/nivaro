import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useTrafficMap } from '../context'
import { Bar, Section } from '../Inspector'
import { inspectorPanels } from '../registry/inspectorPanels'
import { register } from '../registry/registry'
import type { Selection } from '../types'
import { inPage, useEntityDetail } from './b1-shared'

/**
 * #1182 — an entity's traffic split by role (Creator, Approver, Admin…), with API keys and
 * machine accounts as one "Integrations" row and signed-out calls as "Anonymous". Sits beside
 * the workspace split (#1154).
 */
export const ROLES_TAP = 'roles'

export function roleLabel(bucket: string, names: Record<string, string> | undefined): string {
  if (bucket === 'integration') return 'Integrations'
  if (bucket === 'anonymous') return 'Anonymous'
  if (bucket === '__other__') return 'Other roles'
  return names?.[bucket.toUpperCase()] ?? bucket.slice(0, 8)
}

function EntityRoles({ sel }: { sel: Selection }) {
  const { model } = useTrafficMap()
  const detail = useEntityDetail(sel.id)
  const names = useQuery({
    queryKey: ['traffic-map', 'roles'],
    queryFn: async () => (await api.get('/traffic-map/roles')).data.data as Record<string, string>,
    staleTime: 300_000
  })
  const by = (detail?.[ROLES_TAP] ?? model.entityMeta(sel.id)?.ext?.[ROLES_TAP]) as
    | Record<string, number>
    | undefined
  const rows = Object.entries(by ?? {}).sort((a, b) => b[1] - a[1])
  if (rows.length < 2) return null
  return (
    <Section title='By role'>
      <div className='grid gap-1.5' id='tm-entity-roles'>
        {rows.map(([bucket, n]) => (
          <div key={bucket} data-tm-role={bucket}>
            <Bar label={roleLabel(bucket, names.data)} n={n} max={rows[0][1]} mono={false} />
          </div>
        ))}
      </div>
    </Section>
  )
}

register(inspectorPanels, {
  id: 'roles',
  order: 61,
  applies: (sel) => sel.kind === 'entity',
  Component: inPage(EntityRoles)
})

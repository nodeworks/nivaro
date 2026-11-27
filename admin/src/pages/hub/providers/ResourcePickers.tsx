import { useQuery } from '@tanstack/react-query'
import { ChoiceCombobox } from '../hub-parts'
import {
  fetchConnections,
  fetchResources,
  type HubResource,
  providerKeys,
  type ResourceFilter
} from './providers-api'

/**
 * Pickers the existing Hub screens use to name provider things (Task 11c): a connection of one
 * provider, or a resource the Hub manages of one type (a Route 53 zone, an RDS instance, a
 * workflow…). Both are the shared Combobox; an empty list says where to get one.
 */

/** A managed resource's label in a picker: its name, else its provider id, else #id. */
export const resourceLabel = (r: Pick<HubResource, 'id' | 'name' | 'external_id'>) =>
  r.name || r.external_id || `#${r.id}`

export function ConnectionPicker({
  id,
  provider,
  value,
  onChange,
  placeholder = 'Pick a connection'
}: {
  id: string
  provider: string
  value: number | null
  onChange: (id: number) => void
  placeholder?: string
}) {
  const q = useQuery({ queryKey: providerKeys.connections(), queryFn: fetchConnections })
  const rows = (q.data ?? []).filter((c) => c.provider === provider)
  return (
    <ChoiceCombobox
      id={id}
      value={value != null ? String(value) : ''}
      onChange={(v) => onChange(Number(v))}
      options={rows.map((c) => ({ value: String(c.id), label: c.name }))}
      placeholder={q.isPending ? 'Loading…' : placeholder}
      empty={
        q.isError
          ? 'Could not load the connections'
          : 'No connection for this provider yet — add one under Connections.'
      }
      disabled={q.isPending}
    />
  )
}

export function ManagedResourcePicker({
  id,
  type,
  value,
  onChange,
  filter = {},
  placeholder = 'Pick a managed resource',
  allowNone,
  typeLabels
}: {
  id: string
  /**
   * The resource type, e.g. aws.route53_zone. Several (Task 43: an RDS instance or an Azure SQL
   * server / database) list them together, each labelled with `typeLabels`.
   */
  type: string | readonly string[]
  typeLabels?: Record<string, string>
  value: number | null
  onChange: (id: number | null) => void
  /** Narrows the list (scope, app, connection). */
  filter?: Omit<ResourceFilter, 'type'>
  placeholder?: string
  /** Adds a "None" choice that clears the value. */
  allowNone?: string
}) {
  const types = typeof type === 'string' ? [type] : [...type]
  const f: ResourceFilter = types.length === 1 ? { ...filter, type: types[0] } : { ...filter }
  const q = useQuery({ queryKey: providerKeys.resources(f), queryFn: () => fetchResources(f) })
  const live = (q.data ?? []).filter(
    (r) => !r.deleted_at && !!r.external_id && types.includes(r.type)
  )
  const options = [
    ...(allowNone ? [{ value: '', label: allowNone }] : []),
    ...live.map((r) => {
      const kind = types.length > 1 ? (typeLabels?.[r.type] ?? r.type) : null
      const base = kind ? `${resourceLabel(r)} · ${kind}` : resourceLabel(r)
      return {
        value: String(r.id),
        label: r.environment_id == null ? base : `${base} · environment`
      }
    })
  ]
  // A stored value the list no longer has (deleted, out of scope) still shows as its id.
  if (value != null && !live.some((r) => r.id === value))
    options.push({ value: String(value), label: `Resource #${value} (not found)` })
  return (
    <ChoiceCombobox
      id={id}
      value={value != null ? String(value) : ''}
      onChange={(v) => onChange(v ? Number(v) : null)}
      options={options}
      placeholder={q.isPending ? 'Loading…' : placeholder}
      empty={
        q.isError
          ? 'Could not load the resources'
          : 'The Hub manages none of this type yet — add or adopt one under Resources.'
      }
      disabled={q.isPending}
    />
  )
}

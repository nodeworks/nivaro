import { formatDateTime, toLocalDateString } from '../../lib/utils'
import { RelationLabel } from '../layout-editor/pickers/relation-label'
import type { ProposableField, ProposalKind } from './types'

/** One proposed or current value, read the way the form shows it. */
export function ProposalValue({
  value,
  kind,
  relation,
  choices
}: {
  value: unknown
  kind: ProposalKind | null
  relation?: string
  choices?: ProposableField['choices']
}) {
  if (value === null || value === undefined || value === '')
    return <span className='italic text-slate-400 dark:text-slate-500'>empty</span>
  if (kind === 'relation' && relation)
    return <RelationLabel relatedCollection={relation} id={value} />
  if (kind === 'boolean' || typeof value === 'boolean')
    return <>{value === true || value === 1 || value === '1' || value === 'true' ? 'Yes' : 'No'}</>
  if (kind === 'date') return <>{toLocalDateString(value) || String(value)}</>
  if (kind === 'datetime') return <>{formatDateTime(String(value)) || String(value)}</>
  if (kind === 'number' && typeof value === 'number')
    return <span className='tabular-nums'>{value.toLocaleString()}</span>
  if (choices) {
    const hit = choices.find((c) => String(c.value) === String(value))
    if (hit) return <>{hit.text}</>
  }
  return <span className='break-words'>{String(value)}</span>
}

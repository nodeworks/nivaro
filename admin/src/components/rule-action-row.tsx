import { useQuery } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { api, type CMSField } from '@/lib/api'
import { FieldCombobox, type FieldOption } from './rule-condition-row'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface RuleAction {
  type: string
  field?: string
  value?: unknown
  message?: string
  error_message?: string
}

interface ActionRowProps {
  action: RuleAction
  collection: string
  onChange: (updated: RuleAction) => void
  onRemove: () => void
}

// ─── Action row ───────────────────────────────────────────────────────────────

export function RuleActionRow({ action, collection, onChange, onRemove }: ActionRowProps) {
  const { data: colData } = useQuery({
    queryKey: ['collection-detail', collection],
    queryFn: () => api.get(`/collections/${collection}`).then((r) => r.data.data),
    enabled: !!collection && action.type === 'set_field'
  })

  const fields: FieldOption[] = (colData?.fields ?? []).map((f: CMSField) => ({
    field: f.field,
    type: f.type,
    interface: f.interface
  }))

  return (
    <div className='flex flex-wrap items-center gap-2'>
      <Select value={action.type} onValueChange={(t) => onChange({ type: t })}>
        <SelectTrigger className='w-40'>
          <SelectValue placeholder='action type' />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value='set_field'>Set field</SelectItem>
          <SelectItem value='notify'>Send notification</SelectItem>
          <SelectItem value='reject'>Reject (error)</SelectItem>
        </SelectContent>
      </Select>

      {action.type === 'set_field' && (
        <>
          <FieldCombobox
            fields={fields}
            value={action.field ?? ''}
            onChange={(f) => onChange({ ...action, field: f })}
          />
          <Input
            placeholder='value'
            value={String(action.value ?? '')}
            onChange={(e) => onChange({ ...action, value: e.target.value })}
            className='w-48'
          />
        </>
      )}

      {action.type === 'notify' && (
        <Input
          placeholder='Notification message'
          value={action.message ?? ''}
          onChange={(e) => onChange({ ...action, message: e.target.value })}
          className='w-72'
        />
      )}

      {action.type === 'reject' && (
        <Input
          placeholder='Error message returned to caller'
          value={action.error_message ?? ''}
          onChange={(e) => onChange({ ...action, error_message: e.target.value })}
          className='w-72'
        />
      )}

      <Button variant='ghost' size='icon' onClick={onRemove} aria-label='Remove action'>
        <X className='h-4 w-4' />
      </Button>
    </div>
  )
}

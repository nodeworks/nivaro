import { useQuery } from '@tanstack/react-query'
import { Clock } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { api } from '@/lib/api'

interface SlaStatus {
  status: 'none' | 'on_track' | 'warning' | 'breached'
  state_key?: string
  elapsed_hours?: number
  total_hours?: number
  pct_used?: number
  sla_rule?: { name: string; duration_hours: number }
}

const STATUS_COLORS: Record<string, string> = {
  on_track: 'bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/20',
  warning: 'bg-yellow-500/10 text-yellow-700 dark:text-yellow-400 border-yellow-500/20',
  breached: 'bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/20'
}

const STATUS_LABELS: Record<string, string> = {
  on_track: 'On Track',
  warning: 'SLA Warning',
  breached: 'SLA Breached'
}

export function SlaBadge({ collection, item }: { collection: string; item: string }) {
  const { data } = useQuery<SlaStatus>({
    queryKey: ['sla-status', collection, item],
    queryFn: () => api.get<SlaStatus>(`/sla/status/${collection}/${item}`).then((r) => r.data),
    refetchInterval: 60_000,
    retry: false
  })

  if (!data || data.status === 'none') return null

  const colorClass = STATUS_COLORS[data.status] ?? ''
  const label = STATUS_LABELS[data.status] ?? data.status
  const pct = data.pct_used ? Math.round(data.pct_used) : 0

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant='outline' className={`gap-1 text-xs ${colorClass}`}>
          <Clock className='h-3 w-3' />
          {label}
        </Badge>
      </TooltipTrigger>
      <TooltipContent>
        <div className='text-xs space-y-0.5'>
          {data.sla_rule && <p className='font-medium'>{data.sla_rule.name}</p>}
          <p>
            {Math.round(data.elapsed_hours ?? 0)}h / {data.total_hours}h ({pct}% used)
          </p>
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

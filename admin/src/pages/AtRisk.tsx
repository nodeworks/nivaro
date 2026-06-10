import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Power, RefreshCw } from 'lucide-react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table'
import { api } from '@/lib/api'

interface AtRiskCondition {
  field: string
  op: string
  value?: unknown
}

interface AtRiskRule {
  id: number
  collection: string
  name: string
  conditions: AtRiskCondition[]
  highlight_color: 'red' | 'amber'
  is_active: boolean
  created_at: string
}

interface AtRiskSummaryRow {
  collection: string
  at_risk_count: number
  scanned: number
}

const OP_LABELS: Record<string, string> = {
  eq: '=',
  neq: '≠',
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  contains: 'contains',
  null: 'is empty',
  nnull: 'is set'
}

function conditionText(c: AtRiskCondition): string {
  const op = OP_LABELS[c.op] ?? c.op
  if (c.op === 'null' || c.op === 'nnull') return `${c.field} ${op}`
  return `${c.field} ${op} ${String(c.value ?? '')}`
}

export function AtRiskPage() {
  const qc = useQueryClient()

  const { data: rules = [], isLoading } = useQuery<AtRiskRule[]>({
    queryKey: ['at-risk-rules'],
    queryFn: () => api.get<{ data: AtRiskRule[] }>('/at-risk/rules').then((r) => r.data.data)
  })

  const { data: summary = [] } = useQuery<AtRiskSummaryRow[]>({
    queryKey: ['at-risk-summary'],
    queryFn: () =>
      api.get<{ data: AtRiskSummaryRow[] }>('/at-risk/summary').then((r) => r.data.data)
  })

  const toggleMut = useMutation({
    mutationFn: ({ id, is_active }: { id: number; is_active: boolean }) =>
      api.patch(`/at-risk/rules/${id}`, { is_active }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['at-risk-rules'] })
      qc.invalidateQueries({ queryKey: ['at-risk-summary'] })
      toast.success('Rule updated')
    },
    onError: () => toast.error('Failed to update rule')
  })

  const summaryByCollection = new Map(summary.map((s) => [s.collection, s]))

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='shrink-0 border-b border-border px-6 py-4 flex items-center justify-between'>
        <div className='flex items-center gap-2.5'>
          <AlertTriangle className='h-5 w-5 text-muted-foreground' />
          <h1 className='text-lg font-semibold'>At-Risk Rules</h1>
        </div>
        <Button
          variant='outline'
          size='sm'
          onClick={() => {
            qc.invalidateQueries({ queryKey: ['at-risk-summary'] })
            qc.invalidateQueries({ queryKey: ['at-risk-rules'] })
          }}
        >
          <RefreshCw className='h-3.5 w-3.5 mr-1.5' />
          Refresh
        </Button>
      </header>

      <div className='flex-1 overflow-auto p-6 space-y-6'>
        {/* Summary strip */}
        {summary.length > 0 && (
          <div className='grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4'>
            {summary.map((s) => (
              <Link
                key={s.collection}
                to={`/collections/${s.collection}`}
                className='rounded-lg border border-border bg-card p-4 transition-colors hover:border-nvr-cyan/40'
              >
                <p className='truncate text-xs font-medium text-muted-foreground'>{s.collection}</p>
                <p className='mt-1 text-2xl font-semibold'>
                  {s.at_risk_count}
                  <span className='ml-1 text-xs font-normal text-muted-foreground'>
                    / {s.scanned} scanned
                  </span>
                </p>
              </Link>
            ))}
          </div>
        )}

        {/* Rules table */}
        {isLoading ? (
          <div className='space-y-3'>
            {[1, 2, 3].map((i) => (
              <div key={i} className='h-12 rounded-lg bg-muted animate-pulse' />
            ))}
          </div>
        ) : rules.length === 0 ? (
          <div className='flex flex-col items-center justify-center py-24 text-center'>
            <AlertTriangle className='h-10 w-10 text-muted-foreground mb-3' />
            <p className='text-sm font-medium mb-1'>No at-risk rules defined</p>
            <p className='text-xs text-muted-foreground max-w-md'>
              At-risk rules are created per collection in Data Model. This page lists every rule
              across all collections and shows how many records currently match.
            </p>
          </div>
        ) : (
          <div className='rounded-lg border border-border overflow-hidden'>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Collection</TableHead>
                  <TableHead>Conditions</TableHead>
                  <TableHead>Color</TableHead>
                  <TableHead>At Risk</TableHead>
                  <TableHead>Active</TableHead>
                  <TableHead className='w-10' />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rules.map((rule) => {
                  const sum = summaryByCollection.get(rule.collection)
                  return (
                    <TableRow key={rule.id}>
                      <TableCell className='font-medium'>{rule.name}</TableCell>
                      <TableCell>
                        <Link
                          to={`/collections/${rule.collection}`}
                          className='text-sm text-nvr-cyan hover:underline'
                        >
                          {rule.collection}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <div className='flex flex-wrap gap-1'>
                          {rule.conditions.map((c, i) => (
                            <code
                              // biome-ignore lint/suspicious/noArrayIndexKey: conditions are positional
                              key={i}
                              className='rounded bg-muted px-1.5 py-0.5 text-[11px]'
                            >
                              {conditionText(c)}
                            </code>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant='outline'
                          className={
                            rule.highlight_color === 'amber'
                              ? 'text-[11px] bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20'
                              : 'text-[11px] bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/20'
                          }
                        >
                          {rule.highlight_color}
                        </Badge>
                      </TableCell>
                      <TableCell className='text-sm text-muted-foreground'>
                        {rule.is_active && sum ? `${sum.at_risk_count}` : '—'}
                      </TableCell>
                      <TableCell>
                        {rule.is_active ? (
                          <Badge
                            variant='outline'
                            className='text-[11px] bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/20'
                          >
                            Active
                          </Badge>
                        ) : (
                          <Badge variant='outline' className='text-[11px] text-muted-foreground'>
                            Inactive
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <Button
                          variant='ghost'
                          size='icon'
                          className='h-7 w-7'
                          title={rule.is_active ? 'Deactivate' : 'Activate'}
                          onClick={() =>
                            toggleMut.mutate({ id: rule.id, is_active: !rule.is_active })
                          }
                          disabled={toggleMut.isPending}
                        >
                          <Power className='h-3.5 w-3.5' />
                        </Button>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  )
}

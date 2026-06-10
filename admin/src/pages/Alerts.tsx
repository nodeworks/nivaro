import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Bell, BellOff, Clock, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { api } from '@/lib/api'

import { cn, formatDate } from '@/lib/utils'

// ─── Types ────────────────────────────────────────────────────────────────────

interface AlertDefinition {
  id: number
  name: string
  category: string
  collection: string
  field: string
  operator: string
  threshold: number
  unit: string
  cooldown_minutes: number
  is_active: boolean
  filters: Record<string, unknown> | null
  subscriber_count: number
  last_triggered: string | null
}

interface AlertSubscription {
  id: number
  alert_definition: number
  notify_email: boolean
  notify_inapp: boolean
}

interface AlertLogEntry {
  id: number
  alert_definition: number
  definition_name: string
  category: string
  collection: string
  item: string
  field: string
  operator: string
  threshold: number
  unit: string
  field_value: string | null
  triggered_at: string
}

// ─── Constants ────────────────────────────────────────────────────────────────

const OPERATOR_LABELS: Record<string, string> = {
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  eq: '=',
  neq: '≠',
  change_pct: '% Δ'
}

const UNIT_SUFFIX: Record<string, string> = {
  count: '',
  percent: '%',
  dollar: '',
  days: 'd'
}

const CATEGORIES = ['all', 'budget', 'compliance', 'sla', 'inventory', 'workflow', 'general']

const CATEGORY_BADGE: Record<string, string> = {
  budget: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300',
  compliance: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300',
  sla: 'bg-pink-100 text-pink-800 dark:bg-pink-900/30 dark:text-pink-300',
  inventory: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  workflow: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  general: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatCondition(def: AlertDefinition) {
  const op = OPERATOR_LABELS[def.operator] ?? def.operator
  const suffix = UNIT_SUFFIX[def.unit] ?? ''
  return `${def.field} ${op} ${def.threshold}${suffix}`
}

function CategoryBadge({ category }: { category: string }) {
  const cls = CATEGORY_BADGE[category] ?? CATEGORY_BADGE.general
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize',
        cls
      )}
    >
      {category}
    </span>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function AlertsPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [activeTab, setActiveTab] = useState('all')

  const { data: definitions = [], isLoading: defsLoading } = useQuery<AlertDefinition[]>({
    queryKey: ['alert-definitions'],
    queryFn: () =>
      api.get<{ data: AlertDefinition[] }>('/alerts/definitions').then((r) => r.data.data)
  })

  const { data: subscriptions = [] } = useQuery<AlertSubscription[]>({
    queryKey: ['alert-subscriptions'],
    queryFn: () =>
      api.get<{ data: AlertSubscription[] }>('/alerts/subscriptions').then((r) => r.data.data)
  })

  const { data: logEntries = [], isLoading: logLoading } = useQuery<AlertLogEntry[]>({
    queryKey: ['alert-log'],
    queryFn: () => api.get<{ data: AlertLogEntry[] }>('/alerts/log').then((r) => r.data.data)
  })

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.delete(`/alerts/definitions/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['alert-definitions'] })
      queryClient.invalidateQueries({ queryKey: ['alert-log'] })
      toast.success('Alert deleted')
    },
    onError: () => toast.error('Failed to delete alert')
  })

  const toggleActiveMutation = useMutation({
    mutationFn: ({ id, is_active }: { id: number; is_active: boolean }) =>
      api.patch(`/alerts/definitions/${id}`, { is_active }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['alert-definitions'] })
    },
    onError: () => toast.error('Failed to update alert')
  })

  const subscribeMutation = useMutation({
    mutationFn: (alert_definition: number) =>
      api.post('/alerts/subscriptions', { alert_definition }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['alert-subscriptions'] })
      toast.success('Subscribed to alert')
    },
    onError: () => toast.error('Failed to subscribe')
  })

  const unsubscribeMutation = useMutation({
    mutationFn: (subId: number) => api.delete(`/alerts/subscriptions/${subId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['alert-subscriptions'] })
      toast.success('Unsubscribed from alert')
    },
    onError: () => toast.error('Failed to unsubscribe')
  })

  const evaluateMutation = useMutation({
    mutationFn: () => api.post<{ data: { triggered: number } }>('/alerts/evaluate', {}),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['alert-log'] })
      queryClient.invalidateQueries({ queryKey: ['alert-definitions'] })
      const count = res.data.data.triggered
      toast.success(`Evaluation complete — ${count} alert${count !== 1 ? 's' : ''} triggered`)
    },
    onError: () => toast.error('Evaluation failed')
  })

  const subMap = new Map<number, AlertSubscription>()
  for (const sub of subscriptions) {
    subMap.set(sub.alert_definition, sub)
  }

  const filtered =
    activeTab === 'all' ? definitions : definitions.filter((d) => d.category === activeTab)

  const activeCount = definitions.filter((d) => d.is_active).length

  return (
    <div className='space-y-6 p-6'>
      {/* Header */}
      <div className='flex items-center justify-between'>
        <div>
          <h1 className='text-2xl font-semibold tracking-tight'>Alert Manager</h1>
          <p className='text-sm text-muted-foreground mt-0.5'>
            Monitor field thresholds and notify subscribers automatically
          </p>
        </div>
        <div className='flex items-center gap-2'>
          <Button
            variant='outline'
            size='sm'
            onClick={() => evaluateMutation.mutate()}
            disabled={evaluateMutation.isPending}
          >
            <RefreshCw
              className={cn('mr-1.5 h-4 w-4', evaluateMutation.isPending && 'animate-spin')}
            />
            Evaluate Now
          </Button>
          <Button size='sm' onClick={() => navigate('/alerts/new')}>
            <Plus className='mr-1.5 h-4 w-4' />
            New Alert
          </Button>
        </div>
      </div>

      {/* Stats */}
      <div className='grid grid-cols-3 gap-4'>
        <Card>
          <CardHeader className='pb-1 pt-4 px-4'>
            <CardTitle className='text-xs font-medium text-muted-foreground uppercase tracking-wide'>
              Total Alerts
            </CardTitle>
          </CardHeader>
          <CardContent className='px-4 pb-4'>
            <p className='text-2xl font-bold'>{definitions.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className='pb-1 pt-4 px-4'>
            <CardTitle className='text-xs font-medium text-muted-foreground uppercase tracking-wide'>
              Active
            </CardTitle>
          </CardHeader>
          <CardContent className='px-4 pb-4'>
            <p className='text-2xl font-bold text-green-600 dark:text-green-400'>{activeCount}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className='pb-1 pt-4 px-4'>
            <CardTitle className='text-xs font-medium text-muted-foreground uppercase tracking-wide'>
              Recent Triggers (last 100)
            </CardTitle>
          </CardHeader>
          <CardContent className='px-4 pb-4'>
            <p className='text-2xl font-bold text-orange-600 dark:text-orange-400'>
              {logEntries.length}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Definitions table with category tabs */}
      <Card>
        <CardHeader className='px-4 py-3 border-b'>
          <CardTitle className='text-sm font-semibold'>Alert Definitions</CardTitle>
        </CardHeader>
        <CardContent className='p-0'>
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <div className='px-4 pt-3 border-b'>
              <TabsList className='h-8'>
                {CATEGORIES.map((cat) => (
                  <TabsTrigger key={cat} value={cat} className='h-7 text-xs capitalize'>
                    {cat === 'all' ? 'All' : cat}
                    {cat !== 'all' && (
                      <span className='ml-1 text-[10px] opacity-60'>
                        {definitions.filter((d) => d.category === cat).length}
                      </span>
                    )}
                  </TabsTrigger>
                ))}
              </TabsList>
            </div>

            {CATEGORIES.map((cat) => (
              <TabsContent key={cat} value={cat} className='m-0'>
                {defsLoading ? (
                  <div className='space-y-2 p-4'>
                    {[1, 2, 3].map((i) => (
                      <Skeleton key={i} className='h-10 w-full' />
                    ))}
                  </div>
                ) : filtered.length === 0 ? (
                  <div className='flex flex-col items-center gap-2 py-12 text-muted-foreground'>
                    <AlertTriangle className='h-8 w-8 opacity-30' />
                    <p className='text-sm'>No alerts defined</p>
                    <Button variant='outline' size='sm' onClick={() => navigate('/alerts/new')}>
                      <Plus className='mr-1.5 h-3.5 w-3.5' />
                      Create alert
                    </Button>
                  </div>
                ) : (
                  <div className='divide-y'>
                    {filtered.map((def) => {
                      const sub = subMap.get(def.id)
                      return (
                        <div
                          key={def.id}
                          className='flex items-center gap-4 px-4 py-3 hover:bg-muted/30 transition-colors'
                        >
                          {/* Active toggle */}
                          <Switch
                            checked={def.is_active}
                            onCheckedChange={(checked) =>
                              toggleActiveMutation.mutate({ id: def.id, is_active: checked })
                            }
                          />

                          {/* Name + condition */}
                          <div className='flex-1 min-w-0'>
                            <div className='flex items-center gap-2'>
                              <span className='font-medium text-sm truncate'>{def.name}</span>
                              <CategoryBadge category={def.category} />
                            </div>
                            <div className='flex items-center gap-3 mt-0.5'>
                              <span className='text-xs text-muted-foreground'>
                                <span className='font-mono bg-muted px-1 rounded'>
                                  {def.collection}
                                </span>
                                {' · '}
                                <span className='font-mono'>{formatCondition(def)}</span>
                              </span>
                            </div>
                          </div>

                          {/* Subscribers */}
                          <div className='text-xs text-muted-foreground text-right min-w-[60px]'>
                            <span className='font-medium'>{def.subscriber_count}</span>
                            <span className='opacity-60'>
                              {' '}
                              sub{def.subscriber_count !== 1 ? 's' : ''}
                            </span>
                          </div>

                          {/* Last triggered */}
                          <div className='text-xs text-muted-foreground text-right min-w-[100px] hidden md:block'>
                            {def.last_triggered ? (
                              <span className='flex items-center gap-1 justify-end'>
                                <Clock className='h-3 w-3 opacity-50' />
                                {formatDate(def.last_triggered)}
                              </span>
                            ) : (
                              <span className='opacity-40'>Never triggered</span>
                            )}
                          </div>

                          {/* Actions */}
                          <div className='flex items-center gap-1'>
                            {/* Subscribe / Unsubscribe toggle */}
                            {sub ? (
                              <Button
                                variant='ghost'
                                size='icon'
                                className='h-7 w-7 text-nvr-cyan'
                                title='Unsubscribe'
                                onClick={() => unsubscribeMutation.mutate(sub.id)}
                                disabled={unsubscribeMutation.isPending}
                              >
                                <Bell className='h-3.5 w-3.5' />
                              </Button>
                            ) : (
                              <Button
                                variant='ghost'
                                size='icon'
                                className='h-7 w-7 text-muted-foreground'
                                title='Subscribe'
                                onClick={() => subscribeMutation.mutate(def.id)}
                                disabled={subscribeMutation.isPending}
                              >
                                <BellOff className='h-3.5 w-3.5' />
                              </Button>
                            )}

                            <Button
                              variant='ghost'
                              size='icon'
                              className='h-7 w-7'
                              onClick={() => navigate(`/alerts/${def.id}`)}
                            >
                              <Pencil className='h-3.5 w-3.5' />
                            </Button>

                            <Button
                              variant='ghost'
                              size='icon'
                              className='h-7 w-7 text-destructive hover:text-destructive'
                              onClick={() => {
                                if (confirm(`Delete alert "${def.name}"? This cannot be undone.`)) {
                                  deleteMutation.mutate(def.id)
                                }
                              }}
                              disabled={deleteMutation.isPending}
                            >
                              <Trash2 className='h-3.5 w-3.5' />
                            </Button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </TabsContent>
            ))}
          </Tabs>
        </CardContent>
      </Card>

      {/* Recent Alert Log */}
      <Card>
        <CardHeader className='px-4 py-3 border-b'>
          <CardTitle className='text-sm font-semibold'>Recent Alert Log</CardTitle>
        </CardHeader>
        <CardContent className='p-0'>
          {logLoading ? (
            <div className='space-y-2 p-4'>
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className='h-8 w-full' />
              ))}
            </div>
          ) : logEntries.length === 0 ? (
            <div className='py-10 text-center text-sm text-muted-foreground'>
              No alerts have been triggered yet
            </div>
          ) : (
            <div className='overflow-x-auto'>
              <table className='w-full text-sm'>
                <thead>
                  <tr className='border-b bg-muted/40'>
                    <th className='px-4 py-2 text-left text-xs font-medium text-muted-foreground'>
                      Alert
                    </th>
                    <th className='px-4 py-2 text-left text-xs font-medium text-muted-foreground'>
                      Collection
                    </th>
                    <th className='px-4 py-2 text-left text-xs font-medium text-muted-foreground'>
                      Item
                    </th>
                    <th className='px-4 py-2 text-left text-xs font-medium text-muted-foreground'>
                      Value
                    </th>
                    <th className='px-4 py-2 text-left text-xs font-medium text-muted-foreground'>
                      Triggered
                    </th>
                  </tr>
                </thead>
                <tbody className='divide-y'>
                  {logEntries.slice(0, 20).map((entry) => (
                    <tr key={entry.id} className='hover:bg-muted/20'>
                      <td className='px-4 py-2'>
                        <div className='flex items-center gap-1.5'>
                          <CategoryBadge category={entry.category} />
                          <span className='font-medium truncate max-w-[140px]'>
                            {entry.definition_name}
                          </span>
                        </div>
                      </td>
                      <td className='px-4 py-2 font-mono text-xs text-muted-foreground'>
                        {entry.collection}
                      </td>
                      <td className='px-4 py-2 font-mono text-xs'>{entry.item}</td>
                      <td className='px-4 py-2 font-mono text-xs'>
                        {entry.field_value ?? <span className='opacity-40'>—</span>}
                      </td>
                      <td className='px-4 py-2 text-xs text-muted-foreground'>
                        {formatDate(entry.triggered_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

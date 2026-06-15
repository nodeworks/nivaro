import { useMutation, useQuery } from '@tanstack/react-query'
import {
  AlertCircle,
  ArrowUpRight,
  Check,
  CreditCard,
  Download,
  ExternalLink,
  HardDrive,
  Server,
  Users
} from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table'
import {
  cloudAccount,
  type CloudAccountInfo,
  type CloudAccountUsage,
  type CloudBilling,
  type CloudInvoice,
  type CloudPlan
} from '@/lib/api'
import { cn, formatDate } from '@/lib/utils'

// ─── Formatters ──────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

function formatCurrency(amount: number, currency = 'usd'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
    minimumFractionDigits: 0,
    maximumFractionDigits: 2
  }).format(amount / 100)
}

function formatLargeNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
  return n.toLocaleString()
}

function usagePct(used: number, limit: number | null): number {
  if (!limit) return 0
  return Math.min(100, Math.round((used / limit) * 100))
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function PlanStatusBadge({ status }: { status: CloudAccountInfo['status'] }) {
  const map: Record<CloudAccountInfo['status'], { label: string; className: string }> = {
    active: { label: 'Active', className: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20' },
    trialing: { label: 'Trial', className: 'bg-[#00ceff]/10 text-[#00ceff] border-[#00ceff]/20' },
    past_due: { label: 'Past due', className: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20' },
    canceled: { label: 'Canceled', className: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400 border-slate-200 dark:border-slate-700' },
    unpaid: { label: 'Unpaid', className: 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20' }
  }
  const { label, className } = map[status] ?? map.active
  return (
    <Badge variant='outline' className={cn('text-[11px] font-medium', className)}>
      {label}
    </Badge>
  )
}

function InvoiceStatusBadge({ status }: { status: CloudInvoice['status'] }) {
  const map: Record<CloudInvoice['status'], { label: string; className: string }> = {
    paid: { label: 'Paid', className: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20' },
    open: { label: 'Pending', className: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20' },
    void: { label: 'Void', className: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400 border-slate-200 dark:border-slate-700' },
    uncollectible: { label: 'Failed', className: 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20' }
  }
  const { label, className } = map[status] ?? map.open
  return (
    <Badge variant='outline' className={cn('text-[11px] font-medium', className)}>
      {label}
    </Badge>
  )
}

function UsageBar({
  icon: Icon,
  label,
  used,
  limit,
  formatUsed,
  formatLimit
}: {
  icon: React.ElementType
  label: string
  used: number
  limit: number | null
  formatUsed: (n: number) => string
  formatLimit: (n: number) => string
}) {
  const pct = usagePct(used, limit)
  const isWarning = pct >= 80
  const isCritical = pct >= 95

  return (
    <div className='space-y-2'>
      <div className='flex items-center justify-between gap-3'>
        <div className='flex items-center gap-2 min-w-0'>
          <Icon className='h-3.5 w-3.5 shrink-0 text-muted-foreground' />
          <span className='text-sm font-medium text-slate-700 dark:text-slate-300'>{label}</span>
        </div>
        <div className='flex items-center gap-2 shrink-0'>
          <span className={cn(
            'text-[12px] tabular-nums',
            isCritical ? 'text-red-600 dark:text-red-400 font-semibold' :
            isWarning ? 'text-amber-600 dark:text-amber-400 font-medium' :
            'text-slate-600 dark:text-slate-400'
          )}>
            {formatUsed(used)}
          </span>
          <span className='text-[11px] text-muted-foreground'>/</span>
          <span className='text-[12px] text-muted-foreground tabular-nums'>{limit != null ? formatLimit(limit) : '—'}</span>
          <span className={cn(
            'text-[11px] tabular-nums font-medium w-9 text-right',
            isCritical ? 'text-red-600 dark:text-red-400' :
            isWarning ? 'text-amber-600 dark:text-amber-400' :
            'text-muted-foreground'
          )}>
            {pct}%
          </span>
        </div>
      </div>
      <Progress
        value={pct}
        className={cn(
          'h-1.5 rounded-full',
          isCritical ? '[&>div]:bg-red-500' :
          isWarning ? '[&>div]:bg-amber-500' :
          '[&>div]:bg-[#00ceff]'
        )}
      />
    </div>
  )
}

function PlanCard({
  plan,
  isCurrent,
  onManage,
  isLoading
}: {
  plan: CloudPlan
  isCurrent: boolean
  onManage: () => void
  isLoading: boolean
}) {
  return (
    <div className={cn(
      'relative rounded-lg border p-4 transition-colors',
      isCurrent
        ? 'border-[#00ceff] bg-[#00ceff]/5 dark:bg-[#00ceff]/8'
        : 'border-border bg-card hover:border-slate-300 dark:hover:border-slate-600'
    )}>
      {isCurrent && (
        <div className='absolute -top-px left-4 right-4 h-0.5 rounded-full bg-[#00ceff]' />
      )}
      <div className='flex items-center gap-2 mb-3'>
        <span className='text-sm font-semibold text-slate-900 dark:text-slate-100'>{plan.name}</span>
        {isCurrent && (
          <Badge variant='outline' className='text-[10px] px-1.5 py-0 bg-[#00ceff]/10 text-[#00ceff] border-[#00ceff]/30'>
            Current
          </Badge>
        )}
      </div>
      <div className='mt-1 flex items-baseline gap-1 mb-3'>
        {plan.price === 0 ? (
          <span className='text-lg font-bold text-slate-900 dark:text-slate-100'>Free</span>
        ) : (
          <>
            <span className='text-lg font-bold tabular-nums text-slate-900 dark:text-slate-100'>
              {formatCurrency(plan.price, 'usd')}
            </span>
            <span className='text-[11px] text-muted-foreground'>/mo</span>
          </>
        )}
      </div>
      <div className='text-[11px] text-muted-foreground space-y-0.5 mb-4'>
        <div>{formatLargeNumber(plan.recordLimit)} records</div>
        <div>{plan.storageGb} GB storage</div>
        <div>{plan.maxUsers === 0 ? 'Unlimited' : plan.maxUsers} users</div>
      </div>
      {isCurrent ? (
        <Button variant='outline' size='sm' className='w-full h-7 text-[12px]' onClick={onManage} disabled={isLoading}>
          {isLoading ? 'Opening...' : 'Manage billing'}
        </Button>
      ) : (
        <Button variant='outline' size='sm' className='w-full h-7 text-[12px]' onClick={onManage} disabled={isLoading}>
          {isLoading ? 'Opening...' : 'Switch plan'}
        </Button>
      )}
    </div>
  )
}

// ─── Skeleton loaders ─────────────────────────────────────────────────────────

function StatCardSkeleton() {
  return (
    <Card>
      <CardHeader className='pb-2'>
        <Skeleton className='h-4 w-24' />
      </CardHeader>
      <CardContent className='space-y-2'>
        <Skeleton className='h-6 w-32' />
        <Skeleton className='h-4 w-20' />
      </CardContent>
    </Card>
  )
}

// ─── Self-hosted fallback ─────────────────────────────────────────────────────

function SelfHostedView() {
  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <div className='shrink-0 border-b px-6 py-4'>
        <h1 className='text-base font-semibold text-slate-900 dark:text-foreground'>
          Account &amp; Billing
        </h1>
      </div>
      <div className='flex flex-1 items-center justify-center p-8'>
        <div className='max-w-sm text-center'>
          <div className='inline-flex items-center justify-center w-12 h-12 rounded-full bg-slate-100 dark:bg-muted mb-4'>
            <Server className='h-5 w-5 text-slate-500' />
          </div>
          <h2 className='text-sm font-semibold text-slate-900 dark:text-foreground mb-2'>
            Self-hosted Nivaro
          </h2>
          <p className='text-[13px] text-muted-foreground leading-relaxed mb-5'>
            You&apos;re running Nivaro on your own infrastructure. Billing and plan management are
            not available in self-hosted mode.
          </p>
          <Button
            variant='outline'
            size='sm'
            className='gap-1.5'
            onClick={() => window.open('https://nivaro.io/cloud', '_blank')}
          >
            <ExternalLink className='h-3.5 w-3.5' />
            Learn about Nivaro Cloud
          </Button>
        </div>
      </div>
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function AccountPage() {
  const infoQuery = useQuery({
    queryKey: ['cloud-account-info'],
    queryFn: cloudAccount.info,
    retry: false,
    staleTime: 60_000
  })

  const isCloud = infoQuery.isSuccess
  const isNotCloud = infoQuery.isError && (infoQuery.error as { response?: { status?: number } })?.response?.status === 404
  const isLoading = infoQuery.isLoading

  const usageQuery = useQuery({
    queryKey: ['cloud-account-usage'],
    queryFn: cloudAccount.usage,
    enabled: isCloud,
    staleTime: 30_000
  })

  const billingQuery = useQuery({
    queryKey: ['cloud-account-billing'],
    queryFn: cloudAccount.billing,
    enabled: isCloud,
    staleTime: 60_000
  })

  const invoicesQuery = useQuery({
    queryKey: ['cloud-account-invoices'],
    queryFn: cloudAccount.invoices,
    enabled: isCloud,
    staleTime: 60_000
  })

  const plansQuery = useQuery({
    queryKey: ['cloud-account-plans'],
    queryFn: cloudAccount.plans,
    enabled: isCloud,
    staleTime: 300_000
  })

  const portalMutation = useMutation({
    mutationFn: () => cloudAccount.createPortal(window.location.href),
    onSuccess: (data) => {
      window.location.href = data.url
    },
    onError: () => {
      toast.error('Could not open billing portal')
    }
  })

  const checkoutMutation = useMutation({
    mutationFn: (priceId: string) => cloudAccount.createCheckout(priceId),
    onSuccess: (data) => {
      window.location.href = data.url
    },
    onError: () => {
      toast.error('Could not start plan change')
    }
  })

  if (isLoading) {
    return (
      <div className='flex flex-1 min-h-0 flex-col'>
        <div className='shrink-0 border-b px-6 py-4 flex items-center justify-between'>
          <Skeleton className='h-5 w-40' />
          <Skeleton className='h-8 w-32' />
        </div>
        <div className='flex-1 overflow-y-auto'>
          <div className='max-w-5xl mx-auto px-6 py-6 space-y-6'>
            <div className='grid grid-cols-3 gap-4'>
              <StatCardSkeleton />
              <StatCardSkeleton />
              <StatCardSkeleton />
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (isNotCloud || (!isLoading && !isCloud && !infoQuery.isError)) {
    return <SelfHostedView />
  }

  if (infoQuery.isError && !isNotCloud) {
    return <SelfHostedView />
  }

  const info = infoQuery.data as CloudAccountInfo
  const usage = usageQuery.data as CloudAccountUsage | undefined
  const billing = billingQuery.data as CloudBilling | undefined
  const invoices = (invoicesQuery.data ?? []) as CloudInvoice[]
  const plans = (plansQuery.data ?? []) as CloudPlan[]

  const topUsagePct = usage
    ? Math.max(
        usagePct(usage.records.used, usage.records.limit),
        usagePct(usage.storage_gb.used, usage.storage_gb.limit),
        usagePct(usage.users.used, usage.users.limit)
      )
    : null

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      {/* Page header */}
      <div className='shrink-0 border-b px-6 py-4 flex items-center justify-between bg-white dark:bg-background'>
        <div>
          <h1 className='text-base font-semibold text-slate-900 dark:text-foreground'>
            Account &amp; Billing
          </h1>
          {info.name && (
            <p className='text-[12px] text-muted-foreground mt-0.5'>{info.name}</p>
          )}
        </div>
        <Button
          size='sm'
          variant='outline'
          className='gap-1.5 h-8 text-[12px]'
          onClick={() => portalMutation.mutate()}
          disabled={portalMutation.isPending}
        >
          <CreditCard className='h-3.5 w-3.5' />
          {portalMutation.isPending ? 'Opening...' : 'Manage billing'}
          <ArrowUpRight className='h-3 w-3 opacity-60' />
        </Button>
      </div>

      {/* Scrollable body */}
      <div className='flex-1 overflow-y-auto bg-slate-50 dark:bg-background'>
        <div className='max-w-5xl mx-auto px-6 py-6 space-y-6'>

          {/* Top stat row */}
          <div className='grid grid-cols-1 sm:grid-cols-3 gap-4'>
            {/* Current plan */}
            <Card className='border-border'>
              <CardHeader className='pb-2 pt-4 px-4'>
                <CardTitle className='text-[11px] font-medium tracking-wide text-muted-foreground uppercase'>
                  Current plan
                </CardTitle>
              </CardHeader>
              <CardContent className='px-4 pb-4 space-y-2'>
                <div className='flex items-center gap-2'>
                  <span className='text-lg font-semibold text-slate-900 dark:text-foreground'>
                    {info.plan}
                  </span>
                  <PlanStatusBadge status={info.status} />
                </div>
                {billing?.cancel_at_period_end && (
                  <div className='flex items-center gap-1.5 text-[12px] text-amber-600 dark:text-amber-400'>
                    <AlertCircle className='h-3.5 w-3.5 shrink-0' />
                    Cancels {billing.current_period_end ? formatDate(billing.current_period_end) : 'soon'}
                  </div>
                )}
                {!billing?.cancel_at_period_end && billing?.current_period_end && (
                  <p className='text-[12px] text-muted-foreground'>
                    Renews {formatDate(billing.current_period_end)}
                  </p>
                )}
              </CardContent>
            </Card>

            {/* Usage summary */}
            <Card className='border-border'>
              <CardHeader className='pb-2 pt-4 px-4'>
                <CardTitle className='text-[11px] font-medium tracking-wide text-muted-foreground uppercase'>
                  Usage
                </CardTitle>
              </CardHeader>
              <CardContent className='px-4 pb-4'>
                {usageQuery.isLoading ? (
                  <Skeleton className='h-8 w-24' />
                ) : topUsagePct !== null ? (
                  <div className='space-y-2'>
                    <div className='flex items-baseline gap-1'>
                      <span className={cn(
                        'text-2xl font-bold tabular-nums',
                        topUsagePct >= 95 ? 'text-red-600 dark:text-red-400' :
                        topUsagePct >= 80 ? 'text-amber-600 dark:text-amber-400' :
                        'text-slate-900 dark:text-foreground'
                      )}>
                        {topUsagePct}%
                      </span>
                      <span className='text-[12px] text-muted-foreground'>peak usage</span>
                    </div>
                    <Progress
                      value={topUsagePct}
                      className={cn(
                        'h-1.5',
                        topUsagePct >= 95 ? '[&>div]:bg-red-500' :
                        topUsagePct >= 80 ? '[&>div]:bg-amber-500' :
                        '[&>div]:bg-[#00ceff]'
                      )}
                    />
                  </div>
                ) : (
                  <p className='text-[12px] text-muted-foreground'>No usage data</p>
                )}
              </CardContent>
            </Card>

            {/* Next invoice */}
            <Card className='border-border'>
              <CardHeader className='pb-2 pt-4 px-4'>
                <CardTitle className='text-[11px] font-medium tracking-wide text-muted-foreground uppercase'>
                  Next invoice
                </CardTitle>
              </CardHeader>
              <CardContent className='px-4 pb-4'>
                {billingQuery.isLoading ? (
                  <Skeleton className='h-8 w-28' />
                ) : billing?.next_invoice_amount != null ? (
                  <div className='space-y-1'>
                    <div className='text-2xl font-bold tabular-nums text-slate-900 dark:text-foreground'>
                      {formatCurrency(billing.next_invoice_amount, billing.currency)}
                    </div>
                    {billing.next_invoice_date && (
                      <p className='text-[12px] text-muted-foreground'>
                        Due {formatDate(billing.next_invoice_date)}
                      </p>
                    )}
                  </div>
                ) : (
                  <p className='text-[12px] text-muted-foreground'>No upcoming invoice</p>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Usage details */}
          {(usage || usageQuery.isLoading) && (
            <Card className='border-border'>
              <CardHeader className='px-5 pt-5 pb-3'>
                <CardTitle className='text-sm font-semibold text-slate-900 dark:text-foreground'>
                  Usage details
                </CardTitle>
              </CardHeader>
              <CardContent className='px-5 pb-5 space-y-4'>
                {usageQuery.isLoading ? (
                  <div className='space-y-4'>
                    {[0, 1, 2].map((i) => (
                      <div key={i} className='space-y-2'>
                        <Skeleton className='h-4 w-full' />
                        <Skeleton className='h-1.5 w-full' />
                      </div>
                    ))}
                  </div>
                ) : usage ? (
                  <>
                    <UsageBar
                      icon={HardDrive}
                      label='Records'
                      used={usage.records.used}
                      limit={usage.records.limit}
                      formatUsed={formatLargeNumber}
                      formatLimit={formatLargeNumber}
                    />
                    <div className='border-t border-border' />
                    <UsageBar
                      icon={HardDrive}
                      label='Storage'
                      used={usage.storage_gb.used}
                      limit={usage.storage_gb.limit}
                      formatUsed={formatBytes}
                      formatLimit={formatBytes}
                    />
                    <div className='border-t border-border' />
                    <UsageBar
                      icon={Users}
                      label='Users'
                      used={usage.users.used}
                      limit={usage.users.limit}
                      formatUsed={(n) => n.toString()}
                      formatLimit={(n) => n.toString()}
                    />
                  </>
                ) : null}
              </CardContent>
            </Card>
          )}

          {/* Available plans */}
          {(plans.length > 0 || plansQuery.isLoading) && (
            <div>
              <h2 className='text-sm font-semibold text-slate-900 dark:text-foreground mb-3'>
                Available plans
              </h2>
              {plansQuery.isLoading ? (
                <div className='grid grid-cols-2 sm:grid-cols-4 gap-3'>
                  {[0, 1, 2, 3].map((i) => (
                    <Skeleton key={i} className='h-48 rounded-lg' />
                  ))}
                </div>
              ) : (
                <div className='grid grid-cols-2 sm:grid-cols-4 gap-3'>
                  {plans.map((plan) => (
                    <PlanCard
                      key={plan.planKey}
                      plan={plan}
                      isCurrent={plan.planKey === info.plan}
                      onManage={() => portalMutation.mutate()}
                      isLoading={portalMutation.isPending}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Invoice history */}
          <Card className='border-border'>
            <CardHeader className='px-5 pt-5 pb-3 flex-row items-center justify-between space-y-0'>
              <CardTitle className='text-sm font-semibold text-slate-900 dark:text-foreground'>
                Invoice history
              </CardTitle>
            </CardHeader>
            <CardContent className='px-0 pb-0'>
              {invoicesQuery.isLoading ? (
                <div className='px-5 pb-5 space-y-3'>
                  {[0, 1, 2].map((i) => <Skeleton key={i} className='h-10 w-full' />)}
                </div>
              ) : invoices.length === 0 ? (
                <div className='px-5 pb-5 py-8 text-center'>
                  <p className='text-[12px] text-muted-foreground'>No invoices yet</p>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow className='hover:bg-transparent border-b-border'>
                      <TableHead className='text-[11px] font-medium text-muted-foreground pl-5'>Invoice</TableHead>
                      <TableHead className='text-[11px] font-medium text-muted-foreground'>Date</TableHead>
                      <TableHead className='text-[11px] font-medium text-muted-foreground'>Amount</TableHead>
                      <TableHead className='text-[11px] font-medium text-muted-foreground'>Status</TableHead>
                      <TableHead className='text-[11px] font-medium text-muted-foreground pr-5 text-right'>PDF</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {invoices.map((inv) => (
                      <TableRow key={inv.id} className='hover:bg-slate-50 dark:hover:bg-muted/50 border-b-border last:border-0'>
                        <TableCell className='pl-5 py-3 text-[12px] font-mono text-slate-700 dark:text-slate-300'>
                          {inv.number}
                        </TableCell>
                        <TableCell className='py-3 text-[12px] text-slate-600 dark:text-slate-400 tabular-nums'>
                          {formatDate(inv.date)}
                        </TableCell>
                        <TableCell className='py-3 text-[12px] tabular-nums font-medium text-slate-700 dark:text-slate-300'>
                          {formatCurrency(inv.amount, inv.currency)}
                        </TableCell>
                        <TableCell className='py-3'>
                          <InvoiceStatusBadge status={inv.status} />
                        </TableCell>
                        <TableCell className='pr-5 py-3 text-right'>
                          {inv.pdf_url ? (
                            <Button
                              variant='ghost'
                              size='sm'
                              className='h-6 w-6 p-0 text-muted-foreground hover:text-slate-700 dark:hover:text-slate-200'
                              asChild
                            >
                              <a href={inv.pdf_url} target='_blank' rel='noopener noreferrer' aria-label={`Download invoice ${inv.number}`}>
                                <Download className='h-3.5 w-3.5' />
                              </a>
                            </Button>
                          ) : (
                            <span className='text-[11px] text-muted-foreground'>—</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

        </div>
      </div>
    </div>
  )
}

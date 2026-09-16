import { DeliveryChips, EmptyState, ErrorSurface, NotificationDetailBits } from '@nivaro/shared'
import { Contrast, Inbox, Play } from 'lucide-react'
import { useCallback, useRef, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { type ContrastOffender, runContrastAudit } from '@/lib/contrast-audit'
import { cn } from '@/lib/utils'

/**
 * Dark-mode contrast audit page (#44). The command-palette auditor measures
 * whatever page you happen to be on; this page renders a fixed showcase of
 * the shared + admin components in BOTH themes side by side (the dark column
 * is a `.dark` subtree, which is exactly how the app's dark variants key) and
 * measures each column, so a light-on-light regression in a shared component
 * shows up here before anyone reports it — rerunnable on demand, and the
 * whole page can be measured too.
 */

type Theme = 'light' | 'dark'
interface Result {
  theme: Theme
  scanned: string
  offenders: ContrastOffender[]
  at: number
}

const SAMPLE_DELIVERY = {
  inapp: { status: 'delivered' as const },
  push: { status: 'sent' as const, at: new Date().toISOString() },
  email: { status: 'deferred' as const, reason: 'quiet_hours' }
}

function Showcase({ theme }: { theme: Theme }) {
  return (
    <div className='space-y-4 text-[12.5px]' data-contrast-showcase={theme}>
      <section className='space-y-2'>
        <h4 className='text-[11px] font-semibold uppercase tracking-wide text-muted-foreground'>
          Buttons
        </h4>
        <div className='flex flex-wrap gap-2'>
          <Button size='sm'>Primary</Button>
          <Button size='sm' variant='secondary'>
            Secondary
          </Button>
          <Button size='sm' variant='outline'>
            Outline
          </Button>
          <Button size='sm' variant='ghost'>
            Ghost
          </Button>
          <Button size='sm' variant='destructive'>
            Destructive
          </Button>
          <Button size='sm' variant='link'>
            Link
          </Button>
          <Button size='sm' disabled>
            Disabled
          </Button>
        </div>
      </section>
      <section className='space-y-2'>
        <h4 className='text-[11px] font-semibold uppercase tracking-wide text-muted-foreground'>
          Badges & chips
        </h4>
        <div className='flex flex-wrap items-center gap-2'>
          <Badge>Default</Badge>
          <Badge variant='secondary'>Secondary</Badge>
          <Badge variant='outline'>Outline</Badge>
          <Badge variant='success'>Success</Badge>
          <Badge variant='warning'>Warning</Badge>
          <Badge variant='destructive'>Destructive</Badge>
          <DeliveryChips delivery={SAMPLE_DELIVERY} />
          <NotificationDetailBits
            detail={{
              changes: [
                { field: 'may', label: 'May', old: '2', new: '3' },
                { field: 'objective', label: 'Objective', old: 'Old text', new: 'New text' }
              ]
            }}
            why={{ kind: 'watch', text: 'You watch this record', label: 'CM26-79811', id: '1' }}
          />
        </div>
      </section>
      <section className='space-y-2'>
        <h4 className='text-[11px] font-semibold uppercase tracking-wide text-muted-foreground'>
          Inputs
        </h4>
        <div className='flex flex-wrap items-center gap-3'>
          <Input placeholder='Placeholder text' className='h-8 w-44' />
          <Input defaultValue='Typed value' className='h-8 w-36' />
          <Input defaultValue='Disabled' disabled className='h-8 w-28' />
          <label className='flex items-center gap-1.5'>
            <Switch defaultChecked /> Switch
          </label>
          <label className='flex items-center gap-1.5'>
            <Checkbox defaultChecked /> Checkbox
          </label>
          <Tabs defaultValue='a'>
            <TabsList>
              <TabsTrigger value='a'>Active tab</TabsTrigger>
              <TabsTrigger value='b'>Other tab</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </section>
      <section className='space-y-2'>
        <h4 className='text-[11px] font-semibold uppercase tracking-wide text-muted-foreground'>
          Table
        </h4>
        <div className='overflow-hidden rounded-md border border-border'>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Record</TableHead>
                <TableHead>State</TableHead>
                <TableHead className='text-right'>Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell className='font-mono text-[11.5px]'>CM26-79811</TableCell>
                <TableCell>
                  <span className='rounded-full bg-emerald-100 px-2 py-0.5 text-[10.5px] font-medium text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300'>
                    Started
                  </span>
                </TableCell>
                <TableCell className='text-right tabular-nums'>$3,401.00</TableCell>
              </TableRow>
              <TableRow className='bg-muted/40'>
                <TableCell className='font-mono text-[11.5px]'>PW26-80356</TableCell>
                <TableCell>
                  <span className='rounded-full bg-amber-100 px-2 py-0.5 text-[10.5px] font-medium text-amber-800 dark:bg-amber-400/15 dark:text-amber-200'>
                    On hold
                  </span>
                </TableCell>
                <TableCell className='text-right tabular-nums text-muted-foreground'>—</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </section>
      <section className='space-y-2'>
        <h4 className='text-[11px] font-semibold uppercase tracking-wide text-muted-foreground'>
          Text on surfaces
        </h4>
        <div className='grid gap-3 sm:grid-cols-2'>
          <div className='rounded-lg border border-border bg-card p-3'>
            <p className='text-[13px] font-semibold text-foreground'>Card title</p>
            <p className='text-[12px] text-muted-foreground'>Muted supporting copy on a card.</p>
            <p className='mt-1 text-[11px] text-slate-400'>Slate-400 hint text</p>
          </div>
          <div className='rounded-lg bg-nvr-cyan/10 p-3'>
            <p className='text-[13px] font-semibold text-slate-900 dark:text-slate-100'>
              Accent tint surface
            </p>
            <p className='text-[12px] text-slate-600 dark:text-slate-300'>Body copy on the tint.</p>
            <p className='mt-1 text-[11px] text-nvr-navy dark:text-nvr-cyan'>
              Accent-coloured text
            </p>
          </div>
          <div className='rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-500/30 dark:bg-amber-400/10'>
            <p className='text-[12px] font-medium text-amber-900 dark:text-amber-200'>
              Warning callout text
            </p>
          </div>
          <div className='rounded-lg border border-red-200 bg-red-50 p-3 dark:border-red-500/30 dark:bg-red-500/10'>
            <p className='text-[12px] font-medium text-red-700 dark:text-red-300'>
              Error callout text
            </p>
          </div>
        </div>
      </section>
      <section className='space-y-2'>
        <h4 className='text-[11px] font-semibold uppercase tracking-wide text-muted-foreground'>
          Empty & error surfaces
        </h4>
        <div className='grid gap-3 sm:grid-cols-2'>
          <div className='rounded-lg border border-border'>
            <EmptyState
              icon={Inbox}
              title='Nothing here yet'
              detail='Records you open will appear here.'
            />
          </div>
          <div className='rounded-lg border border-border'>
            <ErrorSurface variant='403' detail='You cannot read this collection.' />
          </div>
        </div>
      </section>
      <section className='space-y-2'>
        <h4 className='text-[11px] font-semibold uppercase tracking-wide text-muted-foreground'>
          Loading
        </h4>
        <div className='flex gap-2'>
          <Skeleton className='h-4 w-32' />
          <Skeleton className='h-4 w-20' />
          <Skeleton className='h-4 w-48' />
        </div>
      </section>
    </div>
  )
}

export function ContrastAuditPage() {
  const lightRef = useRef<HTMLDivElement>(null)
  const darkRef = useRef<HTMLDivElement>(null)
  const [results, setResults] = useState<Result[]>([])
  const [running, setRunning] = useState(false)

  const run = useCallback((wholePage: boolean) => {
    setRunning(true)
    // Let the browser paint before measuring — computed styles are final only
    // after layout, and a just-mounted showcase can still be settling.
    window.setTimeout(() => {
      const at = Date.now()
      const out: Result[] = []
      if (wholePage) {
        out.push({
          theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
          scanned: 'whole page',
          offenders: runContrastAudit(document.body),
          at
        })
      } else {
        if (lightRef.current)
          out.push({
            theme: 'light',
            scanned: 'showcase',
            offenders: runContrastAudit(lightRef.current),
            at
          })
        if (darkRef.current)
          out.push({
            theme: 'dark',
            scanned: 'showcase',
            offenders: runContrastAudit(darkRef.current),
            at
          })
      }
      for (const r of out) for (const o of r.offenders) o.el.style.outline = '2px dashed #f59e0b'
      setResults(out)
      setRunning(false)
    }, 60)
  }, [])

  const total = results.reduce((a, r) => a + r.offenders.length, 0)

  return (
    <div className='flex flex-1 min-h-0 flex-col' data-contrast-audit>
      <header className='flex shrink-0 flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'>
        <Contrast className='h-4 w-4 text-nvr-navy dark:text-nvr-cyan' />
        <div>
          <h1 className='text-[15px] font-semibold text-slate-900 dark:text-foreground'>
            Contrast audit
          </h1>
          <p className='mt-0.5 text-[12px] text-slate-500 dark:text-muted-foreground'>
            The shared and admin components rendered in both themes, measured against WCAG (4.5:1
            body, 3:1 large). Rerun after any shared className change.
          </p>
        </div>
        <div className='ml-auto flex items-center gap-2'>
          <Button size='sm' variant='outline' onClick={() => run(true)} disabled={running}>
            Audit this page
          </Button>
          <Button size='sm' onClick={() => run(false)} disabled={running} data-contrast-run>
            <Play className='mr-1 h-3.5 w-3.5' />
            {running ? 'Measuring…' : 'Run audit'}
          </Button>
        </div>
      </header>

      <div className='flex-1 overflow-y-auto bg-slate-50 px-6 py-5 dark:bg-background'>
        {results.length > 0 && (
          <div
            className={cn(
              'mb-5 rounded-xl border px-4 py-3 text-[12.5px]',
              total === 0
                ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200'
                : 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-500/30 dark:bg-amber-400/10 dark:text-amber-200'
            )}
            data-contrast-result={total}
          >
            <p className='font-semibold'>
              {total === 0
                ? 'Every measured text node passes.'
                : `${total} finding${total === 1 ? '' : 's'} — offenders are outlined in the showcase below.`}
              <span className='ml-2 font-normal opacity-70'>
                {results.map((r) => `${r.theme}: ${r.offenders.length}`).join(' · ')}
              </span>
            </p>
            {results.map((r) =>
              r.offenders.length === 0 ? null : (
                <div key={r.theme} className='mt-2'>
                  <p className='text-[11px] font-semibold uppercase tracking-wide opacity-70'>
                    {r.theme} · {r.scanned}
                  </p>
                  <ul className='mt-1 space-y-1'>
                    {r.offenders.slice(0, 40).map((o, i) => (
                      <li
                        key={`${o.selector}-${i}`}
                        className='flex flex-wrap items-baseline gap-x-2 text-[11.5px]'
                        data-contrast-offender={r.theme}
                      >
                        <span className='font-semibold tabular-nums'>{o.ratio}:1</span>
                        <span className='opacity-70'>needs {o.needed}:1</span>
                        <span className='truncate'>“{o.sample}”</span>
                        <span className='font-mono text-[10.5px] opacity-70'>{o.selector}</span>
                        <span className='font-mono text-[10.5px] opacity-70'>
                          {o.fg} on {o.bg}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )
            )}
          </div>
        )}

        <div className='grid gap-5 lg:grid-cols-2'>
          <div
            ref={lightRef}
            className='rounded-xl border border-slate-200 bg-white p-4 text-slate-900'
            data-contrast-column='light'
          >
            <p className='mb-3 text-[11px] font-semibold uppercase tracking-wide text-slate-400'>
              Light
            </p>
            <Showcase theme='light' />
          </div>
          <div
            ref={darkRef}
            className='dark rounded-xl border border-border bg-background p-4 text-foreground'
            data-contrast-column='dark'
          >
            <p className='mb-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground'>
              Dark
            </p>
            <Showcase theme='dark' />
          </div>
        </div>
      </div>
    </div>
  )
}

export default ContrastAuditPage

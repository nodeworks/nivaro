import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Package, X } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

// ─── Types ────────────────────────────────────────────────────────────────────

interface CollectionPresetKit {
  id: string
  name: string
  description: string
  collections: string[]
  fields_count: number
}

// ─── Skeleton card ────────────────────────────────────────────────────────────

function SkeletonCard() {
  return (
    <div className='rounded-xl border border-border bg-background p-5 space-y-3 animate-pulse'>
      <div className='h-5 w-2/3 rounded bg-muted' />
      <div className='h-4 w-full rounded bg-muted' />
      <div className='h-4 w-4/5 rounded bg-muted' />
      <div className='flex gap-2 pt-1'>
        <div className='h-5 w-16 rounded-full bg-muted' />
        <div className='h-5 w-20 rounded-full bg-muted' />
      </div>
      <div className='h-8 w-full rounded bg-muted mt-2' />
    </div>
  )
}

// ─── Preset card ─────────────────────────────────────────────────────────────

function PresetCard({
  preset,
  onInstall,
  installing
}: {
  preset: CollectionPresetKit
  onInstall: (id: string) => void
  installing: boolean
}) {
  const [confirming, setConfirming] = useState(false)
  const [installed, setInstalled] = useState(false)

  function handleInstall() {
    onInstall(preset.id)
    setConfirming(false)
    setInstalled(true)
  }

  return (
    <div
      className={cn(
        'rounded-xl border bg-background p-5 flex flex-col gap-3 transition-shadow hover:shadow-sm',
        installed ? 'border-green-300 dark:border-green-700' : 'border-border'
      )}
    >
      {/* Title row */}
      <div className='flex items-start gap-2'>
        <div className='flex-1 min-w-0'>
          <h3 className='text-[15px] font-semibold text-foreground'>{preset.name}</h3>
        </div>
        {installed && (
          <div className='shrink-0 flex items-center gap-1 text-[12px] font-medium text-green-600 dark:text-green-400'>
            <Check className='h-4 w-4' />
            Installed
          </div>
        )}
      </div>

      {/* Description */}
      <p className='text-[13px] text-muted-foreground leading-relaxed'>{preset.description}</p>

      {/* Meta badges */}
      <div className='flex items-center gap-2 flex-wrap'>
        <Badge
          variant='outline'
          className='text-[11px] bg-nvr-cyan/10 text-nvr-navy dark:text-nvr-cyan border-nvr-cyan/20'
        >
          {preset.collections.length} collection{preset.collections.length !== 1 ? 's' : ''}
        </Badge>
        <Badge
          variant='outline'
          className='text-[11px] bg-slate-100 text-slate-600 dark:bg-muted dark:text-muted-foreground'
        >
          {preset.fields_count} fields
        </Badge>
      </div>

      {/* Collection pills */}
      <div className='flex flex-wrap gap-1.5'>
        {preset.collections.map((col) => (
          <span
            key={col}
            className='inline-flex items-center rounded-full bg-slate-100 dark:bg-muted px-2.5 py-0.5 text-[11px] font-medium text-slate-600 dark:text-muted-foreground'
          >
            {col}
          </span>
        ))}
      </div>

      {/* Confirm / Install button area */}
      {!installed && (
        <div className='pt-1'>
          {confirming ? (
            <div className='rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-900/10 dark:border-amber-700 p-3 space-y-2.5'>
              <p className='text-[12px] text-amber-800 dark:text-amber-300'>
                This will create collections:{' '}
                <span className='font-medium'>{preset.collections.join(', ')}</span>. Continue?
              </p>
              <div className='flex items-center gap-2'>
                <Button
                  size='sm'
                  className='h-7 text-[12px] gap-1'
                  onClick={handleInstall}
                  disabled={installing}
                >
                  <Check className='h-3.5 w-3.5' />
                  {installing ? 'Installing…' : 'Confirm Install'}
                </Button>
                <Button
                  size='sm'
                  variant='ghost'
                  className='h-7 text-[12px] gap-1'
                  onClick={() => setConfirming(false)}
                  disabled={installing}
                >
                  <X className='h-3.5 w-3.5' />
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button
              variant='outline'
              className='w-full h-8 text-[13px]'
              onClick={() => setConfirming(true)}
              disabled={installing}
            >
              Install Preset
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function CollectionPresetsPage() {
  const qc = useQueryClient()

  const { data: presets = [], isLoading } = useQuery<CollectionPresetKit[]>({
    queryKey: ['collection-presets'],
    queryFn: () =>
      api.get<{ data: CollectionPresetKit[] }>('/collection-presets').then((r) => r.data.data),
    // If the endpoint isn't available yet, fall back to the built-in starters
    retry: false
  })

  // Built-in starters shown when the API returns nothing or isn't available
  const builtinPresets: CollectionPresetKit[] = [
    {
      id: 'blog',
      name: 'Blog',
      description:
        'Everything you need for a content blog: posts, categories, tags, and author profiles.',
      collections: ['posts', 'categories', 'tags', 'authors'],
      fields_count: 24
    },
    {
      id: 'crm',
      name: 'CRM',
      description:
        'A lightweight CRM starter with contacts, companies, deals, and activity tracking.',
      collections: ['contacts', 'companies', 'deals', 'activities'],
      fields_count: 38
    },
    {
      id: 'project_tracker',
      name: 'Project Tracker',
      description: 'Manage projects, milestones, tasks, and team members with status workflows.',
      collections: ['projects', 'milestones', 'tasks', 'team_members'],
      fields_count: 31
    },
    {
      id: 'event_manager',
      name: 'Event Manager',
      description:
        'Full event lifecycle management including venues, sessions, speakers, and registrations.',
      collections: ['events', 'venues', 'sessions', 'speakers', 'registrations'],
      fields_count: 45
    }
  ]

  const displayPresets = presets.length > 0 ? presets : builtinPresets

  const installMut = useMutation({
    mutationFn: (id: string) => api.post(`/collection-presets/${id}/install`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['collections-list'] })
      toast.success('Preset installed successfully')
    },
    onError: () => toast.error('Failed to install preset')
  })

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      {/* Header */}
      <header className='shrink-0 border-b border-border px-6 py-4'>
        <div className='flex items-center gap-2.5 mb-0.5'>
          <Package className='h-5 w-5 text-muted-foreground' />
          <h1 className='text-lg font-semibold'>Collection Presets</h1>
        </div>
        <p className='text-[13px] text-muted-foreground mt-1'>
          One-click starter kits for common use cases
        </p>
      </header>

      {/* Grid */}
      <div className='flex-1 overflow-y-auto p-6'>
        {isLoading ? (
          <div className='grid gap-4 md:grid-cols-2 lg:grid-cols-3'>
            {[1, 2, 3, 4].map((i) => (
              <SkeletonCard key={i} />
            ))}
          </div>
        ) : (
          <div className='grid gap-4 md:grid-cols-2 lg:grid-cols-3'>
            {displayPresets.map((preset) => (
              <PresetCard
                key={preset.id}
                preset={preset}
                onInstall={(id) => installMut.mutate(id)}
                installing={installMut.isPending && installMut.variables === preset.id}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

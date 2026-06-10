import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowDown,
  ArrowLeft,
  ArrowLeftRight,
  ArrowRight,
  Bell,
  Check,
  Clock,
  Code,
  Download,
  GitBranch,
  Globe,
  History,
  Mail,
  PlugZap,
  Plus,
  ScrollText,
  Settings2,
  Trash2,
  X,
  Zap
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { api, exportFlow } from '@/lib/api'
import { cn, formatRelative } from '@/lib/utils'

// ─── Types ────────────────────────────────────────────────────────────────────

type FlowOperation = {
  id: string
  name: string
  key: string
  type: string
  position_x: number
  position_y: number
  options?: Record<string, unknown> | null
  resolve?: string | null
  reject?: string | null
}

type Flow = {
  id: string
  name: string
  description: string | null
  status: 'active' | 'inactive'
  trigger: string
  accountability: string | null
  trigger_options: Record<string, unknown> | null
  operations: FlowOperation[]
  updated_at: string
  next_run?: string | null
}

type TransformMapping = {
  from: string
  to: string
  operation: 'copy' | 'set' | 'template' | 'delete'
  value: string
}

// ─── Canvas constants ─────────────────────────────────────────────────────────

const TRIGGER_X = 60
const TRIGGER_Y = 100
const TRIGGER_W = 240
// Handle positions relative to trigger origin
const _TRIG_OUT_DX = TRIGGER_W
const TRIG_OUT_DY = 72

const OP_W = 220
// Handle positions relative to op node origin
const OP_IN_DX = 0
const OP_IN_DY = 40
const OP_RES_DX = OP_W + 10
const OP_RES_DY = 56
const OP_REJ_DX = OP_W + 10
const OP_REJ_DY = 74

const TRIGGER_H = 156 // approx rendered height
const OP_H = 80 // approx rendered height

const CANVAS_W = 3200
const CANVAS_H = 2000

// ─── Op type config ───────────────────────────────────────────────────────────

const OP_ICONS: Record<string, React.ElementType> = {
  condition: GitBranch,
  'exec-script': Code,
  log: ScrollText,
  mail: Mail,
  notification: Bell,
  webhook: Globe,
  transform: ArrowLeftRight,
  'run-flow': Zap,
  'external-api': PlugZap
}

const OP_TYPE_CONFIG: Record<string, { cls: string; label: string; color: string }> = {
  condition: {
    cls: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/20 dark:text-amber-400 dark:border-amber-800',
    label: 'Condition',
    color: '#d97706'
  },
  'exec-script': {
    cls: 'bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-900/20 dark:text-violet-400 dark:border-violet-800',
    label: 'Script',
    color: '#7c3aed'
  },
  log: {
    cls: 'bg-slate-50 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700',
    label: 'Log',
    color: '#64748b'
  },
  mail: {
    cls: 'bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-900/20 dark:text-sky-400 dark:border-sky-800',
    label: 'Mail',
    color: '#0284c7'
  },
  notification: {
    cls: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/20 dark:text-emerald-400 dark:border-emerald-800',
    label: 'Notify',
    color: '#059669'
  },
  webhook: {
    cls: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-900/20 dark:text-blue-400 dark:border-blue-800',
    label: 'Webhook',
    color: '#2563eb'
  },
  transform: {
    cls: 'bg-pink-50 text-pink-700 border-pink-200 dark:bg-pink-900/20 dark:text-pink-400 dark:border-pink-800',
    label: 'Transform',
    color: '#db2777'
  },
  'run-flow': {
    cls: 'bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-900/20 dark:text-orange-400 dark:border-orange-800',
    label: 'Run Flow',
    color: '#ea580c'
  },
  'external-api': {
    cls: 'bg-teal-50 text-teal-700 border-teal-200 dark:bg-teal-900/20 dark:text-teal-400 dark:border-teal-800',
    label: 'Ext API',
    color: '#0d9488'
  }
}

function OpTypeBadge({ type }: { type: string }) {
  const cfg = OP_TYPE_CONFIG[type] ?? {
    cls: 'bg-slate-50 text-slate-600 border-slate-200',
    label: type
  }
  return (
    <span
      className={cn(
        'inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10px] font-medium',
        cfg.cls
      )}
    >
      {cfg.label}
    </span>
  )
}

// ─── Layout helpers ───────────────────────────────────────────────────────────

function autoLayout(operations: FlowOperation[]): Record<string, { x: number; y: number }> {
  const positions: Record<string, { x: number; y: number }> = {}
  if (!operations.length) return positions

  const opMap = new Map(operations.map((op) => [op.id, op]))
  const referencedIds = new Set(
    operations.flatMap((op) => [op.resolve, op.reject]).filter((id): id is string => id != null)
  )
  const root = operations.find((op) => !referencedIds.has(op.id))

  if (!root) {
    operations.forEach((op, i) => {
      positions[op.id] = { x: 340 + i * 300, y: 100 }
    })
    return positions
  }

  const visited = new Set<string>()
  const queue: Array<{ id: string; x: number; y: number }> = [{ id: root.id, x: 340, y: 100 }]
  while (queue.length) {
    const { id, x, y } = queue.shift()!
    if (visited.has(id)) continue
    visited.add(id)
    const op = opMap.get(id)
    if (!op) continue
    positions[id] = { x, y }
    if (op.resolve) queue.push({ id: op.resolve, x: x + 300, y })
    if (op.reject) queue.push({ id: op.reject, x: x + 300, y: y + 170 })
  }
  let ux = 340
  for (const op of operations) {
    if (!positions[op.id]) {
      positions[op.id] = { x: ux, y: 400 }
      ux += 300
    }
  }
  return positions
}

// Auto-detects curve axis from the dominant distance between endpoints
function bezierPath(x1: number, y1: number, x2: number, y2: number): string {
  const dx = Math.abs(x2 - x1)
  const dy = Math.abs(y2 - y1)
  if (dy > dx) {
    const cy = Math.max(60, dy * 0.5)
    return `M ${x1} ${y1} C ${x1} ${y1 + cy} ${x2} ${y2 - cy} ${x2} ${y2}`
  }
  const cx = Math.max(60, dx * 0.5)
  return `M ${x1} ${y1} C ${x1 + cx} ${y1} ${x2 - cx} ${y2} ${x2} ${y2}`
}

// ─── Shared form: multi-checkbox ──────────────────────────────────────────────

function MultiCheckbox({
  options,
  value,
  onChange
}: {
  options: { value: string; label: string }[]
  value: string[]
  onChange: (v: string[]) => void
}) {
  function toggle(v: string) {
    onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v])
  }
  return (
    <div className='space-y-2'>
      {options.map((opt) => (
        <label key={opt.value} className='flex items-center gap-2 cursor-pointer'>
          <input
            type='checkbox'
            checked={value.includes(opt.value)}
            onChange={() => toggle(opt.value)}
            className='h-3.5 w-3.5 rounded border-slate-300 accent-nvr-cyan'
          />
          <span className='text-[13px] text-slate-700 dark:text-slate-300'>{opt.label}</span>
        </label>
      ))}
    </div>
  )
}

// ─── Event trigger editor ─────────────────────────────────────────────────────

const EVENT_TYPES = [
  { value: 'create', label: 'Create — item created' },
  { value: 'update', label: 'Update — item updated' },
  { value: 'delete', label: 'Delete — item deleted' },
  { value: 'login', label: 'Login — user authenticates' },
  { value: 'logout', label: 'Logout — user signs out' }
]

interface EventTriggerOptions {
  timing: 'before' | 'after'
  types: string[]
  collections: string[]
  return_payload: boolean
}

function EventTriggerEditor({
  options,
  onChange
}: {
  options: Partial<EventTriggerOptions>
  onChange: (o: EventTriggerOptions) => void
}) {
  const timing = options.timing ?? 'after'
  const types = options.types ?? []
  const collections = options.collections ?? []
  const returnPayload = options.return_payload ?? false

  function set(patch: Partial<EventTriggerOptions>) {
    onChange({ timing, types, collections, return_payload: returnPayload, ...patch })
  }

  const { data: colsData } = useQuery({
    queryKey: ['collections-list-for-flow'],
    queryFn: () =>
      api
        .get<{ data: Array<{ collection: string; name?: string }> }>('/collections')
        .then((r) => r.data.data),
    staleTime: 60_000
  })
  const collectionOptions = (colsData ?? []).map((c) => ({
    value: c.collection,
    label: (c as { collection: string; display_name?: string | null }).display_name ?? c.collection
  }))

  return (
    <div className='rounded-xl border border-slate-200 bg-white dark:bg-slate-900 dark:border-slate-700 p-5 space-y-4'>
      <div className='flex items-center gap-2'>
        <Zap className='h-4 w-4 text-violet-500' />
        <h2 className='text-[13px] font-semibold text-slate-900 dark:text-slate-100'>
          Event Trigger
        </h2>
      </div>
      <div className='space-y-1.5'>
        <Label>Timing</Label>
        <Select value={timing} onValueChange={(v) => set({ timing: v as 'before' | 'after' })}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value='before'>Before — synchronous, can modify payload</SelectItem>
            <SelectItem value='after'>After — async, post-save processing</SelectItem>
          </SelectContent>
        </Select>
        {timing === 'before' && (
          <p className='text-[11px] text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 rounded px-2 py-1.5 border border-amber-200 dark:border-amber-800'>
            Before hooks run synchronously. Use exec-script to validate or modify the payload.
          </p>
        )}
      </div>
      <div className='space-y-1.5'>
        <Label>Event Types</Label>
        <div className='rounded-lg border border-slate-200 dark:border-slate-700 p-3'>
          <MultiCheckbox options={EVENT_TYPES} value={types} onChange={(v) => set({ types: v })} />
        </div>
      </div>
      <div className='space-y-1.5'>
        <Label>Collections</Label>
        <p className='text-[11px] text-slate-400'>
          Leave all unchecked to apply to every collection.
        </p>
        {collectionOptions.length === 0 ? (
          <p className='text-[12px] text-slate-400'>No collections found.</p>
        ) : (
          <div className='rounded-lg border border-slate-200 dark:border-slate-700 p-3 max-h-40 overflow-y-auto'>
            <MultiCheckbox
              options={collectionOptions}
              value={collections}
              onChange={(v) => set({ collections: v })}
            />
          </div>
        )}
      </div>
      {timing === 'before' && (
        <div className='flex items-center justify-between rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-2.5'>
          <div>
            <Label className='cursor-pointer'>Return Modified Payload</Label>
            <p className='text-[11px] text-slate-400'>
              Allow exec-script to return an altered payload back.
            </p>
          </div>
          <Switch checked={returnPayload} onCheckedChange={(v) => set({ return_payload: v })} />
        </div>
      )}
    </div>
  )
}

// ─── Webhook trigger editor ───────────────────────────────────────────────────

interface WebhookTriggerOptions {
  method: string
  async: boolean
  auth_type: 'none' | 'bearer' | 'hmac-sha256'
  secret: string
  return_response: boolean
  cors_origins: string
}

function WebhookTriggerEditor({
  flowId,
  options,
  onChange
}: {
  flowId: string
  options: Partial<WebhookTriggerOptions>
  onChange: (o: WebhookTriggerOptions) => void
}) {
  const method = options.method ?? '*'
  const isAsync = options.async ?? false
  const authType = options.auth_type ?? 'none'
  const secret = options.secret ?? ''
  const returnResponse = options.return_response ?? false
  const corsOrigins = options.cors_origins ?? ''

  function set(patch: Partial<WebhookTriggerOptions>) {
    onChange({
      method,
      async: isAsync,
      auth_type: authType,
      secret,
      return_response: returnResponse,
      cors_origins: corsOrigins,
      ...patch
    })
  }

  const webhookUrl = `${window.location.origin}/api/flows/webhook/${flowId}`

  return (
    <div className='rounded-xl border border-slate-200 bg-white dark:bg-slate-900 dark:border-slate-700 p-5 space-y-4'>
      <div className='flex items-center gap-2'>
        <Globe className='h-4 w-4 text-blue-500' />
        <h2 className='text-[13px] font-semibold text-slate-900 dark:text-slate-100'>
          Webhook Trigger
        </h2>
      </div>
      <div className='space-y-1.5'>
        <Label>Inbound URL</Label>
        <div className='flex items-center gap-2'>
          <Input
            readOnly
            value={webhookUrl}
            className='font-mono text-[12px] bg-slate-50 dark:bg-slate-800'
            onClick={(e) => (e.target as HTMLInputElement).select()}
          />
          <Button
            type='button'
            variant='outline'
            size='sm'
            className='shrink-0'
            onClick={() => {
              navigator.clipboard.writeText(webhookUrl)
              toast.success('Copied')
            }}
          >
            Copy
          </Button>
        </div>
      </div>
      <div className='space-y-1.5'>
        <Label>HTTP Method</Label>
        <Select value={method} onValueChange={(v) => set({ method: v })}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value='*'>Any method</SelectItem>
            <SelectItem value='GET'>GET</SelectItem>
            <SelectItem value='POST'>POST</SelectItem>
            <SelectItem value='PUT'>PUT</SelectItem>
            <SelectItem value='PATCH'>PATCH</SelectItem>
            <SelectItem value='DELETE'>DELETE</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className='flex items-center justify-between rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-2.5'>
        <div>
          <Label className='cursor-pointer'>Asynchronous</Label>
          <p className='text-[11px] text-slate-400'>
            Respond 202 immediately; flow runs in background.
          </p>
        </div>
        <Switch checked={isAsync} onCheckedChange={(v) => set({ async: v })} />
      </div>
      {!isAsync && (
        <div className='flex items-center justify-between rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-2.5'>
          <div>
            <Label className='cursor-pointer'>Return Flow Output</Label>
            <p className='text-[11px] text-slate-400'>
              Include final flow data in the response body.
            </p>
          </div>
          <Switch checked={returnResponse} onCheckedChange={(v) => set({ return_response: v })} />
        </div>
      )}
      <div className='space-y-1.5'>
        <Label>Authentication</Label>
        <Select
          value={authType}
          onValueChange={(v) => set({ auth_type: v as WebhookTriggerOptions['auth_type'] })}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value='none'>None</SelectItem>
            <SelectItem value='bearer'>Bearer Token</SelectItem>
            <SelectItem value='hmac-sha256'>HMAC-SHA256 Signature</SelectItem>
          </SelectContent>
        </Select>
        {authType !== 'none' && (
          <Input
            type='password'
            value={secret}
            onChange={(e) => set({ secret: e.target.value })}
            placeholder={authType === 'hmac-sha256' ? 'HMAC signing secret' : 'Bearer token value'}
            className='font-mono text-[13px]'
          />
        )}
      </div>
      <div className='space-y-1.5'>
        <Label>CORS Allowed Origins</Label>
        <Input
          value={corsOrigins}
          onChange={(e) => set({ cors_origins: e.target.value })}
          placeholder='* or https://example.com, https://app.com'
        />
      </div>
    </div>
  )
}

// ─── Manual trigger editor ────────────────────────────────────────────────────

interface ManualInputField {
  field: string
  label: string
  type: 'string' | 'number' | 'boolean'
  required: boolean
  default: string
}
interface ManualTriggerOptions {
  input_schema: ManualInputField[]
  confirm: boolean
}

function ManualTriggerEditor({
  options,
  onChange
}: {
  options: Partial<ManualTriggerOptions>
  onChange: (o: ManualTriggerOptions) => void
}) {
  const schema = options.input_schema ?? []
  const confirm = options.confirm ?? false

  function set(patch: Partial<ManualTriggerOptions>) {
    onChange({ input_schema: schema, confirm, ...patch })
  }
  function updateField(idx: number, patch: Partial<ManualInputField>) {
    set({ input_schema: schema.map((f, i) => (i === idx ? { ...f, ...patch } : f)) })
  }

  return (
    <div className='rounded-xl border border-slate-200 bg-white dark:bg-slate-900 dark:border-slate-700 p-5 space-y-4'>
      <div className='flex items-center gap-2'>
        <Settings2 className='h-4 w-4 text-orange-500' />
        <h2 className='text-[13px] font-semibold text-slate-900 dark:text-slate-100'>
          Manual Trigger
        </h2>
      </div>
      <div className='flex items-center justify-between rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-2.5'>
        <div>
          <Label className='cursor-pointer'>Require Confirmation</Label>
          <p className='text-[11px] text-slate-400'>
            Show a confirm dialog before running from the UI.
          </p>
        </div>
        <Switch checked={confirm} onCheckedChange={(v) => set({ confirm: v })} />
      </div>
      <div className='space-y-2'>
        <div className='flex items-center justify-between'>
          <Label>Input Fields</Label>
          <Button
            type='button'
            variant='outline'
            size='sm'
            onClick={() =>
              set({
                input_schema: [
                  ...schema,
                  { field: '', label: '', type: 'string', required: false, default: '' }
                ]
              })
            }
            className='gap-1.5'
          >
            <Plus className='h-3.5 w-3.5' /> Add Field
          </Button>
        </div>
        {schema.length === 0 ? (
          <p className='text-[13px] text-slate-400 py-2'>
            No input fields — flow triggers with empty payload.
          </p>
        ) : (
          schema.map((field, idx) => (
            <div
              key={idx}
              className='rounded-lg border border-slate-200 dark:border-slate-700 p-3 space-y-2'
            >
              <div className='grid grid-cols-3 gap-2'>
                <div className='space-y-1'>
                  <span className='text-[10px] font-medium text-slate-500'>Field key</span>
                  <Input
                    value={field.field}
                    onChange={(e) => updateField(idx, { field: e.target.value })}
                    placeholder='my_field'
                    className='h-7 font-mono text-[12px]'
                  />
                </div>
                <div className='space-y-1'>
                  <span className='text-[10px] font-medium text-slate-500'>Label</span>
                  <Input
                    value={field.label}
                    onChange={(e) => updateField(idx, { label: e.target.value })}
                    placeholder='My Field'
                    className='h-7 text-[12px]'
                  />
                </div>
                <div className='space-y-1'>
                  <span className='text-[10px] font-medium text-slate-500'>Type</span>
                  <Select
                    value={field.type}
                    onValueChange={(v) => updateField(idx, { type: v as ManualInputField['type'] })}
                  >
                    <SelectTrigger className='h-7 text-[12px]'>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value='string'>String</SelectItem>
                      <SelectItem value='number'>Number</SelectItem>
                      <SelectItem value='boolean'>Boolean</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className='flex items-center gap-3'>
                <label className='flex items-center gap-1.5 cursor-pointer shrink-0'>
                  <input
                    type='checkbox'
                    checked={field.required}
                    onChange={(e) => updateField(idx, { required: e.target.checked })}
                    className='h-3.5 w-3.5 accent-nvr-cyan'
                  />
                  <span className='text-[12px] text-slate-600 dark:text-slate-400'>Required</span>
                </label>
                <Input
                  value={field.default}
                  onChange={(e) => updateField(idx, { default: e.target.value })}
                  placeholder='Default value'
                  className='h-7 text-[12px] flex-1'
                />
                <button
                  type='button'
                  onClick={() => set({ input_schema: schema.filter((_, i) => i !== idx) })}
                  className='text-slate-400 hover:text-red-500 shrink-0'
                >
                  <Trash2 className='h-3.5 w-3.5' />
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

// ─── Cron editor ──────────────────────────────────────────────────────────────

const CRON_PRESETS = [
  { label: 'Every minute', expression: '* * * * *' },
  { label: 'Every 5 min', expression: '*/5 * * * *' },
  { label: 'Hourly', expression: '0 * * * *' },
  { label: 'Daily midnight', expression: '0 0 * * *' },
  { label: 'Daily 9am (UTC)', expression: '0 9 * * *' },
  { label: 'Weekdays 9am', expression: '0 9 * * 1-5' },
  { label: 'Weekly Monday', expression: '0 0 * * 1' }
]

function CronEditor({
  value,
  nextRun,
  onChange
}: {
  value: string
  nextRun?: string | null
  onChange: (expression: string) => void
}) {
  const parts = value.split(' ')
  const isValid = parts.length === 5 && parts.every((p) => p.length > 0)
  return (
    <div className='rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-5 space-y-4'>
      <div className='flex items-center gap-2'>
        <Clock className='h-4 w-4 text-slate-400' />
        <h2 className='text-[13px] font-semibold text-slate-900 dark:text-slate-100'>Schedule</h2>
      </div>
      <div>
        <p className='mb-2 text-[11px] font-medium text-slate-400'>Presets</p>
        <div className='flex flex-wrap gap-1.5'>
          {CRON_PRESETS.map((p) => (
            <button
              key={p.expression}
              type='button'
              onClick={() => onChange(p.expression)}
              className={cn(
                'rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors',
                value === p.expression
                  ? 'border-nvr-cyan/40 bg-nvr-cyan/10 text-nvr-cyan'
                  : 'border-slate-200 text-slate-600 hover:border-slate-300 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800'
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
      <div className='space-y-1.5'>
        <Label htmlFor='cron-expression'>Cron Expression</Label>
        <div className='flex items-center gap-2'>
          <Input
            id='cron-expression'
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder='* * * * *'
            className={cn(
              'max-w-xs font-mono text-[13px]',
              value && !isValid ? 'border-red-300' : ''
            )}
            spellCheck={false}
          />
          {value && (
            <span className={cn('text-[11px]', isValid ? 'text-slate-400' : 'text-red-500')}>
              {isValid ? '✓ valid' : '✗ need 5 fields'}
            </span>
          )}
        </div>
        <p className='text-[11px] text-slate-400'>
          Format: <span className='font-mono'>minute hour day month weekday</span>
          {' · '}
          <a
            href='https://crontab.guru'
            target='_blank'
            rel='noreferrer'
            className='text-nvr-cyan hover:underline'
          >
            crontab.guru
          </a>
        </p>
      </div>
      {nextRun && (
        <div className='flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 dark:bg-emerald-900/20 dark:border-emerald-800 px-3 py-2'>
          <Clock className='h-3.5 w-3.5 shrink-0 text-emerald-600' />
          <span className='text-[11px] text-emerald-700 dark:text-emerald-400'>
            Next run: <span className='font-medium'>{new Date(nextRun).toLocaleString()}</span>
          </span>
        </div>
      )}
    </div>
  )
}

// ─── Edit Operation Dialog ────────────────────────────────────────────────────

const CONDITION_OPERATORS = [
  { value: 'eq', label: 'equals (==)' },
  { value: 'neq', label: 'not equals (!=)' },
  { value: 'gt', label: '> greater than' },
  { value: 'gte', label: '>= greater or equal' },
  { value: 'lt', label: '< less than' },
  { value: 'lte', label: '<= less or equal' },
  { value: 'contains', label: 'contains' },
  { value: 'startsWith', label: 'starts with' },
  { value: 'endsWith', label: 'ends with' },
  { value: 'in', label: 'in list (comma-separated)' },
  { value: 'notIn', label: 'not in list' },
  { value: 'exists', label: 'exists (not null)' },
  { value: 'notExists', label: 'not exists (null)' }
]

function EditOperationDialog({
  flowId,
  op,
  open,
  onOpenChange
}: {
  flowId: string
  op: FlowOperation
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const queryClient = useQueryClient()
  const [opName, setOpName] = useState(op.name)
  const [optsState, setOptsState] = useState<Record<string, unknown>>(
    (op.options ?? {}) as Record<string, unknown>
  )

  function setOpt(key: string, value: unknown) {
    setOptsState((prev) => ({ ...prev, [key]: value }))
  }

  const mappings = (optsState.mappings as TransformMapping[]) ?? []
  const operator = (optsState.operator as string) ?? 'eq'
  const noValueOps = new Set(['exists', 'notExists'])

  const { data: flowsData } = useQuery({
    queryKey: ['flows-list-for-op'],
    queryFn: () =>
      api.get<{ data: Array<{ id: string; name: string }> }>('/flows').then((r) => r.data.data),
    enabled: op.type === 'run-flow',
    staleTime: 30_000
  })

  const { data: extApisData } = useQuery({
    queryKey: ['ext-apis-for-op'],
    queryFn: () =>
      api
        .get<{ data: Array<{ id: number; name: string }> }>('/external-apis')
        .then((r) => r.data.data),
    enabled: op.type === 'external-api',
    staleTime: 30_000
  })

  const { data: registeredOpsData } = useQuery({
    queryKey: ['flow-registered-ops'],
    queryFn: () =>
      api
        .get<{
          data: Array<{
            type: string
            label: string
            description?: string
            color?: string
            fields?: Array<{
              key: string
              label: string
              type: string
              options?: Array<{ value: string; label: string }>
              placeholder?: string
              required?: boolean
              description?: string
              defaultValue?: unknown
            }>
          }>
        }>('/flows/registered-operations')
        .then((r) => r.data.data),
    staleTime: 60_000
  })

  const registeredOpMeta = registeredOpsData?.find((o) => o.type === op.type)

  const [extApiEndpoints, setExtApiEndpoints] = useState<
    Array<{ id: number; name: string; method: string; path: string }>
  >([])
  const selectedExtApiId = optsState.api_id as number | undefined

  useEffect(() => {
    if (op.type !== 'external-api' || !selectedExtApiId) {
      setExtApiEndpoints([])
      return
    }
    api
      .get<{ data: Array<{ id: number; name: string; method: string; path: string }> }>(
        `/external-apis/${selectedExtApiId}/endpoints`
      )
      .then((r) => setExtApiEndpoints(r.data.data))
      .catch(() => setExtApiEndpoints([]))
  }, [selectedExtApiId, op.type])

  const updateOp = useMutation({
    mutationFn: (body: { options: Record<string, unknown>; name?: string }) =>
      api.patch(`/flows/${flowId}/operations/${op.id}`, body).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['flows', flowId] })
      onOpenChange(false)
      toast.success('Operation updated')
    },
    onError: () => toast.error('Failed to update operation')
  })

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    updateOp.mutate({ options: optsState, name: opName || op.name })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-w-2xl max-h-[90vh] overflow-y-auto'>
        <DialogHeader>
          <DialogTitle className='flex items-center gap-2'>
            Edit Operation
            <span className='font-mono text-[13px] text-slate-500'>{op.key}</span>
            <OpTypeBadge type={op.type} />
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <div className='space-y-4 px-6 pb-6'>
            <div className='space-y-1.5'>
              <Label>Name</Label>
              <Input
                value={opName}
                onChange={(e) => setOpName(e.target.value)}
                placeholder='Operation name'
              />
            </div>
            <div className='flex items-center justify-between rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-2.5'>
              <div>
                <Label className='cursor-pointer'>Asynchronous</Label>
                <p className='text-[11px] text-slate-400'>
                  Fire and forget — chain continues down resolve path immediately without waiting
                  for this op to finish.
                </p>
              </div>
              <Switch
                checked={(optsState.async as boolean) ?? false}
                onCheckedChange={(v) => setOpt('async', v)}
              />
            </div>
            {op.type === 'log' && (
              <>
                <div className='space-y-1.5'>
                  <Label>Message</Label>
                  <Input
                    value={(optsState.message as string) ?? ''}
                    onChange={(e) => setOpt('message', e.target.value)}
                    placeholder='{{$trigger}} fired — {{collection}}'
                  />
                  <p className='text-[11px] text-slate-400'>Supports {'{{variable}}'} templates.</p>
                </div>
                <div className='space-y-1.5'>
                  <Label>Log Level</Label>
                  <Select
                    value={(optsState.level as string) ?? 'info'}
                    onValueChange={(v) => setOpt('level', v)}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value='debug'>debug</SelectItem>
                      <SelectItem value='info'>info</SelectItem>
                      <SelectItem value='warn'>warn</SelectItem>
                      <SelectItem value='error'>error</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </>
            )}
            {op.type === 'condition' && (
              <>
                <div className='rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-400'>
                  <strong>true</strong> → resolve path. <strong>false</strong> → reject path.
                </div>
                <div className='space-y-1.5'>
                  <Label>Field Path</Label>
                  <Input
                    value={(optsState.field as string) ?? ''}
                    onChange={(e) => setOpt('field', e.target.value)}
                    placeholder='payload.status or $data.amount'
                    className='font-mono text-[13px]'
                  />
                </div>
                <div className='space-y-1.5'>
                  <Label>Operator</Label>
                  <Select value={operator} onValueChange={(v) => setOpt('operator', v)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CONDITION_OPERATORS.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {!noValueOps.has(operator) && (
                  <div className='space-y-1.5'>
                    <Label>Compare Value</Label>
                    <Input
                      value={(optsState.value as string) ?? ''}
                      onChange={(e) => setOpt('value', e.target.value)}
                      placeholder='e.g. active'
                    />
                  </div>
                )}
              </>
            )}
            {op.type === 'exec-script' && (
              <>
                <div className='rounded-lg border border-violet-200 dark:border-violet-800 bg-violet-50 dark:bg-violet-900/20 px-3 py-2 text-[11px] text-violet-700 dark:text-violet-400'>
                  <Code className='inline h-3 w-3 mr-1' />
                  Available: <code className='font-mono'>data</code> (flow data),{' '}
                  <code className='font-mono'>log</code> (logger). Return{' '}
                  <code className='font-mono'>data</code> to pass downstream.
                </div>
                <div className='space-y-1.5'>
                  <Label>JavaScript Code</Label>
                  <Textarea
                    value={(optsState.code as string) ?? ''}
                    onChange={(e) => setOpt('code', e.target.value)}
                    className='font-mono text-[12px] resize-y'
                    rows={12}
                    spellCheck={false}
                    placeholder={`// Modify data and return it\ndata.computed = data.payload?.amount * 1.1;\nreturn data;`}
                  />
                </div>
                <div className='space-y-1.5'>
                  <Label>Timeout (ms)</Label>
                  <Input
                    type='number'
                    value={(optsState.timeout_ms as number) ?? 5000}
                    onChange={(e) => setOpt('timeout_ms', Number(e.target.value))}
                    min={100}
                    max={30000}
                    className='w-32'
                  />
                </div>
              </>
            )}
            {op.type === 'webhook' && (
              <>
                <div className='space-y-1.5'>
                  <Label>
                    URL <span className='text-red-500'>*</span>
                  </Label>
                  <Input
                    value={(optsState.url as string) ?? ''}
                    onChange={(e) => setOpt('url', e.target.value)}
                    placeholder='https://example.com/webhook'
                  />
                  <p className='text-[11px] text-slate-400'>Supports {'{{variable}}'} templates.</p>
                </div>
                <div className='space-y-1.5'>
                  <Label>Method</Label>
                  <Select
                    value={(optsState.method as string) ?? 'POST'}
                    onValueChange={(v) => setOpt('method', v)}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => (
                        <SelectItem key={m} value={m}>
                          {m}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className='flex items-center justify-between rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-2.5'>
                  <div>
                    <Label className='cursor-pointer'>Asynchronous</Label>
                    <p className='text-[11px] text-slate-400'>
                      Fire and forget; don't wait for response.
                    </p>
                  </div>
                  <Switch
                    checked={(optsState.async as boolean) ?? false}
                    onCheckedChange={(v) => setOpt('async', v)}
                  />
                </div>
                <div className='space-y-1.5'>
                  <Label>Additional Headers (JSON)</Label>
                  <Textarea
                    defaultValue={
                      typeof optsState.headers === 'object'
                        ? JSON.stringify(optsState.headers, null, 2)
                        : ((optsState.headers as string) ?? '{}')
                    }
                    onChange={(e) => {
                      try {
                        setOpt('headers', JSON.parse(e.target.value))
                      } catch {
                        /* allow typing */
                      }
                    }}
                    className='font-mono text-[12px] resize-y'
                    rows={3}
                    spellCheck={false}
                  />
                </div>
              </>
            )}
            {op.type === 'mail' && (
              <>
                <div className='rounded-lg border border-sky-200 dark:border-sky-800 bg-sky-50 dark:bg-sky-900/20 px-3 py-2 text-[11px] text-sky-700 dark:text-sky-400'>
                  <Mail className='inline h-3 w-3 mr-1' />
                  Supports <code className='font-mono'>{'{{variable}}'}</code> templates. Requires
                  SMTP in Settings.
                </div>
                <div className='space-y-1.5'>
                  <Label>
                    To <span className='text-red-500'>*</span>
                  </Label>
                  <Input
                    value={(optsState.to as string) ?? ''}
                    onChange={(e) => setOpt('to', e.target.value)}
                    placeholder='user@example.com or {{$data.email}}'
                  />
                </div>
                <div className='space-y-1.5'>
                  <Label>From (override)</Label>
                  <Input
                    value={(optsState.from as string) ?? ''}
                    onChange={(e) => setOpt('from', e.target.value)}
                    placeholder='Leave blank to use MAIL_FROM setting'
                  />
                </div>
                <div className='space-y-1.5'>
                  <Label>Subject</Label>
                  <Input
                    value={(optsState.subject as string) ?? ''}
                    onChange={(e) => setOpt('subject', e.target.value)}
                    placeholder='New item {{$trigger}}d in {{$collection}}'
                  />
                </div>
                <div className='space-y-1.5'>
                  <Label>Body (HTML)</Label>
                  <Textarea
                    value={(optsState.body as string) ?? ''}
                    onChange={(e) => setOpt('body', e.target.value)}
                    className='font-mono text-[12px] resize-y'
                    rows={8}
                    spellCheck={false}
                    placeholder='<p>Hello {{name}}</p>'
                  />
                </div>
              </>
            )}
            {op.type === 'notification' && (
              <>
                <div className='rounded-lg border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-900/20 px-3 py-2 text-[11px] text-emerald-700 dark:text-emerald-400'>
                  <Bell className='inline h-3 w-3 mr-1' />
                  Sends an in-app notification. Supports{' '}
                  <code className='font-mono'>{'{{variable}}'}</code> templates.
                </div>
                <div className='space-y-1.5'>
                  <Label>
                    Recipient (User ID) <span className='text-red-500'>*</span>
                  </Label>
                  <Input
                    value={(optsState.recipient as string) ?? ''}
                    onChange={(e) => setOpt('recipient', e.target.value)}
                    placeholder='User UUID or {{$data.user_id}}'
                    className='font-mono text-[13px]'
                  />
                </div>
                <div className='space-y-1.5'>
                  <Label>Subject</Label>
                  <Input
                    value={(optsState.subject as string) ?? ''}
                    onChange={(e) => setOpt('subject', e.target.value)}
                    placeholder='Item {{$trigger}}d'
                  />
                </div>
                <div className='space-y-1.5'>
                  <Label>Message</Label>
                  <Textarea
                    value={(optsState.message as string) ?? ''}
                    onChange={(e) => setOpt('message', e.target.value)}
                    rows={3}
                    placeholder='Item {{id}} was updated by {{user}}.'
                  />
                </div>
              </>
            )}
            {op.type === 'transform' && (
              <>
                <p className='text-[11px] text-slate-400'>
                  Map, set, template-render, or delete fields. Applied in order.
                </p>
                <div className='space-y-2'>
                  {mappings.map((m, idx) => (
                    <div
                      key={idx}
                      className='rounded-lg border border-slate-200 dark:border-slate-700 p-2.5 space-y-2'
                    >
                      <div className='grid grid-cols-[1fr_130px] gap-2'>
                        <div className='space-y-1'>
                          <span className='text-[10px] text-slate-400'>
                            {m.operation === 'delete' ? 'Path to delete' : 'Source / from'}
                          </span>
                          <Input
                            value={m.from}
                            onChange={(e) => {
                              const n = [...mappings]
                              n[idx] = { ...m, from: e.target.value }
                              setOpt('mappings', n)
                            }}
                            placeholder='payload.status'
                            className='font-mono text-[12px] h-7'
                          />
                        </div>
                        <div className='space-y-1'>
                          <span className='text-[10px] text-slate-400'>Operation</span>
                          <Select
                            value={m.operation}
                            onValueChange={(v) => {
                              const n = [...mappings]
                              n[idx] = { ...m, operation: v as TransformMapping['operation'] }
                              setOpt('mappings', n)
                            }}
                          >
                            <SelectTrigger className='h-7 text-[12px]'>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value='copy'>→ copy to</SelectItem>
                              <SelectItem value='set'>→ set value</SelectItem>
                              <SelectItem value='template'>→ template</SelectItem>
                              <SelectItem value='delete'>delete</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                      {m.operation !== 'delete' && (
                        <div className='space-y-1'>
                          <span className='text-[10px] text-slate-400'>
                            {m.operation === 'copy'
                              ? 'Target path'
                              : m.operation === 'template'
                                ? 'Template ({{var}} syntax)'
                                : 'Value to set'}
                          </span>
                          <div className='flex items-center gap-2'>
                            <Input
                              value={m.operation === 'copy' ? m.to : m.value}
                              onChange={(e) => {
                                const n = [...mappings]
                                n[idx] =
                                  m.operation === 'copy'
                                    ? { ...m, to: e.target.value }
                                    : { ...m, value: e.target.value, to: m.from }
                                setOpt('mappings', n)
                              }}
                              className='font-mono text-[12px] h-7 flex-1'
                            />
                            <button
                              type='button'
                              onClick={() =>
                                setOpt(
                                  'mappings',
                                  mappings.filter((_, i) => i !== idx)
                                )
                              }
                              className='text-slate-400 hover:text-red-500 shrink-0'
                            >
                              <Trash2 className='h-3.5 w-3.5' />
                            </button>
                          </div>
                        </div>
                      )}
                      {m.operation === 'delete' && (
                        <div className='flex justify-end'>
                          <button
                            type='button'
                            onClick={() =>
                              setOpt(
                                'mappings',
                                mappings.filter((_, i) => i !== idx)
                              )
                            }
                            className='text-slate-400 hover:text-red-500'
                          >
                            <Trash2 className='h-3.5 w-3.5' />
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                  <button
                    type='button'
                    onClick={() =>
                      setOpt('mappings', [
                        ...mappings,
                        { from: '', to: '', operation: 'copy', value: '' }
                      ])
                    }
                    className='flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-slate-300 dark:border-slate-600 py-2 text-[12px] font-medium text-slate-500 transition-colors hover:border-nvr-cyan/50 hover:text-nvr-cyan'
                  >
                    <Plus className='h-3.5 w-3.5' /> Add Mapping
                  </button>
                </div>
              </>
            )}
            {op.type === 'run-flow' && (
              <>
                <div className='space-y-1.5'>
                  <Label>
                    Flow to Run <span className='text-red-500'>*</span>
                  </Label>
                  <Select
                    value={(optsState.flow_id as string) ?? ''}
                    onValueChange={(v) => setOpt('flow_id', v)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder='Select a flow…' />
                    </SelectTrigger>
                    <SelectContent>
                      {(flowsData ?? [])
                        .filter((f) => f.id !== flowId)
                        .map((f) => (
                          <SelectItem key={f.id} value={f.id}>
                            {f.name}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className='flex items-center justify-between rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-2.5'>
                  <div>
                    <Label className='cursor-pointer'>Wait for Completion</Label>
                    <p className='text-[11px] text-slate-400'>Block until the sub-flow finishes.</p>
                  </div>
                  <Switch
                    checked={(optsState.wait as boolean) ?? true}
                    onCheckedChange={(v) => setOpt('wait', v)}
                  />
                </div>
                <div className='space-y-1.5'>
                  <div className='flex items-center justify-between'>
                    <Label>Payload Override (JSON)</Label>
                    <Badge variant='outline' className='font-mono text-[10px]'>
                      JSON
                    </Badge>
                  </div>
                  <Textarea
                    value={(optsState.payload as string) ?? ''}
                    onChange={(e) => setOpt('payload', e.target.value)}
                    className='font-mono text-[12px] resize-y'
                    rows={4}
                    spellCheck={false}
                    placeholder={'{\n  "source": "{{$trigger}}"\n}'}
                  />
                </div>
              </>
            )}
            {registeredOpMeta && (
              <div className='rounded-lg border border-slate-200 dark:border-border bg-slate-50 dark:bg-muted/30 px-3 py-2 text-[11px] text-slate-500 dark:text-slate-400'>
                Extension operation:{' '}
                <span className='font-semibold text-slate-700 dark:text-foreground'>
                  {registeredOpMeta.label}
                </span>
                {registeredOpMeta.description && (
                  <span className='ml-1'>— {registeredOpMeta.description}</span>
                )}
              </div>
            )}
            {registeredOpMeta?.fields &&
              registeredOpMeta.fields.length > 0 &&
              registeredOpMeta.fields.map((field) =>
                field.type === 'boolean' ? (
                  <div
                    key={field.key}
                    className='flex items-center justify-between rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-2.5'
                  >
                    <div>
                      <Label className='cursor-pointer'>{field.label}</Label>
                      {field.description && (
                        <p className='text-[11px] text-slate-400'>{field.description}</p>
                      )}
                    </div>
                    <Switch
                      checked={
                        (optsState[field.key] as boolean) ??
                        (field.defaultValue as boolean) ??
                        false
                      }
                      onCheckedChange={(v) => setOpt(field.key, v)}
                    />
                  </div>
                ) : (
                  <div key={field.key} className='space-y-1.5'>
                    <Label>
                      {field.label}
                      {field.required && <span className='text-red-500 ml-0.5'>*</span>}
                    </Label>
                    {field.type === 'select' ? (
                      <Select
                        value={String(optsState[field.key] ?? field.defaultValue ?? '')}
                        onValueChange={(v) => setOpt(field.key, v)}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder={field.placeholder} />
                        </SelectTrigger>
                        <SelectContent>
                          {(field.options ?? []).map((o) => (
                            <SelectItem key={o.value} value={o.value}>
                              {o.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : field.type === 'textarea' || field.type === 'json' ? (
                      <Textarea
                        value={String(optsState[field.key] ?? field.defaultValue ?? '')}
                        onChange={(e) => setOpt(field.key, e.target.value)}
                        placeholder={field.placeholder}
                        className={cn('resize-y', field.type === 'json' && 'font-mono text-[12px]')}
                        rows={4}
                        spellCheck={false}
                      />
                    ) : field.type === 'number' ? (
                      <Input
                        type='number'
                        value={String(optsState[field.key] ?? field.defaultValue ?? '')}
                        onChange={(e) => setOpt(field.key, Number(e.target.value))}
                        placeholder={field.placeholder}
                      />
                    ) : (
                      <Input
                        value={String(optsState[field.key] ?? field.defaultValue ?? '')}
                        onChange={(e) => setOpt(field.key, e.target.value)}
                        placeholder={field.placeholder}
                      />
                    )}
                    {field.description && (
                      <p className='text-[11px] text-slate-400'>{field.description}</p>
                    )}
                  </div>
                )
              )}
            {op.type === 'external-api' && (
              <>
                {/* Mode toggle */}
                <div className='flex gap-1 rounded-lg border border-slate-200 dark:border-slate-700 p-1'>
                  {(['predefined', 'custom'] as const).map((m) => (
                    <button
                      key={m}
                      type='button'
                      onClick={() => setOpt('mode', m)}
                      className={cn(
                        'flex-1 rounded py-1 text-[11px] font-medium transition-colors',
                        (optsState.mode ?? 'predefined') === m
                          ? 'bg-teal-600 text-white'
                          : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'
                      )}
                    >
                      {m === 'predefined' ? 'Predefined Config' : 'Custom URL'}
                    </button>
                  ))}
                </div>

                {(optsState.mode ?? 'predefined') === 'predefined' ? (
                  <>
                    <div className='space-y-1.5'>
                      <Label>
                        API Config <span className='text-red-500'>*</span>
                      </Label>
                      <Select
                        value={String(optsState.api_id ?? '')}
                        onValueChange={(v) => {
                          setOpt('api_id', Number(v))
                          setOpt('endpoint', undefined)
                          setExtApiEndpoints([])
                        }}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder='Select an API…' />
                        </SelectTrigger>
                        <SelectContent>
                          {(extApisData ?? []).map((a) => (
                            <SelectItem key={a.id} value={String(a.id)}>
                              {a.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    {extApiEndpoints.length > 0 && (
                      <div className='space-y-1.5'>
                        <Label>Endpoint</Label>
                        <Select
                          value={String(optsState.endpoint ?? '')}
                          onValueChange={(v) =>
                            setOpt('endpoint', v === '__none__' ? undefined : Number(v))
                          }
                        >
                          <SelectTrigger>
                            <SelectValue placeholder='Use base URL (no endpoint)' />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value='__none__'>— none (base URL) —</SelectItem>
                            {extApiEndpoints.map((ep) => (
                              <SelectItem key={ep.id} value={String(ep.id)}>
                                <span className='font-mono text-[11px] text-slate-400 mr-1.5'>
                                  {ep.method}
                                </span>
                                {ep.name}
                                <span className='ml-1.5 font-mono text-[10px] text-slate-400'>
                                  {ep.path}
                                </span>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                    <div className='space-y-1.5'>
                      <Label>Method Override</Label>
                      <Select
                        value={(optsState.method_override as string) ?? '__inherit__'}
                        onValueChange={(v) =>
                          setOpt('method_override', v === '__inherit__' ? undefined : v)
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value='__inherit__'>— inherit from config —</SelectItem>
                          {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => (
                            <SelectItem key={m} value={m}>
                              {m}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className='space-y-1.5'>
                      <Label>Path Override</Label>
                      <Input
                        value={(optsState.path_override as string) ?? ''}
                        onChange={(e) => setOpt('path_override', e.target.value || undefined)}
                        placeholder='/items/{{id}}'
                        className='font-mono text-[13px]'
                      />
                      <p className='text-[11px] text-slate-400'>
                        Overrides the endpoint path. Supports {'{{variable}}'} templates.
                      </p>
                    </div>
                  </>
                ) : (
                  <>
                    <div className='space-y-1.5'>
                      <Label>
                        URL <span className='text-red-500'>*</span>
                      </Label>
                      <Input
                        value={(optsState.url as string) ?? ''}
                        onChange={(e) => setOpt('url', e.target.value)}
                        placeholder='https://api.example.com/items/{{id}}'
                      />
                      <p className='text-[11px] text-slate-400'>
                        Supports {'{{variable}}'} templates.
                      </p>
                    </div>
                    <div className='space-y-1.5'>
                      <Label>Method</Label>
                      <Select
                        value={(optsState.method as string) ?? 'GET'}
                        onValueChange={(v) => setOpt('method', v)}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => (
                            <SelectItem key={m} value={m}>
                              {m}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className='space-y-1.5'>
                      <Label>Headers (JSON)</Label>
                      <Textarea
                        defaultValue={
                          typeof optsState.headers === 'object'
                            ? JSON.stringify(optsState.headers, null, 2)
                            : ((optsState.headers as string) ?? '{}')
                        }
                        onChange={(e) => {
                          try {
                            setOpt('headers', JSON.parse(e.target.value))
                          } catch {
                            /* allow typing */
                          }
                        }}
                        className='font-mono text-[12px] resize-y'
                        rows={3}
                        spellCheck={false}
                      />
                    </div>
                    <div className='space-y-1.5'>
                      <Label>Timeout (ms)</Label>
                      <Input
                        type='number'
                        value={(optsState.timeout_ms as number) ?? 10000}
                        onChange={(e) => setOpt('timeout_ms', Number(e.target.value))}
                        min={500}
                        max={60000}
                        className='w-32'
                      />
                    </div>
                  </>
                )}

                {/* Common fields */}
                <div className='space-y-1.5'>
                  <Label>Request Body (JSON)</Label>
                  <Textarea
                    value={(optsState.body as string) ?? ''}
                    onChange={(e) => setOpt('body', e.target.value)}
                    className='font-mono text-[12px] resize-y'
                    rows={5}
                    spellCheck={false}
                    placeholder={'{\n  "id": "{{item_id}}"\n}'}
                  />
                  <p className='text-[11px] text-slate-400'>
                    Supports {'{{variable}}'} templates. Leave blank to send no body.
                  </p>
                </div>
                <div className='space-y-1.5'>
                  <Label>Result Key</Label>
                  <Input
                    value={(optsState.result_key as string) ?? '$ext_response'}
                    onChange={(e) => setOpt('result_key', e.target.value || '$ext_response')}
                    className='font-mono text-[13px]'
                    placeholder='$ext_response'
                  />
                  <p className='text-[11px] text-slate-400'>
                    Flow data key where <code className='font-mono'>{'{ status, body }'}</code> is
                    stored.
                  </p>
                </div>
                <div className='flex items-center justify-between rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-2.5'>
                  <div>
                    <Label className='cursor-pointer'>Fail on non-2xx</Label>
                    <p className='text-[11px] text-slate-400'>
                      Take reject path when response status ≥ 400.
                    </p>
                  </div>
                  <Switch
                    checked={(optsState.fail_on_error as boolean) ?? true}
                    onCheckedChange={(v) => setOpt('fail_on_error', v)}
                  />
                </div>
              </>
            )}
          </div>
          <DialogFooter>
            <Button type='button' variant='outline' onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type='submit' disabled={updateOp.isPending}>
              {updateOp.isPending ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ─── Add Operation Dialog (with optional link) ────────────────────────────────

function AddOperationDialog({
  flowId,
  open,
  onOpenChange,
  sourceOpId,
  linkType,
  defaultPosition
}: {
  flowId: string
  open: boolean
  onOpenChange: (v: boolean) => void
  sourceOpId?: string | null
  linkType?: 'resolve' | 'reject' | null
  defaultPosition?: { x: number; y: number }
}) {
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [key, setKey] = useState('')
  const [type, setType] = useState('log')

  const { data: registeredOpsForAdd } = useQuery({
    queryKey: ['flow-registered-ops'],
    queryFn: () =>
      api
        .get<{ data: Array<{ type: string; label: string; description?: string }> }>(
          '/flows/registered-operations'
        )
        .then((r) => r.data.data),
    staleTime: 60_000
  })

  const addOp = useMutation({
    mutationFn: async (body: { name: string; key: string; type: string }) => {
      const pos = defaultPosition ?? { x: 340, y: 100 }
      const res = await api
        .post(`/flows/${flowId}/operations`, { ...body, position_x: pos.x, position_y: pos.y })
        .then((r) => r.data)
      if (sourceOpId && linkType) {
        await api.patch(`/flows/${flowId}/operations/${sourceOpId}`, { [linkType]: res.data.id })
      }
      return res
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['flows', flowId] })
      onOpenChange(false)
      setName('')
      setKey('')
      setType('log')
      toast.success('Operation added')
    },
    onError: () => toast.error('Failed to add operation')
  })

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    addOp.mutate({ name, key, type })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {sourceOpId && linkType
              ? `Add ${linkType === 'resolve' ? 'Resolve' : 'Reject'} Operation`
              : 'Add Operation'}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <div className='space-y-4 px-6 pb-6'>
            <div className='space-y-1.5'>
              <Label htmlFor='op-name'>
                Name <span className='text-red-500'>*</span>
              </Label>
              <Input
                id='op-name'
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder='e.g. Send notification'
                required
              />
            </div>
            <div className='space-y-1.5'>
              <Label htmlFor='op-key'>
                Key <span className='text-red-500'>*</span>
              </Label>
              <Input
                id='op-key'
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder='e.g. send_notification'
                className='font-mono text-[13px]'
                required
              />
              <p className='text-[11px] text-slate-400'>Unique — lowercase, underscores only.</p>
            </div>
            <div className='space-y-1.5'>
              <Label htmlFor='op-type'>Type</Label>
              <Select value={type} onValueChange={setType}>
                <SelectTrigger id='op-type'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='condition'>Condition — branch on a field value</SelectItem>
                  <SelectItem value='exec-script'>Script — run JavaScript</SelectItem>
                  <SelectItem value='log'>Log — write to server log</SelectItem>
                  <SelectItem value='mail'>Mail — send an email</SelectItem>
                  <SelectItem value='notification'>Notification — in-app alert</SelectItem>
                  <SelectItem value='webhook'>Webhook — call external URL</SelectItem>
                  <SelectItem value='transform'>Transform — map/set/delete fields</SelectItem>
                  <SelectItem value='run-flow'>Run Flow — trigger another flow</SelectItem>
                  <SelectItem value='external-api'>
                    External API — call predefined or custom endpoint
                  </SelectItem>
                  {(registeredOpsForAdd ?? []).length > 0 && (
                    <>
                      <div className='my-1 border-t border-slate-100 dark:border-border' />
                      {(registeredOpsForAdd ?? []).map((o) => (
                        <SelectItem key={o.type} value={o.type}>
                          {o.label}
                          {o.description ? ` — ${o.description}` : ''}
                        </SelectItem>
                      ))}
                    </>
                  )}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button type='button' variant='outline' onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type='submit' disabled={addOp.isPending || !name.trim() || !key.trim()}>
              {addOp.isPending ? 'Adding…' : 'Add Operation'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ─── Canvas: Trigger node ─────────────────────────────────────────────────────

const TRIGGER_ICONS: Record<string, React.ElementType> = {
  manual: Settings2,
  schedule: Clock,
  event: Zap,
  webhook: Globe
}

function TriggerSummary({
  trigger,
  options
}: {
  trigger: string
  options: Record<string, unknown> | null
}) {
  if (trigger === 'schedule') {
    const cron = (options?.cron as string) ?? '—'
    return <span className='font-mono text-[11px] text-slate-400'>{cron}</span>
  }
  if (trigger === 'event') {
    const types = (options?.types as string[]) ?? []
    const cols = (options?.collections as string[]) ?? []
    return (
      <div className='text-[11px] text-slate-400 space-y-0.5'>
        {types.length > 0 && <div>Events: {types.join(', ')}</div>}
        {cols.length > 0 && <div className='truncate'>Collections: {cols.join(', ')}</div>}
      </div>
    )
  }
  if (trigger === 'manual') {
    return <span className='text-[11px] text-slate-400'>Triggers on manual run</span>
  }
  if (trigger === 'webhook') {
    const method = (options?.method as string) ?? '*'
    return (
      <span className='text-[11px] text-slate-400'>
        Inbound HTTP {method !== '*' ? method : 'any'}
      </span>
    )
  }
  return null
}

function TriggerNode({
  trigger,
  triggerOptions,
  status,
  triggerPos,
  nodeDir,
  onDirChange,
  onAddFirst,
  onPointerDown
}: {
  trigger: string
  triggerOptions: Record<string, unknown> | null
  status: 'active' | 'inactive'
  triggerPos: { x: number; y: number }
  nodeDir: 'h' | 'v'
  onDirChange: (d: 'h' | 'v') => void
  onAddFirst: () => void
  onPointerDown: (e: React.PointerEvent) => void
}) {
  const Icon = TRIGGER_ICONS[trigger] ?? Zap
  const isH = nodeDir === 'h'
  return (
    <div
      style={{ position: 'absolute', left: triggerPos.x, top: triggerPos.y, width: TRIGGER_W }}
      className='overflow-visible'
    >
      <div className='rounded-xl border-2 border-nvr-cyan bg-white dark:bg-card shadow-md select-none'>
        <div
          className='flex items-center gap-2 border-b border-slate-100 dark:border-border px-3.5 py-2.5 cursor-grab active:cursor-grabbing'
          onPointerDown={onPointerDown}
        >
          <div className='flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-nvr-cyan/10'>
            <Icon className='h-3.5 w-3.5 text-nvr-cyan' />
          </div>
          <span className='text-[12.5px] font-semibold text-slate-800 dark:text-foreground'>
            Trigger
          </span>
        </div>
        <div className='px-3.5 py-2.5 min-h-[48px]'>
          <div className='mb-1 text-[11px] font-medium capitalize text-slate-500'>{trigger}</div>
          <TriggerSummary trigger={trigger} options={triggerOptions} />
        </div>
        <div className='flex items-center justify-between border-t border-slate-100 dark:border-border px-3.5 py-2'>
          <div className='flex items-center gap-1.5'>
            <span
              className={cn(
                'h-1.5 w-1.5 rounded-full',
                status === 'active' ? 'bg-emerald-500' : 'bg-slate-300'
              )}
            />
            <span
              className={cn(
                'text-[11px] font-medium',
                status === 'active' ? 'text-emerald-600' : 'text-slate-400'
              )}
            >
              {status === 'active' ? 'Active' : 'Inactive'}
            </span>
          </div>
          <div className='flex items-center rounded border border-slate-200 dark:border-slate-700 overflow-hidden'>
            <button
              type='button'
              onClick={() => onDirChange('h')}
              className={cn(
                'flex items-center justify-center w-5 h-5 transition-colors',
                nodeDir === 'h'
                  ? 'bg-nvr-cyan/10 text-nvr-cyan'
                  : 'text-slate-400 hover:text-slate-600'
              )}
              title='Outputs right'
            >
              <ArrowRight className='h-2.5 w-2.5' />
            </button>
            <button
              type='button'
              onClick={() => onDirChange('v')}
              className={cn(
                'flex items-center justify-center w-5 h-5 border-l border-slate-200 dark:border-slate-700 transition-colors',
                nodeDir === 'v'
                  ? 'bg-nvr-cyan/10 text-nvr-cyan'
                  : 'text-slate-400 hover:text-slate-600'
              )}
              title='Outputs down'
            >
              <ArrowDown className='h-2.5 w-2.5' />
            </button>
          </div>
        </div>
      </div>
      {/* Output handle — right for H, bottom for V */}
      <div
        style={
          isH
            ? { position: 'absolute', right: -10, top: TRIG_OUT_DY - 8 }
            : { position: 'absolute', top: TRIGGER_H - 8, left: TRIGGER_W / 2 - 8 }
        }
        className={cn('flex items-center gap-1 overflow-visible', !isH && 'flex-col')}
      >
        <div className='h-4 w-4 rounded-full border-2 border-nvr-cyan bg-white dark:bg-card flex items-center justify-center shadow-sm z-10'>
          <div className='h-1.5 w-1.5 rounded-full bg-nvr-cyan' />
        </div>
        <div className={isH ? 'h-px w-5 bg-nvr-cyan/40' : 'h-5 w-px bg-nvr-cyan/40'} />
        <button
          type='button'
          onClick={onAddFirst}
          className='h-5 w-5 rounded-full border-2 border-nvr-cyan/60 bg-white dark:bg-card flex items-center justify-center hover:bg-nvr-cyan/10 transition-colors shadow-sm z-10'
          title='Add parallel branch'
        >
          <Plus className='h-3 w-3 text-nvr-cyan' />
        </button>
      </div>
    </div>
  )
}

// ─── Canvas: Operation node ───────────────────────────────────────────────────

function OperationNode({
  op,
  nodeDir,
  onDirChange,
  onEdit,
  onDelete,
  onAddResolve,
  onAddReject,
  onPointerDown
}: {
  op: FlowOperation & { x: number; y: number }
  nodeDir: 'h' | 'v'
  onDirChange: (d: 'h' | 'v') => void
  onEdit: () => void
  onDelete: () => void
  onAddResolve: () => void
  onAddReject: () => void
  onPointerDown: (e: React.PointerEvent) => void
}) {
  const Icon = OP_ICONS[op.type] ?? Zap
  const cfg = OP_TYPE_CONFIG[op.type] ?? { color: '#64748b', label: op.type }
  const isH = nodeDir === 'h'

  return (
    <div
      style={{ position: 'absolute', left: op.x, top: op.y, width: OP_W }}
      className='overflow-visible'
    >
      {/* Input handle — left for H, top for V */}
      <div
        style={
          isH
            ? { position: 'absolute', left: -10, top: OP_IN_DY - 8 }
            : { position: 'absolute', top: -10, left: OP_W / 2 - 8 }
        }
        className='h-4 w-4 rounded-full border-2 border-slate-300 bg-white dark:bg-card shadow-sm z-10'
      />

      <div className='rounded-lg border border-slate-200 dark:border-border bg-white dark:bg-card shadow-sm'>
        <div
          className='flex items-center gap-2 px-3 py-2.5 cursor-grab active:cursor-grabbing select-none'
          onPointerDown={onPointerDown}
        >
          <div
            className='flex h-6 w-6 shrink-0 items-center justify-center rounded-md'
            style={{ backgroundColor: `${cfg.color}18` }}
          >
            <Icon className='h-3.5 w-3.5' style={{ color: cfg.color }} />
          </div>
          <div className='min-w-0 flex-1'>
            <div className='truncate text-[12.5px] font-semibold text-slate-800 dark:text-foreground'>
              {op.name}
            </div>
            <div className='flex items-center gap-1.5 mt-0.5'>
              <OpTypeBadge type={op.type} />
              <span className='font-mono text-[10px] text-slate-400 truncate'>{op.key}</span>
              {!!(op.options as Record<string, unknown>)?.async && (
                <span className='rounded border border-violet-200 bg-violet-50 px-1 py-0.5 font-mono text-[9px] font-medium text-violet-600 dark:border-violet-800 dark:bg-violet-900/20 dark:text-violet-400'>
                  async
                </span>
              )}
            </div>
          </div>
        </div>
        <div className='flex items-center justify-between px-3 pb-1.5 pt-0 border-t border-slate-50 dark:border-border/50'>
          <div className='flex items-center rounded border border-slate-200 dark:border-slate-700 overflow-hidden'>
            <button
              type='button'
              onClick={() => onDirChange('h')}
              className={cn(
                'flex items-center justify-center w-5 h-5 transition-colors',
                nodeDir === 'h'
                  ? 'bg-slate-100 dark:bg-muted text-slate-600 dark:text-foreground'
                  : 'text-slate-300 hover:text-slate-500'
              )}
              title='Outputs right'
            >
              <ArrowRight className='h-2.5 w-2.5' />
            </button>
            <button
              type='button'
              onClick={() => onDirChange('v')}
              className={cn(
                'flex items-center justify-center w-5 h-5 border-l border-slate-200 dark:border-slate-700 transition-colors',
                nodeDir === 'v'
                  ? 'bg-slate-100 dark:bg-muted text-slate-600 dark:text-foreground'
                  : 'text-slate-300 hover:text-slate-500'
              )}
              title='Outputs down'
            >
              <ArrowDown className='h-2.5 w-2.5' />
            </button>
          </div>
          <div className='flex gap-1'>
            <button
              type='button'
              onClick={onEdit}
              className='rounded-md px-1.5 py-0.5 text-[10px] text-slate-400 hover:text-slate-700 hover:bg-slate-50 dark:hover:bg-muted transition-colors'
            >
              configure
            </button>
            <button
              type='button'
              onClick={onDelete}
              className='rounded-md px-1.5 py-0.5 text-[10px] text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/20 transition-colors'
            >
              remove
            </button>
          </div>
        </div>
      </div>

      {/* Resolve handle — right for H, bottom-left for V */}
      <div
        style={
          isH
            ? { position: 'absolute', left: OP_RES_DX - 8, top: OP_RES_DY - 8 }
            : { position: 'absolute', top: OP_H - 8, left: Math.round(OP_W * 0.3) - 8 }
        }
        className={cn('flex items-center gap-1 overflow-visible z-10', !isH && 'flex-col')}
      >
        <div className='h-4 w-4 rounded-full border-2 border-nvr-cyan bg-white dark:bg-card flex items-center justify-center shadow-sm'>
          <Check className='h-2.5 w-2.5 text-nvr-cyan' />
        </div>
        {!op.resolve && (
          <>
            <div className={isH ? 'h-px w-4 bg-nvr-cyan/40' : 'h-4 w-px bg-nvr-cyan/40'} />
            <button
              type='button'
              onClick={onAddResolve}
              className='h-5 w-5 rounded-full border-2 border-nvr-cyan/50 bg-white dark:bg-card flex items-center justify-center hover:bg-nvr-cyan/10 transition-colors shadow-sm'
              title='Add resolve operation'
            >
              <Plus className='h-3 w-3 text-nvr-cyan/80' />
            </button>
          </>
        )}
      </div>

      {/* Reject handle — right for H, bottom-right for V */}
      <div
        style={
          isH
            ? { position: 'absolute', left: OP_REJ_DX - 8, top: OP_REJ_DY - 8 }
            : { position: 'absolute', top: OP_H - 8, left: Math.round(OP_W * 0.65) - 8 }
        }
        className={cn('flex items-center gap-1 overflow-visible z-10', !isH && 'flex-col')}
      >
        <div className='h-4 w-4 rounded-full border-2 border-rose-400 bg-white dark:bg-card flex items-center justify-center shadow-sm'>
          <X className='h-2.5 w-2.5 text-rose-400' />
        </div>
        {!op.reject && (
          <>
            <div className={isH ? 'h-px w-4 bg-rose-400/40' : 'h-4 w-px bg-rose-400/40'} />
            <button
              type='button'
              onClick={onAddReject}
              className='h-5 w-5 rounded-full border-2 border-rose-400/50 bg-white dark:bg-card flex items-center justify-center hover:bg-rose-50 dark:hover:bg-rose-950/20 transition-colors shadow-sm'
              title='Add reject operation'
            >
              <Plus className='h-3 w-3 text-rose-400' />
            </button>
          </>
        )}
      </div>
    </div>
  )
}

// ─── Canvas ───────────────────────────────────────────────────────────────────

type AddOpState = {
  sourceOpId: string | null
  linkType: 'resolve' | 'reject' | null
  defaultPosition: { x: number; y: number }
} | null

function FlowCanvas({ flow, flowId }: { flow: Flow; flowId: string }) {
  const queryClient = useQueryClient()
  const [editingOp, setEditingOp] = useState<FlowOperation | null>(null)
  const [addOpState, setAddOpState] = useState<AddOpState>(null)
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const TRIGGER_DIR_KEY = `${flowId}:tdir`
  const [triggerDir, setTriggerDir] = useState<'h' | 'v'>(
    () => (localStorage.getItem(TRIGGER_DIR_KEY) as 'h' | 'v') ?? 'h'
  )

  const [opDirs, setOpDirs] = useState<Record<string, 'h' | 'v'>>(() => {
    const out: Record<string, 'h' | 'v'> = {}
    for (const op of flow.operations) {
      const d = (op.options as Record<string, unknown>)?.direction
      if (d === 'h' || d === 'v') out[op.id] = d
    }
    return out
  })

  function getOpDir(opId: string): 'h' | 'v' {
    return opDirs[opId] ?? 'h'
  }

  function changeTriggerDir(d: 'h' | 'v') {
    setTriggerDir(d)
    localStorage.setItem(TRIGGER_DIR_KEY, d)
  }

  const allZero = flow.operations.every((op) => op.position_x === 0 && op.position_y === 0)
  const layoutedPositions =
    allZero && flow.operations.length > 0 ? autoLayout(flow.operations) : null

  const TRIGGER_POS_KEY = `nivaro-trigger-pos-${flowId}`
  const [triggerPos, setTriggerPos] = useState<{ x: number; y: number }>(() => {
    try {
      return JSON.parse(localStorage.getItem(TRIGGER_POS_KEY) ?? '') as { x: number; y: number }
    } catch {
      return { x: TRIGGER_X, y: TRIGGER_Y }
    }
  })

  const [localPositions, setLocalPositions] = useState<Record<string, { x: number; y: number }>>({})
  const dragState = useRef<
    | {
        kind: 'op'
        opId: string
        startMouseX: number
        startMouseY: number
        startNodeX: number
        startNodeY: number
      }
    | {
        kind: 'trigger'
        startMouseX: number
        startMouseY: number
        startNodeX: number
        startNodeY: number
      }
    | null
  >(null)

  const patchPos = useMutation({
    mutationFn: ({ opId, x, y }: { opId: string; x: number; y: number }) =>
      api.patch(`/flows/${flowId}/operations/${opId}`, { position_x: x, position_y: y }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['flows', flowId] })
  })

  const patchOpOptions = useMutation({
    mutationFn: ({ opId, options }: { opId: string; options: Record<string, unknown> }) =>
      api.patch(`/flows/${flowId}/operations/${opId}`, { options })
  })

  const deleteOp = useMutation({
    mutationFn: (opId: string) => api.delete(`/flows/${flowId}/operations/${opId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['flows', flowId] })
      setPendingDelete(null)
      toast.success('Operation removed')
    },
    onError: () => toast.error('Failed to remove operation')
  })

  function getOpPos(op: FlowOperation): { x: number; y: number } {
    if (localPositions[op.id]) return localPositions[op.id]
    if (layoutedPositions?.[op.id]) return layoutedPositions[op.id]
    return { x: op.position_x, y: op.position_y }
  }

  function handlePointerDown(e: React.PointerEvent, op: FlowOperation) {
    e.stopPropagation()
    const pos = getOpPos(op)
    dragState.current = {
      kind: 'op',
      opId: op.id,
      startMouseX: e.clientX,
      startMouseY: e.clientY,
      startNodeX: pos.x,
      startNodeY: pos.y
    }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  function handleTriggerPointerDown(e: React.PointerEvent) {
    e.stopPropagation()
    dragState.current = {
      kind: 'trigger',
      startMouseX: e.clientX,
      startMouseY: e.clientY,
      startNodeX: triggerPos.x,
      startNodeY: triggerPos.y
    }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  function handlePointerMove(e: React.PointerEvent) {
    const ds = dragState.current
    if (!ds) return
    const dx = e.clientX - ds.startMouseX
    const dy = e.clientY - ds.startMouseY
    if (ds.kind === 'op') {
      setLocalPositions((prev) => ({
        ...prev,
        [ds.opId]: {
          x: Math.max(0, ds.startNodeX + dx),
          y: Math.max(0, ds.startNodeY + dy)
        }
      }))
    } else {
      setTriggerPos({
        x: Math.max(0, ds.startNodeX + dx),
        y: Math.max(0, ds.startNodeY + dy)
      })
    }
  }

  function handlePointerUp(e: React.PointerEvent) {
    const ds = dragState.current
    if (!ds) return
    const dx = e.clientX - ds.startMouseX
    const dy = e.clientY - ds.startMouseY
    if (ds.kind === 'op') {
      const finalPos = { x: Math.max(0, ds.startNodeX + dx), y: Math.max(0, ds.startNodeY + dy) }
      patchPos.mutate({ opId: ds.opId, x: finalPos.x, y: finalPos.y })
    } else {
      const finalPos = { x: Math.max(0, ds.startNodeX + dx), y: Math.max(0, ds.startNodeY + dy) }
      setTriggerPos(finalPos)
      localStorage.setItem(TRIGGER_POS_KEY, JSON.stringify(finalPos))
    }
    dragState.current = null
  }

  const opMap = new Map(flow.operations.map((op) => [op.id, op]))
  const referencedIds = new Set(
    flow.operations
      .flatMap((op) => [op.resolve, op.reject])
      .filter((id): id is string => id != null)
  )
  const rootOps = flow.operations.filter((op) => !referencedIds.has(op.id))

  function changeOpDir(opId: string, d: 'h' | 'v') {
    setOpDirs((prev) => ({ ...prev, [opId]: d }))
    const op = opMap.get(opId)
    if (op) {
      patchOpOptions.mutate({
        opId,
        options: { ...((op.options as Record<string, unknown>) ?? {}), direction: d }
      })
    }
  }

  function addFromHandle(sourceOpId: string, linkType: 'resolve' | 'reject') {
    const source = opMap.get(sourceOpId)
    if (!source) return
    const pos = getOpPos(source)
    const isH = getOpDir(sourceOpId) === 'h'
    const newX = isH ? pos.x + 300 : linkType === 'reject' ? pos.x + 270 : pos.x
    const newY = isH ? (linkType === 'reject' ? pos.y + 170 : pos.y) : pos.y + 220
    setAddOpState({ sourceOpId, linkType, defaultPosition: { x: newX, y: newY } })
  }

  function addFirstOp() {
    const isH = triggerDir === 'h'
    const x = isH
      ? triggerPos.x + TRIGGER_W + 80
      : rootOps.length > 0
        ? Math.max(...rootOps.map((op) => getOpPos(op).x)) + 270
        : triggerPos.x
    const y = isH
      ? rootOps.length > 0
        ? Math.max(...rootOps.map((op) => getOpPos(op).y)) + 170
        : triggerPos.y
      : triggerPos.y + TRIGGER_H + 80
    setAddOpState({ sourceOpId: null, linkType: null, defaultPosition: { x, y } })
  }

  return (
    <>
      <div className='relative flex-1 overflow-hidden flex flex-col'>
        <div
          className='relative flex-1 overflow-auto'
          style={{
            backgroundImage: 'radial-gradient(circle, rgba(0,0,0,0.10) 1px, transparent 1px)',
            backgroundSize: '20px 20px',
            backgroundColor: '#f8fafc'
          }}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
        >
          <div
            style={{
              position: 'relative',
              width: CANVAS_W,
              height: CANVAS_H,
              minWidth: '100%',
              minHeight: '100%'
            }}
          >
            {/* SVG edges */}
            <svg
              aria-hidden='true'
              style={{
                position: 'absolute',
                inset: 0,
                width: CANVAS_W,
                height: CANVAS_H,
                pointerEvents: 'none',
                overflow: 'visible'
              }}
            >
              <defs>
                <marker
                  id='arrow-slate'
                  markerWidth='6'
                  markerHeight='6'
                  refX='5'
                  refY='3'
                  orient='auto'
                >
                  <path d='M0,0 L0,6 L6,3 z' fill='#94a3b8' />
                </marker>
                <marker
                  id='arrow-cyan'
                  markerWidth='6'
                  markerHeight='6'
                  refX='5'
                  refY='3'
                  orient='auto'
                >
                  <path d='M0,0 L0,6 L6,3 z' fill='#00ceff' />
                </marker>
                <marker
                  id='arrow-rose'
                  markerWidth='6'
                  markerHeight='6'
                  refX='5'
                  refY='3'
                  orient='auto'
                >
                  <path d='M0,0 L0,6 L6,3 z' fill='#f43f5e' />
                </marker>
              </defs>

              {/* Trigger → root ops (fan-out) */}
              {rootOps.map((rootOp) => {
                const rp = getOpPos(rootOp)
                const tIsH = triggerDir === 'h'
                const rIsH = getOpDir(rootOp.id) === 'h'
                const x1 = triggerPos.x + (tIsH ? TRIGGER_W : TRIGGER_W / 2)
                const y1 = triggerPos.y + (tIsH ? TRIG_OUT_DY : TRIGGER_H)
                const x2 = rp.x + (rIsH ? OP_IN_DX : OP_W / 2)
                const y2 = rp.y + (rIsH ? OP_IN_DY : 0)
                return (
                  <path
                    key={rootOp.id}
                    d={bezierPath(x1, y1, x2, y2)}
                    fill='none'
                    stroke='#94a3b8'
                    strokeWidth='1.5'
                    markerEnd='url(#arrow-slate)'
                  />
                )
              })}

              {/* Op → resolve/reject edges */}
              {flow.operations.map((op) => {
                const sp = getOpPos(op)
                const sIsH = getOpDir(op.id) === 'h'
                return (
                  <g key={op.id}>
                    {op.resolve &&
                      opMap.has(op.resolve) &&
                      (() => {
                        const tp = getOpPos(opMap.get(op.resolve)!)
                        const tIsH = getOpDir(op.resolve) === 'h'
                        const x1 = sp.x + (sIsH ? OP_RES_DX : Math.round(OP_W * 0.3))
                        const y1 = sp.y + (sIsH ? OP_RES_DY : OP_H)
                        return (
                          <path
                            d={bezierPath(
                              x1,
                              y1,
                              tp.x + (tIsH ? OP_IN_DX : OP_W / 2),
                              tp.y + (tIsH ? OP_IN_DY : 0)
                            )}
                            fill='none'
                            stroke='#00ceff'
                            strokeWidth='1.5'
                            markerEnd='url(#arrow-cyan)'
                          />
                        )
                      })()}
                    {op.reject &&
                      opMap.has(op.reject) &&
                      (() => {
                        const tp = getOpPos(opMap.get(op.reject)!)
                        const tIsH = getOpDir(op.reject) === 'h'
                        const x1 = sp.x + (sIsH ? OP_REJ_DX : Math.round(OP_W * 0.65))
                        const y1 = sp.y + (sIsH ? OP_REJ_DY : OP_H)
                        return (
                          <path
                            d={bezierPath(
                              x1,
                              y1,
                              tp.x + (tIsH ? OP_IN_DX : OP_W / 2),
                              tp.y + (tIsH ? OP_IN_DY : 0)
                            )}
                            fill='none'
                            stroke='#f43f5e'
                            strokeWidth='1.5'
                            markerEnd='url(#arrow-rose)'
                          />
                        )
                      })()}
                  </g>
                )
              })}
            </svg>

            {/* Trigger node */}
            <TriggerNode
              trigger={flow.trigger}
              triggerOptions={flow.trigger_options}
              status={flow.status}
              triggerPos={triggerPos}
              nodeDir={triggerDir}
              onDirChange={changeTriggerDir}
              onAddFirst={addFirstOp}
              onPointerDown={handleTriggerPointerDown}
            />

            {/* Operation nodes */}
            {flow.operations.map((op) => {
              const pos = getOpPos(op)
              return (
                <div key={op.id} className='group'>
                  {pendingDelete === op.id ? (
                    <div
                      style={{ position: 'absolute', left: pos.x, top: pos.y, width: OP_W }}
                      className='rounded-lg border border-red-200 bg-white dark:bg-card shadow-sm p-3 flex flex-col gap-2'
                    >
                      <p className='text-[12px] text-slate-700 font-medium'>
                        Remove <span className='font-semibold'>{op.name}</span>?
                      </p>
                      <div className='flex gap-1.5'>
                        <button
                          type='button'
                          onClick={() => deleteOp.mutate(op.id)}
                          className='flex-1 rounded bg-red-500 py-1 text-[11px] font-medium text-white hover:bg-red-600'
                        >
                          Remove
                        </button>
                        <button
                          type='button'
                          onClick={() => setPendingDelete(null)}
                          className='flex-1 rounded border py-1 text-[11px] hover:bg-slate-50 dark:hover:bg-muted'
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <OperationNode
                      op={{ ...op, ...pos }}
                      nodeDir={getOpDir(op.id)}
                      onDirChange={(d) => changeOpDir(op.id, d)}
                      onEdit={() => setEditingOp(op)}
                      onDelete={() => setPendingDelete(op.id)}
                      onAddResolve={() => addFromHandle(op.id, 'resolve')}
                      onAddReject={() => addFromHandle(op.id, 'reject')}
                      onPointerDown={(e) => handlePointerDown(e, op)}
                    />
                  )}
                </div>
              )
            })}
          </div>
        </div>
        {flow.operations.length === 0 && (
          <div className='pointer-events-none absolute bottom-6 left-1/2 -translate-x-1/2 select-none rounded-full border border-slate-200 dark:border-slate-700 bg-white/80 dark:bg-card/80 backdrop-blur-sm px-4 py-2 text-[12px] text-slate-400 whitespace-nowrap'>
            Click{' '}
            <span className='font-mono bg-slate-100 dark:bg-muted px-1 rounded pointer-events-none'>
              +
            </span>{' '}
            on the trigger to add your first operation
          </div>
        )}
      </div>

      {editingOp && (
        <EditOperationDialog
          flowId={flowId}
          op={editingOp}
          open={!!editingOp}
          onOpenChange={(v) => {
            if (!v) setEditingOp(null)
          }}
        />
      )}

      {addOpState !== null && (
        <AddOperationDialog
          flowId={flowId}
          open
          onOpenChange={(v) => {
            if (!v) setAddOpState(null)
          }}
          sourceOpId={addOpState.sourceOpId}
          linkType={addOpState.linkType}
          defaultPosition={addOpState.defaultPosition}
        />
      )}
    </>
  )
}

// ─── Versions section ─────────────────────────────────────────────────────────

type FlowVersionRow = {
  id: number
  version: number
  created_at: string
  created_by: string | null
  first_name: string | null
  last_name: string | null
  user_email: string | null
}

function versionAuthor(v: FlowVersionRow): string {
  if (v.first_name || v.last_name) return [v.first_name, v.last_name].filter(Boolean).join(' ')
  return v.user_email ?? 'System'
}

function FlowVersionsSection({ flowId }: { flowId: string }) {
  const queryClient = useQueryClient()
  const [confirmVersion, setConfirmVersion] = useState<number | null>(null)

  const { data: versions, isLoading } = useQuery({
    queryKey: ['flow-versions', flowId],
    queryFn: () =>
      api.get<{ data: FlowVersionRow[] }>(`/flows/${flowId}/versions`).then((r) => r.data.data)
  })

  const restoreMut = useMutation({
    mutationFn: (version: number) =>
      api.post(`/flows/${flowId}/versions/${version}/restore`).then((r) => r.data),
    onSuccess: (_data, version) => {
      setConfirmVersion(null)
      toast.success(`Restored version ${version}`)
      queryClient.invalidateQueries({ queryKey: ['flows', flowId] })
      queryClient.invalidateQueries({ queryKey: ['flows'] })
      queryClient.invalidateQueries({ queryKey: ['flow-versions', flowId] })
    },
    onError: () => toast.error('Failed to restore version')
  })

  return (
    <div className='rounded-xl border border-slate-200 bg-white dark:bg-slate-900 dark:border-slate-700 p-5 space-y-3'>
      <div className='flex items-center gap-2'>
        <History className='h-4 w-4 text-slate-400' />
        <h2 className='text-[13px] font-semibold text-slate-900 dark:text-slate-100'>Versions</h2>
        {versions && versions.length > 0 && (
          <span className='ml-auto rounded-full bg-slate-100 dark:bg-muted px-2 py-0.5 text-[10px] font-semibold text-slate-500 dark:text-muted-foreground'>
            {versions.length}
          </span>
        )}
      </div>
      {isLoading ? (
        <div className='space-y-2'>
          <Skeleton className='h-8 rounded' />
          <Skeleton className='h-8 rounded' />
        </div>
      ) : !versions || versions.length === 0 ? (
        <p className='text-[12px] text-slate-400'>
          No versions yet. A version is captured automatically before each change to the trigger or
          operations.
        </p>
      ) : (
        <div className='divide-y divide-slate-100 dark:divide-border'>
          {versions.map((v) => (
            <div key={v.id} className='py-2'>
              <div className='flex items-center gap-2'>
                <span className='font-mono text-[11px] font-semibold text-slate-700 dark:text-foreground shrink-0'>
                  v{v.version}
                </span>
                <span className='min-w-0 flex-1 truncate text-[11.5px] text-slate-500 dark:text-muted-foreground'>
                  {versionAuthor(v)}
                </span>
                <span className='shrink-0 text-[10.5px] text-slate-400'>
                  {formatRelative(v.created_at)}
                </span>
              </div>
              <div className='mt-1 flex items-center justify-end gap-1.5'>
                {confirmVersion === v.version ? (
                  <>
                    <span className='text-[10.5px] text-slate-500'>Restore this version?</span>
                    <Button
                      size='sm'
                      variant='destructive'
                      className='h-5 px-2 text-[10.5px]'
                      disabled={restoreMut.isPending}
                      onClick={() => restoreMut.mutate(v.version)}
                    >
                      {restoreMut.isPending ? 'Restoring…' : 'Yes, restore'}
                    </Button>
                    <Button
                      size='sm'
                      variant='outline'
                      className='h-5 px-2 text-[10.5px]'
                      onClick={() => setConfirmVersion(null)}
                    >
                      Cancel
                    </Button>
                  </>
                ) : (
                  <button
                    type='button'
                    onClick={() => setConfirmVersion(v.version)}
                    className='rounded px-1.5 py-0.5 text-[10.5px] text-slate-400 transition-colors hover:bg-slate-50 hover:text-slate-700 dark:hover:bg-muted'
                  >
                    Restore
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      <p className='text-[10.5px] text-slate-400'>
        Restoring snapshots the current state first, then replaces the flow and its operations.
      </p>
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function FlowEditPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const { data: flow, isLoading } = useQuery({
    queryKey: ['flows', id],
    queryFn: () => api.get(`/flows/${id}`).then((r) => r.data.data as Flow),
    enabled: !!id
  })

  const { data: registeredTriggers } = useQuery({
    queryKey: ['flow-registered-triggers'],
    queryFn: () =>
      api
        .get<{
          data: Array<{
            type: string
            label: string
            description?: string
            fields?: Array<{
              key: string
              label: string
              type: string
              options?: Array<{ value: string; label: string }>
              placeholder?: string
              required?: boolean
              description?: string
              defaultValue?: unknown
            }>
          }>
        }>('/flows/registered-triggers')
        .then((r) => r.data.data),
    staleTime: 60_000
  })

  const [form, setForm] = useState<
    Partial<Flow & { trigger_options: Record<string, unknown> | null }>
  >({})

  const name = form.name ?? flow?.name ?? ''
  const description = form.description ?? flow?.description ?? ''
  const trigger = form.trigger ?? flow?.trigger ?? 'manual'
  const status = form.status ?? flow?.status ?? 'active'
  const accountability = form.accountability ?? flow?.accountability ?? 'all'

  const triggerOptions: Record<string, unknown> =
    form.trigger_options != null
      ? form.trigger_options
      : form.trigger == null || form.trigger === flow?.trigger
        ? ((flow?.trigger_options ?? {}) as Record<string, unknown>)
        : {}

  function setTriggerOptions(opts: Record<string, unknown>) {
    setForm((p) => ({ ...p, trigger_options: opts }))
  }

  function handleTriggerChange(v: string) {
    setForm((p) => ({ ...p, trigger: v, trigger_options: null }))
  }

  const updateFlow = useMutation({
    mutationFn: (body: Partial<Flow>) => api.patch(`/flows/${id}`, body).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['flows', id] })
      queryClient.invalidateQueries({ queryKey: ['flows'] })
      toast.success('Flow saved')
    },
    onError: () => toast.error('Failed to save flow')
  })

  const triggerManually = useMutation({
    mutationFn: () => api.post(`/flows/${id}/trigger`).then((r) => r.data),
    onSuccess: () => toast.success('Flow triggered'),
    onError: () => toast.error('Failed to trigger flow')
  })

  function handleSave() {
    updateFlow.mutate({
      name,
      description: description || null,
      trigger,
      status,
      accountability,
      trigger_options: form.trigger_options ?? flow?.trigger_options ?? null
    })
  }

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      {/* Header */}
      <div className='shrink-0 border-b border-slate-200 dark:border-border bg-white dark:bg-card px-6 py-3'>
        <div className='flex items-center justify-between'>
          <div className='flex items-center gap-2'>
            <button
              type='button'
              onClick={() => navigate('/flows')}
              className='flex items-center gap-1.5 rounded-lg p-1 text-slate-400 transition-colors hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-700'
            >
              <ArrowLeft className='h-4 w-4' />
            </button>
            <span className='text-[13px] text-slate-400'>/</span>
            <span className='text-[13px] font-medium text-slate-500'>Flows</span>
            <span className='text-[13px] text-slate-400'>/</span>
            {isLoading ? (
              <Skeleton className='h-4 w-32' />
            ) : (
              <span className='text-[13px] font-semibold text-slate-900 dark:text-foreground'>
                {flow?.name ?? 'Flow'}
              </span>
            )}
          </div>
          <div className='flex items-center gap-2'>
            {flow && (
              <button
                type='button'
                onClick={() =>
                  setForm((p) => ({
                    ...p,
                    status: (p.status ?? flow.status) === 'active' ? 'inactive' : 'active'
                  }))
                }
                className={cn(
                  'flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[12px] font-medium transition-colors',
                  (form.status ?? flow.status) === 'active'
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-400'
                    : 'border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100 dark:border-border dark:bg-muted dark:text-slate-400'
                )}
              >
                <span
                  className={cn(
                    'h-1.5 w-1.5 rounded-full',
                    (form.status ?? flow.status) === 'active' ? 'bg-emerald-500' : 'bg-slate-400'
                  )}
                />
                {(form.status ?? flow.status) === 'active' ? 'Active' : 'Inactive'}
              </button>
            )}
            {status === 'active' && trigger === 'manual' && flow && (
              <Button
                size='sm'
                variant='outline'
                onClick={() => triggerManually.mutate()}
                disabled={triggerManually.isPending}
                className='gap-1.5'
              >
                <Zap className='h-3.5 w-3.5' />
                {triggerManually.isPending ? 'Running…' : 'Run Flow'}
              </Button>
            )}
            <Button
              size='sm'
              variant='outline'
              onClick={async () => {
                try {
                  await exportFlow(id!)
                } catch {
                  toast.error('Export failed')
                }
              }}
            >
              <Download className='mr-1.5 h-3.5 w-3.5' /> Export
            </Button>
            <Button size='sm' onClick={handleSave} disabled={updateFlow.isPending}>
              {updateFlow.isPending ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
      </div>

      {isLoading ? (
        <div className='flex-1 p-6 space-y-4 max-w-xl'>
          <Skeleton className='h-40 w-full rounded-xl' />
          <Skeleton className='h-32 w-full rounded-xl' />
        </div>
      ) : !flow ? (
        <div className='flex-1 flex items-center justify-center text-[13px] text-slate-400'>
          Flow not found.
        </div>
      ) : (
        <div className='flex flex-1 min-h-0 overflow-hidden'>
          {/* Settings panel */}
          <aside className='w-[340px] shrink-0 overflow-y-auto border-r border-slate-200 dark:border-border bg-white dark:bg-card p-5 space-y-5'>
            <div className='space-y-4'>
              <div className='space-y-1.5'>
                <Label htmlFor='edit-name' className='text-[12px]'>
                  Name
                </Label>
                <Input
                  id='edit-name'
                  value={name}
                  onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                  placeholder='Flow name'
                  className='h-8 text-[13px]'
                />
              </div>
              <div className='space-y-1.5'>
                <Label htmlFor='edit-description' className='text-[12px]'>
                  Description
                </Label>
                <Textarea
                  id='edit-description'
                  value={description ?? ''}
                  onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))}
                  placeholder='What does this flow do?'
                  rows={2}
                  className='resize-none text-[13px]'
                />
              </div>
              <div className='space-y-1.5'>
                <Label htmlFor='edit-trigger' className='text-[12px]'>
                  Trigger
                </Label>
                <Select value={trigger} onValueChange={handleTriggerChange}>
                  <SelectTrigger id='edit-trigger' className='h-8 text-[13px]'>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value='manual'>Manual</SelectItem>
                    <SelectItem value='schedule'>Schedule (cron)</SelectItem>
                    <SelectItem value='event'>Event (item hooks)</SelectItem>
                    <SelectItem value='webhook'>Webhook (inbound HTTP)</SelectItem>
                    {(registeredTriggers ?? []).length > 0 && (
                      <>
                        <div className='my-1 border-t border-slate-100 dark:border-border' />
                        {(registeredTriggers ?? []).map((t) => (
                          <SelectItem key={t.type} value={t.type}>
                            {t.label}
                            {t.description ? ` — ${t.description}` : ''}
                          </SelectItem>
                        ))}
                      </>
                    )}
                  </SelectContent>
                </Select>
              </div>
              <div className='space-y-1.5'>
                <Label htmlFor='edit-accountability' className='text-[12px]'>
                  Accountability
                </Label>
                <Select
                  value={accountability ?? 'all'}
                  onValueChange={(v) => setForm((p) => ({ ...p, accountability: v }))}
                >
                  <SelectTrigger id='edit-accountability' className='h-8 text-[13px]'>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value='all'>All (track activity)</SelectItem>
                    <SelectItem value='activity'>Activity only</SelectItem>
                    <SelectItem value='null'>None</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {trigger === 'schedule' && (
              <CronEditor
                value={(triggerOptions?.cron as string) ?? ''}
                nextRun={flow.next_run}
                onChange={(cron) => setTriggerOptions({ cron })}
              />
            )}
            {trigger === 'event' && (
              <EventTriggerEditor
                options={triggerOptions as Partial<EventTriggerOptions>}
                onChange={(o) => setTriggerOptions(o as unknown as Record<string, unknown>)}
              />
            )}
            {trigger === 'webhook' && (
              <WebhookTriggerEditor
                flowId={id!}
                options={triggerOptions as Partial<WebhookTriggerOptions>}
                onChange={(o) => setTriggerOptions(o as unknown as Record<string, unknown>)}
              />
            )}
            {trigger === 'manual' && (
              <ManualTriggerEditor
                options={triggerOptions as Partial<ManualTriggerOptions>}
                onChange={(o) => setTriggerOptions(o as unknown as Record<string, unknown>)}
              />
            )}
            {(() => {
              const extTrigger = (registeredTriggers ?? []).find((t) => t.type === trigger)
              if (!extTrigger) return null
              if (!extTrigger.fields?.length)
                return (
                  <div className='rounded-lg border border-slate-200 dark:border-border bg-slate-50 dark:bg-muted/30 px-3 py-2 text-[11px] text-slate-500'>
                    Extension trigger: <span className='font-semibold'>{extTrigger.label}</span>. No
                    configuration required.
                  </div>
                )
              return (
                <div className='space-y-3'>
                  <p className='text-[11px] font-medium text-slate-500'>
                    {extTrigger.label} Options
                  </p>
                  {extTrigger.fields.map((field) =>
                    field.type === 'boolean' ? (
                      <div
                        key={field.key}
                        className='flex items-center justify-between rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-2.5'
                      >
                        <div>
                          <Label className='cursor-pointer text-[12px]'>{field.label}</Label>
                          {field.description && (
                            <p className='text-[11px] text-slate-400'>{field.description}</p>
                          )}
                        </div>
                        <Switch
                          checked={
                            (triggerOptions[field.key] as boolean) ??
                            (field.defaultValue as boolean) ??
                            false
                          }
                          onCheckedChange={(v) =>
                            setTriggerOptions({ ...triggerOptions, [field.key]: v })
                          }
                        />
                      </div>
                    ) : (
                      <div key={field.key} className='space-y-1.5'>
                        <Label className='text-[12px]'>
                          {field.label}
                          {field.required && <span className='text-red-500 ml-0.5'>*</span>}
                        </Label>
                        {field.type === 'select' ? (
                          <Select
                            value={String(triggerOptions[field.key] ?? field.defaultValue ?? '')}
                            onValueChange={(v) =>
                              setTriggerOptions({ ...triggerOptions, [field.key]: v })
                            }
                          >
                            <SelectTrigger className='h-8 text-[13px]'>
                              <SelectValue placeholder={field.placeholder} />
                            </SelectTrigger>
                            <SelectContent>
                              {(field.options ?? []).map((o) => (
                                <SelectItem key={o.value} value={o.value}>
                                  {o.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : field.type === 'textarea' || field.type === 'json' ? (
                          <Textarea
                            value={String(triggerOptions[field.key] ?? field.defaultValue ?? '')}
                            onChange={(e) =>
                              setTriggerOptions({ ...triggerOptions, [field.key]: e.target.value })
                            }
                            placeholder={field.placeholder}
                            className={cn(
                              'resize-none text-[13px]',
                              field.type === 'json' && 'font-mono text-[12px]'
                            )}
                            rows={3}
                            spellCheck={false}
                          />
                        ) : field.type === 'number' ? (
                          <Input
                            type='number'
                            value={String(triggerOptions[field.key] ?? field.defaultValue ?? '')}
                            onChange={(e) =>
                              setTriggerOptions({
                                ...triggerOptions,
                                [field.key]: Number(e.target.value)
                              })
                            }
                            placeholder={field.placeholder}
                            className='h-8 text-[13px]'
                          />
                        ) : (
                          <Input
                            value={String(triggerOptions[field.key] ?? field.defaultValue ?? '')}
                            onChange={(e) =>
                              setTriggerOptions({ ...triggerOptions, [field.key]: e.target.value })
                            }
                            placeholder={field.placeholder}
                            className='h-8 text-[13px]'
                          />
                        )}
                        {field.description && (
                          <p className='text-[11px] text-slate-400'>{field.description}</p>
                        )}
                      </div>
                    )
                  )}
                </div>
              )
            })()}

            {id && <FlowVersionsSection flowId={id} />}
          </aside>

          {/* Canvas */}
          {id && <FlowCanvas flow={flow} flowId={id} />}
        </div>
      )}
    </div>
  )
}

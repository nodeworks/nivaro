import { ConfirmButton, QueryErrorState } from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRight, KeyRound, Plus, RotateCcw, Trash2, X } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Skeleton } from '@/components/ui/skeleton'
import { cn, formatDateTime, formatRelative } from '@/lib/utils'
import type { HubEnvironment } from '../hub-api'
import { dangerArmed, dangerGhost, Field, ghostButton, ToneChip } from '../hub-parts'
import {
  type BindingInput,
  type BindingTarget,
  type BindingView,
  fetchBindings,
  type OutputView,
  outputKeys,
  saveBindings,
  shortPrint,
  TARGET_LABEL
} from './outputs-api'
import { type HubResource, providerToast, type ResourceTypeInfo } from './providers-api'

/**
 * Outputs + bindings of one managed resource (opened from its row): what the provider handed out
 * — a connection string, an API key, a URL — and where each one goes in this app's environments.
 * Values never reach the page: an output shows whether the Hub holds it, a short fingerprint and
 * when it changed. A binding writes a stack setting or secret (the stack then needs Apply now) or
 * an allow-listed app setting; once-only outputs that were lost can only be rotated.
 */
export function OutputsCard({
  resource,
  type,
  environments,
  canDeploy,
  idPrefix,
  onRotate,
  onClose
}: {
  resource: HubResource
  type: ResourceTypeInfo
  /** The environments this resource may feed (its app's; every app's for a shared one). */
  environments: Array<Pick<HubEnvironment, 'id' | 'key'>>
  canDeploy: boolean
  idPrefix: string
  /** Plans the rotation (a change view the row shows). */
  onRotate?: () => void
  onClose: () => void
}) {
  const qc = useQueryClient()
  const key = outputKeys.bindings(resource.id)
  const q = useQuery({
    queryKey: key,
    queryFn: () => fetchBindings(resource.id),
    // A save pushes in the background: look again until every new binding has an outcome.
    refetchInterval: (query) =>
      query.state.data?.bindings.some((b) => !b.last_pushed_at && !b.last_error) ? 2500 : false
  })
  const [adding, setAdding] = useState(false)
  const save = useMutation({
    mutationFn: (list: BindingInput[]) => saveBindings(resource.id, list),
    onSuccess: (d) => {
      qc.setQueryData(key, (old) => (old ? { ...old, ...d } : d))
      if (adding && d.bindings.length) toast.success('Bound — the Hub writes it now')
      setAdding(false)
    },
    onError: (e) => providerToast(e, 'Could not save the bindings')
  })
  const current = (q.data?.bindings ?? []).map(
    (b): BindingInput => ({
      output_key: b.output_key,
      environment_id: b.environment_id,
      target: b.target,
      target_key: b.target_key
    })
  )
  const labelOf = (k: string) => q.data?.outputs.find((o) => o.key === k)?.label ?? k

  return (
    <section
      aria-label={`Outputs of ${resource.name ?? resource.type}`}
      className='rounded-md border border-slate-200 bg-white dark:border-border dark:bg-card'
    >
      <header className='flex items-start gap-2 border-b border-slate-200 px-3 py-2 dark:border-border'>
        <div className='min-w-0 flex-1'>
          <h6 className='m-0 text-[12.5px] font-semibold text-slate-900 dark:text-foreground'>
            Outputs
          </h6>
          <p className='m-0 mt-0.5 max-w-[68ch] text-[11.5px] text-slate-500 dark:text-muted-foreground'>
            What this {type.label} hands out. The Hub keeps each value sealed and writes it where
            you bind it; it never shows a value here.
          </p>
        </div>
        <button
          type='button'
          className={cn(ghostButton, '-mr-1.5 w-8 shrink-0 px-0')}
          aria-label='Close outputs'
          onClick={onClose}
        >
          <X className='h-3.5 w-3.5' aria-hidden />
        </button>
      </header>

      {q.isPending ? (
        <div className='space-y-1.5 p-3'>
          <Skeleton className='h-6 w-full' />
          <Skeleton className='h-6 w-2/3' />
        </div>
      ) : q.isError ? (
        <div className='p-3'>
          <QueryErrorState error={q.error} what='the outputs' onRetry={() => void q.refetch()} />
        </div>
      ) : (
        <>
          <ul className='m-0 list-none divide-y divide-slate-100 p-0 dark:divide-border'>
            {q.data.outputs.map((o) => (
              <OutputLine key={o.key} output={o} canDeploy={canDeploy} onRotate={onRotate} />
            ))}
          </ul>

          <div className='border-t border-slate-200 px-3 py-2 dark:border-border'>
            <h6 className='m-0 text-[11px] font-semibold text-slate-600 dark:text-muted-foreground'>
              Where they go
              <span className='ml-1.5 font-normal tabular-nums'>{q.data.bindings.length}</span>
            </h6>
            {q.data.bindings.length === 0 && !adding ? (
              <p className='m-0 mt-1 text-[12px] text-slate-500 dark:text-muted-foreground'>
                Nothing is bound yet.
                {canDeploy
                  ? ' Bind an output to a stack setting, a stack secret or an app setting, and the Hub keeps it filled in.'
                  : ''}
              </p>
            ) : (
              <ul className='m-0 mt-1 list-none space-y-1 p-0'>
                {q.data.bindings.map((b) => (
                  <BindingLine
                    key={b.id}
                    binding={b}
                    outputLabel={labelOf(b.output_key)}
                    canDeploy={canDeploy}
                    busy={save.isPending}
                    onRemove={() =>
                      save.mutate(
                        current.filter(
                          (x) =>
                            !(
                              x.output_key === b.output_key &&
                              x.environment_id === b.environment_id &&
                              x.target === b.target &&
                              x.target_key === b.target_key
                            )
                        )
                      )
                    }
                  />
                ))}
              </ul>
            )}
            {canDeploy &&
              (adding ? (
                <AddBinding
                  outputs={q.data.outputs}
                  environments={environments}
                  appSettings={q.data.app_settings ?? []}
                  idPrefix={idPrefix}
                  busy={save.isPending}
                  onCancel={() => setAdding(false)}
                  onAdd={(b) => save.mutate([...current, b])}
                />
              ) : (
                <button
                  type='button'
                  className={cn(ghostButton, 'mt-1 -ml-2.5')}
                  onClick={() => setAdding(true)}
                  disabled={q.data.outputs.length === 0}
                >
                  <Plus className='h-3.5 w-3.5' aria-hidden /> Bind an output
                </button>
              ))}
          </div>
        </>
      )}
    </section>
  )
}

function OutputLine({
  output: o,
  canDeploy,
  onRotate
}: {
  output: OutputView
  canDeploy: boolean
  onRotate?: () => void
}) {
  return (
    <li className='flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1.5'>
      <KeyRound
        className='h-3.5 w-3.5 shrink-0 text-slate-400 dark:text-muted-foreground'
        aria-hidden
      />
      <span className='min-w-0 flex-[1_1_160px]'>
        <span className='text-[12.5px] font-medium text-slate-900 dark:text-foreground'>
          {o.label}
        </span>
        <span className='ml-1.5 font-mono text-[11px] text-slate-500 dark:text-muted-foreground'>
          {o.key}
        </span>
      </span>
      <span className='flex flex-wrap items-center gap-1'>
        {o.secret && (
          <ToneChip tone='neutral' compact tip='Bound only to secrets and credentials'>
            Secret
          </ToneChip>
        )}
        {o.once_only && (
          <ToneChip
            tone='neutral'
            compact
            tip='The provider shows it only when it is made; the Hub can rotate it, never read it again'
          >
            Shown once
          </ToneChip>
        )}
        {o.lost ? (
          <ToneChip
            tone='warn'
            compact
            tip='The Hub no longer holds it. Rotate it to get a new one.'
          >
            Lost
          </ToneChip>
        ) : o.set ? (
          <ToneChip
            tone='ok'
            compact
            tip={o.updated_at ? `Changed ${formatDateTime(o.updated_at)}` : undefined}
          >
            Held · <span className='font-mono'>{shortPrint(o.fingerprint)}</span>
          </ToneChip>
        ) : (
          <ToneChip tone='neutral' compact tip='The provider has not handed it out yet'>
            Not yet
          </ToneChip>
        )}
      </span>
      <span className='ml-auto flex items-center gap-1'>
        {o.set && o.updated_at && (
          <span className='text-[11px] tabular-nums text-slate-500 dark:text-muted-foreground'>
            {formatRelative(o.updated_at)}
          </span>
        )}
        {canDeploy && o.rotate && o.once_only && onRotate && (
          <button
            type='button'
            className={ghostButton}
            data-tip='Plan a rotation: the provider makes a new one, the Hub seals it and updates every binding'
            onClick={onRotate}
          >
            <RotateCcw className='h-3.5 w-3.5' aria-hidden /> Rotate
          </button>
        )}
      </span>
    </li>
  )
}

function BindingLine({
  binding: b,
  outputLabel,
  canDeploy,
  busy,
  onRemove
}: {
  binding: BindingView
  outputLabel: string
  canDeploy: boolean
  busy: boolean
  onRemove: () => void
}) {
  let status: ReactNode
  if (b.last_error)
    status = (
      <ToneChip tone='down' compact tip={b.last_error}>
        Not written
      </ToneChip>
    )
  else if (!b.last_pushed_at)
    status = (
      <ToneChip tone='live' compact tip='The Hub is writing it now'>
        Writing…
      </ToneChip>
    )
  else if (b.stale)
    status = (
      <ToneChip tone='warn' compact tip='The value changed since it was last written'>
        Out of date
      </ToneChip>
    )
  else if (b.needs_apply)
    status = (
      <ToneChip
        tone='warn'
        compact
        tip='Saved in the stack settings; use Apply now on the environment’s stack to deploy it'
      >
        Needs Apply now
      </ToneChip>
    )
  else
    status = (
      <ToneChip tone='ok' compact tip={formatDateTime(b.last_pushed_at)}>
        Written {formatRelative(b.last_pushed_at)}
      </ToneChip>
    )
  return (
    <li className='rounded-md bg-slate-50 px-2 py-1.5 dark:bg-muted/40'>
      <div className='flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12px]'>
        <span className='font-medium text-slate-800 dark:text-foreground'>{outputLabel}</span>
        <ArrowRight className='h-3 w-3 shrink-0 text-slate-400' aria-hidden />
        <span className='text-slate-600 dark:text-slate-300'>
          {b.environment_key ?? `#${b.environment_id}`}
        </span>
        <span className='text-slate-400'>·</span>
        <span className='text-slate-600 dark:text-slate-300'>{TARGET_LABEL[b.target]}</span>
        <span className='break-all font-mono text-[11.5px] text-slate-800 dark:text-foreground'>
          {b.target_key}
        </span>
        <span className='ml-auto flex items-center gap-1'>
          {status}
          {canDeploy && (
            <ConfirmButton
              title={`Stop writing ${b.target_key}`}
              confirmLabel='Remove?'
              className={cn(dangerGhost, 'h-7 px-1.5')}
              armedClassName={dangerArmed}
              disabled={busy}
              onConfirm={onRemove}
            >
              <Trash2 className='h-3.5 w-3.5' aria-hidden />
              <span className='sr-only'>Remove</span>
            </ConfirmButton>
          )}
        </span>
      </div>
      {b.last_error && (
        <p className='m-0 mt-1 text-[11.5px] text-red-700 dark:text-red-300'>{b.last_error}</p>
      )}
    </li>
  )
}

const TARGETS: BindingTarget[] = ['stack_secret', 'stack_setting', 'app_setting']

function AddBinding({
  outputs,
  environments,
  appSettings,
  idPrefix,
  busy,
  onCancel,
  onAdd
}: {
  outputs: OutputView[]
  environments: Array<Pick<HubEnvironment, 'id' | 'key'>>
  appSettings: string[]
  idPrefix: string
  busy: boolean
  onCancel: () => void
  onAdd: (b: BindingInput) => void
}) {
  const [output, setOutput] = useState(outputs[0]?.key ?? '')
  const [env, setEnv] = useState(environments[0] ? String(environments[0].id) : '')
  const spec = outputs.find((o) => o.key === output)
  const [target, setTarget] = useState<BindingTarget>(
    spec?.secret ? 'stack_secret' : 'stack_setting'
  )
  const [targetKey, setTargetKey] = useState('')
  const allowed = TARGETS.filter((t) => !(t === 'stack_setting' && spec?.secret))
  const effective: BindingTarget = allowed.includes(target) ? target : allowed[0]
  const keyOk =
    effective === 'app_setting'
      ? appSettings.includes(targetKey)
      : /^[A-Z][A-Z0-9_]{0,63}$/.test(targetKey)
  const ready = !!output && !!env && keyOk
  const id = (s: string) => `${idPrefix}-bind-${s}`
  return (
    <form
      className='mt-2 grid grid-cols-1 gap-2 rounded-md border border-slate-200 p-2.5 sm:grid-cols-2 dark:border-border'
      onSubmit={(e) => {
        e.preventDefault()
        if (!ready) return
        onAdd({
          output_key: output,
          environment_id: Number(env),
          target: effective,
          target_key: targetKey.trim()
        })
      }}
    >
      <Field id={id('output')} label='Output'>
        <SimpleSelect
          value={output}
          onChange={setOutput}
          ariaLabel='Output'
          className='h-8 text-[13px]'
          options={outputs.map((o) => ({ value: o.key, label: o.label }))}
        />
      </Field>
      <Field id={id('env')} label='Environment'>
        <SimpleSelect
          value={env}
          onChange={setEnv}
          ariaLabel='Environment'
          className='h-8 text-[13px]'
          options={environments.map((e) => ({ value: String(e.id), label: e.key }))}
        />
      </Field>
      <Field
        id={id('target')}
        label='Write it to'
        hint={
          effective === 'app_setting'
            ? 'Set in the app through its hub link.'
            : 'Saved in the stack settings. The stack needs Apply now to use it; the Hub never deploys on its own.'
        }
      >
        <SimpleSelect
          value={effective}
          onChange={(v) => {
            setTarget(v as BindingTarget)
            setTargetKey('')
          }}
          ariaLabel='Write it to'
          className='h-8 text-[13px]'
          options={allowed.map((t) => ({ value: t, label: TARGET_LABEL[t] }))}
        />
      </Field>
      <Field
        id={id('key')}
        label={effective === 'app_setting' ? 'App setting' : 'Name'}
        hint={
          effective === 'app_setting'
            ? undefined
            : 'Capital letters, digits and _, e.g. DB_PASSWORD.'
        }
      >
        {effective === 'app_setting' ? (
          <SimpleSelect
            value={targetKey}
            onChange={setTargetKey}
            ariaLabel='App setting'
            className='h-8 font-mono text-[13px]'
            options={[
              { value: '', label: 'Pick a setting' },
              ...appSettings.map((k) => ({ value: k, label: k }))
            ]}
          />
        ) : (
          <Input
            id={id('key')}
            value={targetKey}
            onChange={(e) => setTargetKey(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))}
            placeholder={spec?.secret ? 'DB_PASSWORD' : 'PUBLIC_URL'}
            className='h-8 font-mono text-[13px]'
            autoComplete='off'
            spellCheck={false}
          />
        )}
      </Field>
      <div className='flex items-center justify-end gap-1 sm:col-span-2'>
        <button type='button' className={ghostButton} onClick={onCancel}>
          Cancel
        </button>
        <Button type='submit' size='sm' className='h-8' disabled={!ready || busy}>
          {busy ? 'Saving…' : 'Bind'}
        </Button>
      </div>
    </form>
  )
}

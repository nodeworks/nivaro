import { ErrorNotice } from '@nivaro/shared'
import { Check, Copy, KeyRound, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SimpleSelect } from '@/components/ui/simple-select'
import { cn } from '@/lib/utils'
import { hubError } from '../hub-api'
import { Field, ghostButton, SecretInput } from '../hub-parts'
import {
  type DnsMode,
  type DockerDraft,
  dockerDraftErrors,
  generateAgentToken,
  MULTI_NODE_VOLUMES_TEXT,
  multiNodeLocal,
  useAgentCheck
} from './docker-api'

/**
 * The fields of a Docker driver (Hub admins): the Hub agent's address, how a new stack name
 * reaches the edge (automatic wildcard DNS or manual), and the agent token — generated here,
 * shown until the person confirms they saved it (or leaves the page), then only as a mask.
 */

export const TOKEN_ONCE_LINE = "Put this in the agent's token secret now — it is never shown again"

export function DockerDriverFields({
  idPrefix,
  draft,
  onChange,
  token,
  onTokenChange,
  tokenStored,
  fresh,
  onFresh,
  tried
}: {
  idPrefix: string
  draft: DockerDraft
  onChange: (patch: Partial<DockerDraft>) => void
  token: string
  onTokenChange: (v: string) => void
  /** Whether a token is stored now (the field starts at the mask). */
  tokenStored: boolean
  /** The freshly generated token, held by the page (so it survives the create → edit remount). */
  fresh: string | null
  onFresh: (token: string | null) => void
  tried: boolean
}) {
  const errors = dockerDraftErrors(draft)
  const shown = (k: keyof typeof errors) => (tried ? errors[k] || null : null)
  const [copied, setCopied] = useState(false)

  const generate = () => {
    const t = generateAgentToken()
    onFresh(t)
    setCopied(false)
    onTokenChange(t)
  }
  const copy = () => {
    if (!navigator.clipboard) {
      toast.error('Select it and copy by hand')
      return
    }
    void navigator.clipboard
      .writeText(fresh ?? '')
      .then(() => setCopied(true))
      .catch(() => toast.error('Select it and copy by hand'))
  }

  return (
    <>
      <div className='sm:col-span-2'>
        <Field
          id={`${idPrefix}-agent`}
          label='Agent URL'
          error={shown('agent_url')}
          hint='Where the Hub agent on the swarm manager answers.'
        >
          <Input
            id={`${idPrefix}-agent`}
            value={draft.agent_url}
            onChange={(e) => onChange({ agent_url: e.target.value })}
            placeholder='https://swarm.example.com:8443'
            inputMode='url'
            className='h-8 text-[13px]'
          />
        </Field>
      </div>
      <Field
        id={`${idPrefix}-dns`}
        label='DNS mode'
        hint={
          draft.dns_mode === 'automatic'
            ? 'A wildcard DNS name already points at the edge, so new names work at once.'
            : 'Someone adds a DNS record for each new name; the Hub tells you which.'
        }
      >
        <SimpleSelect
          value={draft.dns_mode}
          onChange={(v) => onChange({ dns_mode: v as DnsMode })}
          options={[
            { value: 'automatic', label: 'Automatic (wildcard DNS)' },
            { value: 'manual', label: 'Manual (add each name)' }
          ]}
          ariaLabel='DNS mode'
          className='h-8 text-[13px]'
          triggerProps={{ id: `${idPrefix}-dns` }}
        />
      </Field>
      {draft.dns_mode === 'automatic' ? (
        <Field
          id={`${idPrefix}-wildcard`}
          label='Wildcard domain'
          error={shown('wildcard_domain')}
          hint='Every stack name ends with this.'
        >
          <Input
            id={`${idPrefix}-wildcard`}
            value={draft.wildcard_domain}
            onChange={(e) => onChange({ wildcard_domain: e.target.value })}
            placeholder='apps.example.com'
            className='h-8 font-mono text-[13px]'
          />
        </Field>
      ) : (
        <Field
          id={`${idPrefix}-edge`}
          label='Edge target'
          error={shown('edge_target')}
          hint='What each new name must point at.'
        >
          <Input
            id={`${idPrefix}-edge`}
            value={draft.edge_target}
            onChange={(e) => onChange({ edge_target: e.target.value })}
            placeholder='edge.example.com'
            className='h-8 font-mono text-[13px]'
          />
        </Field>
      )}
      <div className='sm:col-span-2'>
        <Field
          id={`${idPrefix}-token`}
          label='Agent token'
          hint={
            tokenStored && !fresh
              ? 'Stored sealed. Leave as is to keep it; Generate makes a new one.'
              : 'The shared secret between the Hub and the agent. Stored sealed.'
          }
        >
          <div className='flex flex-wrap items-center gap-2'>
            <div className='min-w-[12rem] flex-1'>
              <SecretInput
                id={`${idPrefix}-token`}
                value={token}
                onChange={(v) => {
                  onFresh(null)
                  onTokenChange(v)
                }}
                stored={tokenStored}
              />
            </div>
            <button
              type='button'
              className={ghostButton}
              data-tip='Make a new random token'
              onClick={generate}
            >
              <KeyRound className='h-3.5 w-3.5' aria-hidden /> Generate
            </button>
          </div>
        </Field>
        {fresh && (
          <div
            role='status'
            className='mt-2 space-y-1.5 rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-500/40 dark:bg-amber-950/30'
          >
            <p className='m-0 text-[12px] font-medium text-amber-900 dark:text-amber-200'>
              {TOKEN_ONCE_LINE}
            </p>
            <div className='flex flex-wrap items-center gap-2'>
              <code
                data-testid='generated-token'
                className='min-w-0 flex-1 break-all rounded bg-white px-2 py-1 font-mono text-[12px] text-slate-900 dark:bg-card dark:text-foreground'
              >
                {fresh}
              </code>
              <button type='button' className={ghostButton} onClick={copy}>
                {copied ? (
                  <Check className='h-3.5 w-3.5' aria-hidden />
                ) : (
                  <Copy className='h-3.5 w-3.5' aria-hidden />
                )}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <button type='button' className={ghostButton} onClick={() => onFresh(null)}>
              I've saved it
            </button>
          </div>
        )}
      </div>
    </>
  )
}

/** "Check agent": asks the saved agent about itself and shows its version, edge and allow-lists. */
export function AgentCheck({ driverId, dirty }: { driverId: number; dirty: boolean }) {
  const q = useAgentCheck(driverId)
  const h = q.data
  return (
    <div className='space-y-2'>
      <div className='flex flex-wrap items-center gap-2'>
        <Button
          size='sm'
          variant='outline'
          className='h-8'
          disabled={q.isFetching}
          onClick={() => void q.refetch()}
        >
          <RefreshCw
            className={cn('mr-1.5 h-3.5 w-3.5', q.isFetching && 'animate-spin')}
            aria-hidden
          />
          {q.isFetching ? 'Checking…' : 'Check agent'}
        </Button>
        {dirty && (
          <span className='text-[11px] text-slate-500 dark:text-muted-foreground'>
            Checks the saved driver. Save your changes first to check them.
          </span>
        )}
      </div>
      {q.isError && (
        <ErrorNotice
          description={hubError(q.error, 'The Hub agent could not be checked')}
          onRetry={() => void q.refetch()}
        />
      )}
      {h && (
        <dl className='m-0 grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 text-[12px] sm:grid-cols-2 dark:border-border dark:bg-border'>
          <AgentFact label='Agent version' value={h.agent_version} />
          <AgentFact
            label='Edge mode'
            value={h.edge === 'traefik' ? 'Traefik (host names)' : 'Published ports'}
          />
          <AgentFact label='Allowed images' value={h.images.length ? h.images : 'None'} mono />
          <AgentFact
            label='Host name suffixes'
            value={h.host_suffixes.length ? h.host_suffixes : 'None'}
            mono
          />
          {h.publish_ports && (
            <AgentFact
              label='Publish ports'
              value={`${h.publish_ports[0]}–${h.publish_ports[1]}`}
            />
          )}
          {typeof h.swarm?.nodes === 'number' && (
            <AgentFact label='Swarm nodes' value={String(h.swarm.nodes)} />
          )}
          {h.volume_driver && <AgentFact label='Volume driver' value={h.volume_driver} mono />}
        </dl>
      )}
      {h && multiNodeLocal(h) && (
        <p role='status' className='m-0 text-[12px] text-amber-700 dark:text-amber-400'>
          {MULTI_NODE_VOLUMES_TEXT}
        </p>
      )}
    </div>
  )
}

function AgentFact({
  label,
  value,
  mono
}: {
  label: string
  /** A list shows one entry per line. */
  value: string | string[]
  mono?: boolean
}) {
  return (
    <div className='min-w-0 bg-white px-3 py-2 dark:bg-card'>
      <dt className='text-[11px] text-slate-500 dark:text-muted-foreground'>{label}</dt>
      <dd
        className={
          mono
            ? 'm-0 break-all font-mono text-slate-900 dark:text-foreground'
            : 'm-0 text-slate-900 dark:text-foreground'
        }
      >
        {Array.isArray(value)
          ? value.map((v) => (
              <span key={v} className='block'>
                {v}
              </span>
            ))
          : value}
      </dd>
    </div>
  )
}

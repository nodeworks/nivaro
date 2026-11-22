import { ConfirmButton, type ErrorDescription, ErrorNotice } from '@nivaro/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { HUB_MASK } from '../hub-api'
import { dangerArmed, dangerGhost, Field, SecretInput } from '../hub-parts'
import {
  type DbEngine,
  type DbServer,
  dbError,
  dbKeys,
  dbToast,
  describeFailure,
  ENGINE_LABEL,
  ENGINE_PORT,
  MODE_LABEL,
  type ProvisionMode,
  probeWords,
  type ServerProbe,
  SSL_LABEL,
  type SslMode
} from './db-api'

/**
 * One database server: where it is, how its databases get made (automatic = the Hub creates them
 * with a provisioning login, manual = a DBA does) and how the Hub reaches it. The provisioning
 * login is two values, user + password; both come back as the mask and stay stored while left
 * alone. Test connects with the saved login and says what it may do in words.
 */
export function DbServerForm({
  server,
  onSaved,
  onCancel,
  onDeleted
}: {
  server: DbServer | null
  onSaved: (id: number) => void
  onCancel: () => void
  onDeleted?: () => void
}) {
  const qc = useQueryClient()
  const stored = !!server?.admin_secret
  const [name, setName] = useState(server?.name ?? '')
  const [engine, setEngine] = useState<DbEngine>(server?.engine ?? 'mssql')
  const [host, setHost] = useState(server?.host ?? '')
  const [port, setPort] = useState(server?.port != null ? String(server.port) : '')
  const [mode, setMode] = useState<ProvisionMode>(server?.provision_mode ?? 'manual')
  const [ssl, setSsl] = useState<SslMode | ''>(server?.ssl_mode ?? '')
  const [trust, setTrust] = useState(server?.trust_server_cert ?? false)
  const [collation, setCollation] = useState(server?.collation ?? '')
  const [userHost, setUserHost] = useState(server?.user_host ?? '')
  const [notes, setNotes] = useState(server?.notes ?? '')
  const [loginUser, setLoginUser] = useState(stored ? HUB_MASK : '')
  const [loginPass, setLoginPass] = useState(stored ? HUB_MASK : '')
  const [tried, setTried] = useState(false)
  const [failure, setFailure] = useState<ErrorDescription | null>(null)
  const [probe, setProbe] = useState<ServerProbe | null>(null)

  const isMy = engine === 'mysql2' || engine === 'mariadb'
  const loginTouched =
    loginUser !== (stored ? HUB_MASK : '') || loginPass !== (stored ? HUB_MASK : '')
  const portNum = port.trim() === '' ? null : Number(port)
  // A change of where the login connects needs the login typed again (the API refuses otherwise).
  const moved =
    !!server &&
    stored &&
    !loginTouched &&
    (engine !== server.engine ||
      host.trim().toLowerCase() !== server.host.toLowerCase() ||
      (portNum ?? ENGINE_PORT[engine]) !== (server.port ?? ENGINE_PORT[server.engine]) ||
      (ssl || null) !== server.ssl_mode ||
      trust !== server.trust_server_cert)

  const errors = {
    name: name.trim() ? '' : 'Give the server a name',
    host: host.trim() ? '' : 'The host name or IP address',
    port:
      portNum === null || (Number.isInteger(portNum) && portNum >= 1 && portNum <= 65535)
        ? ''
        : 'A whole number from 1 to 65535',
    login:
      loginTouched && (loginUser === HUB_MASK || loginPass === HUB_MASK)
        ? 'Type both the user and the password again, or leave both as they are'
        : moved
          ? 'The address or TLS setting changed: type the user and the password again'
          : mode === 'automatic' && (!stored || loginTouched) && !(loginUser.trim() && loginPass)
            ? 'An automatic server needs a user and a password'
            : loginTouched && !!loginUser.trim() !== !!loginPass
              ? 'Type both the user and the password, or clear both'
              : ''
  }
  const invalid = Object.values(errors).some(Boolean)

  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {
        name: name.trim(),
        engine,
        host: host.trim(),
        port: portNum,
        provision_mode: mode,
        ssl_mode: ssl || null,
        trust_server_cert: trust,
        collation: engine === 'mssql' ? collation.trim() || null : null,
        user_host: isMy ? userHost.trim() || null : null,
        notes: notes.trim() || null
      }
      // Untouched = the mask (the stored login stays); cleared = null; typed = the new pair.
      if (loginTouched)
        body.admin_secret =
          !loginUser.trim() && !loginPass ? null : { user: loginUser.trim(), password: loginPass }
      else if (stored) body.admin_secret = HUB_MASK
      return (
        server
          ? api
              .patch<{ data: DbServer }>(`/hub/db-servers/${server.id}`, body)
              .then((r) => r.data.data)
          : api.post<{ data: DbServer }>('/hub/db-servers', body).then((r) => r.data.data)
      ).catch(describeFailure('Could not save the server'))
    },
    onSuccess: (saved) => {
      setFailure(null)
      setProbe(null)
      if (loginTouched) {
        const has = !!(loginUser.trim() && loginPass)
        setLoginUser(has ? HUB_MASK : '')
        setLoginPass(has ? HUB_MASK : '')
      }
      void qc.invalidateQueries({ queryKey: dbKeys.servers() })
      onSaved(saved?.id ?? server?.id ?? 0)
    },
    onError: (err) => setFailure(dbError(err, 'Could not save the server'))
  })

  const test = useMutation({
    mutationFn: () =>
      api
        .post<{ data: ServerProbe }>(`/hub/db-servers/${server?.id}/test`, {})
        .then((r) => r.data.data)
        .catch(describeFailure('Could not test the server')),
    onSuccess: (p) => setProbe(p),
    onError: (err) => dbToast(err, 'Could not test the server')
  })

  const remove = useMutation({
    mutationFn: () =>
      api
        .delete(`/hub/db-servers/${server?.id}`)
        .catch(describeFailure('Could not delete the server')),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: dbKeys.servers() })
      void qc.invalidateQueries({ queryKey: dbKeys.databases() })
      onDeleted?.()
    },
    onError: (err) => dbToast(err, 'Could not delete the server')
  })

  const id = (f: string) => `hub-dbserver-${server?.id ?? 'new'}-${f}`
  const words = probe ? probeWords(probe) : null
  return (
    <div className='p-4 sm:p-6'>
      <div className='max-w-[760px] space-y-5'>
        <div className='flex flex-wrap items-start gap-3'>
          <h2 className='m-0 min-w-0 flex-1 truncate text-[18px] font-semibold tracking-[-0.015em] text-slate-900 dark:text-foreground'>
            {server ? server.name : 'New database server'}
          </h2>
          {server && (
            <ConfirmButton
              title='Delete server'
              confirmLabel='Delete this server?'
              className={dangerGhost}
              armedClassName={dangerArmed}
              disabled={remove.isPending}
              onConfirm={() => remove.mutate()}
            >
              <Trash2 className='h-3.5 w-3.5' aria-hidden /> Delete
            </ConfirmButton>
          )}
        </div>

        <div className='grid grid-cols-1 gap-4 rounded-lg border border-slate-200 bg-white p-4 sm:grid-cols-2 dark:border-border dark:bg-card'>
          <Field id={id('name')} label='Name' error={tried ? errors.name : null}>
            <Input
              id={id('name')}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder='Shared SQL Server'
              className='h-8 text-[13px]'
            />
          </Field>
          <Field id={id('engine')} label='Engine'>
            <SimpleSelect
              value={engine}
              onChange={(v) => setEngine(v as DbEngine)}
              options={(Object.keys(ENGINE_LABEL) as DbEngine[]).map((e) => ({
                value: e,
                label: ENGINE_LABEL[e]
              }))}
              ariaLabel='Engine'
              className='h-8 text-[13px]'
              triggerProps={{ id: id('engine') }}
            />
          </Field>
          <Field id={id('host')} label='Host' error={tried ? errors.host : null}>
            <Input
              id={id('host')}
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder='db.example.com'
              className='h-8 font-mono text-[13px]'
            />
          </Field>
          <Field
            id={id('port')}
            label='Port'
            error={tried ? errors.port : null}
            hint={`Empty = ${ENGINE_PORT[engine]}`}
          >
            <Input
              id={id('port')}
              value={port}
              onChange={(e) => setPort(e.target.value)}
              inputMode='numeric'
              placeholder={String(ENGINE_PORT[engine])}
              className='h-8 font-mono text-[13px]'
            />
          </Field>
          <Field
            id={id('mode')}
            label='Databases are made'
            hint={
              mode === 'automatic'
                ? 'The Hub creates the database and its login with the provisioning login below.'
                : 'A DBA makes each database from a checklist; the Hub then checks it.'
            }
          >
            <SimpleSelect
              value={mode}
              onChange={(v) => setMode(v as ProvisionMode)}
              options={(Object.keys(MODE_LABEL) as ProvisionMode[]).map((m) => ({
                value: m,
                label: MODE_LABEL[m]
              }))}
              ariaLabel='Databases are made'
              className='h-8 text-[13px]'
              triggerProps={{ id: id('mode') }}
            />
          </Field>
          <Field id={id('ssl')} label='TLS'>
            <SimpleSelect
              value={ssl}
              onChange={(v) => setSsl(v as SslMode | '')}
              options={[
                { value: '', label: 'Engine default' },
                ...(Object.keys(SSL_LABEL) as SslMode[]).map((m) => ({
                  value: m,
                  label: SSL_LABEL[m]
                }))
              ]}
              ariaLabel='TLS'
              className='h-8 text-[13px]'
              triggerProps={{ id: id('ssl') }}
            />
          </Field>
          {engine === 'mssql' && (
            <>
              <Field
                id={id('trust')}
                label='Trust the server certificate'
                hint='For a self-signed certificate. Leave off when it is signed by a CA.'
              >
                <div>
                  <Switch
                    id={id('trust')}
                    checked={trust}
                    onCheckedChange={setTrust}
                    aria-label='Trust the server certificate'
                  />
                </div>
              </Field>
              <Field
                id={id('collation')}
                label='Collation'
                hint='For new databases. Empty = SQL_Latin1_General_CP1_CI_AS.'
              >
                <Input
                  id={id('collation')}
                  value={collation}
                  onChange={(e) => setCollation(e.target.value)}
                  placeholder='SQL_Latin1_General_CP1_CI_AS'
                  className='h-8 font-mono text-[13px]'
                />
              </Field>
            </>
          )}
          {isMy && (
            <Field
              id={id('userhost')}
              label='Login host'
              hint='Where the database login may connect from. Empty = %.'
            >
              <Input
                id={id('userhost')}
                value={userHost}
                onChange={(e) => setUserHost(e.target.value)}
                placeholder='%'
                className='h-8 font-mono text-[13px]'
              />
            </Field>
          )}
          <div className='sm:col-span-2'>
            <p className='m-0 mb-2 text-[12px] font-medium text-slate-700 dark:text-foreground'>
              Provisioning login{mode === 'automatic' ? '' : ' (optional)'}
            </p>
            <div className='grid grid-cols-1 gap-4 sm:grid-cols-2'>
              <Field id={id('login-user')} label='User' error={tried ? errors.login : null}>
                <Input
                  id={id('login-user')}
                  value={loginUser}
                  onChange={(e) => setLoginUser(e.target.value)}
                  autoComplete='off'
                  spellCheck={false}
                  onFocus={(e) => {
                    if (stored && loginUser === HUB_MASK) e.currentTarget.select()
                  }}
                  className='h-8 font-mono text-[13px]'
                />
              </Field>
              <Field
                id={id('login-pass')}
                label='Password'
                hint={
                  stored
                    ? 'Stored sealed. Leave as is to keep it; clear both to remove the login.'
                    : 'Stored sealed; never shown again.'
                }
              >
                <SecretInput
                  id={id('login-pass')}
                  value={loginPass}
                  onChange={setLoginPass}
                  stored={stored}
                />
              </Field>
            </div>
            {moved && (
              <p className='m-0 mt-2 text-[12px] text-amber-700 dark:text-amber-400'>
                The address or TLS setting changed: the saved login is not sent there. Type the user
                and password again.
              </p>
            )}
          </div>
          <div className='sm:col-span-2'>
            <Field id={id('notes')} label='Notes'>
              <Textarea
                id={id('notes')}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                className='text-[13px]'
              />
            </Field>
          </div>
        </div>

        {failure != null && <ErrorNotice description={failure} />}

        {words && probe && (
          <div
            role='status'
            className={
              words.good
                ? 'rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-[12px] text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300'
                : 'rounded-lg border border-amber-200 bg-amber-50 p-3 text-[12px] text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200'
            }
          >
            <p className='m-0 font-medium'>{words.title}</p>
            {words.hint && <p className='m-0 mt-0.5'>{words.hint}</p>}
            {probe.missing.length > 0 && (
              <ul className='m-0 mt-1.5 list-disc pl-5'>
                {probe.missing.map((m) => (
                  <li key={m}>Missing right: {m}</li>
                ))}
              </ul>
            )}
            {probe.text && probe.text !== 'manual' && !words.good && (
              <details className='mt-1.5'>
                <summary className='cursor-pointer'>Details for support</summary>
                <p className='m-0 mt-1 break-words font-mono text-[11px]'>{probe.text}</p>
              </details>
            )}
          </div>
        )}

        <div className='flex flex-wrap items-center gap-2'>
          <Button
            size='sm'
            className='h-8 bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
            disabled={save.isPending}
            onClick={() => {
              setTried(true)
              if (!invalid) save.mutate()
            }}
          >
            {save.isPending ? 'Saving…' : server ? 'Save' : 'Add server'}
          </Button>
          {server && (
            <Button
              size='sm'
              variant='outline'
              className='h-8'
              disabled={test.isPending}
              onClick={() => test.mutate()}
              data-tip='Connects with the saved login. Save first if you changed anything.'
            >
              {test.isPending ? 'Testing…' : 'Test'}
            </Button>
          )}
          <Button size='sm' variant='ghost' className='h-8' onClick={onCancel}>
            {server ? 'Close' : 'Cancel'}
          </Button>
        </div>
      </div>
    </div>
  )
}

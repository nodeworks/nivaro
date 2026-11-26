import { ConfirmButton, ErrorNotice, QueryErrorState } from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Archive, ArchiveRestore, Download, FileUp, Plus, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { HubToolbar } from '@/components/hub-page'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useAuth } from '@/lib/auth'
import { cn, formatDate, formatFileSize } from '@/lib/utils'
import { dangerArmed, dangerGhost, Field, ghostButton } from '../hub-parts'
import {
  countsLine,
  deleteTemplate,
  downloadTemplate,
  fetchTemplates,
  type HubTemplate,
  patchTemplate,
  reviewLines,
  TEMPLATE_MAX_BYTES,
  templateError,
  templateKeys,
  templateToast,
  uploadTemplate
} from './templates-api'

/**
 * Templates (Apps hub tab, administrators; Hub enhancement 24): the App Blueprints Create app can
 * install into a new app. Upload an export (Promotion → Blueprints → Export or Publish in any app)
 * with a name, description and version; edit the words, archive (leaves Create app), download, or
 * delete one no creation used.
 */
export default function HubTemplatesTab() {
  const { user } = useAuth()
  const isAdmin = !!(user as { is_admin?: boolean } | null)?.is_admin
  if (!isAdmin)
    return (
      <div className='flex flex-1 items-center justify-center bg-slate-50 p-8 text-center dark:bg-background'>
        <p className='m-0 max-w-[48ch] text-[13px] text-slate-600 dark:text-muted-foreground'>
          Only administrators manage app templates.
        </p>
      </div>
    )
  return <HubTemplates />
}

export function HubTemplates() {
  const [showArchived, setShowArchived] = useState(false)
  const [picked, setPicked] = useState<number | 'new' | null>(null)
  const list = useQuery({
    queryKey: templateKeys.list(showArchived),
    queryFn: () => fetchTemplates(showArchived)
  })
  const current = picked === 'new' ? null : (list.data?.find((t) => t.id === picked) ?? null)

  return (
    <section aria-label='App templates' className='flex flex-1 min-h-0 flex-col'>
      <HubToolbar
        description={
          <>
            A template is an App Blueprint (schema, workflows, layouts, queues and rules, never
            data). Pick one on Create app and the Hub installs it into every new environment once
            its first administrator exists.
            {list.data && (
              <span className='tabular-nums text-slate-500 dark:text-muted-foreground'>
                {' '}
                {list.data.length} {list.data.length === 1 ? 'template' : 'templates'}.
              </span>
            )}
          </>
        }
        actions={
          <>
            <div className='flex items-center gap-1.5 text-[12px] text-slate-600 dark:text-muted-foreground'>
              <Switch
                checked={showArchived}
                onCheckedChange={setShowArchived}
                id='hub-templates-archived'
              />
              <label htmlFor='hub-templates-archived'>Show archived</label>
            </div>
            <button
              type='button'
              aria-pressed={picked === 'new'}
              className={cn(ghostButton, picked === 'new' && 'bg-accent')}
              onClick={() => setPicked('new')}
            >
              <Plus className='h-3.5 w-3.5' aria-hidden /> Upload template
            </button>
          </>
        }
      />

      <div className='relative min-h-0 flex-1 overflow-y-auto bg-slate-50 dark:bg-background'>
        <div className='space-y-4 p-4 pb-20 sm:p-6'>
          {picked === 'new' && (
            <UploadForm onClose={() => setPicked(null)} onSaved={(id) => setPicked(id)} />
          )}
          {list.isPending ? (
            <div className='grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3'>
              {[0, 1].map((i) => (
                <Skeleton key={i} className='h-20 w-full' />
              ))}
            </div>
          ) : list.isError ? (
            <QueryErrorState
              error={list.error}
              what='the templates'
              onRetry={() => void list.refetch()}
            />
          ) : list.data.length === 0 ? (
            picked !== 'new' && (
              <p className='m-0 rounded-lg border border-dashed border-slate-300 px-4 py-6 text-center text-[12px] text-slate-500 dark:border-border dark:text-muted-foreground'>
                No templates yet. Upload an App Blueprint export to offer it on Create app.
              </p>
            )
          ) : (
            <ul className='m-0 grid list-none grid-cols-1 gap-2 p-0 sm:grid-cols-2 xl:grid-cols-3'>
              {list.data.map((t) => (
                <li key={t.id}>
                  <TemplateCard
                    template={t}
                    active={t.id === picked}
                    onSelect={() => setPicked(t.id === picked ? null : t.id)}
                  />
                </li>
              ))}
            </ul>
          )}
          {current && (
            <TemplateDetail key={current.id} template={current} onClose={() => setPicked(null)} />
          )}
        </div>
      </div>
    </section>
  )
}

function TemplateCard({
  template,
  active,
  onSelect
}: {
  template: HubTemplate
  active: boolean
  onSelect: () => void
}) {
  return (
    <button
      type='button'
      onClick={onSelect}
      aria-current={active ? 'true' : undefined}
      className={cn(
        'w-full rounded-lg border px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50',
        active
          ? 'border-nvr-cyan/60 bg-accent dark:bg-nvr-cyan/10'
          : 'border-slate-200 bg-white hover:bg-muted dark:border-border dark:bg-card'
      )}
    >
      <span className='flex items-center gap-2'>
        <span className='min-w-0 flex-1 truncate text-[13px] font-medium text-slate-900 dark:text-foreground'>
          {template.name}
        </span>
        <span className='shrink-0 rounded-full border border-slate-200 px-1.5 py-px font-mono text-[10px] text-slate-600 dark:border-border dark:text-slate-300'>
          {template.version}
        </span>
        {template.used > 0 && (
          <span
            data-tip={`Installed into ${template.used} ${template.used === 1 ? 'environment' : 'environments'}`}
            className='shrink-0 rounded-full bg-nvr-cyan/10 px-1.5 py-px text-[10px] font-medium text-slate-700 dark:text-slate-200'
          >
            In use · {template.used}
          </span>
        )}
        {template.archived && (
          <span className='shrink-0 rounded-full bg-slate-100 px-1.5 py-px text-[10px] font-medium text-slate-600 dark:bg-muted dark:text-slate-300'>
            Archived
          </span>
        )}
      </span>
      {template.description && (
        <span className='mt-0.5 block truncate text-[12px] text-slate-600 dark:text-muted-foreground'>
          {template.description}
        </span>
      )}
      <span className='mt-0.5 block text-[11px] text-slate-500 dark:text-muted-foreground'>
        {countsLine(template.manifest)}
      </span>
    </button>
  )
}

/** A picked file's text (FileReader: older browsers and jsdom have no Blob.text). */
function readText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result ?? ''))
    r.onerror = () => reject(r.error)
    r.readAsText(file)
  })
}

function UploadForm({ onClose, onSaved }: { onClose: () => void; onSaved: (id: number) => void }) {
  const qc = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)
  const [bundle, setBundle] = useState<unknown>(null)
  const [fileName, setFileName] = useState('')
  const [fileFacts, setFileFacts] = useState('')
  const [readError, setReadError] = useState('')
  const [name, setName] = useState('')
  const [version, setVersion] = useState('')
  const [description, setDescription] = useState('')

  const upload = useMutation({
    mutationFn: () =>
      uploadTemplate({
        bundle,
        name: name.trim() || undefined,
        version: version.trim() || undefined,
        description: description.trim()
      }),
    onSuccess: (t) => {
      void qc.invalidateQueries({ queryKey: templateKeys.all() })
      toast.success(`${t.name} ${t.version} is in the library`)
      onSaved(t.id)
    }
  })

  async function pick(file: File | undefined) {
    setReadError('')
    setBundle(null)
    setFileFacts('')
    if (!file) return
    setFileName(file.name)
    // Review L8: say so before reading a file the Hub would refuse anyway.
    if (file.size > TEMPLATE_MAX_BYTES) {
      setReadError(
        `This file is ${formatFileSize(file.size)}; a template is at most ${formatFileSize(TEMPLATE_MAX_BYTES)}. Export fewer collections.`
      )
      return
    }
    try {
      const parsed = JSON.parse(await readText(file)) as Record<string, unknown>
      const m = (parsed?.manifest ?? null) as Record<string, unknown> | null
      const bp = (parsed?.blueprint ?? parsed) as Record<string, unknown>
      if (bp?.type !== 'nivaro-blueprint') {
        setReadError('This file is not an App Blueprint export.')
        return
      }
      setBundle(parsed)
      const cols = Array.isArray(bp.collections) ? bp.collections.length : 0
      const flows = Array.isArray(bp.workflows) ? bp.workflows.length : 0
      setFileFacts(
        `${formatFileSize(file.size)} · ${cols} ${cols === 1 ? 'collection' : 'collections'} · ${flows} ${flows === 1 ? 'workflow' : 'workflows'}`
      )
      if (!name.trim()) setName(String(m?.name ?? bp.name ?? ''))
      if (!version.trim() && typeof m?.version === 'string') setVersion(m.version)
      if (!description.trim() && typeof m?.description === 'string') setDescription(m.description)
    } catch {
      setReadError('This file is not JSON. Pick the .json file an export downloads.')
    }
  }

  return (
    <div className='space-y-3 rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
      <div className='flex items-center gap-2'>
        <h3 className='m-0 flex-1 text-[13px] font-semibold text-slate-900 dark:text-foreground'>
          Upload a template
        </h3>
        <button type='button' className={ghostButton} onClick={onClose} aria-label='Close'>
          <X className='h-3.5 w-3.5' aria-hidden />
        </button>
      </div>
      <Field
        id='hub-template-file'
        label='App Blueprint export'
        hint='The .json file Promotion → Blueprints → Export or Publish downloads in any app.'
        error={readError || null}
      >
        <div className='relative'>
          <input
            ref={fileRef}
            id='hub-template-file'
            type='file'
            accept='application/json,.json'
            className='sr-only'
            onChange={(e) => void pick(e.target.files?.[0])}
          />
          <button
            type='button'
            onClick={() => fileRef.current?.click()}
            className='flex w-full items-center gap-3 rounded-md border border-dashed border-slate-300 bg-slate-50 px-3 py-3 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:border-border dark:bg-background'
          >
            <FileUp
              className='h-4 w-4 shrink-0 text-slate-500 dark:text-muted-foreground'
              aria-hidden
            />
            <span className='min-w-0 flex-1'>
              <span className='block truncate text-[13px] font-medium text-slate-900 dark:text-foreground'>
                {fileName || 'Pick an export file'}
              </span>
              <span className='block truncate text-[11px] text-slate-500 dark:text-muted-foreground'>
                {fileFacts || (fileName ? 'Not read yet' : 'Nothing picked yet')}
              </span>
            </span>
            {fileName && (
              <span className='shrink-0 text-[12px] text-slate-600 dark:text-muted-foreground'>
                Change
              </span>
            )}
          </button>
        </div>
      </Field>
      <div className='grid grid-cols-1 gap-3 sm:grid-cols-[1fr_160px]'>
        <Field id='hub-template-name' label='Name'>
          <Input
            id='hub-template-name'
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={120}
            className='h-8 text-[13px]'
          />
        </Field>
        <Field id='hub-template-version' label='Version' hint='Like 1.0.0'>
          <Input
            id='hub-template-version'
            value={version}
            onChange={(e) => setVersion(e.target.value)}
            maxLength={40}
            className='h-8 font-mono text-[13px]'
          />
        </Field>
      </div>
      <Field id='hub-template-description' label='Description'>
        <Textarea
          id='hub-template-description'
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={1000}
          rows={2}
          className='text-[13px]'
        />
      </Field>
      {upload.isError && (
        <ErrorNotice description={templateError(upload.error, 'Could not upload the template')} />
      )}
      <div className='flex flex-wrap items-center justify-end gap-2'>
        {(!bundle || !name.trim()) && (
          <p className='m-0 mr-auto text-[11px] text-slate-500 dark:text-muted-foreground'>
            {!bundle ? 'Pick an export file to upload.' : 'Give the template a name.'}
          </p>
        )}
        <Button type='button' variant='outline' size='sm' onClick={onClose}>
          Cancel
        </Button>
        <Button
          type='button'
          size='sm'
          className='bg-nvr-cyan text-white'
          disabled={!bundle || !name.trim() || upload.isPending}
          onClick={() => upload.mutate()}
        >
          {upload.isPending ? 'Uploading…' : 'Upload'}
        </Button>
      </div>
    </div>
  )
}

function TemplateDetail({ template, onClose }: { template: HubTemplate; onClose: () => void }) {
  const qc = useQueryClient()
  const [name, setName] = useState(template.name)
  const [description, setDescription] = useState(template.description ?? '')
  const refresh = () => void qc.invalidateQueries({ queryKey: templateKeys.all() })
  const box = useRef<HTMLDivElement>(null)
  // The detail opens under the cards: bring it into view so a picked card visibly opens something.
  useEffect(() => {
    box.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
  }, [])
  const save = useMutation({
    mutationFn: (patch: { name?: string; description?: string | null; archived?: boolean }) =>
      patchTemplate(template.id, patch),
    onSuccess: (t, patch) => {
      refresh()
      toast.success(
        patch.archived === undefined
          ? 'Template saved'
          : patch.archived
            ? `${t.name} ${t.version} archived: it leaves Create app`
            : `${t.name} ${t.version} is offered on Create app again`
      )
    }
  })
  const remove = useMutation({
    mutationFn: () => deleteTemplate(template.id),
    onSuccess: () => {
      refresh()
      onClose()
    },
    onError: (err) => templateToast(err, 'Could not delete the template')
  })
  const dirty = name.trim() !== template.name || description.trim() !== (template.description ?? '')
  const m = template.manifest
  const removed = reviewLines(m?.review)

  return (
    <div
      ref={box}
      className='scroll-mt-4 space-y-3 rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'
    >
      <div className='flex flex-wrap items-center gap-2'>
        <h3 className='m-0 min-w-0 flex-1 basis-full truncate text-[13px] font-semibold text-slate-900 sm:basis-auto dark:text-foreground'>
          {template.name} <span className='font-mono font-normal'>{template.version}</span>
        </h3>
        <button
          type='button'
          className={ghostButton}
          onClick={() =>
            void downloadTemplate(template).catch((err) =>
              templateToast(err, 'Could not download the template')
            )
          }
        >
          <Download className='h-3.5 w-3.5' aria-hidden /> Download
        </button>
        <button
          type='button'
          className={ghostButton}
          disabled={save.isPending}
          onClick={() => save.mutate({ archived: !template.archived })}
        >
          {template.archived ? (
            <>
              <ArchiveRestore className='h-3.5 w-3.5' aria-hidden /> Restore
            </>
          ) : (
            <>
              <Archive className='h-3.5 w-3.5' aria-hidden /> Archive
            </>
          )}
        </button>
        {template.used > 0 ? (
          <span
            data-tip={`Installed into ${template.used} ${template.used === 1 ? 'environment' : 'environments'}: archive it instead`}
          >
            <button type='button' className={dangerGhost} disabled aria-disabled='true'>
              <Trash2 className='h-3.5 w-3.5' aria-hidden /> Delete
            </button>
          </span>
        ) : (
          <ConfirmButton
            title='Delete template'
            confirmLabel='Delete this template?'
            className={dangerGhost}
            armedClassName={dangerArmed}
            disabled={remove.isPending}
            onConfirm={() => remove.mutate()}
          >
            <Trash2 className='h-3.5 w-3.5' aria-hidden /> Delete
          </ConfirmButton>
        )}
        <button type='button' className={ghostButton} onClick={onClose} aria-label='Close'>
          <X className='h-3.5 w-3.5' aria-hidden />
        </button>
      </div>

      <div className='grid gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 text-[12px] sm:grid-cols-2 xl:grid-cols-4 dark:border-border dark:bg-border'>
        {[
          ['Contents', countsLine(m)],
          ['Exported from', m?.nivaro_version ? `Nivaro ${m.nivaro_version}` : 'Unknown'],
          ['Size', formatFileSize(template.size_bytes)],
          ['Used by', `${template.used} ${template.used === 1 ? 'environment' : 'environments'}`],
          ['Uploaded', template.created_at ? formatDate(template.created_at) : 'Unknown'],
          ['Collections', m?.collections.length ? m.collections.join(', ') : 'None'],
          ['Version', `${template.version} (a new version is a new upload)`],
          ['Digest', template.digest.replace(/^sha256:/, '').slice(0, 12)]
        ].map(([k, v]) => (
          <div key={k} className='bg-white px-3 py-2 dark:bg-card'>
            <div className='text-[11px] text-slate-500 dark:text-muted-foreground'>{k}</div>
            <div className='mt-0.5 break-words text-slate-900 dark:text-foreground'>{v}</div>
          </div>
        ))}
      </div>
      {m?.review && (m.review.transition_actions > 0 || m.review.rules > 0) && (
        <p className='m-0 text-[12px] text-slate-600 dark:text-muted-foreground'>
          Runs on the app once installed:{' '}
          {plural(m.review.transition_actions, 'transition action', 'transition actions')} ·{' '}
          {plural(m.review.rules, 'rule', 'rules')}
        </p>
      )}
      {removed.length > 0 && (
        <div className='rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200'>
          <p className='m-0 font-medium'>Removed on upload</p>
          <ul className='m-0 mt-1 list-disc space-y-0.5 pl-4'>
            {removed.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      )}

      <div className='grid grid-cols-1 gap-3'>
        <Field id={`hub-template-${template.id}-name`} label='Name'>
          <Input
            id={`hub-template-${template.id}-name`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={120}
            className='h-8 text-[13px]'
          />
        </Field>
        <Field id={`hub-template-${template.id}-description`} label='Description'>
          <Textarea
            id={`hub-template-${template.id}-description`}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={1000}
            rows={2}
            className='text-[13px]'
          />
        </Field>
      </div>
      {save.isError && (
        <ErrorNotice description={templateError(save.error, 'Could not save the template')} />
      )}
      <div className='flex justify-end'>
        <Button
          type='button'
          size='sm'
          className='bg-nvr-cyan text-white'
          disabled={!dirty || !name.trim() || save.isPending}
          onClick={() =>
            save.mutate({ name: name.trim(), description: description.trim() || null })
          }
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  )
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

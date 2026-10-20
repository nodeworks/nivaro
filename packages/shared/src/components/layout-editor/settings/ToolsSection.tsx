import { useQuery } from '@tanstack/react-query'
import { ExternalLink } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useNivaroClient } from '../../../context'
import { get } from '../../../lib/commands'
import { cn } from '../../../lib/utils'
import { HistoryPanel } from '../HistoryPanel'
import { useLayoutEditorHost } from '../host'
import { useRoleNames } from '../overview/overview-api'
import { RelationPicker } from '../pickers/relation-picker'
import { PickList, quietText, Setting, smallBtn, useSettingVisible } from './controls'
import type { SectionProps } from './section-props'
import { type RolePreview, useRolePreview } from './settings-api'
import { settingDef } from './settings-registry'

export interface ToolsSectionProps extends SectionProps {
  /** Told when the admin previews as a role, so the canvas can mark hidden / read-only fields. */
  onPreviewRole?: (preview: RolePreview | null) => void
}

export function ToolsSection(props: ToolsSectionProps) {
  const id = Number(props.layout.id)
  return (
    <>
      <PreviewRecordSetting {...props} />
      <PreviewRoleSetting {...props} />
      <SlotSetting k='tool.describe' layoutId={id} />
      <SlotSetting k='tool.ai_review' layoutId={id} />
      <HistorySetting layoutId={id} />
      <DriftSetting layoutId={id} />
    </>
  )
}

function PreviewRecordSetting({ collection, layout }: SectionProps) {
  const host = useLayoutEditorHost()
  const [recordId, setRecordId] = useState<string | null>(null)
  const slug = layout.slug ? String(layout.slug) : null
  const href = recordId
    ? `${host.recordLink(collection, recordId)}${slug ? `?layout=${encodeURIComponent(slug)}` : ''}`
    : null
  return (
    <Setting
      k='tool.preview_record'
      note={
        slug
          ? `The record opens pinned to this layout (?layout=${slug}).`
          : 'Without a link name the record opens on whichever layout it resolves to.'
      }
    >
      <div className='flex flex-wrap items-center gap-1.5'>
        <div className='min-w-[180px] flex-1'>
          <RelationPicker
            relatedCollection={collection}
            value={recordId}
            onChange={(v) => setRecordId(v == null || v === '' ? null : String(v))}
            placeholder='Pick a record…'
          />
        </div>
        <a
          href={href ?? undefined}
          target='_blank'
          rel='noreferrer'
          aria-disabled={!href}
          data-layout-record-preview-open
          className={cn(smallBtn, !href && 'pointer-events-none opacity-40')}
        >
          <ExternalLink className='h-3.5 w-3.5' />
          Open in a new tab
        </a>
      </div>
    </Setting>
  )
}

/** The summary line the classic editor showed: which layout, how many fields hidden / read-only. */
export function rolePreviewSummary(preview: RolePreview, collection: string): string {
  if (preview.role.admin_access)
    return `As ${preview.role.name}: admin — default layout, every field.`
  if (!preview.can_read) return `As ${preview.role.name}: cannot read ${collection} at all.`
  const parts: string[] = [`gets “${preview.layout?.name ?? 'no layout'}”`]
  const hidden = preview.hidden_fields.length
  const readonly = preview.readonly_fields.length
  if (hidden) parts.push(`${hidden} field${hidden === 1 ? '' : 's'} hidden`)
  if (readonly) parts.push(`${readonly} read-only`)
  if (!preview.can_update) parts.push('cannot edit')
  return `As ${preview.role.name}: ${parts.join(' · ')}`
}

function PreviewRoleSetting({ collection, onPreviewRole }: ToolsSectionProps) {
  const { data: roles = [] } = useRoleNames(true)
  const [roleId, setRoleId] = useState<string | null>(null)
  const { data: preview = null, isFetching } = useRolePreview(collection, roleId)
  const report = useRef(onPreviewRole)
  report.current = onPreviewRole
  useEffect(() => {
    report.current?.(roleId ? preview : null)
  }, [roleId, preview])
  // Leaving Form settings (or the editor) ends the preview: the canvas marks go too.
  useEffect(() => () => report.current?.(null), [])
  return (
    <Setting
      k='tool.preview_as_role'
      control={
        <PickList
          ariaLabel='Preview as role'
          value={roleId}
          options={[...roles]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((r) => ({ value: r.id, label: r.name }))}
          clearLabel='Nobody (off)'
          onChange={setRoleId}
        />
      }
    >
      {roleId && (
        <div
          data-role-preview
          className='rounded-md border border-slate-200 bg-slate-50 p-2 text-[12px] dark:border-border dark:bg-muted/40'
        >
          {isFetching && !preview ? (
            <p className={quietText}>Checking…</p>
          ) : preview ? (
            <>
              <p
                className={cn(
                  'text-slate-700 dark:text-foreground',
                  !preview.can_read && 'text-[#9c2f47] dark:text-[#f08aa1]'
                )}
              >
                {rolePreviewSummary(preview, collection)}
              </p>
              {preview.note && <p className={cn('mt-1', quietText)}>{preview.note}</p>}
            </>
          ) : (
            <p className={quietText}>Could not preview this role.</p>
          )}
        </div>
      )}
    </Setting>
  )
}

/** Admin-only tools the host supplies (AI review, describe); a quiet note when it does not. */
function SlotSetting({ k, layoutId }: { k: 'tool.describe' | 'tool.ai_review'; layoutId: number }) {
  const host = useLayoutEditorHost()
  const node =
    k === 'tool.ai_review'
      ? host.aiReviewSlot?.(layoutId)
      : host.explainSlot?.({
          kind: 'config',
          type: 'layout',
          id: layoutId,
          label: 'Describe this layout'
        })
  return <Setting k={k}>{node ?? <p className={quietText}>Not offered in this app.</p>}</Setting>
}

/** Version history, what changed and restore live in one panel; any of the three keys shows it. */
function HistorySetting({ layoutId }: { layoutId: number }) {
  const history = useSettingVisible('tool.version_history')
  const diff = useSettingVisible('tool.version_diff')
  const restore = useSettingVisible('tool.version_restore')
  if (!history && !diff && !restore) return null
  const def = settingDef('tool.version_history')
  return (
    <div data-setting='tool.version_history' className='py-2.5'>
      <p className='text-[12.5px] font-medium text-slate-800 dark:text-foreground'>{def?.label}</p>
      <p className={cn('mt-0.5', quietText)}>
        {def?.effect} {settingDef('tool.version_diff')?.effect}{' '}
        {settingDef('tool.version_restore')?.effect}
      </p>
      <div className='mt-2'>
        <HistoryPanel layoutId={layoutId} />
      </div>
    </div>
  )
}

interface DriftRow {
  layout_id: number
  warnings: string[]
  since: string | null
}

function DriftSetting({ layoutId }: { layoutId: number }) {
  const client = useNivaroClient()
  const [asked, setAsked] = useState(false)
  const { data, isFetching, isError, refetch } = useQuery<DriftRow[]>({
    queryKey: ['layout-editor', 'drift'],
    queryFn: () =>
      client
        .request<{ data: DriftRow[] }>(get('/collection-layouts/drift'))
        .then((r) => (Array.isArray(r?.data) ? r.data : [])),
    enabled: asked,
    staleTime: 0
  })
  const mine = data?.find((d) => Number(d.layout_id) === layoutId)
  return (
    <Setting
      k='tool.layout_drift'
      control={
        <button
          type='button'
          className={smallBtn}
          disabled={isFetching}
          onClick={() => (asked ? void refetch() : setAsked(true))}
        >
          {isFetching ? 'Checking…' : 'Check now'}
        </button>
      }
    >
      {asked && !isFetching && isError && (
        <p className='text-[12px] text-[#9c2f47] dark:text-[#f08aa1]'>The check failed.</p>
      )}
      {asked && data && !isFetching && (
        <div data-layout-drift className='text-[12px]'>
          {mine ? (
            <ul className='space-y-1'>
              {mine.warnings.map((w) => (
                <li
                  key={w}
                  className='rounded bg-[#fae6eb] px-1.5 py-1 text-[#9c2f47] dark:bg-[#3d1621] dark:text-[#f08aa1]'
                >
                  {w}
                </li>
              ))}
            </ul>
          ) : (
            <p className={quietText}>No drift: the layout matches its last saved version.</p>
          )}
        </div>
      )}
    </Setting>
  )
}

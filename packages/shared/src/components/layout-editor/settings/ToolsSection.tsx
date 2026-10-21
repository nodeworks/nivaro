import { useQuery } from '@tanstack/react-query'
import { ExternalLink } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNivaroClient } from '../../../context'
import { get } from '../../../lib/commands'
import { applyLayoutOps, type LayoutBundle } from '../../../lib/layout-ops'
import { cn } from '../../../lib/utils'
import { AiTextTools } from '../ai-text/AiTextTools'
import { HistoryPanel } from '../HistoryPanel'
import { type LayoutReviewContext, useLayoutEditorHost } from '../host'
import { LayoutOpsBlocks } from '../ops/LayoutOpsBlocks'
import { useRoleNames } from '../overview/overview-api'
import { labelText, tintCard } from '../panel-style'
import { RelationPicker } from '../pickers/relation-picker'
import { CostLimitSetting } from '../testing/CostLimitSetting'
import { humanizeOpError } from '../useLayoutDraft'
import { PickList, quietText, Segmented, Setting, smallBtn, useSettingVisible } from './controls'
import { FreezeSetting } from './ResolveSettings'
import type { SectionProps } from './section-props'
import { type RolePreview, useRolePreview } from './settings-api'
import { settingDef } from './settings-registry'

export interface ToolsSectionProps extends SectionProps {
  /** Told when the admin previews as a role, so the canvas can mark hidden / read-only fields. */
  onPreviewRole?: (preview: RolePreview | null) => void
  /** Shared role choice (FormSettingsProps): followed instead of local state when both are set. */
  previewRoleId?: string | null
  onPreviewRoleChange?: (roleId: string | null) => void
}

export function ToolsSection(props: ToolsSectionProps) {
  const id = Number(props.layout.id)
  return (
    <>
      <PreviewRecordSetting {...props} />
      <PreviewRoleSetting {...props} />
      <SlotSetting k='tool.describe' layoutId={id} />
      <SlotSetting k='tool.ai_review' layoutId={id} bundle={props.bundle} apply={props.apply} />
      <AiTextSetting {...props} />
      <CostLimitSetting {...props} />
      <HistorySetting layoutId={id} />
      <ChangeNoteSetting {...props} />
      <EmailSectionSetting {...props} />
      <FreezeSetting {...props} />
      <DriftSetting layoutId={id} />
      <LayoutOpsBlocks
        collection={props.collection}
        layoutId={id}
        name={String(props.layout.name ?? '')}
      />
    </>
  )
}

const CHANGE_NOTE_LABELS = {
  off: 'Turn off Ask why on every save',
  note: 'Ask for a reason on every save',
  note_ticket: 'Ask for a reason and a ticket on every save'
} as const

/** Required change note (#2654): Save asks for a reason (and a ticket link). */
function ChangeNoteSetting({ layout, set }: SectionProps) {
  const v = layout.change_note
  const value: keyof typeof CHANGE_NOTE_LABELS = v === 'note' || v === 'note_ticket' ? v : 'off'
  return (
    <Setting
      k='layout.change_note'
      control={
        <Segmented
          ariaLabel='Ask why on every save'
          value={value}
          options={[
            { value: 'off', label: 'Off' },
            { value: 'note', label: 'Reason' },
            { value: 'note_ticket', label: 'Reason + ticket' }
          ]}
          onChange={(next) =>
            set({ change_note: next === 'off' ? null : next }, CHANGE_NOTE_LABELS[next])
          }
        />
      }
      note={
        value === 'off'
          ? null
          : 'Autosave stays off for this form: every save waits for its reason.'
      }
    />
  )
}

/** A section as an email body (#2725): which section notification emails summarise the record with. */
function EmailSectionSetting({ bundle, layout, set }: SectionProps) {
  const options = useMemo(
    () =>
      bundle.groups
        .filter(
          (g) =>
            g.parent_key === null &&
            !g.key.startsWith('__') &&
            (g.type === 'section' || g.type === 'container')
        )
        .sort((a, b) => a.sort - b.sort)
        .map((g) => ({ value: g.key, label: g.label || g.key })),
    [bundle.groups]
  )
  const value = typeof layout.email_summary_group === 'string' ? layout.email_summary_group : null
  const name = options.find((o) => o.value === value)?.label
  return (
    <Setting
      k='layout.email_summary_group'
      control={
        <PickList
          ariaLabel='Section for notification emails'
          value={value}
          options={
            value && !name ? [...options, { value, label: `Missing section (${value})` }] : options
          }
          clearLabel='None (header strip)'
          placeholder='None (header strip)'
          emptyText='This form has no sections yet'
          onChange={(next) =>
            set(
              { email_summary_group: next },
              next
                ? `Use ${options.find((o) => o.value === next)?.label ?? next} in emails`
                : 'Use the header strip in emails'
            )
          }
        />
      }
    />
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
          ? `The record opens pinned to this form (?layout=${slug}).`
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

function PreviewRoleSetting({
  collection,
  onPreviewRole,
  previewRoleId,
  onPreviewRoleChange
}: ToolsSectionProps) {
  const { data: roles = [] } = useRoleNames(true)
  const [ownRoleId, setOwnRoleId] = useState<string | null>(null)
  const roleId = onPreviewRoleChange ? (previewRoleId ?? null) : ownRoleId
  const setRoleId = onPreviewRoleChange ?? setOwnRoleId
  const { data: preview = null, isFetching } = useRolePreview(collection, roleId)
  const report = useRef(onPreviewRole)
  report.current = onPreviewRole
  useEffect(() => {
    report.current?.(roleId ? preview : null)
  }, [roleId, preview])
  // Unmounting stops the onPreviewRole reports (canvas marks fed by them go).
  // A shared role (previewRoleId + onPreviewRoleChange) is not ended here:
  // the host owns it and keeps previewing after Form settings closes.
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
        <div data-role-preview className={cn(tintCard, 'p-3 text-[12px]')}>
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
function SlotSetting({
  k,
  layoutId,
  bundle,
  apply
}: {
  k: 'tool.describe' | 'tool.ai_review'
  layoutId: number
  bundle?: LayoutBundle
  apply?: SectionProps['apply']
}) {
  const host = useLayoutEditorHost()
  const ctx = useMemo<LayoutReviewContext | undefined>(
    () =>
      bundle && apply
        ? {
            bundle,
            apply,
            check: (ops) => {
              try {
                applyLayoutOps(bundle, ops)
                return null
              } catch (e) {
                return humanizeOpError(e instanceof Error ? e.message : String(e))
              }
            }
          }
        : undefined,
    [bundle, apply]
  )
  const node =
    k === 'tool.ai_review'
      ? host.aiReviewSlot?.(layoutId, ctx)
      : host.explainSlot?.({
          kind: 'config',
          type: 'layout',
          id: layoutId,
          label: 'Describe this form'
        })
  return <Setting k={k}>{node ?? <p className={quietText}>Not offered in this app.</p>}</Setting>
}

/** AI wording tools (#2677–#2683): admins only, applied through the draft. */
function AiTextSetting({ layout, bundle, collection, apply }: SectionProps) {
  const host = useLayoutEditorHost()
  return (
    <Setting k='tool.ai_text'>
      {host.isAdmin && apply ? (
        <AiTextTools
          layoutId={Number(layout.id)}
          bundle={bundle}
          collection={collection}
          apply={apply}
        />
      ) : (
        <p className={quietText}>Not offered here: administrators only.</p>
      )}
    </Setting>
  )
}

/** Version history, what changed and restore live in one panel; any of the three keys shows it. */
function HistorySetting({ layoutId }: { layoutId: number }) {
  const history = useSettingVisible('tool.version_history')
  const diff = useSettingVisible('tool.version_diff')
  const restore = useSettingVisible('tool.version_restore')
  if (!history && !diff && !restore) return null
  const def = settingDef('tool.version_history')
  return (
    <div data-setting='tool.version_history' className='space-y-1.5'>
      <p className={labelText}>{def?.label}</p>
      <HistoryPanel layoutId={layoutId} />
      <p className={quietText}>
        {def?.effect} {settingDef('tool.version_diff')?.effect}{' '}
        {settingDef('tool.version_restore')?.effect}
      </p>
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
            <p className={quietText}>No drift: the form matches its last saved version.</p>
          )}
        </div>
      )}
    </Setting>
  )
}

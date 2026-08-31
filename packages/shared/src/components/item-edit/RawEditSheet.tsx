import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, ShieldAlert, Wrench } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../context'
import { del, get, patch, post } from '../../lib/commands'
import { titleCase } from '../../lib/utils'
import { Button } from '../ui/button'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '../ui/sheet'
import { ChangeReasonDialog, changeReasonChallenge, type ChangeReasonChallenge } from './ChangeReasonDialog'
import { FieldRenderer } from './FieldRenderer'
import { M2MCombobox, m2aWriteMeta } from './M2MCombobox'
import { M2MStagingContext, type M2MStagingCtx } from './M2MStagingContext'
import type { CMSField, CMSRelation } from './types'

/**
 * Admin-only raw record editor — every PHYSICAL field laid out flat with no
 * conditional logic: visibility rules, lock conditions, layout readonly,
 * cascade filters and field-rule side effects are all bypassed. Inputs keep
 * their proper interfaces (M2O pickers still show friendly labels and pick
 * one record; dates/numbers/selects format normally). Server-side rules
 * (validation, RLS, caps, change-reason) still apply on save — this bypasses
 * the FORM's curation, not the API's enforcement.
 *
 * M2M/M2A aliases edit here too: picks stage into a local map and flush as
 * junction-row creates/deletes on Save (same mechanics as the normal form).
 * O2M aliases stay read-only — their values are full child ROWS, not links.
 */
export function RawEditSheet({
  collection,
  itemId,
  open,
  onClose,
  onSaved
}: {
  collection: string
  itemId: string
  open: boolean
  onClose: () => void
  onSaved?: () => void
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [draft, setDraft] = useState<Record<string, unknown>>({})
  // M2M staging — same shape the full form uses; flushed as junction writes.
  const [m2mLinks, setM2mLinks] = useState<Map<string, unknown[]>>(new Map())
  const [m2mUnlinks, setM2mUnlinks] = useState<Map<string, Set<unknown>>>(new Map())
  const [saving, setSaving] = useState(false)
  const [crChallenge, setCrChallenge] = useState<ChangeReasonChallenge | null>(null)

  const { data: fieldConfig } = useQuery<{ fields: CMSField[]; relations: CMSRelation[] }>({
    queryKey: ['raw-edit-config', collection],
    queryFn: async () => {
      const [fc, col] = await Promise.all([
        client
          .request<{ data: CMSField[] }>(get(`/field-config/${collection}`))
          .then((r) => r.data ?? []),
        client
          .request<{ data: { relations: CMSRelation[] } }>(get(`/collections/${collection}`))
          .then((r) => r.data)
      ])
      return { fields: fc, relations: col.relations ?? [] }
    },
    enabled: open,
    staleTime: 60_000
  })

  const { data: record, isLoading: recordLoading } = useQuery<Record<string, unknown>>({
    queryKey: ['raw-edit-record', collection, itemId],
    queryFn: () =>
      client
        .request<{ data: Record<string, unknown> }>(get(`/items/${collection}/${itemId}`))
        .then((r) => r.data),
    enabled: open,
    staleTime: 0
  })

  const rows = useMemo(() => {
    const fields = fieldConfig?.fields ?? []
    const relations = fieldConfig?.relations ?? []
    const isAlias = (f: CMSField) =>
      relations.some((r) => r.one_collection === collection && r.one_field === f.field)
    return fields
      .filter((f) => !f.field.startsWith('__'))
      .map((f) => ({
        // Strip every conditional/curation config — raw mode ignores them all
        field: {
          ...f,
          hidden: false,
          readonly: false,
          visibility_rules: null,
          lock_condition: null,
          dependency_config: null
        } as CMSField,
        alias: isAlias(f),
        m2mRel: relations.find(
          (r) =>
            r.one_collection === collection && r.one_field === f.field && r.junction_field != null
        )
      }))
      .sort((a, b) => (a.field.sort ?? 0) - (b.field.sort ?? 0))
  }, [fieldConfig, collection])

  const relations = fieldConfig?.relations ?? []
  const findM2MRel = (key: string) =>
    relations.find(
      (r) => r.one_collection === collection && r.one_field === key && r.junction_field != null
    )

  const stagingCtx = useMemo<M2MStagingCtx>(
    () => ({
      getStagedLinks: (k) => m2mLinks.get(k) ?? [],
      getStagedUnlinks: (k) => m2mUnlinks.get(k) ?? new Set(),
      stageLink: (k, id) =>
        setM2mLinks((prev) => {
          const next = new Map(prev)
          next.set(k, [...(next.get(k) ?? []), id])
          return next
        }),
      unstageLink: (k, id) =>
        setM2mLinks((prev) => {
          const next = new Map(prev)
          next.set(k, (next.get(k) ?? []).filter((x) => String(x) !== String(id)))
          return next
        }),
      stageUnlink: (k, jId) =>
        setM2mUnlinks((prev) => {
          const next = new Map(prev)
          const set = new Set(next.get(k) ?? [])
          set.add(jId)
          next.set(k, set)
          return next
        }),
      unstageUnlink: (k, jId) =>
        setM2mUnlinks((prev) => {
          const next = new Map(prev)
          const set = new Set(next.get(k) ?? [])
          set.delete(jId)
          next.set(k, set)
          return next
        })
    }),
    [m2mLinks, m2mUnlinks]
  )

  const hasM2MChanges =
    [...m2mLinks.values()].some((ids) => ids.length > 0) ||
    [...m2mUnlinks.values()].some((ids) => ids.size > 0)
  const dirty = Object.keys(draft).length > 0 || hasM2MChanges

  const doSave = async (changeReason?: string) => {
    setSaving(true)
    try {
      if (Object.keys(draft).length > 0) {
        const payload: Record<string, unknown> = { ...draft }
        if (changeReason) payload._change_reason = changeReason
        await client.request(patch(`/items/${collection}/${itemId}`, payload))
      }
      // Junction flush — deletes then creates, mirroring the full form.
      const m2mOps: Promise<unknown>[] = []
      for (const [key, ids] of m2mUnlinks.entries()) {
        if (!ids.size) continue
        const rel = findM2MRel(key)
        if (!rel) continue
        for (const jId of ids)
          m2mOps.push(client.request(del(`/items/${rel.many_collection}/${jId}`)).catch(() => {}))
      }
      for (const [key, ids] of m2mLinks.entries()) {
        if (!ids.length) continue
        const rel = findM2MRel(key)
        if (!rel) continue
        const companion = relations.find(
          (c) =>
            c.many_collection === rel.many_collection &&
            c.many_field === rel.junction_field &&
            c.id !== rel.id
        )
        const m2a = m2aWriteMeta(companion)
        const extra = m2a ? { [m2a.field]: m2a.value } : {}
        for (const relId of ids)
          m2mOps.push(
            client
              .request(
                post(`/items/${rel.many_collection}`, {
                  [rel.many_field ?? '']: itemId,
                  [rel.junction_field ?? '']: relId,
                  ...extra
                })
              )
              .catch(() => {})
          )
      }
      await Promise.all(m2mOps)
      toast.success('Raw changes saved')
      setDraft({})
      setM2mLinks(new Map())
      setM2mUnlinks(new Map())
      void qc.invalidateQueries({ queryKey: ['item', collection, String(itemId)] })
      void qc.invalidateQueries({ queryKey: ['raw-edit-record', collection, itemId] })
      void qc.invalidateQueries({ queryKey: ['m2m-items'] })
      onSaved?.()
      onClose()
    } catch (err) {
      const challenge = changeReasonChallenge(err)
      if (challenge) {
        setCrChallenge(challenge)
        return
      }
      const resp = (err as { response?: { error?: string; data?: { error?: string } } })?.response
      toast.error(resp?.data?.error ?? resp?.error ?? 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        if (o || saving) return
        // Close without saving discards everything staged — reopening must
        // never resurrect half-made junction edits.
        setDraft({})
        setM2mLinks(new Map())
        setM2mUnlinks(new Map())
        onClose()
      }}
    >
      <SheetContent side='right' className='flex w-[720px] max-w-[92vw] flex-col p-0 sm:max-w-[92vw]'>
        <SheetHeader className='shrink-0 border-b border-slate-200 px-5 py-3 dark:border-border'>
          <SheetTitle className='flex items-center gap-2 text-[14px]'>
            <Wrench className='h-4 w-4 text-nvr-cyan' />
            Raw edit — {titleCase(collection)} #{itemId}
          </SheetTitle>
        </SheetHeader>
        <p className='flex shrink-0 items-center gap-2 border-b border-amber-200 bg-amber-50 px-5 py-2 text-[12px] text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300'>
          <ShieldAlert className='h-3.5 w-3.5 shrink-0' />
          Admin raw mode — visibility rules, locks, cascades and layout restrictions are bypassed.
          Server-side validation still applies. Every change is recorded in the revision history.
        </p>
        <div className='min-h-0 flex-1 overflow-y-auto px-5 py-4'>
          {recordLoading || !fieldConfig ? (
            <div className='flex justify-center py-10'>
              <Loader2 className='h-5 w-5 animate-spin text-slate-400' />
            </div>
          ) : (
            <div className='space-y-3'>
              {rows.map(({ field, alias, m2mRel }) => {
                const raw = field.field in draft ? draft[field.field] : record?.[field.field]
                return (
                  <div key={field.field} className='grid grid-cols-[220px_1fr] items-start gap-3'>
                    <div className='pt-1.5'>
                      <p className='text-[12px] font-medium text-slate-700 dark:text-slate-200'>
                        {field.label || titleCase(field.field)}
                      </p>
                      <p className='font-mono text-[10.5px] text-slate-400'>{field.field}</p>
                    </div>
                    {field.field === 'id' ? (
                      <p className='pt-1.5 font-mono text-[12px] text-slate-500'>{String(raw ?? '')}</p>
                    ) : alias && m2mRel ? (
                      <M2MStagingContext.Provider value={stagingCtx}>
                        <M2MCombobox
                          relation={m2mRel}
                          parentId={itemId}
                          allRelations={relations}
                        />
                      </M2MStagingContext.Provider>
                    ) : alias ? (
                      <p className='pt-1.5 text-[11.5px] italic text-slate-400'>
                        Child rows (one-to-many) — edit through the normal form
                      </p>
                    ) : (
                      <FieldRenderer
                        field={field}
                        value={raw}
                        onChange={(v) => setDraft((prev) => ({ ...prev, [field.field]: v }))}
                        relations={fieldConfig.relations}
                        collection={collection}
                        itemId={itemId}
                      />
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
        <div className='flex shrink-0 items-center justify-between gap-3 border-t border-slate-200 px-5 py-3 dark:border-border'>
          <span className='text-[11.5px] text-slate-400'>
            {(() => {
              if (!dirty) return 'No changes yet'
              const n =
                Object.keys(draft).length +
                [...m2mLinks.values()].filter((ids) => ids.length > 0).length +
                [...m2mUnlinks.values()].filter((ids) => ids.size > 0).length
              return `${n} field${n !== 1 ? 's' : ''} changed`
            })()}
          </span>
          <div className='flex gap-2'>
            <Button variant='outline' size='sm' onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button size='sm' onClick={() => void doSave()} disabled={!dirty || saving}>
              {saving ? <Loader2 className='h-3.5 w-3.5 animate-spin' /> : 'Save raw changes'}
            </Button>
          </div>
        </div>
        <ChangeReasonDialog
          challenge={crChallenge}
          onCancel={() => setCrChallenge(null)}
          onSubmit={(reason) => {
            setCrChallenge(null)
            void doSave(reason)
          }}
        />
      </SheetContent>
    </Sheet>
  )
}

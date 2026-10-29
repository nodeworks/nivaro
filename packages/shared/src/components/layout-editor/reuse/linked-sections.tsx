import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link2, Unlink } from 'lucide-react'
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState
} from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../../context'
import { del, get, post, put } from '../../../lib/commands'
import type { LayoutBundle, LayoutOp } from '../../../lib/layout-ops'
import { cn } from '../../../lib/utils'
import type { DesignMark, DesignTarget } from '../design-context'
import { apiFailure } from '../overview/overview-api'
import { amberStrip, effectText, tintCard } from '../panel-style'
import type { ApplyOptions, LayoutDraft } from '../useLayoutDraft'
import { type FieldMap, reuseKeys, useRefreshTemplates } from './reuse-api'
import { reuseBtn, reusePrimary } from './SectionReuseActions'

// Linked sections (#3194). A library section placed as LINKED stays tied to
// the library: it is read-only on the form (its fields never drag, its
// settings never change here) and changes in one place — "Edit the shared
// section" opens it for editing on this form, "Publish" saves the form and
// sends the section to the library and every form that links it, each as its
// own saved change with a History entry. "Unlink" keeps the section as an
// ordinary copy. The server half: api/src/routes/layout-section-links.ts.

export interface SectionLink {
  id: number
  template_id: number
  template_name: string
  source_collection: string | null
  group_key: string
  field_map: FieldMap
  /** On the saved form (false: the linked drop is still only in this draft). */
  confirmed: boolean
  /** The saved copy matches the library; null before the first save. */
  in_sync: boolean | null
  linked_forms: number
}

export interface PublishResult {
  template_id: number
  updated: Array<{ layout_id: number; name: string }>
  unchanged: number
  skipped: Array<{ layout_id: number; name: string; reason?: string }>
}

// ─── Pure ───────────────────────────────────────────────────────────────────

export interface LinkIndex {
  /** Every group key of a linked section (its root and the tabs under it) → its link. */
  byGroup: Map<string, SectionLink>
  /** Root keys of linked sections on the form. */
  roots: Set<string>
}

export const EMPTY_INDEX: LinkIndex = { byGroup: new Map(), roots: new Set() }

/** Which groups of `bundle` belong to a linked section (links whose root is not there are ignored). */
export function indexLinks(
  bundle: Pick<LayoutBundle, 'groups'> | null,
  links: SectionLink[]
): LinkIndex {
  if (!bundle || links.length === 0) return EMPTY_INDEX
  const byGroup = new Map<string, SectionLink>()
  const roots = new Set<string>()
  const keys = new Set(bundle.groups.map((g) => g.key))
  for (const l of links) {
    if (!keys.has(l.group_key)) continue
    roots.add(l.group_key)
    byGroup.set(l.group_key, l)
  }
  if (!roots.size) return EMPTY_INDEX
  for (let grew = true; grew; ) {
    grew = false
    for (const g of bundle.groups) {
      const parent = g.parent_key ? byGroup.get(g.parent_key) : undefined
      if (parent && !byGroup.has(g.key)) {
        byGroup.set(g.key, parent)
        grew = true
      }
    }
  }
  return { byGroup, roots }
}

/** The link a canvas node sits in (the section itself, a tab of it, or a field inside). */
export function linkOfTarget(index: LinkIndex, t: DesignTarget | null): SectionLink | null {
  if (!t || index.roots.size === 0) return null
  if (t.kind === 'group') return index.byGroup.get(t.key) ?? null
  if (t.kind === 'field' || t.kind === 'slot')
    return t.group_key ? (index.byGroup.get(t.group_key) ?? null) : null
  return null
}

/** Nodes inside a linked section (not the section itself, which still moves on the form). */
export function isLockedTarget(index: LinkIndex, t: DesignTarget, editing: string | null): boolean {
  const link = linkOfTarget(index, t)
  if (!link || link.group_key === editing) return false
  return !(t.kind === 'group' && index.roots.has(t.key))
}

/**
 * The linked section a batch of ops would change in place, or null. Moving
 * the section on the form and taking it off the form are allowed; anything
 * inside it (fields, tabs, its own settings) changes only in the library.
 */
export function blockedLink(
  ops: LayoutOp[],
  index: LinkIndex,
  editing: string | null
): SectionLink | null {
  if (index.roots.size === 0) return null
  const hit = (key: string | null | undefined) => {
    if (!key) return null
    const l = index.byGroup.get(key)
    return l && l.group_key !== editing ? l : null
  }
  for (const op of ops) {
    let l: SectionLink | null = null
    switch (op.op) {
      case 'place':
        l = hit(op.group_key)
        break
      case 'move':
        l = hit(op.from.group_key) ?? hit(op.to_group_key)
        break
      case 'update_placement':
      case 'remove':
        l = hit(op.at.group_key)
        break
      case 'group_create':
        l = hit(op.parent_key)
        break
      case 'group_update':
        l = hit(op.key)
        break
      case 'group_move':
        l = (index.roots.has(op.key) ? null : hit(op.key)) ?? hit(op.parent_key)
        break
      case 'group_remove':
        l = index.roots.has(op.key) ? null : hit(op.key)
        break
    }
    if (l) return l
  }
  return null
}

const formsWord = (n: number) => `${n} ${n === 1 ? 'form' : 'forms'}`

/** What a publish did, in words. */
export function publishWords(r: PublishResult): { text: string; skipped: string | null } {
  const parts = [`${formsWord(r.updated.length)} updated`]
  if (r.unchanged) parts.push(`${r.unchanged} already matched`)
  const skipped = r.skipped.length
    ? `Not updated: ${r.skipped
        .slice(0, 4)
        .map((s) => `${s.name}${s.reason ? ` (${s.reason})` : ''}`)
        .join(
          ', '
        )}${r.skipped.length > 4 ? ` and ${r.skipped.length - 4} more` : ''}. Update them from their editors.`
    : null
  return { text: parts.join(', '), skipped }
}

// ─── API ────────────────────────────────────────────────────────────────────

type Client = ReturnType<typeof useNivaroClient>

export const linkKeys = {
  layout: (layoutId: number) => ['layout-editor', 'section-links', layoutId] as const
}

export function useSectionLinks(layoutId: number | null) {
  const client = useNivaroClient()
  return useQuery<SectionLink[]>({
    queryKey: linkKeys.layout(layoutId ?? 0),
    queryFn: () =>
      client
        .request<{ data?: SectionLink[] }>(get(`/collection-layouts/${layoutId}/section-links`))
        .then((r) => (Array.isArray(r?.data) ? r.data : [])),
    enabled: layoutId != null && layoutId > 0,
    staleTime: 15_000
  })
}

export function createLink(
  client: Client,
  layoutId: number,
  body: { template_id: number; group_key: string; field_map?: FieldMap }
) {
  return client.request(post(`/collection-layouts/${layoutId}/section-links`, body))
}

export function unlinkSection(client: Client, layoutId: number, key: string) {
  return client.request(
    del(`/collection-layouts/${layoutId}/section-links/${encodeURIComponent(key)}`)
  )
}

export function planLinkUpdate(
  client: Client,
  layoutId: number,
  key: string,
  bundle: LayoutBundle
) {
  return client.request<{ ops: LayoutOp[]; in_sync: boolean }>(
    post(`/collection-layouts/${layoutId}/section-links/${encodeURIComponent(key)}/plan`, {
      bundle: { groups: bundle.groups, placements: bundle.placements }
    })
  )
}

export function publishSection(
  client: Client,
  templateId: number,
  body: { layout_id: number; group_key: string }
) {
  return client
    .request<{ data: PublishResult }>(
      put(`/collection-layouts/templates/${templateId}/content`, body)
    )
    .then((r) => r.data)
}

// ─── Editor state ───────────────────────────────────────────────────────────

export interface LinkedSectionsValue {
  layoutId: number
  bundle: LayoutBundle | null
  links: SectionLink[]
  index: LinkIndex
  /** Root key of the linked section open for editing on this form, else null. */
  editing: string | null
  setEditing(key: string | null): void
  /** The draft's own apply: linked-section actions change the section on purpose. */
  rawApply(ops: LayoutOp[], opts?: ApplyOptions): void
  /** Save the draft; true when nothing is left unsaved. */
  save(): Promise<boolean>
  refresh(): void
}

const LinkedSectionsContext = createContext<LinkedSectionsValue | null>(null)

export function LinkedSectionsProvider({
  value,
  children
}: {
  value: LinkedSectionsValue
  children: ReactNode
}) {
  return <LinkedSectionsContext.Provider value={value}>{children}</LinkedSectionsContext.Provider>
}

export function useLinkedSectionsContext(): LinkedSectionsValue | null {
  return useContext(LinkedSectionsContext)
}

/**
 * The editor's linked sections and a draft whose `apply` refuses in-place
 * changes to them (one toast says where they change instead). Undo / Redo
 * and the linked-section actions themselves go around the guard.
 */
export function useLinkedSections(layoutId: number, draft: LayoutDraft) {
  const qc = useQueryClient()
  const { data: links = [] } = useSectionLinks(layoutId)
  const [editing, setEditing] = useState<string | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: a switch of layout ends the edit
  useEffect(() => setEditing(null), [layoutId])
  const bundle = draft.bundle
  const index = useMemo(() => indexLinks(bundle, links), [bundle, links])
  const refresh = useCallback(
    () => void qc.invalidateQueries({ queryKey: linkKeys.layout(layoutId) }),
    [qc, layoutId]
  )
  // Every confirmed save may confirm a pending link or change what is in sync.
  // biome-ignore lint/correctness/useExhaustiveDependencies: baseRev is the trigger
  useEffect(() => {
    if (links.length) refresh()
  }, [draft.baseRev])
  // A section open for editing that left the form (undo, removed) is no longer edited.
  useEffect(() => {
    if (editing && !index.roots.has(editing)) setEditing(null)
  }, [editing, index])

  const rawApply = draft.apply
  const apply = useCallback(
    (ops: LayoutOp[], opts?: ApplyOptions) => {
      const hit = blockedLink(ops, index, editing)
      if (hit) {
        toast(`${hit.template_name} is a linked library section`, {
          id: 'linked-section-refused',
          description:
            'Select it and choose Edit the shared section to change it on every form, or Unlink to change it here only.'
        })
        return
      }
      rawApply(ops, opts)
    },
    [index, editing, rawApply]
  )
  const save = useCallback(async () => {
    await draft.save()
    return draft.unsavedOps().length === 0
  }, [draft])
  const guarded: LayoutDraft = useMemo(() => ({ ...draft, apply }), [draft, apply])
  const value = useMemo<LinkedSectionsValue>(
    () => ({ layoutId, bundle, links, index, editing, setEditing, rawApply, save, refresh }),
    [layoutId, bundle, links, index, editing, rawApply, save, refresh]
  )
  return { draft: guarded, value }
}

/** Canvas tags: "Linked" on each linked section, and nodes inside it locked. */
export function useLinkedSectionMarks(marks?: (t: DesignTarget) => DesignMark[]): {
  marks: ((t: DesignTarget) => DesignMark[]) | undefined
  locked: ((t: DesignTarget) => boolean) | undefined
} {
  const ctx = useLinkedSectionsContext()
  const index = ctx?.index ?? EMPTY_INDEX
  const editing = ctx?.editing ?? null
  return useMemo(() => {
    if (index.roots.size === 0) return { marks, locked: undefined }
    return {
      marks: (t: DesignTarget) => {
        const own = marks?.(t) ?? []
        if (t.kind !== 'group' || !index.roots.has(t.key)) return own
        const link = index.byGroup.get(t.key) as SectionLink
        return [...own, linkedMark(link, link.group_key === editing)]
      },
      locked: (t: DesignTarget) => isLockedTarget(index, t, editing)
    }
  }, [index, editing, marks])
}

export function linkedMark(link: SectionLink, editing: boolean): DesignMark {
  if (editing)
    return {
      text: 'Editing shared section',
      tone: 'violet',
      icon: 'link',
      highlight: true,
      tip: `Changes here go to the library section ${link.template_name} and ${formsWord(link.linked_forms)} when you publish.`
    }
  if (link.in_sync === false)
    return {
      text: 'Linked · differs',
      tone: 'amber',
      icon: 'link',
      tip: `Linked to ${link.template_name} in the section library, but this copy differs from it. Select it to update it.`
    }
  return {
    text: 'Linked',
    tone: 'slate',
    icon: 'link',
    tip: `Linked to ${link.template_name} in the section library: it changes there, on every form that uses it.`
  }
}

/** The inspector's link of the selected node, and whether it is open for editing. */
export function useLinkedTarget(target: DesignTarget | null) {
  const ctx = useLinkedSectionsContext()
  if (!ctx) return null
  const link = linkOfTarget(ctx.index, target)
  return link ? { link, editing: ctx.editing === link.group_key } : null
}

// ─── Inspector notice ───────────────────────────────────────────────────────

const quiet = effectText
const strong = 'font-medium text-slate-800 dark:text-foreground'

/** The linked section's card at the top of the inspector: where it changes, and how. */
export function LinkedSectionNotice({ link }: { link: SectionLink }) {
  const ctx = useLinkedSectionsContext()
  const client = useNivaroClient()
  const qc = useQueryClient()
  const refreshTemplates = useRefreshTemplates()
  const [busy, setBusy] = useState<null | 'update' | 'publish' | 'cancel' | 'unlink'>(null)
  const [confirmUnlink, setConfirmUnlink] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!ctx) return null
  const editing = ctx.editing === link.group_key
  const others = Math.max(0, link.linked_forms - 1)

  /** Bring this form's copy back to the library version, as one undo step. */
  const backToLibrary = async (label: string) => {
    if (!ctx.bundle) return false
    const plan = await planLinkUpdate(client, ctx.layoutId, link.group_key, ctx.bundle)
    if (plan.ops.length && !plan.in_sync) ctx.rawApply(plan.ops, { label })
    return true
  }

  const run = async (kind: NonNullable<typeof busy>, fn: () => Promise<void>) => {
    if (busy) return
    setBusy(kind)
    setError(null)
    try {
      await fn()
    } catch (err) {
      setError(apiFailure(err, 'That did not work').message)
    } finally {
      setBusy(null)
    }
  }

  const update = () =>
    run('update', async () => {
      await backToLibrary(`Update ${link.template_name} from the library`)
      toast.success(`${link.template_name} matches the library again. Save to keep it.`)
    })

  const cancel = () =>
    run('cancel', async () => {
      await backToLibrary(`Undo edits to ${link.template_name}`)
      ctx.setEditing(null)
    })

  const publish = () =>
    run('publish', async () => {
      if (!(await ctx.save())) {
        setError('Save the form first (it may ask for a reason), then publish.')
        return
      }
      const r = await publishSection(client, link.template_id, {
        layout_id: ctx.layoutId,
        group_key: link.group_key
      })
      ctx.setEditing(null)
      ctx.refresh()
      refreshTemplates('section')
      void qc.invalidateQueries({ queryKey: reuseKeys.templates('section') })
      const words = publishWords(r)
      toast.success(`Published ${link.template_name}: ${words.text}`)
      if (words.skipped) toast.warning(words.skipped, { duration: 10_000 })
    })

  const unlink = () =>
    run('unlink', async () => {
      await unlinkSection(client, ctx.layoutId, link.group_key)
      ctx.setEditing(null)
      ctx.refresh()
      refreshTemplates('section')
      toast.success(`${link.template_name} is an ordinary section on this form now`)
    })

  return (
    <div
      data-linked-section={link.group_key}
      data-linked-editing={editing ? '' : undefined}
      className={cn(tintCard, 'mb-4 space-y-2.5 p-3')}
    >
      <p className='flex items-start gap-2 text-[12.5px] leading-snug text-slate-700 dark:text-foreground'>
        <Link2
          aria-hidden
          className='mt-0.5 h-3.5 w-3.5 shrink-0 text-[#0089ad] dark:text-nvr-cyan'
        />
        {editing ? (
          <span>
            Editing the shared section <span className={strong}>{link.template_name}</span>. Publish
            saves this form and sends the section to the library
            {others ? ` and ${formsWord(others)} that use it` : ''}.
          </span>
        ) : (
          <span>
            Linked to <span className={strong}>{link.template_name}</span> in the section library
            {others ? `, also on ${formsWord(others)}` : ''}. It changes there, for every form at
            once.
          </span>
        )}
      </p>
      {!editing && !link.confirmed && (
        <p className={quiet}>The link is kept when you save this form.</p>
      )}
      {!editing && link.in_sync === false && (
        <p
          data-linked-differs=''
          className={cn('rounded-md border px-2.5 py-1.5 text-[12px] leading-snug', amberStrip)}
        >
          This copy differs from the library (changed here, or the library changed while the form
          could not be updated).
        </p>
      )}
      {confirmUnlink ? (
        <div className='space-y-2'>
          <p className={quiet}>
            The section stays on this form as an ordinary copy you can change. Library changes stop
            reaching it.
          </p>
          <div className='flex flex-wrap gap-1.5'>
            <button
              type='button'
              data-linked-unlink-confirm=''
              disabled={!!busy}
              onClick={() => void unlink()}
              className={reuseBtn}
            >
              <Unlink className='h-3.5 w-3.5' />
              {busy === 'unlink' ? 'Unlinking…' : 'Unlink'}
            </button>
            <button type='button' className={reuseBtn} onClick={() => setConfirmUnlink(false)}>
              Keep linked
            </button>
          </div>
        </div>
      ) : editing ? (
        <div className='flex flex-wrap gap-1.5'>
          <button
            type='button'
            data-linked-publish=''
            disabled={!!busy}
            onClick={() => void publish()}
            className={reusePrimary}
          >
            {busy === 'publish'
              ? 'Publishing…'
              : others
                ? `Publish to ${formsWord(others + 1)}`
                : 'Publish to the library'}
          </button>
          <button
            type='button'
            data-linked-cancel=''
            disabled={!!busy}
            onClick={() => void cancel()}
            className={reuseBtn}
          >
            {busy === 'cancel' ? 'Putting it back…' : 'Cancel'}
          </button>
        </div>
      ) : (
        <div className='flex flex-wrap gap-1.5'>
          <button
            type='button'
            data-linked-edit=''
            disabled={!!busy}
            onClick={() => ctx.setEditing(link.group_key)}
            className={reusePrimary}
          >
            Edit the shared section
          </button>
          {link.in_sync === false && (
            <button
              type='button'
              data-linked-update=''
              disabled={!!busy}
              onClick={() => void update()}
              className={reuseBtn}
            >
              {busy === 'update' ? 'Updating…' : 'Update from the library'}
            </button>
          )}
          <button
            type='button'
            data-linked-unlink=''
            disabled={!!busy}
            onClick={() => setConfirmUnlink(true)}
            className={reuseBtn}
          >
            <Unlink className='h-3.5 w-3.5' />
            Unlink
          </button>
        </div>
      )}
      {error && (
        <p role='alert' className='text-[12px] leading-snug text-red-700 dark:text-red-300'>
          {error}
        </p>
      )}
    </div>
  )
}

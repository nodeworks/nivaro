import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, Check, ChevronDown, Loader2, Search, X } from 'lucide-react'
import type { CSSProperties } from 'react'
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useItemEditAuth, useNivaroClient, useStaleFieldReporter } from '../../context'
import { get, post } from '../../lib/commands'
import { compareByMatch } from '../../lib/picker-rank'
import { useRecordReader } from '../../lib/record-loader'
import { useOnlineUsers } from '../../lib/use-online-users'
import { SearchHighlight } from '../SearchHighlight'
import { UserAvatar } from '../UserAvatar'

/** Initials from a rendered user label ("Jane Doe (jane@x)" → "JD"). */
function labelInitials(label: string): string {
  return (
    label
      .replace(/\(.*$/, '')
      .trim()
      .split(/\s+/)
      .map((p) => p[0])
      .filter(Boolean)
      .slice(0, 2)
      .join('')
      .toUpperCase() || '?'
  )
}

import { cn, matchesAllTokens, userOptionFilter } from '../../lib/utils'
import { applyDisplayTemplate } from './helpers'
import {
  collidingIds,
  disambiguators,
  isNamelessLabel,
  NAMELESS_LABEL
} from './option-disambiguate'
import { type PickerMissPlacement, usePickerMissReport } from './picker-miss'
import {
  labelOnlyMatches,
  narrowLocally,
  onlyCloseMatches,
  PICKER_PAGE,
  useLatestSearch
} from './picker-search'
import { RelatedMissingLabel, retryRelatedRead } from './related-missing'

/**
 * Instant hover tooltip for a picker whose committed value failed its
 * availability probe ("Current value is not an available option"). The old
 * inline <p> wrapped into a squished text column inside narrow grid cells —
 * the amber border + triangle stay as the signal, the words ride this
 * pointer-events-none body portal (safe under modal locks). Spread `bind`
 * onto the trigger element and render `tip` anywhere in the tree.
 */
export function useStaleTip(active: boolean): {
  bind: {
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => void
    onMouseLeave: () => void
  }
  tip: React.ReactNode
} {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const bind = {
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => {
      if (!active) return
      const r = e.currentTarget.getBoundingClientRect()
      const flipUp = window.innerHeight - r.bottom < 80
      setPos({ x: r.left, y: flipUp ? r.top - 58 : r.bottom + 4 })
    },
    onMouseLeave: () => setPos(null)
  }
  const tip =
    active && pos
      ? createPortal(
          <div
            style={{ position: 'fixed', left: pos.x, top: pos.y, zIndex: 130 }}
            className='pointer-events-none max-w-[300px] rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11.5px] leading-snug text-amber-800 shadow-md dark:border-amber-500/40 dark:bg-[#2a2113] dark:text-amber-300'
          >
            Current value is not an available option — clear to pick another
          </div>,
          document.body
        )
      : null
  return { bind, tip }
}

// ─── RelationCombobox (M2O) ────────────────────────────────────────────────────

/** Picking the option that is already the field's value. It must be a
 *  no-op: sending the same id again still counted as a parent change for the
 *  form (string vs number id), so re-picking Project Type cleared the Project
 *  Sub Type it had auto-filled (army 2026-11-05). */
export function isSamePick(value: unknown, id: unknown): boolean {
  if (value === null || value === undefined || value === '') return false
  if (id === null || id === undefined || id === '') return false
  return String(value) === String(id)
}

export function RelationCombobox({
  collection,
  value,
  onChange,
  disabled,
  placeholder,
  extraFilter,
  autoSelectSingle,
  optionSort,
  requiredParent,
  facets,
  fieldKey,
  narrowedBy,
  pinned,
  missPlacement,
  defaultOpen,
  onClose,
  displayTemplate
}: {
  collection: string
  /** Overrides the collection's display template for this picker's options —
   *  a catalog's "Add any item" shows the item number AND its description
   *  (army11 f1: bare numbers made people pick blind). */
  displayTemplate?: string | null
  /** Open the options panel on mount (a list cell's inline editor, #3224). */
  defaultOpen?: boolean
  /** Called when the options panel closes (picked, clicked away or Escape). */
  onClose?: () => void
  /** The record-form placement this picker sits on: searches that find
   *  nothing are counted there (#2726). Absent = not reported. */
  missPlacement?: PickerMissPlacement | null
  value: unknown
  onChange: (v: unknown) => void
  /** A "floating" option shown FIRST regardless of search or sort — the
   *  parent's default item for a materials line, say. Label = the option's
   *  own display label; `tag` is the small badge beside it ("Default"). */
  pinned?: { id: unknown; tag?: string } | null
  disabled?: boolean
  placeholder?: string
  extraFilter?: Record<string, unknown>
  /** The parent fields whose current values narrow this picker (cascade
   *  filters). When the narrowed list is EMPTY the panel says which parents
   *  did it and offers to clear one — instead of a blank "No results". */
  narrowedBy?: {
    labels: string[]
    keys: string[]
    /** Keys offered for clearing; absent = all of `keys`. */
    clearable?: string[]
    onClear?: (key: string) => void
  }
  /** When the filtered option set has EXACTLY one option and the field is
   *  empty, pick it automatically (options.auto_select_single). Two or more
   *  options — or zero — leave the field blank; an existing value is never
   *  overridden. Re-evaluates when the effective filter changes (e.g. a
   *  cascade parent narrowing the list). */
  autoSelectSingle?: boolean
  /** Option ordering: 'column' | '-column' (server sort) | 'label' | '-label' (display-label sort). Default: label ascending. */
  optionSort?: string
  requiredParent?: string
  /** Field name, so staleness can be reported to the form by name. */
  fieldKey?: string
  /** In-picker filter facets: M2O fields ON THE TARGET COLLECTION rendered as
   *  small pickers inside the dropdown. Ephemeral — they only narrow the
   *  option list, nothing is written to the form. */
  facets?: Array<{ field: string; label?: string; sort?: string; filter?: Record<string, unknown> }>
}) {
  const client = useNivaroClient()
  const readRow = useRecordReader()
  const [open, setOpen] = useState(defaultOpen ?? false)
  const [query, setQuery] = useState('')
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const wasOpenRef = useRef(open)
  useEffect(() => {
    if (wasOpenRef.current && !open) onCloseRef.current?.()
    wasOpenRef.current = open
  }, [open])
  // One server search at a time (picker-search.ts): typing while a search is
  // in flight waits for it, then only the newest text goes out.
  const [searchBusy, setSearchBusy] = useState(false)
  const debouncedQuery = useLatestSearch(query, searchBusy)
  const inputRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listId = useId()
  // The keyboard-highlighted option (index into the pinned + listed options).
  const [activeIndex, setActiveIndex] = useState(-1)

  // Enter pressed while the search for the typed text is still out: picked
  // when that answer lands (a fast "201943⏎" must pick 201943, never the
  // first row of the previous list). Any further typing or closing drops it.
  const pendingEnterRef = useRef<string | null>(null)
  const focusSearch = () => {
    const el = inputRef.current
    if (!el || document.activeElement === el) return
    el.focus({ preventScroll: true })
    // Caret after the text already typed on the trigger.
    const end = el.value.length
    el.setSelectionRange?.(end, end)
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on the listed inputs only; the helpers it calls read refs
  useEffect(() => {
    if (open) setTimeout(focusSearch, 30)
    else {
      setQuery('')
      pendingEnterRef.current = null
    }
  }, [open])

  const refocusRef = useRef(false)
  const closeAndRefocus = () => {
    setOpen(false)
    triggerRef.current?.focus()
    refocusRef.current = true
  }
  // The trigger is a different element while the value cannot be read (the
  // "Change" control beside the words). A pick or a clear made from it swaps
  // the element that holds the focus, which drops the focus to the page: hand
  // it to the trigger that took its place so Tab carries on from this field.
  useEffect(() => {
    if (!refocusRef.current) return
    refocusRef.current = false
    const active = document.activeElement
    if (!active || active === document.body) triggerRef.current?.focus()
  })

  // Escape closes the list (army8 b01 HIGH: it did nothing, the open list hung
  // over the next field and the next click picked a row under it). Listened
  // on WINDOW in the capture phase so it runs before a hosting sheet's own
  // Escape handler (Radix listens on document, capture) — Escape closes the
  // list, not the sheet around it. Only the picker holding focus answers, so
  // a facet picker inside this panel closes alone.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const a = document.activeElement
      const mine =
        a === document.body ||
        !!(a && (panelRef.current?.contains(a) || rootRef.current?.contains(a)))
      if (!mine) return
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
      triggerRef.current?.focus()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])

  // Focus moving anywhere outside the picker (Tab, a click into another
  // field, a screen reader jump) closes the list: an open list must never sit
  // over the next field waiting to swallow its click.
  useEffect(() => {
    if (!open) return
    const onFocus = (e: FocusEvent) => {
      const t = e.target as Element | null
      if (!t || t === document.body) return
      if (t.closest?.('[data-nvr-combobox-panel]')) return
      if (rootRef.current?.contains(t)) return
      setOpen(false)
    }
    document.addEventListener('focusin', onFocus)
    return () => document.removeEventListener('focusin', onFocus)
  }, [open])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      const t = e.target as Element | null
      // The panel PORTALS out of rootRef (see panelStyle below) — clicks inside
      // any combobox panel (incl. a nested facet's) must not read as outside.
      if (t?.closest?.('[data-nvr-combobox-panel]')) return
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // ── Portal positioning ──────────────────────────────────────────────────────
  // The options panel used to be `absolute` inside the trigger's own tree, so
  // any overflow ancestor (inline-grid drawers, table wrappers) CLIPPED it.
  // Portal it out — into the hosting [role=dialog] content when inside a sheet
  // (a body portal there inherits the modal lock's pointer-events:none — the
  // DropPanel/roster precedent), else document.body. Flips upward near the
  // viewport bottom; repositions on capture-phase scroll + resize.
  const [panelStyle, setPanelStyle] = useState<CSSProperties | null>(null)
  const [portalEl, setPortalEl] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => {
    if (!open) {
      setPanelStyle(null)
      return
    }
    const update = () => {
      const anchor = rootRef.current
      if (!anchor) return
      const r = anchor.getBoundingClientRect()
      const container = (anchor.closest('[role="dialog"]') as HTMLElement | null) ?? document.body
      setPortalEl(container)
      const flipUp = window.innerHeight - r.bottom < 340 && r.top > window.innerHeight - r.bottom
      const x = r.left
      const y = flipUp ? r.top - 4 : r.bottom + 4
      const common: CSSProperties = {
        minWidth: r.width,
        zIndex: 120,
        ...(flipUp ? { transform: 'translateY(-100%)' } : {})
      }
      if (container === document.body) {
        setPanelStyle({ position: 'fixed', left: x, top: y, ...common })
      } else {
        const c = container.getBoundingClientRect()
        setPanelStyle({ position: 'absolute', left: x - c.left, top: y - c.top, ...common })
      }
    }
    update()
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    return () => {
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
    }
  }, [open])
  // The search box takes focus the moment the panel exists (not 30 ms later):
  // keys typed in the meantime would otherwise land on the trigger.
  const panelReady = open && !!panelStyle && !!portalEl
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on the listed inputs only; the helpers it calls read refs
  useLayoutEffect(() => {
    if (panelReady && document.activeElement === triggerRef.current) focusSearch()
  }, [panelReady])

  const { data: colMeta, isPending: colMetaPending } = useQuery<{ display_template?: string }>({
    queryKey: ['col-meta', collection],
    queryFn: () =>
      client
        .request<{ data: { display_template?: string } }>(get(`/collections/${collection}`))
        .then((r) => r.data),
    staleTime: 300_000,
    retry: false
  })

  type Item = Record<string, unknown>

  // ── In-picker facets ──────────────────────────────────────────────────────
  const [facetSel, setFacetSel] = useState<Record<string, unknown>>({})
  const { data: targetRelations = [] } = useQuery<
    Array<{
      many_collection?: string
      many_field?: string
      one_collection?: string
      junction_field?: string | null
    }>
  >({
    queryKey: ['collection-meta', collection],
    queryFn: () =>
      client
        .request<{ data: { relations?: Array<Record<string, unknown>> } }>(
          get(`/collections/${collection}`)
        )
        .then(
          (r) =>
            (r.data?.relations ?? []) as Array<{
              many_collection?: string
              many_field?: string
              one_collection?: string
              junction_field?: string | null
            }>
        ),
    enabled: !!facets?.length,
    staleTime: 10 * 60_000
  })
  const facetTargets = useMemo(() => {
    const map: Record<string, string> = {}
    for (const f of facets ?? []) {
      const rel = targetRelations.find(
        (r) => r.many_collection === collection && r.many_field === f.field && !r.junction_field
      )
      if (rel?.one_collection) map[f.field] = rel.one_collection
    }
    return map
  }, [facets, targetRelations, collection])
  // System user pickers: nivaro_users has no nivaro_collections row, so give it a
  // sane default template + exclude redacted/suspended users (mirrors listUsers()).
  const isUserCollection = collection === 'nivaro_users'
  // Online presence dots in user pickers (#284) — the shared 30s-polled set.
  const onlineUsers = useOnlineUsers(isUserCollection)
  const viewerIsAdmin = useItemEditAuth().isAdmin
  const combinedFilter = useMemo(() => {
    const clauses: Record<string, unknown>[] = []
    if (isUserCollection) clauses.push(userOptionFilter(viewerIsAdmin))
    if (extraFilter) clauses.push(extraFilter)
    for (const [f, v] of Object.entries(facetSel)) {
      if (v !== null && v !== undefined && v !== '') clauses.push({ [f]: { _eq: v } })
    }
    if (clauses.length === 0) return undefined
    return clauses.length === 1 ? clauses[0] : { _and: clauses }
  }, [extraFilter, facetSel, viewerIsAdmin])

  // Extract template fields for relation expansion (e.g. '{{category.name}}' → 'category.name')
  const effectiveTemplate =
    displayTemplate ||
    colMeta?.display_template ||
    (isUserCollection ? '{{first_name}} {{last_name}} ({{email}})' : null)
  const tmplFields = useMemo(() => {
    if (!effectiveTemplate) return undefined
    const matches = [...effectiveTemplate.matchAll(/\{\{([\w.]+)\}\}/g)].map((m) => m[1])
    if (!matches.length) return undefined
    // Each column once: a `{{id}}` template asked for `id,id` (army11 f3).
    return [...new Set(['id', ...matches])].join(',')
  }, [effectiveTemplate])

  const filterStr = combinedFilter ? JSON.stringify(combinedFilter) : undefined
  // Column-based option sort goes to the server; 'label'/'-label' sort client-side
  const serverSort = optionSort && !/^-?label$/.test(optionSort) ? optionSort : undefined
  const fetchOptions = (search: string) =>
    client
      .request<{ data: Item[] }>(
        get(`/items/${collection}`, {
          limit: PICKER_PAGE,
          picker: '1',
          // Typo pass (fix11-search): only when the exact search finds nothing,
          // the server answers close matches, each marked `fuzzy`.
          ...(search.trim() ? { search: search.trim(), typo: '1' } : {}),
          ...(filterStr ? { filter: filterStr } : {}),
          ...(tmplFields ? { fields: tmplFields } : {}),
          ...(serverSort ? { sort: serverSort } : {})
        })
      )
      .then((r) => (r.data ?? []) as Item[])
  const {
    data,
    isFetching: isLoadingOptions,
    isPlaceholderData
  } = useQuery<Item[]>({
    queryKey: [
      'relation-opts',
      collection,
      debouncedQuery,
      filterStr,
      tmplFields,
      serverSort ?? ''
    ],
    queryFn: () => fetchOptions(debouncedQuery),
    // Wait for the display template: it decides `fields`, and starting before
    // it lands sent the whole first page twice.
    enabled: open && !colMetaPending,
    staleTime: filterStr ? 0 : 30_000,
    // A new SEARCH keeps the previous answer on screen (narrowed locally below)
    // instead of blanking the list behind a spinner. A changed filter, sort or
    // template never does — those rows may no longer be allowed.
    placeholderData: (prev, prevQuery) => {
      const k = prevQuery?.queryKey
      if (!prev || !k) return undefined
      return k[1] === collection &&
        k[3] === filterStr &&
        k[4] === tmplFields &&
        k[5] === (serverSort ?? '')
        ? prev
        : undefined
    }
  })
  useEffect(() => setSearchBusy(isLoadingOptions), [isLoadingOptions])
  // army11 f3 HIGH — the server searches TEXT columns, so a list whose label is
  // a number (Funding Year = its id) answered "No results for 2026". When the
  // server finds nothing, the whole (short) list is read once and matched on
  // the labels the person sees. Same cache as the empty-box list.
  // Close matches only (the typo pass) count as "found nothing" here: an exact
  // label match on the whole list beats a guess.
  const serverFoundNothing =
    !!debouncedQuery.trim() &&
    query === debouncedQuery &&
    !isPlaceholderData &&
    !isLoadingOptions &&
    data !== undefined &&
    (data.length === 0 || onlyCloseMatches(data))
  const { data: wholeList } = useQuery<Item[]>({
    queryKey: ['relation-opts', collection, '', filterStr, tmplFields, serverSort ?? ''],
    queryFn: () => fetchOptions(''),
    enabled: open && !colMetaPending && serverFoundNothing,
    staleTime: filterStr ? 0 : 30_000
  })
  const labelMatches = useMemo(
    () =>
      serverFoundNothing && wholeList
        ? labelOnlyMatches(
            wholeList,
            (item) => applyDisplayTemplate(effectiveTemplate, item) || '',
            query
          )
        : null,
    [serverFoundNothing, wholeList, effectiveTemplate, query]
  )
  const waitingOnLabels = serverFoundNothing && wholeList === undefined
  // The list shows the server's close matches ("Did you mean…").
  const showingCloseMatches =
    !!data && onlyCloseMatches(data) && !(labelMatches && labelMatches.length > 0)
  usePickerMissReport({
    placement: missPlacement,
    open,
    search: debouncedQuery,
    settled: !isLoadingOptions && !isPlaceholderData && data !== undefined && !waitingOnLabels,
    count: labelMatches?.length ?? data?.length ?? 0
  })

  const {
    data: selected,
    isLoading: isLoadingSelected,
    error: selectedError,
    isFetched: selectedFetched
  } = useQuery<Item | null>({
    queryKey: ['relation-single', collection, String(value), tmplFields],
    queryFn: () =>
      readRow(collection, value as string | number, tmplFields) as Promise<Item | null>,
    enabled: !!value,
    staleTime: 60_000,
    retry: retryRelatedRead
  })
  // A value the reader cannot open (a project now outside their zones) says
  // so in words on the trigger — it used to look empty ("Select…") or show
  // its number (army9 review M7).
  const selectedUnreadable = !!value && !isLoadingSelected && selectedFetched && !selected

  const pinnedId = pinned?.id != null && pinned.id !== '' ? String(pinned.id) : null
  const { data: pinnedItem } = useQuery<Item | null>({
    queryKey: ['relation-single', collection, pinnedId ?? '', tmplFields],
    queryFn: () =>
      (readRow(collection, pinnedId as string, tmplFields) as Promise<Item | null>).catch(
        () => null
      ),
    enabled: !!pinnedId && open,
    staleTime: 60_000
  })

  const availabilityFilter = extraFilter
    ? JSON.stringify({ _and: [{ id: { _eq: value } }, extraFilter] })
    : JSON.stringify({ id: { _eq: value } })

  const { data: availabilityData } = useQuery<Item[]>({
    queryKey: ['relation-avail', collection, String(value), filterStr],
    queryFn: () =>
      client
        .request<{ data: Item[] }>(
          get(`/items/${collection}`, {
            filter: availabilityFilter,
            picker: '1',
            limit: 1,
            fields: 'id'
          })
        )
        .then((r) => r.data ?? []),
    // The pinned option is offered OUTSIDE the option filter (a type's generic
    // item is excluded from the general list on purpose), so a value that IS
    // the pin is available by construction — never probe it, never flag it.
    enabled: !!value && !!selected && String(value) !== pinnedId,
    staleTime: 30_000
  })
  const isStale =
    !!value &&
    String(value) !== pinnedId &&
    availabilityData !== undefined &&
    availabilityData.length === 0

  // auto_select_single: with the field EMPTY, probe the filtered option set
  // (limit 2 — only the "exactly one?" answer matters) and pick the sole
  // option. Side-effect fetch outside react-query, so it carries the same
  // dedupe guard as useCascadeEffects: one probe per filter shape, ref cleared
  // on failure so a transient error can't permanently suppress the fill.
  // A MANUAL clear switches the auto-fill off for this field until it holds
  // a value again (reported 2026-09-11: clearing a parent picker on a form put
  // it straight back). Stamping the filter shape was not enough: the clear
  // itself cascades (a child picker empties), which changes THIS field's filter
  // shape and re-armed the probe. Fields this one cascades to or from keep
  // their own auto-fill — only the field the user cleared stays empty.
  const autoSelectRef = useRef<string | null>(null)
  const manualClearRef = useRef(false)
  const autoSelectKey = `${collection}|${filterStr ?? ''}`
  const clearByUser = () => {
    manualClearRef.current = true
    autoSelectRef.current = autoSelectKey
    onChange(null)
  }
  const isEmpty = value === null || value === undefined || value === ''
  useEffect(() => {
    if (!isEmpty) manualClearRef.current = false
  }, [isEmpty])
  useEffect(() => {
    if (!autoSelectSingle || disabled || !isEmpty || manualClearRef.current) return
    const probeKey = autoSelectKey
    if (autoSelectRef.current === probeKey) return
    autoSelectRef.current = probeKey
    client
      .request<{ data: Item[] }>(
        get(`/items/${collection}`, {
          limit: 2,
          picker: '1',
          fields: 'id',
          ...(filterStr ? { filter: filterStr } : {})
        })
      )
      .then((r) => {
        const rows = r.data ?? []
        if (rows.length === 1 && rows[0]?.id != null) onChange(rows[0].id)
      })
      .catch(() => {
        autoSelectRef.current = null
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSelectSingle, disabled, isEmpty, collection, filterStr])

  const tmpl = effectiveTemplate
  const selectedRaw = value && selected ? applyDisplayTemplate(tmpl, selected) : null
  // A value whose row renders no name says so in words — never "#5331".
  const selectedLabel =
    selectedRaw === null ? null : isNamelessLabel(selectedRaw) ? NAMELESS_LABEL : selectedRaw
  // The answer on screen is for what is typed now — otherwise the previous
  // answer, narrowed by the newer text until the server replies.
  const optionsSettled = !isPlaceholderData && query === debouncedQuery && !waitingOnLabels
  const shownOptions = useMemo(
    () =>
      (labelMatches && (labelMatches.length > 0 || !data?.length) ? labelMatches : null) ??
      narrowLocally(
        data ?? [],
        (item) => applyDisplayTemplate(tmpl, item) || `#${item.id}`,
        // The server also reads a joined code by its parts ("2026-NNO-POWER"
        // finds 2026-WEST-NNO-HE-POWERING, services/search-synonyms.ts), so
        // the list narrowed while that search is out does too.
        query.replace(/[-_/]+/g, ' '),
        optionsSettled
      ),
    [data, tmpl, query, optionsSettled, labelMatches]
  )

  // Options that render the same label ("CEG 1" twice) get a muted secondary
  // detail: the column that tells them apart, read only for those rows.
  const dupIds = useMemo(
    () => collidingIds(data ?? [], (item) => applyDisplayTemplate(tmpl, item) || `#${item.id}`),
    [data, tmpl]
  )
  const { data: dupRows } = useQuery<Item[]>({
    queryKey: ['relation-opts-dups', collection, dupIds.join(',')],
    queryFn: () =>
      client
        .request<{ data: Item[] }>(
          get(`/items/${collection}`, {
            limit: dupIds.length,
            picker: '1',
            filter: JSON.stringify({ id: { _in: dupIds } }),
            fields: '*'
          })
        )
        .then((r) => (r.data ?? []) as Item[]),
    enabled: open && dupIds.length > 0 && !isUserCollection,
    staleTime: 60_000
  })
  const dupDetail = useMemo(() => {
    if (!dupRows?.length) return new Map<string, string>()
    // Group by the label the list shows (a `*` read does not expand the
    // template's relation paths, so the label comes from the option row).
    const labelById = new Map(
      (data ?? []).map((item) => [
        String(item.id),
        (applyDisplayTemplate(tmpl, item) || `#${item.id}`).trim().toLowerCase()
      ])
    )
    const groups = new Map<string, Item[]>()
    for (const r of dupRows) {
      const key = labelById.get(String(r.id))
      if (key !== undefined) groups.set(key, [...(groups.get(key) ?? []), r])
    }
    return disambiguators(
      [...groups.values()],
      (tmplFields?.split(',') ?? []).map((f) => f.split('.')[0])
    )
  }, [dupRows, data, tmpl, tmplFields])
  const showLoader = !!value && isLoadingSelected && !selected
  const staleTip = useStaleTip(isStale)

  // The listed options, in display order. Rows whose display fields are all
  // empty are left out (nothing to recognise them by — army8 b01 "#5331" and
  // the "-" projects); the field's current value always stays listed. When NO
  // row has a name (a role whose access leaves out the label field) they all
  // stay, listed as "Unnamed record" and still pickable — an empty picker
  // would leave the field impossible to fill (army8 review M1).
  const anyNamed = useMemo(
    () => (data ?? []).some((item) => !isNamelessLabel(applyDisplayTemplate(tmpl, item))),
    [data, tmpl]
  )
  const listOptions = useMemo(
    () =>
      (serverSort
        ? [...shownOptions]
        : [...shownOptions].sort((a, b) =>
            compareByMatch(
              applyDisplayTemplate(tmpl, a),
              applyDisplayTemplate(tmpl, b),
              query,
              optionSort === '-label'
            )
          )
      )
        .filter((item) => !pinnedId || String(item.id) !== pinnedId)
        .filter(
          (item) =>
            !anyNamed ||
            String(item.id) === String(value) ||
            !isNamelessLabel(applyDisplayTemplate(tmpl, item))
        ),
    [shownOptions, serverSort, tmpl, query, optionSort, pinnedId, value, anyNamed]
  )
  // The pinned (Default) row is offered while the box is empty, and while
  // typing only when the text matches it — otherwise it sat at index 0 above
  // the match and Enter wrote the default (army8 review H1).
  const pinnedLabel =
    pinnedItem && !isNamelessLabel(applyDisplayTemplate(tmpl, pinnedItem))
      ? applyDisplayTemplate(tmpl, pinnedItem)
      : NAMELESS_LABEL
  const pinnedShown =
    !!pinnedId &&
    (!query.trim() ||
      matchesAllTokens(
        `${pinnedItem ? pinnedLabel : ''} ${pinned?.tag ?? 'Default'}`,
        query.replace(/[-_/]+/g, ' ')
      ))
  const navOffset = pinnedShown ? 1 : 0
  const navCount = navOffset + listOptions.length
  const active = activeIndex >= navCount ? navCount - 1 : activeIndex
  // Typing highlights the first listed match so Enter picks it (the pinned
  // row only when nothing else is listed); an empty box highlights nothing
  // (Enter then picks only a sole option).
  useEffect(() => {
    // A close match (a guess at a typo) is never picked by Enter alone: the
    // person arrows to it or clicks it.
    setActiveIndex(open && query.trim() && !showingCloseMatches ? navOffset : -1)
  }, [open, query, navOffset, showingCloseMatches])
  const optionDomId = (i: number) => `${listId}-opt-${i}`
  const pickPinned = () => {
    const id = pinnedItem?.id ?? pinned?.id
    if (!isSamePick(value, id)) onChange(id)
    closeAndRefocus()
  }
  const pickItem = (item: Item) => {
    if (!isSamePick(value, item.id)) onChange(item.id)
    closeAndRefocus()
  }
  const pickAt = (i: number) => {
    if (i < 0 || i >= navCount) return
    if (i < navOffset) pickPinned()
    else pickItem(listOptions[i - navOffset])
  }
  useEffect(() => {
    if (!open || active < 0) return
    const el = panelRef.current?.querySelector(`[data-nav-index="${active}"]`) as
      | (HTMLElement & { scrollIntoView?: (o?: ScrollIntoViewOptions) => void })
      | null
    el?.scrollIntoView?.({ block: 'nearest' })
  }, [open, active])
  // A waiting Enter (see pendingEnterRef) picks once the typed text's answer
  // is on screen — the same pick Enter makes on a settled list.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on the listed inputs only; the helpers it calls read refs
  useEffect(() => {
    const want = pendingEnterRef.current
    if (want === null) return
    if (!open || want !== query) {
      pendingEnterRef.current = null
      return
    }
    if (!optionsSettled) return
    pendingEnterRef.current = null
    if (active >= 0) pickAt(active)
    else if (navCount === 1 && data !== undefined && !showingCloseMatches) pickAt(0)
  }, [open, query, optionsSettled, active, navCount])
  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (navCount > 0) setActiveIndex(active < 0 ? 0 : Math.min(active + 1, navCount - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (navCount > 0) setActiveIndex(active <= 0 ? 0 : active - 1)
    } else if (e.key === 'Home' && navCount > 0 && !query) {
      e.preventDefault()
      setActiveIndex(0)
    } else if (e.key === 'End' && navCount > 0 && !query) {
      e.preventDefault()
      setActiveIndex(navCount - 1)
    } else if (e.key === 'Enter') {
      // Never submits a surrounding form. Picks the highlighted option, or the
      // only one left (a typed project number that leaves one match). While
      // the answer for the typed text is still out, the pick waits for it.
      e.preventDefault()
      if (query.trim() && !optionsSettled) pendingEnterRef.current = query
      else if (active >= 0) pickAt(active)
      // A sole option only once the list is in — while the first list loads
      // the pinned Default is the only row (army9 review L1).
      else if (navCount === 1 && optionsSettled && data !== undefined && !showingCloseMatches)
        pickAt(0)
    } else if (e.key === 'Tab') {
      // The panel is portaled to the end of the page: move focus back to the
      // trigger first so Tab continues to the NEXT FIELD, not off the page.
      setOpen(false)
      triggerRef.current?.focus()
    }
  }
  const onTriggerKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return
    const printable =
      e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && (open || e.key !== ' ')
    if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault()
      setOpen(true)
    } else if (printable) {
      // Typing on a closed picker opens it with that text searched. Keys that
      // land on the trigger after it opened — a fast typist, or a busy page
      // that has not moved focus into the search box yet — are ADDED to the
      // search, never dropped (army9 b01 HIGH: "201943" kept only "2" and
      // Enter picked the first project containing a 2).
      e.preventDefault()
      const typed = e.key
      pendingEnterRef.current = null
      // Always appended: a closed picker's search is empty, and a key that
      // arrives before React re-rendered must not replace the earlier ones.
      // A space never starts the search or doubles one (army9 review L2: it
      // sent a server search for " ").
      setQuery((q) => (typed === ' ' && (q === '' || q.endsWith(' ')) ? q : q + typed))
      if (!open) setOpen(true)
      else focusSearch()
    } else if (open && e.key === 'Backspace') {
      e.preventDefault()
      pendingEnterRef.current = null
      setQuery((q) => q.slice(0, -1))
      focusSearch()
    } else if (
      open &&
      (e.key === 'Enter' ||
        e.key === 'ArrowDown' ||
        e.key === 'ArrowUp' ||
        e.key === 'Home' ||
        e.key === 'End')
    ) {
      // The list is open but focus is still on the trigger: these keys mean
      // what they mean in the search box (Enter picks, it does not toggle).
      onSearchKeyDown(e as unknown as React.KeyboardEvent<HTMLInputElement>)
      focusSearch()
    }
  }

  // Report upward. Deliberately AFTER availability has resolved: reporting
  // `false` while the probe is in flight would clear a real flag on every
  // re-render.
  const reportStale = useStaleFieldReporter()
  useEffect(() => {
    if (!reportStale || !fieldKey || availabilityData === undefined) return
    reportStale(fieldKey, isStale)
  }, [reportStale, fieldKey, isStale, availabilityData])

  if (requiredParent) {
    return (
      <button
        type='button'
        disabled
        className='flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 text-sm text-left opacity-50 cursor-not-allowed'
      >
        <span className='truncate text-muted-foreground'>Select {requiredParent} first</span>
        <ChevronDown className='h-4 w-4 shrink-0 opacity-50' />
      </button>
    )
  }

  return (
    // Stale tooltip binds on the WRAPPER: a disabled trigger button swallows
    // mouse events, so a locked-but-stale field would never show the hint.
    <div ref={rootRef} className='relative' {...staleTip.bind}>
      {selectedUnreadable ? (
        // A value the reader cannot open is words, not a button: the field
        // says the value is hidden from them (or gone) and, when it may be
        // edited, offers the one thing they can do about it. It used to be
        // the picker's own button reading "Record not found" — a broken
        // record with a control that explained nothing (production review
        // 2026-11-12); locked, that button was dead as well.
        <div
          data-related-unavailable-field=''
          className='flex h-9 w-full items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 text-sm dark:border-border dark:bg-muted/40'
        >
          <span className='min-w-0 flex-1 truncate'>
            <RelatedMissingLabel error={selectedError} collection={collection} id={value} />
          </span>
          {!disabled && (
            <button
              ref={triggerRef}
              type='button'
              aria-haspopup='listbox'
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
              onKeyDown={onTriggerKeyDown}
              className='-mr-1.5 shrink-0 rounded px-1.5 py-0.5 text-[12px] font-medium text-slate-600 hover:bg-slate-200/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60 dark:text-slate-300 dark:hover:bg-white/10'
            >
              Change
            </button>
          )}
        </div>
      ) : (
        <button
          ref={triggerRef}
          type='button'
          disabled={disabled}
          aria-haspopup='listbox'
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          onKeyDown={onTriggerKeyDown}
          className={cn(
            'flex h-9 w-full items-center justify-between gap-2 rounded-md border bg-background px-3 text-sm text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60 disabled:pointer-events-none disabled:opacity-50',
            isStale ? 'border-amber-300 dark:border-amber-600' : 'border-input'
          )}
        >
          {showLoader ? (
            <Loader2 className='h-3.5 w-3.5 animate-spin text-muted-foreground' />
          ) : (
            <span
              className={cn(
                'flex items-center gap-1.5 truncate min-w-0',
                (!selectedLabel || selectedLabel === NAMELESS_LABEL) && 'text-muted-foreground'
              )}
            >
              {isStale && (
                <>
                  <AlertTriangle
                    aria-hidden='true'
                    className='h-3.5 w-3.5 shrink-0 text-amber-500'
                  />
                  <span className='sr-only'>Not an available option: </span>
                </>
              )}
              <span className='truncate'>{selectedLabel ?? placeholder ?? 'Select…'}</span>
            </span>
          )}
          <ChevronDown className='h-4 w-4 shrink-0 opacity-50' />
        </button>
      )}
      {staleTip.tip}
      {open &&
        panelStyle &&
        portalEl &&
        createPortal(
          <div
            ref={panelRef}
            data-nvr-combobox-panel=''
            style={panelStyle}
            className={cn(
              'nvr-pop-in rounded-md border border-border bg-popover shadow-md',
              facets?.length ? 'w-[560px] max-w-[92vw]' : 'min-w-[240px] w-max max-w-[360px]'
            )}
          >
            {!!facets?.length && (
              <div className='grid grid-cols-2 gap-2 border-b border-border bg-slate-50/60 p-2 dark:bg-muted/40'>
                {facets.map((f) => {
                  const target = facetTargets[f.field]
                  if (!target) return null
                  return (
                    <div key={f.field}>
                      <p className='mb-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-400'>
                        {f.label ?? f.field}
                      </p>
                      <RelationCombobox
                        collection={target}
                        value={facetSel[f.field] ?? null}
                        onChange={(v) => setFacetSel((prev) => ({ ...prev, [f.field]: v }))}
                        placeholder='Any'
                        optionSort={f.sort}
                        extraFilter={f.filter}
                      />
                    </div>
                  )
                })}
              </div>
            )}
            <div className='flex items-center border-b px-3'>
              <Search className='mr-2 h-4 w-4 shrink-0 opacity-50' />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => {
                  pendingEnterRef.current = null
                  setQuery(e.target.value)
                }}
                onKeyDown={onSearchKeyDown}
                role='combobox'
                aria-expanded
                aria-autocomplete='list'
                aria-controls={`${listId}-list`}
                aria-activedescendant={active >= 0 ? optionDomId(active) : undefined}
                placeholder='Search…'
                className='flex h-9 w-full bg-transparent py-3 text-[13px] outline-none placeholder:text-muted-foreground'
              />
              {/* A newer search is out while the last answer stays listed. */}
              {isLoadingOptions && data !== undefined && (
                <Loader2
                  data-picker-searching
                  className='ml-2 h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground'
                />
              )}
            </div>
            <div id={`${listId}-list`} role='listbox' className='max-h-52 overflow-y-auto py-1'>
              {!!value && !disabled && (
                <button
                  type='button'
                  tabIndex={-1}
                  onClick={() => {
                    clearByUser()
                    closeAndRefocus()
                  }}
                  className='flex w-full items-center gap-2 px-3 py-1.5 text-[13px] text-slate-500 hover:bg-muted border-b border-slate-100 dark:text-slate-400 dark:border-border'
                >
                  <X className='h-3.5 w-3.5 text-slate-400' />
                  Clear selection
                </button>
              )}
              {pinnedShown && (
                <button
                  type='button'
                  tabIndex={-1}
                  id={optionDomId(0)}
                  role='option'
                  aria-selected={String(value) === pinnedId}
                  data-nav-index={0}
                  data-nvr-pinned-option
                  onClick={pickPinned}
                  onMouseMove={() => active !== 0 && setActiveIndex(0)}
                  className={cn(
                    'flex w-full items-center gap-2 border-b border-slate-100 px-3 py-1.5 text-left text-[13px] hover:bg-nvr-cyan/10 dark:border-border',
                    active === 0 ? 'bg-nvr-cyan/10' : 'bg-nvr-cyan/5'
                  )}
                >
                  <div
                    className={cn(
                      'flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors',
                      String(value) === pinnedId
                        ? 'border-nvr-cyan bg-nvr-cyan'
                        : 'border-slate-300'
                    )}
                  >
                    {String(value) === pinnedId && <Check className='h-2.5 w-2.5 text-white' />}
                  </div>
                  <span className='min-w-0 flex-1 truncate'>
                    {pinnedItem === undefined ? 'Loading…' : pinnedLabel}
                  </span>
                  <span className='shrink-0 rounded bg-nvr-cyan/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-700 dark:text-foreground'>
                    {pinned?.tag ?? 'Default'}
                  </span>
                </button>
              )}
              {data === undefined && isLoadingOptions ? (
                <div className='flex items-center justify-center py-4'>
                  <Loader2 className='h-4 w-4 animate-spin text-muted-foreground' />
                </div>
              ) : listOptions.length === 0 && !optionsSettled ? (
                <p className='px-3 py-2 text-[13px] text-muted-foreground'>Searching…</p>
              ) : listOptions.length === 0 ? (
                pinnedShown && query.trim() ? null : narrowedBy &&
                  narrowedBy.labels.length > 0 &&
                  !query.trim() ? (
                  <div className='px-3 py-2 text-[12px] leading-5 text-muted-foreground'>
                    <p>
                      No options for{' '}
                      <span className='font-medium text-foreground'>
                        {narrowedBy.labels.join(' · ')}
                      </span>
                      {narrowedBy.onClear
                        ? ' — clear one to widen the list:'
                        : '. Change it, or ask an administrator to add options for it.'}
                    </p>
                    {narrowedBy.onClear && (
                      <div className='mt-1.5 flex flex-wrap gap-1.5'>
                        {narrowedBy.keys.map((k, i) =>
                          narrowedBy.clearable && !narrowedBy.clearable.includes(k) ? null : (
                            <button
                              key={k}
                              type='button'
                              onClick={(e) => {
                                e.stopPropagation()
                                narrowedBy.onClear?.(k)
                              }}
                              className='rounded-md border border-border bg-background px-2 py-0.5 text-[11.5px] font-medium text-foreground transition-colors duration-150 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
                            >
                              Clear {narrowedBy.labels[i] ?? k}
                            </button>
                          )
                        )}
                      </div>
                    )}
                  </div>
                ) : (
                  <p className='px-3 py-2 text-[13px] text-muted-foreground'>
                    {query.trim() ? `No results for “${query.trim()}”` : 'No results'}
                  </p>
                )
              ) : (
                <>
                  {showingCloseMatches && (
                    <p
                      data-picker-close-matches
                      className='px-3 pb-1 pt-2 text-[11.5px] text-muted-foreground'
                    >
                      No exact match for “{query.trim()}” — did you mean:
                    </p>
                  )}
                  {listOptions.map((item, i) => {
                    const raw = applyDisplayTemplate(tmpl, item)
                    const label = isNamelessLabel(raw) ? NAMELESS_LABEL : raw
                    const sel = String(item.id) === String(value)
                    const nav = i + navOffset
                    return (
                      <button
                        key={String(item.id)}
                        type='button'
                        tabIndex={-1}
                        id={optionDomId(nav)}
                        role='option'
                        aria-selected={sel}
                        data-nav-index={nav}
                        onClick={() => pickItem(item)}
                        onMouseMove={() => active !== nav && setActiveIndex(nav)}
                        className={cn(
                          'flex w-full items-center gap-2 px-3 py-1.5 text-[13px] text-left hover:bg-muted',
                          active === nav && 'bg-muted'
                        )}
                      >
                        <div
                          className={cn(
                            'flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors',
                            sel ? 'border-nvr-cyan bg-nvr-cyan' : 'border-slate-300'
                          )}
                        >
                          {sel && <Check className='h-2.5 w-2.5 text-white' />}
                        </div>
                        {isUserCollection && (
                          <UserAvatar
                            userId={item.id as string}
                            className='h-4 w-4'
                            fallback={
                              <span className='flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-nvr-cyan/20 text-[8px] font-bold text-nvr-navy dark:text-nvr-cyan'>
                                {labelInitials(label)}
                              </span>
                            }
                          />
                        )}
                        {isUserCollection && onlineUsers.has(String(item.id).toUpperCase()) && (
                          <span
                            className='h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500'
                            data-tip='Online now'
                          />
                        )}
                        {/* The typed words marked in the label (lib/search-text.ts). */}
                        <SearchHighlight text={label} query={query} />
                        {dupDetail.has(String(item.id)) && (
                          <span
                            className='ml-auto max-w-[45%] shrink-0 truncate pl-2 text-[11.5px] text-muted-foreground'
                            data-option-detail
                          >
                            {dupDetail.get(String(item.id))}
                          </span>
                        )}
                      </button>
                    )
                  })}
                </>
              )}
            </div>
            {!isLoadingOptions && (
              <PickerNarrowingNote
                collection={collection}
                search={debouncedQuery}
                filter={combinedFilter}
                narrowedLabels={narrowedBy?.labels ?? []}
                auto={(data ?? []).length === 0 && !!debouncedQuery}
              />
            )}
          </div>,
          portalEl
        )}
    </div>
  )
}

// ─── PickerNarrowingNote (#537) ────────────────────────────────────────────────

interface Narrowing {
  shown: number
  by_field_filter: number
  by_exclusions: number
  scopes: string[]
  row_filter: boolean
}

/**
 * "Missing something?" under a picker's options. A narrowed list used to look
 * exactly like an absent record; this asks the server which curation hid
 * matches — in counts only for rows the viewer may read, and by NAME only for
 * scope / role narrowing (never a count of rows the viewer cannot see).
 * Fires on its own when a search finds nothing; otherwise on click.
 */
function PickerNarrowingNote({
  collection,
  search,
  filter,
  narrowedLabels,
  auto
}: {
  collection: string
  search: string
  filter: Record<string, unknown> | undefined
  narrowedLabels: string[]
  auto: boolean
}) {
  const client = useNivaroClient()
  const [asked, setAsked] = useState(false)
  const filterKey = filter ? JSON.stringify(filter) : ''
  const { data, isFetching } = useQuery<Narrowing>({
    queryKey: ['picker-narrowing', collection, search, filterKey],
    queryFn: () =>
      client
        .request<{ data: Narrowing }>(
          post('/picker-narrowing', { collection, search, filter: filter ?? null })
        )
        .then((r) => r.data),
    enabled: asked || auto,
    staleTime: 30_000,
    retry: false
  })
  if (!asked && !auto)
    return (
      <button
        type='button'
        onClick={(e) => {
          e.stopPropagation()
          setAsked(true)
        }}
        className='w-full border-t border-border px-3 py-1.5 text-left text-[11px] text-muted-foreground hover:text-foreground'
        data-picker-narrowing-ask
      >
        Missing something?
      </button>
    )
  if (isFetching && !data)
    return (
      <p className='border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground'>
        Checking what narrows this list…
      </p>
    )
  if (!data) return null
  const lines: string[] = []
  const what = search ? `match “${search}”` : 'exist'
  if (data.by_field_filter > 0)
    lines.push(
      `${data.by_field_filter.toLocaleString()} more ${what} but this field only offers ${
        narrowedLabels.length
          ? `records that fit ${narrowedLabels.join(' · ')}`
          : 'records its filter allows'
      }.`
    )
  if (data.by_exclusions > 0)
    lines.push(
      `${data.by_exclusions.toLocaleString()} ${data.by_exclusions === 1 ? 'is' : 'are'} hidden from pickers by an admin.`
    )
  if (data.scopes.length > 0)
    lines.push(`Your ${data.scopes.join(', ')} access narrows what you can pick here.`)
  if (data.row_filter) lines.push('Your role only sees some of these records.')
  if (lines.length === 0)
    lines.push(
      search
        ? `Nothing else you can see matches “${search}”.`
        : 'Nothing narrows this list — every record you can see is offered.'
    )
  return (
    <div
      className='space-y-0.5 border-t border-border px-3 py-1.5 text-[11px] leading-4 text-muted-foreground'
      data-picker-narrowing
      data-picker-narrowing-field={data.by_field_filter}
      data-picker-narrowing-excluded={data.by_exclusions}
    >
      {lines.map((l) => (
        <p key={l}>{l}</p>
      ))}
    </div>
  )
}

// ─── RelatedItemLabel ──────────────────────────────────────────────────────────

export function RelatedItemLabel({
  collection,
  id,
  displayTemplate,
  explainMissing
}: {
  collection: string
  id: unknown
  displayTemplate?: string | null
  /** A row that cannot be read asks the server whether it is hidden from the
   *  reader or gone (one extra read). For a record's own single value — not
   *  for lists of chips, where every unreadable row would ask. */
  explainMissing?: boolean
}) {
  const client = useNivaroClient()
  const readRow = useRecordReader()
  const isFiles = collection === 'nivaro_files' || collection === 'directus_files'
  // A dotted display template needs the nested expansion — the bare row only
  // carries FK ids and every such label rendered as '-'.
  const nestedFields = (() => {
    if (!displayTemplate || !displayTemplate.includes('.')) return null
    const tokens = [...displayTemplate.matchAll(/\{\{([^}]+)\}\}/g)].map((m) => m[1].trim())
    return tokens.length > 0 ? ['id', ...tokens].join(',') : null
  })()
  const { data, isLoading, error } = useQuery<Record<string, unknown>>({
    queryKey: ['relation-single', collection, String(id), nestedFields ?? ''],
    queryFn: () =>
      isFiles
        ? // The file's row, not its bytes: GET /files/:id downloads the whole
          // file (twice with the retry, 404 when storage lost it) only to read
          // its name, and a missing object left the raw id as the label.
          client
            .request<{ data: Record<string, unknown> }>(
              get(`/files/${encodeURIComponent(String(id))}/meta`)
            )
            .then((r) => r.data)
        : (readRow(collection, id as string | number, nestedFields) as Promise<
            Record<string, unknown>
          >),
    enabled: !!id && !!collection,
    staleTime: 60_000,
    retry: retryRelatedRead
  })
  if (isLoading) return <Loader2 className='h-3 w-3 animate-spin text-slate-400' />
  // A row the reader can't open says why in words (refused / not found /
  // failed to load) — never its raw id (army8 b01 "Find a Unit 273025").
  if (!data)
    return id == null || id === '' ? null : (
      <RelatedMissingLabel
        error={error}
        collection={explainMissing ? collection : null}
        id={explainMissing ? id : null}
      />
    )
  if (isFiles) {
    const label = (data.title ||
      data.filename_download ||
      data.filename_disk ||
      String(id)) as string
    return <span>{label}</span>
  }
  const text = applyDisplayTemplate(displayTemplate, data)
  if (isNamelessLabel(text))
    return <span className='italic text-muted-foreground'>{NAMELESS_LABEL}</span>
  return <span>{text}</span>
}

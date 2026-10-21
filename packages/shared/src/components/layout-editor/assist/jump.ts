import { HEADER_GROUP_KEY, type LayoutBundle, type PlacementRow } from '../../../lib/layout-ops'
import type { DesignTarget } from '../design-context'
import { SUBTITLE_FIELD } from '../inspector/model'
import type { SettingEntry } from './settings-index'

/**
 * Jump to a control (#2676): open the panel it lives in, pick something it
 * applies to when it is an inspector control (the selected field or section
 * if it fits, else the first one on the form), switch to its tab, then scroll
 * to `[data-setting="<key>"]` and flash it. DOM-driven on purpose: the panels
 * keep their own tab state, and the parity keys are already on every control.
 */

export interface JumpEnv {
  bundle: LayoutBundle
  selection: DesignTarget[]
  /** Select on the canvas (the right panel shows the inspector). */
  select(t: DesignTarget): void
  openSettings(): void
  openAddPanel(): void
  /** The editor's root element. */
  root: HTMLElement | null
}

export type JumpResult = { ok: true } | { ok: false; message: string }

const isSlotField = (f: string) => /^__[a-z][a-z0-9_-]*__$/.test(f) && f !== SUBTITLE_FIELD

function realField(p: PlacementRow) {
  return !p.field.startsWith('__') && p.widget_id == null && p.group_key !== HEADER_GROUP_KEY
}

/** What an inspector control needs selected, or why nothing on this form fits. */
export function targetFor(
  entry: SettingEntry,
  bundle: LayoutBundle,
  selection: DesignTarget[]
): DesignTarget | { none: string } {
  const prefix = entry.key.split('.')[0]
  const sel = selection.length === 1 ? selection[0] : null
  const placements = bundle.placements
  switch (prefix) {
    case 'group': {
      if (sel?.kind === 'group' && !sel.key.startsWith('__')) return sel
      const g = bundle.groups.find((x) => !x.key.startsWith('__'))
      return g ? { kind: 'group', key: g.key } : { none: 'This form has no sections yet' }
    }
    case 'slot':
    case 'pdf_button': {
      if (sel?.kind === 'slot' && isSlotField(sel.field)) return sel
      const p = placements.find(
        (x) => isSlotField(x.field) && (prefix === 'slot' || x.field === '__pdf__')
      )
      return p
        ? { kind: 'slot', field: p.field, group_key: p.group_key }
        : { none: prefix === 'slot' ? 'This form has no panels' : 'This form has no PDF button' }
    }
    case 'widget': {
      const p = placements.find((x) => x.widget_id != null)
      return p
        ? { kind: 'slot', field: p.field, group_key: p.group_key }
        : { none: 'This form has no widgets' }
    }
    case 'header': {
      if (sel?.kind === 'header' && sel.field !== SUBTITLE_FIELD) return sel
      const p = placements.find(
        (x) => x.group_key === HEADER_GROUP_KEY && x.field !== SUBTITLE_FIELD
      )
      return p
        ? { kind: 'header', field: p.field }
        : { none: 'This form has no header strip items' }
    }
    case 'subtitle':
      return placements.some((x) => x.field === SUBTITLE_FIELD)
        ? { kind: 'header', field: SUBTITLE_FIELD }
        : { none: 'This form has no subtitle' }
    default: {
      if (sel?.kind === 'field' && !sel.field.startsWith('__')) return sel
      // The first field as the form shows it: by section order, then within the section.
      const order = new Map(bundle.groups.map((g, i) => [g.key, i]))
      const p = placements
        .filter(realField)
        .sort(
          (a, b) =>
            (order.get(a.group_key ?? '') ?? 1e6) - (order.get(b.group_key ?? '') ?? 1e6) ||
            a.sort - b.sort
        )[0]
      return p
        ? { kind: 'field', field: p.field, group_key: p.group_key }
        : { none: 'This form has no fields yet' }
    }
  }
}

const nextFrame = () =>
  new Promise<void>((r) =>
    typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(() => r())
      : setTimeout(r, 16)
  )

/** Polls for an element over a few frames (the panel renders after the state change). */
export async function waitFor<T>(find: () => T | null, timeoutMs = 1500): Promise<T | null> {
  const end = Date.now() + timeoutMs
  for (;;) {
    const v = find()
    if (v) return v
    if (Date.now() > end) return null
    await nextFrame()
  }
}

/** Scroll a control into view, outline it for a moment and focus it. */
export function flashSetting(el: HTMLElement): void {
  el.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
  const prev = {
    outline: el.style.outline,
    outlineOffset: el.style.outlineOffset,
    borderRadius: el.style.borderRadius,
    background: el.style.background
  }
  el.setAttribute('data-setting-found', '')
  el.style.outline = '2px solid var(--nvr-cyan, #00ceff)'
  el.style.outlineOffset = '3px'
  el.style.borderRadius = el.style.borderRadius || '6px'
  el.style.background = 'rgb(var(--nvr-cyan-rgb, 0 206 255) / 0.08)'
  const focusable = el.matches('input, textarea, button, [role="switch"], [tabindex]')
    ? el
    : el.querySelector<HTMLElement>('input, textarea, [role="switch"], button, [tabindex]')
  focusable?.focus({ preventScroll: true })
  setTimeout(() => {
    el.removeAttribute('data-setting-found')
    Object.assign(el.style, prev)
  }, 2600)
}

// Keys are letters, digits and . _ : - — quoted, with quotes and backslashes escaped anyway.
const settingSel = (key: string) => `[data-setting="${key.replace(/["\\]/g, '\\$&')}"]`

export async function jumpToSetting(entry: SettingEntry, env: JumpEnv): Promise<JumpResult> {
  const root = env.root
  if (!root) return { ok: false, message: 'The editor is not open' }
  const find = (scope: string) =>
    root.querySelector<HTMLElement>(`${scope} ${settingSel(entry.key)}`)

  if (entry.home === 'form_settings') {
    env.openSettings()
    let el = await waitFor(() => find('[data-form-settings]'), 800)
    if (!el) {
      // A search typed into Form settings may be hiding it: clear it and look again.
      const clear = root.querySelector<HTMLElement>(
        '[data-form-settings] [aria-label="Clear search"]'
      )
      if (clear) {
        clear.click()
        el = await waitFor(() => find('[data-form-settings]'), 800)
      }
    }
    if (!el)
      return {
        ok: false,
        message: `“${entry.label}” is not offered for this kind of layout.`
      }
    flashSetting(el)
    return { ok: true }
  }

  if (entry.home === 'inspector') {
    const target = targetFor(entry, env.bundle, env.selection)
    if ('none' in target)
      return {
        ok: false,
        message: `${target.none}, so there is nothing to show “${entry.label}” on.`
      }
    env.select(target)
    await nextFrame()
    const panel = '[data-editor-inspector]'
    if (entry.place && !INSPECTOR_NO_TABS.has(entry.place)) {
      const tab = await waitFor(() => {
        const tabs = [...root.querySelectorAll<HTMLElement>(`${panel} [role="tab"]`)]
        if (tabs.length === 0) return null
        return (
          tabs.find((t) => {
            const text = t.textContent?.trim()
            return text === entry.place || (entry.place === 'Grid' && text === 'Table')
          }) ?? ('missing' as const)
        )
      })
      if (tab === 'missing' || tab === null)
        return {
          ok: false,
          message: `“${entry.label}” is on the ${entry.place} tab, which only some fields have. Select such a field and open that tab.`
        }
      if (tab.getAttribute('aria-selected') !== 'true') tab.click()
    }
    const el = await waitFor(() => find(panel))
    if (!el)
      return {
        ok: false,
        message: `“${entry.label}” is in ${entry.where}, but the selected item does not offer it.`
      }
    flashSetting(el)
    return { ok: true }
  }

  if (entry.home === 'add_panel') env.openAddPanel()
  const el = await waitFor(() => root.querySelector<HTMLElement>(settingSel(entry.key)), 600)
  if (el) {
    flashSetting(el)
    return { ok: true }
  }
  return {
    ok: false,
    message:
      entry.home === 'overview'
        ? `“${entry.label}” is on the Layouts overview (${entry.place}). Leave the editor with Layouts to get there.`
        : `“${entry.label}” is in ${entry.where}.`
  }
}

/** Inspector places that are panels without tabs. */
const INSPECTOR_NO_TABS = new Set([
  'Group',
  'Slot',
  'Widget',
  'Header item',
  'Subtitle',
  'All tabs'
])

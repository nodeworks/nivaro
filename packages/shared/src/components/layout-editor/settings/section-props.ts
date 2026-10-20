import type { LayoutBundle, LayoutPatch } from '../../../lib/layout-ops'
import { type LayoutKind, settingDef } from './settings-registry'

/** What every Form settings section gets from the panel. */
export interface SectionProps {
  bundle: LayoutBundle
  /** bundle.layout with its columns readable by name. */
  layout: Record<string, unknown>
  kind: LayoutKind
  collection: string
  /** One `layout_update` op, one undo step labelled in plain words. */
  set(patch: LayoutPatch, label: string): void
  /** Typing: coalesced per setting and sent after a pause; call flush() on blur. */
  setText(patch: LayoutPatch, label: string): void
  flush(): void
}

/** A stored bit / boolean read as a boolean. */
export const flag = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true'

/** "Turn on Hide comments" / "Turn off Hide comments". */
export function toggleLabel(key: string, on: boolean): string {
  return `Turn ${on ? 'on' : 'off'} ${settingDef(key)?.label ?? key}`
}

export function changeLabel(key: string): string {
  return `Change ${settingDef(key)?.label ?? key}`
}

/** `layout.disable_comments` → `disable_comments`. */
export const column = (key: string) => key.replace(/^layout\./, '')

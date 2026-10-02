/** Small shared pieces of the investigation actions: button classes, the stack hook, file saves. */
import { useSyncExternalStore } from 'react'
import { getInspectSnapshot, type InspectStackState, subscribeInspect } from '../../inspect/stack'

export const ICON_BTN =
  'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--tm-fg-2)] transition-colors duration-150 ease-out hover:bg-[var(--tm-card-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan disabled:cursor-not-allowed disabled:opacity-40'
export const ICON_BTN_ON = 'bg-[var(--tm-card-2)] text-[var(--tm-fg)]'
export const POP =
  'traffic-map border-[var(--tm-line)] bg-[var(--tm-card)] p-3 text-[12.5px] text-[var(--tm-fg)]'
export const MENU_ITEM =
  'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12.5px] text-[var(--tm-fg)] hover:bg-[var(--tm-card-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan disabled:cursor-not-allowed disabled:opacity-50'
export const FIELD =
  'w-full rounded-md border border-[var(--tm-line)] bg-[var(--tm-card)] px-2.5 py-1.5 text-[12.5px] text-[var(--tm-fg)] placeholder:text-[var(--tm-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
export const MUTED = 'text-[12px] text-[var(--tm-muted)]'

export function useInspectStack(): InspectStackState {
  return useSyncExternalStore(subscribeInspect, getInspectSnapshot, getInspectSnapshot)
}

/** Save `text` as a file named `name` (the browser's own download). */
export function downloadText(name: string, text: string, type: string): void {
  const blob = new Blob([text], { type })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Copy to the clipboard; false when the browser refused. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/** Status + server code + message of a failed admin call. */
export function apiErrorOf(err: unknown): {
  status: number | null
  code: string | null
  message: string
} {
  const e = err as {
    response?: { status?: number; data?: { error?: string; code?: string } }
    message?: string
  }
  return {
    status: e?.response?.status ?? null,
    code: e?.response?.data?.code ?? null,
    message: e?.response?.data?.error ?? e?.message ?? 'Something went wrong'
  }
}

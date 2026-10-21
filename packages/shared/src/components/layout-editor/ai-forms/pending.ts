import { useEffect } from 'react'
import { toast } from 'sonner'
import type { LayoutBundle } from '../../../lib/layout-ops'
import type { LayoutDraft } from '../useLayoutDraft'
import type { AiPlan } from './plan'

/**
 * A new layout made from an AI proposal (overview "Start with AI", the
 * editor's lighter version for a role) is created empty; its content is
 * handed to the editor here and applied through the editor's draft once its
 * bundle loads — one undo step that the admin still saves (or discards).
 * In memory only: the overview and the editor share the page.
 */

export interface PendingBuild {
  /** The undo step's name. */
  label: string
  /** Planned against the new layout's bundle when it loads. */
  plan(bundle: LayoutBundle): AiPlan
  /** The toast once applied. */
  done: string
}

const pending = new Map<number, PendingBuild>()

export function stashBuild(layoutId: number, build: PendingBuild): void {
  pending.set(layoutId, build)
}

export function hasPendingBuild(layoutId: number): boolean {
  return pending.has(layoutId)
}

/** Apply the build waiting for this layout, once, when its bundle is loaded. */
export function usePendingBuild(layoutId: number, draft: Pick<LayoutDraft, 'bundle' | 'apply'>) {
  const bundle = draft.bundle
  const apply = draft.apply
  useEffect(() => {
    if (!bundle || Number(bundle.layout.id) !== layoutId) return
    const build = pending.get(layoutId)
    if (!build) return
    pending.delete(layoutId)
    const plan = build.plan(bundle)
    if (plan.ops.length === 0) {
      toast.error('The AI proposal no longer fits this layout — nothing was changed')
      return
    }
    apply(plan.ops, { label: build.label })
    toast.success(build.done)
  }, [layoutId, bundle, apply])
}

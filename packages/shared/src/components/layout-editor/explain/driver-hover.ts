import { useEffect, useRef } from 'react'
import { dependentsOf, type RuleDep } from './rule-graph'

/**
 * Hover a field that drives others (#2641): every section, picker, grid and
 * field its value controls gets a dashed ring, and the field a "Controls n"
 * tag (DesignNode's DRIVER_CLS styles both). Plain DOM attributes on the
 * canvas nodes, set and cleared on pointer moves: a hover never re-renders
 * the form.
 */

/** The field a design node stands for (`field:x:group`, `header:x`), else null. */
export function fieldOfTargetKey(key: string): string | null {
  const m = /^(?:field|header):([^:]+)/.exec(key)
  return m ? m[1] : null
}

// A quoted attribute value: only `"` and `\` need escaping.
const quoted = (v: string) => `"${v.replace(/["\\]/g, '\\$&')}"`

/** CSS selectors for the canvas nodes a dependency points at. */
export function dependentSelectors(dep: RuleDep): string[] {
  if (dep.target.kind === 'group')
    return [`[data-design-target=${quoted(`group:${dep.target.key}`)}]`]
  const f = dep.target.field
  return [
    `[data-design-target^=${quoted(`field:${f}:`)}]`,
    `[data-design-target=${quoted(`header:${f}`)}]`
  ]
}

const KIND_WORD: Record<RuleDep['kind'], string> = {
  visibility: 'shows',
  skip: 'skips',
  cascade: 'filters',
  field_rule: 'fills',
  parent_cascade: 'fills lines',
  row_rule: 'row rules'
}

export function useDriverHover(deps: RuleDep[]) {
  const ref = useRef<HTMLDivElement | null>(null)
  const depsRef = useRef(deps)
  depsRef.current = deps
  useEffect(() => {
    const root = ref.current
    if (!root) return
    let current: Element | null = null
    const lit: Element[] = []
    const clear = () => {
      for (const el of lit) {
        el.removeAttribute('data-rule-dependent')
        el.removeAttribute('data-rule-drives')
      }
      lit.length = 0
      current = null
    }
    const onOver = (e: PointerEvent) => {
      const node = (e.target as Element | null)?.closest?.('[data-design-target]') ?? null
      if (node === current) return
      clear()
      if (!node || !root.contains(node)) return
      const field = fieldOfTargetKey(node.getAttribute('data-design-target') ?? '')
      if (!field) return
      const deps = dependentsOf(depsRef.current, field)
      if (deps.length === 0) return
      current = node
      const seen = new Set<Element>()
      for (const d of deps)
        for (const el of root.querySelectorAll(dependentSelectors(d).join(','))) {
          if (el === node || seen.has(el)) continue
          seen.add(el)
          el.setAttribute('data-rule-dependent', KIND_WORD[d.kind])
          lit.push(el)
        }
      node.setAttribute('data-rule-drives', `Controls ${deps.length}`)
      lit.push(node)
    }
    const onOut = (e: PointerEvent) => {
      const to = e.relatedTarget as Node | null
      if (!to || !root.contains(to)) clear()
    }
    root.addEventListener('pointerover', onOver)
    root.addEventListener('pointerout', onOut)
    return () => {
      root.removeEventListener('pointerover', onOver)
      root.removeEventListener('pointerout', onOut)
      clear()
    }
  }, [])
  return ref
}

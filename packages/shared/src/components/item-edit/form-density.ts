import { useInsertionEffect } from 'react'

/**
 * Form density (#3182): a per-form setting (entry_config.density) that changes the spacing
 * of the record form people fill in — section headers and bodies, the field grid's gaps,
 * the label-to-control gap and (with a mouse) control heights. Comfortable is today's
 * spacing and writes nothing; compact is the only stored value.
 *
 * The form root carries `data-form-density="compact"`; these rules key on it plus the data
 * attributes the form already stamps (or that GroupSection / RecordReadView add for this),
 * never on utility classes alone: host CSS (efp-new) loads after full.css and re-emits the
 * same utilities, so an attribute-qualified selector is what wins in both apps.
 * Touch screens keep their control heights (44 px targets); only the gaps tighten there.
 */
export type FormDensity = 'comfortable' | 'compact'

export function formDensityOf(config: { density?: unknown } | null | undefined): FormDensity {
  return config?.density === 'compact' ? 'compact' : 'comfortable'
}

const C = '[data-form-density=compact]'

export const FORM_DENSITY_CSS = `
${C} [data-form-body]{padding:1rem 1.25rem}
${C} [data-form-body]>:not([hidden])~:not([hidden]),${C} [data-section-stack]>:not([hidden])~:not([hidden]){margin-top:.625rem}
${C} [data-usage-header]{padding-top:.5rem;padding-bottom:.5rem}
${C} [data-section-body]{padding:.625rem 1rem .75rem}
${C} [data-section-grid]{row-gap:.625rem;column-gap:.875rem}
${C} [data-summary-strip]{padding-top:.375rem;padding-bottom:.375rem}
${C} [data-field]>:not([hidden])~:not([hidden]){margin-top:.25rem}
${C} [data-read-head]{padding-top:.375rem;padding-bottom:.375rem}
${C} [data-read-body]{padding:.75rem 1rem 1rem}
${C} [data-read-dl]{row-gap:.75rem;column-gap:1rem}
@media (hover: hover) and (pointer: fine){
${C} [data-section-key] .h-9{height:2rem}
${C} [data-section-key] .h-10{height:2.25rem}
${C} [data-section-key] textarea{min-height:3.5rem}
}
@media (max-width: 639px){
${C} [data-form-body]{padding:.75rem}
}
`
const STYLE_ID = 'nvr-form-density-css'

/** Puts the density rules in the document once (the first compact form that opens). */
export function useFormDensityCss(on: boolean) {
  useInsertionEffect(() => {
    if (!on || typeof document === 'undefined' || document.getElementById(STYLE_ID)) return
    const el = document.createElement('style')
    el.id = STYLE_ID
    el.textContent = FORM_DENSITY_CSS
    document.head.appendChild(el)
  }, [on])
}

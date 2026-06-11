import type { Command, NivaroClient } from '@nivaro/sdk'
import type React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useOptionalNivaroClient } from '../context'
import type {
  FormErrors,
  FormFieldDescriptor,
  FormGroupDescriptor,
  FormLockCondition,
  FormSchema,
  FormVisibilityRule,
  UseNivaroFormOptions,
  UseNivaroFormReturn
} from '../types'
import { useFormSchema } from './useFormSchema'

// Minimal command builders (avoid importing the SDK's internal `cmd`).
function get<T>(path: string, params?: Record<string, unknown>): Command<T> {
  return { _method: 'GET', _path: path, _params: params } as Command<T>
}
function post<T>(path: string, body?: unknown): Command<T> {
  return { _method: 'POST', _path: path, _body: body } as Command<T>
}
function patch<T>(path: string, body?: unknown): Command<T> {
  return { _method: 'PATCH', _path: path, _body: body } as Command<T>
}

// ─── Client-side condition evaluation ────────────────────────────────────────

function evaluateCondition(
  condition: { when: string; op: string; value?: unknown },
  values: Record<string, unknown>
): boolean {
  const fieldValue = values[condition.when]
  switch (condition.op) {
    case 'eq':
      return fieldValue === condition.value
    case 'neq':
      return fieldValue !== condition.value
    case 'null':
      return fieldValue == null || fieldValue === ''
    case 'nnull':
      return fieldValue != null && fieldValue !== ''
    case 'in':
      return Array.isArray(condition.value) && condition.value.includes(fieldValue)
    case 'contains':
      return (
        typeof fieldValue === 'string' && fieldValue.includes(String(condition.value ?? ''))
      )
    default:
      return true
  }
}

function isFieldVisible(
  rules: FormVisibilityRule[] | null,
  values: Record<string, unknown>
): boolean {
  if (!rules || rules.length === 0) return true
  // Each rule either reveals or conceals when its condition matches.
  // Resolve in order; later matching rules win. Default visible.
  let visible = true
  let sawShowRule = false
  for (const rule of rules) {
    const matched = evaluateCondition(rule, values)
    if (rule.action === 'show') {
      sawShowRule = true
      if (matched) visible = true
    } else if (rule.action === 'hide') {
      if (matched) visible = false
    }
  }
  // If there are only show-rules and none matched, the field stays hidden.
  if (sawShowRule) {
    const anyShowMatched = rules.some((r) => r.action === 'show' && evaluateCondition(r, values))
    const anyHideMatched = rules.some((r) => r.action === 'hide' && evaluateCondition(r, values))
    if (!anyShowMatched && !anyHideMatched) return false
  }
  return visible
}

function isFieldLocked(
  condition: FormLockCondition | null,
  values: Record<string, unknown>
): boolean {
  if (!condition) return false
  return evaluateCondition(condition, values)
}

// ─── Default value seeding ───────────────────────────────────────────────────

function seedDefaults(
  schema: FormSchema | null,
  defaults: Record<string, unknown> | undefined
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (schema) {
    for (const f of schema.fields) {
      if (f.defaultValue !== undefined && f.defaultValue !== null) {
        out[f.field] = f.defaultValue
      }
    }
  }
  if (defaults) Object.assign(out, defaults)
  return out
}

// ─── Validation ──────────────────────────────────────────────────────────────

function isEmpty(value: unknown): boolean {
  return (
    value == null ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  )
}

// ─── Hook ──────────────────────────────────────────────────────────────────

export function useNivaroForm(
  collection: string,
  options: UseNivaroFormOptions,
  client?: NivaroClient
): UseNivaroFormReturn {
  const contextClient = useOptionalNivaroClient()
  const resolvedClient = client ?? contextClient
  if (!resolvedClient) {
    throw new Error(
      'useNivaroForm requires a NivaroClient — pass one as the third argument or wrap the tree in <NivaroProvider>.'
    )
  }

  const {
    mode,
    itemId,
    defaultValues,
    onSuccess,
    onError,
    validate,
    includeHidden = false,
    layoutId
  } = options

  const {
    schema,
    loading: schemaLoading,
    error: schemaError
  } = useFormSchema(resolvedClient, collection, includeHidden, layoutId)

  const [values, setValuesState] = useState<Record<string, unknown>>({})
  const [initialValues, setInitialValues] = useState<Record<string, unknown>>({})
  const [errors, setErrors] = useState<FormErrors>({})
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [itemLoading, setItemLoading] = useState(mode === 'edit')
  const seededRef = useRef(false)
  const ruleDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Seed initial values once schema is loaded (and item loaded for edit mode).
  useEffect(() => {
    if (!schema || seededRef.current) return

    if (mode === 'edit' && itemId != null) {
      let active = true
      setItemLoading(true)
      resolvedClient
        .request<{ data: Record<string, unknown> }>(get(`/items/${collection}/${itemId}`))
        .then((res) => {
          if (!active) return
          const merged = { ...seedDefaults(schema, defaultValues), ...(res.data ?? {}) }
          setValuesState(merged)
          setInitialValues(merged)
          seededRef.current = true
          setItemLoading(false)
        })
        .catch((err: unknown) => {
          if (!active) return
          setItemLoading(false)
          onError?.(err instanceof Error ? err : new Error(String(err)))
        })
      return () => {
        active = false
      }
    }

    const seeded = seedDefaults(schema, defaultValues)
    setValuesState(seeded)
    setInitialValues(seeded)
    seededRef.current = true
    setItemLoading(false)
  }, [schema, mode, itemId, collection, defaultValues, onError, resolvedClient])

  // Run server-side field rules (debounced) whenever values change post-seed.
  const runFieldRules = useCallback(
    (next: Record<string, unknown>) => {
      if (ruleDebounceRef.current) clearTimeout(ruleDebounceRef.current)
      ruleDebounceRef.current = setTimeout(() => {
        resolvedClient
          .request<{ data: { updates: Record<string, unknown> } }>(
            post('/field-rules/evaluate', { collection, values: next })
          )
          .then((res) => {
            const updates = res.data?.updates
            if (updates && Object.keys(updates).length > 0) {
              setValuesState((prev) => ({ ...prev, ...updates }))
            }
          })
          .catch(() => {
            // Field rules are best-effort; ignore evaluation failures.
          })
      }, 300)
    },
    [collection, resolvedClient]
  )

  useEffect(() => {
    return () => {
      if (ruleDebounceRef.current) clearTimeout(ruleDebounceRef.current)
    }
  }, [])

  const setValue = useCallback(
    (field: string, value: unknown) => {
      setValuesState((prev) => {
        const next = { ...prev, [field]: value }
        runFieldRules(next)
        return next
      })
      setErrors((prev) => {
        if (!prev[field]) return prev
        const { [field]: _removed, ...rest } = prev
        return rest
      })
    },
    [runFieldRules]
  )

  const setValues = useCallback(
    (patchValues: Record<string, unknown>) => {
      setValuesState((prev) => {
        const next = { ...prev, ...patchValues }
        runFieldRules(next)
        return next
      })
    },
    [runFieldRules]
  )

  const reset = useCallback(
    (nextValues?: Record<string, unknown>) => {
      const target = nextValues ?? initialValues
      setValuesState(target)
      setErrors({})
    },
    [initialValues]
  )

  const isVisible = useCallback(
    (field: string): boolean => {
      const f = schema?.fields.find((x) => x.field === field)
      if (!f) return true
      return isFieldVisible(f.visibilityRules, values)
    },
    [schema, values]
  )

  const isLocked = useCallback(
    (field: string): boolean => {
      const f = schema?.fields.find((x) => x.field === field)
      if (!f) return false
      if (f.readonly) return true
      return isFieldLocked(f.lockCondition, values)
    },
    [schema, values]
  )

  const validateForm = useCallback((): FormErrors => {
    const next: FormErrors = {}
    if (!schema) return next

    for (const f of schema.fields) {
      // Skip validation for fields hidden by visibility rules.
      if (!isFieldVisible(f.visibilityRules, values)) continue

      const value = values[f.field]

      if (f.required && isEmpty(value)) {
        ;(next[f.field] ??= []).push(`${f.label} is required`)
      }

      for (const rule of f.validationRules ?? []) {
        if (rule.soft) continue // soft rules are warnings, not blockers
        const err = applyValidationRule(rule, value, f.label)
        if (err) (next[f.field] ??= []).push(err)
      }

      const customValidator = validate?.[f.field]
      if (customValidator) {
        const msg = customValidator(value, values)
        if (msg) (next[f.field] ??= []).push(msg)
      }
    }

    // Custom validators for fields not present in the schema.
    if (validate) {
      for (const [field, validator] of Object.entries(validate)) {
        if (next[field]) continue
        if (schema.fields.some((f) => f.field === field)) continue
        const msg = validator(values[field], values)
        if (msg) (next[field] ??= []).push(msg)
      }
    }

    return next
  }, [schema, values, validate])

  const handleSubmit = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault?.()
      const validationErrors = validateForm()
      setErrors(validationErrors)
      if (Object.keys(validationErrors).length > 0) return

      setIsSubmitting(true)
      try {
        const res =
          mode === 'edit' && itemId != null
            ? await resolvedClient.request<{ data: Record<string, unknown> }>(
                patch(`/items/${collection}/${itemId}`, values)
              )
            : await resolvedClient.request<{ data: Record<string, unknown> }>(
                post(`/items/${collection}`, values)
              )
        const saved = res.data ?? values
        setInitialValues(values)
        onSuccess?.(saved)
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err))
        // Surface server-side field errors when present.
        const response = (err as { response?: { field?: string; error?: string } })?.response
        if (response?.field && response.error) {
          setErrors((prev) => ({ ...prev, [response.field as string]: [response.error as string] }))
        }
        onError?.(error)
      } finally {
        setIsSubmitting(false)
      }
    },
    [validateForm, mode, itemId, collection, values, resolvedClient, onSuccess, onError]
  )

  const isDirty = useMemo(
    () => JSON.stringify(values) !== JSON.stringify(initialValues),
    [values, initialValues]
  )

  const fieldsByGroup = useMemo(() => {
    const map = new Map<string | null, FormFieldDescriptor[]>()
    if (!schema) return map
    for (const f of schema.fields) {
      const key = f.group ?? null
      const arr = map.get(key) ?? []
      arr.push(f)
      map.set(key, arr)
    }
    return map
  }, [schema])

  const visibleGroups = useMemo<FormGroupDescriptor[]>(() => {
    if (!schema) return []
    return schema.groups.filter((g) => {
      const groupFields = fieldsByGroup.get(g.key) ?? []
      return groupFields.some((f) => isFieldVisible(f.visibilityRules, values))
    })
  }, [schema, fieldsByGroup, values])

  return {
    schema,
    schemaLoading,
    schemaError,
    values,
    errors,
    isDirty,
    isSubmitting,
    isLoading: schemaLoading || itemLoading,
    isVisible,
    isLocked,
    setValue,
    setValues,
    reset,
    handleSubmit,
    fieldsByGroup,
    visibleGroups
  }
}

function applyValidationRule(
  rule: { type: string; value?: unknown; message?: string },
  value: unknown,
  label: string
): string | null {
  // Empty values are only caught by the required check.
  if (isEmpty(value) && rule.type !== 'required') return null

  switch (rule.type) {
    case 'required':
      return isEmpty(value) ? (rule.message ?? `${label} is required`) : null
    case 'min': {
      const min = Number(rule.value)
      if (typeof value === 'number' && value < min) {
        return rule.message ?? `${label} must be at least ${min}`
      }
      if (typeof value === 'string' && value.length < min) {
        return rule.message ?? `${label} must be at least ${min} characters`
      }
      return null
    }
    case 'max': {
      const max = Number(rule.value)
      if (typeof value === 'number' && value > max) {
        return rule.message ?? `${label} must be at most ${max}`
      }
      if (typeof value === 'string' && value.length > max) {
        return rule.message ?? `${label} must be at most ${max} characters`
      }
      return null
    }
    case 'regex': {
      try {
        const re = new RegExp(String(rule.value))
        return re.test(String(value)) ? null : (rule.message ?? `${label} is invalid`)
      } catch {
        return null
      }
    }
    case 'email': {
      const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
      return re.test(String(value)) ? null : (rule.message ?? `${label} must be a valid email`)
    }
    case 'url': {
      try {
        new URL(String(value))
        return null
      } catch {
        return rule.message ?? `${label} must be a valid URL`
      }
    }
    default:
      return null
  }
}

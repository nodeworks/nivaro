import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useOptionalNivaroClient } from '../context';
import { get, patch, post } from '../lib/commands';
import { useFormSchema } from './useFormSchema';
function evaluateCondition(condition, values) {
    const fieldValue = values[condition.when];
    switch (condition.op) {
        case 'eq':
            return fieldValue === condition.value;
        case 'neq':
            return fieldValue !== condition.value;
        case 'null':
            return fieldValue == null || fieldValue === '';
        case 'nnull':
            return fieldValue != null && fieldValue !== '';
        case 'in':
            return Array.isArray(condition.value) && condition.value.includes(fieldValue);
        case 'contains':
            return typeof fieldValue === 'string' && fieldValue.includes(String(condition.value ?? ''));
        default:
            return true;
    }
}
export function isFieldVisible(rules, values) {
    if (!rules || rules.length === 0)
        return true;
    let visible = true;
    let sawShowRule = false;
    for (const rule of rules) {
        const matched = evaluateCondition(rule, values);
        if (rule.action === 'show') {
            sawShowRule = true;
            if (matched)
                visible = true;
        }
        else if (rule.action === 'hide') {
            if (matched)
                visible = false;
        }
    }
    if (sawShowRule) {
        const anyShowMatched = rules.some((r) => r.action === 'show' && evaluateCondition(r, values));
        const anyHideMatched = rules.some((r) => r.action === 'hide' && evaluateCondition(r, values));
        if (!anyShowMatched && !anyHideMatched)
            return false;
    }
    return visible;
}
export function isFieldLocked(condition, values) {
    if (!condition)
        return false;
    return evaluateCondition(condition, values);
}
function seedDefaults(schema, defaults) {
    const out = {};
    if (schema) {
        for (const f of schema.fields) {
            if (f.defaultValue !== undefined && f.defaultValue !== null) {
                out[f.field] = f.defaultValue;
            }
        }
    }
    if (defaults)
        Object.assign(out, defaults);
    return out;
}
function isEmpty(value) {
    return value == null || value === '' || (Array.isArray(value) && value.length === 0);
}
function shallowEqual(a, b) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length)
        return false;
    for (const key of aKeys) {
        if (!Object.hasOwn(b, key) || a[key] !== b[key])
            return false;
    }
    return true;
}
function applyValidationRule(rule, value, label) {
    if (isEmpty(value) && rule.type !== 'required')
        return null;
    switch (rule.type) {
        case 'required':
            return isEmpty(value) ? (rule.message ?? `${label} is required`) : null;
        case 'min': {
            const min = Number(rule.value);
            if (typeof value === 'number' && value < min)
                return rule.message ?? `${label} must be at least ${min}`;
            if (typeof value === 'string' && value.length < min)
                return rule.message ?? `${label} must be at least ${min} characters`;
            return null;
        }
        case 'max': {
            const max = Number(rule.value);
            if (typeof value === 'number' && value > max)
                return rule.message ?? `${label} must be at most ${max}`;
            if (typeof value === 'string' && value.length > max)
                return rule.message ?? `${label} must be at most ${max} characters`;
            return null;
        }
        case 'regex': {
            try {
                const re = new RegExp(String(rule.value));
                return re.test(String(value)) ? null : (rule.message ?? `${label} is invalid`);
            }
            catch {
                return null;
            }
        }
        case 'email': {
            const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            return re.test(String(value)) ? null : (rule.message ?? `${label} must be a valid email`);
        }
        case 'url': {
            try {
                new URL(String(value));
                return null;
            }
            catch {
                return rule.message ?? `${label} must be a valid URL`;
            }
        }
        default:
            return null;
    }
}
export function useNivaroForm(collection, options, client) {
    const contextClient = useOptionalNivaroClient();
    const resolvedClient = client ?? contextClient;
    if (!resolvedClient) {
        throw new Error('useNivaroForm requires a NivaroClient — pass one as the third argument or wrap the tree in <NivaroProvider>.');
    }
    const { mode, itemId, defaultValues, onSuccess, onError, validate, includeHidden = false, layoutId, fieldRulesDebounce = 300 } = options;
    const { schema, loading: schemaLoading, error: schemaError } = useFormSchema(resolvedClient, collection, includeHidden, layoutId);
    const [values, setValuesState] = useState({});
    const [initialValues, setInitialValues] = useState({});
    const [errors, setErrors] = useState({});
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [itemLoading, setItemLoading] = useState(mode === 'edit');
    const seededRef = useRef(false);
    const ruleDebounceRef = useRef(null);
    const gridFlushersRef = useRef(new Map());
    const mountedRef = useRef(true);
    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
        };
    }, []);
    useEffect(() => {
        seededRef.current = false;
    }, []);
    useEffect(() => {
        if (!schema || seededRef.current)
            return;
        if (mode === 'edit' && itemId != null) {
            let active = true;
            setItemLoading(true);
            const m2mFields = schema.fields.filter((f) => f.fieldType === 'relation-m2m' &&
                f.relation?.relatedCollection &&
                f.relation?.manyField &&
                f.relation?.junctionField);
            resolvedClient
                .request(get(`/items/${collection}/${itemId}`))
                .then(async (res) => {
                if (!active)
                    return;
                const merged = {
                    ...seedDefaults(schema, defaultValues),
                    ...(res.data ?? {})
                };
                if (m2mFields.length > 0) {
                    const m2mResults = await Promise.allSettled(m2mFields.map((f) => {
                        const rel = f.relation;
                        const fetchCollection = rel.junctionCollection ?? rel.relatedCollection;
                        return resolvedClient
                            .request(get(`/items/${fetchCollection}`, {
                            filter: JSON.stringify({ [rel.manyField]: { _eq: itemId } }),
                            fields: `id,${rel.junctionField}`,
                            limit: 200
                        }))
                            .then((r) => ({
                            field: f.field,
                            junctionField: rel.junctionField,
                            rows: r.data ?? []
                        }))
                            .catch(() => ({ field: f.field, junctionField: rel.junctionField, rows: [] }));
                    }));
                    for (const result of m2mResults) {
                        if (result.status === 'fulfilled') {
                            const { field, junctionField, rows } = result.value;
                            merged[field] = rows.map((r) => r[junctionField]).filter((v) => v != null);
                        }
                    }
                }
                if (!active)
                    return;
                setValuesState(merged);
                setInitialValues(merged);
                seededRef.current = true;
                setItemLoading(false);
            })
                .catch((err) => {
                if (!active)
                    return;
                setItemLoading(false);
                onError?.(err instanceof Error ? err : new Error(String(err)));
            });
            return () => {
                active = false;
            };
        }
        const seeded = seedDefaults(schema, defaultValues);
        setValuesState(seeded);
        setInitialValues(seeded);
        seededRef.current = true;
        setItemLoading(false);
    }, [schema, mode, itemId, collection, defaultValues, onError, resolvedClient]);
    const runFieldRules = useCallback((next) => {
        if (fieldRulesDebounce <= 0)
            return;
        if (ruleDebounceRef.current)
            clearTimeout(ruleDebounceRef.current);
        ruleDebounceRef.current = setTimeout(() => {
            ruleDebounceRef.current = null;
            resolvedClient
                .request(post('/field-rules/evaluate', { collection, data: next }))
                .then((res) => {
                if (!mountedRef.current)
                    return;
                const updates = res.data?.updates;
                if (updates && Object.keys(updates).length > 0) {
                    setValuesState((prev) => ({ ...prev, ...updates }));
                }
            })
                .catch(() => { });
        }, fieldRulesDebounce);
    }, [collection, resolvedClient, fieldRulesDebounce]);
    useEffect(() => {
        return () => {
            if (ruleDebounceRef.current)
                clearTimeout(ruleDebounceRef.current);
        };
    }, []);
    const setValue = useCallback((field, value) => {
        setValuesState((prev) => {
            const next = { ...prev, [field]: value };
            runFieldRules(next);
            return next;
        });
        setErrors((prev) => {
            if (!prev[field])
                return prev;
            const { [field]: _r, ...rest } = prev;
            return rest;
        });
    }, [runFieldRules]);
    const setValues = useCallback((patchValues) => {
        setValuesState((prev) => {
            const next = { ...prev, ...patchValues };
            runFieldRules(next);
            return next;
        });
    }, [runFieldRules]);
    const reset = useCallback((nextValues) => {
        setValuesState(nextValues ?? initialValues);
        setErrors({});
    }, [initialValues]);
    const isVisible = useCallback((field) => {
        const f = schema?.fields.find((x) => x.field === field);
        if (!f)
            return true;
        return isFieldVisible(f.visibilityRules, values);
    }, [schema, values]);
    const isLocked = useCallback((field) => {
        const f = schema?.fields.find((x) => x.field === field);
        if (!f)
            return false;
        if (f.readonly)
            return true;
        return isFieldLocked(f.lockCondition, values);
    }, [schema, values]);
    const validateForm = useCallback(() => {
        const next = {};
        if (!schema)
            return next;
        for (const f of schema.fields) {
            if (!isFieldVisible(f.visibilityRules, values))
                continue;
            const value = values[f.field];
            if (f.required && isEmpty(value)) {
                if (next[f.field] == null)
                    next[f.field] = [];
                next[f.field].push(`${f.label} is required`);
            }
            for (const rule of f.validationRules ?? []) {
                if (rule.soft)
                    continue;
                const err = applyValidationRule(rule, value, f.label);
                if (err) {
                    if (next[f.field] == null)
                        next[f.field] = [];
                    next[f.field].push(err);
                }
            }
            const customValidator = validate?.[f.field];
            if (customValidator) {
                const msg = customValidator(value, values);
                if (msg) {
                    if (next[f.field] == null)
                        next[f.field] = [];
                    next[f.field].push(msg);
                }
            }
        }
        if (validate) {
            for (const [field, validator] of Object.entries(validate)) {
                if (next[field])
                    continue;
                if (schema.fields.some((f) => f.field === field))
                    continue;
                const msg = validator(values[field], values);
                if (msg) {
                    if (next[field] == null)
                        next[field] = [];
                    next[field].push(msg);
                }
            }
        }
        return next;
    }, [schema, values, validate]);
    const handleSubmit = useCallback(async (e) => {
        e?.preventDefault?.();
        const validationErrors = validateForm();
        setErrors(validationErrors);
        if (Object.keys(validationErrors).length > 0)
            return;
        setIsSubmitting(true);
        try {
            for (const flush of gridFlushersRef.current.values())
                await flush();
            const res = mode === 'edit' && itemId != null
                ? await resolvedClient.request(patch(`/items/${collection}/${itemId}`, values))
                : await resolvedClient.request(post(`/items/${collection}`, values));
            const saved = res.data ?? values;
            setInitialValues(saved);
            onSuccess?.(saved);
        }
        catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            const response = err?.response;
            if (response != null && typeof response === 'object') {
                const r = response;
                if (typeof r.field === 'string' && typeof r.error === 'string') {
                    setErrors((prev) => ({ ...prev, [r.field]: [r.error] }));
                }
                else if (Array.isArray(r.errors)) {
                    const fieldErrors = {};
                    for (const e of r.errors) {
                        if (e != null && typeof e === 'object') {
                            const fe = e;
                            if (typeof fe.field === 'string' && typeof fe.message === 'string') {
                                if (fieldErrors[fe.field] == null)
                                    fieldErrors[fe.field] = [];
                                fieldErrors[fe.field].push(fe.message);
                            }
                        }
                    }
                    if (Object.keys(fieldErrors).length > 0)
                        setErrors((prev) => ({ ...prev, ...fieldErrors }));
                }
            }
            onError?.(error);
        }
        finally {
            setIsSubmitting(false);
        }
    }, [validateForm, mode, itemId, collection, values, resolvedClient, onSuccess, onError]);
    const isDirty = useMemo(() => !shallowEqual(values, initialValues), [values, initialValues]);
    const fieldsByGroup = useMemo(() => {
        const map = new Map();
        if (!schema)
            return map;
        for (const f of schema.fields) {
            const key = f.group ?? null;
            const arr = map.get(key) ?? [];
            arr.push(f);
            map.set(key, arr);
        }
        return map;
    }, [schema]);
    const visibleGroups = useMemo(() => {
        if (!schema)
            return [];
        return schema.groups.filter((g) => {
            const groupFields = fieldsByGroup.get(g.key) ?? [];
            return groupFields.some((f) => isFieldVisible(f.visibilityRules, values));
        });
    }, [schema, fieldsByGroup, values]);
    return {
        schema,
        schemaLoading,
        schemaError,
        values,
        initialValues,
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
        visibleGroups,
        gridFlushersRef
    };
}
//# sourceMappingURL=useNivaroForm.js.map
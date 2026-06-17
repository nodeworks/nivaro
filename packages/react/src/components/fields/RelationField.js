import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import { useOptionalNivaroClient } from '../../context';
import { useRelationOptions } from '../../hooks/useRelationOptions';
/**
 * Unstyled relation picker.
 *  - m2o: single <select> of related items
 *  - o2m / m2m: multi <select> of related item ids
 *
 * Options are fetched from the related collection via useRelationOptions and
 * labelled with the relation's display template.
 *
 * If no NivaroClient is available (neither via NivaroProvider nor passed
 * directly to the field consumer), a visible error is shown instead of a
 * silently-empty picker.
 */
export function RelationField({ field, value, onChange, error, disabled, readOnly, inputId, errorId }) {
    const client = useOptionalNivaroClient();
    const [search, setSearch] = useState('');
    const relatedCollection = field.relation?.relatedCollection ?? '';
    const { options, loading, error: fetchError } = useRelationOptions(client, relatedCollection, {
        search: search || undefined,
        displayTemplate: field.relation?.displayTemplate ?? null,
        enabled: !!relatedCollection
    });
    const id = inputId ?? field.field;
    // max_values=1 on M2M means "single pick" — same logic as ItemEdit's M2MSingleSelectCombobox
    const isForcedSingle = (field.fieldType === 'relation-o2m' || field.fieldType === 'relation-m2m') &&
        field.options?.max_values === 1;
    const isMany = (field.fieldType === 'relation-o2m' || field.fieldType === 'relation-m2m') && !isForcedSingle;
    if (!client) {
        return (_jsx("span", { role: 'alert', "data-nivaro-field-error": true, children: "No NivaroClient available \u2014 wrap in <NivaroProvider> or pass a client prop." }));
    }
    if (!relatedCollection) {
        return (_jsx("input", { type: 'text', id: id, name: field.field, value: value == null ? '' : String(value), disabled: disabled, readOnly: readOnly, "aria-required": field.required, "aria-invalid": error != null && error.length > 0, "aria-describedby": errorId, onChange: (e) => onChange(e.target.value) }));
    }
    if (isForcedSingle) {
        // M2M stored as array but interface wants a single pick — read first, write as [id]
        const arr = Array.isArray(value) ? value : value != null ? [value] : [];
        const current = arr.length > 0
            ? arr[0] != null && typeof arr[0] === 'object'
                ? String(arr[0].id ?? '')
                : String(arr[0])
            : '';
        return (_jsxs("div", { children: [_jsx("input", { type: 'search', placeholder: 'Search\u2026', value: search, disabled: disabled || readOnly, onChange: (e) => setSearch(e.target.value) }), _jsxs("select", { id: id, name: field.field, required: field.required, disabled: disabled || readOnly, value: current, "aria-required": field.required, "aria-invalid": error != null && error.length > 0, "aria-describedby": errorId, onChange: (e) => onChange(e.target.value === '' ? [] : [e.target.value]), children: [_jsx("option", { value: '', children: "\u2014" }), options.map((o) => (_jsx("option", { value: String(o.id), children: o.label }, String(o.id))))] }), loading ? _jsx("span", { "aria-live": 'polite', children: "Loading\u2026" }) : null, fetchError ? _jsx("span", { role: 'alert', children: fetchError.message }) : null] }));
    }
    if (isMany) {
        const selected = Array.isArray(value)
            ? value.map((v) => v != null && typeof v === 'object' ? String(v.id) : String(v))
            : [];
        return (_jsxs("div", { children: [_jsx("input", { type: 'search', placeholder: 'Search\u2026', value: search, disabled: disabled || readOnly, onChange: (e) => setSearch(e.target.value) }), _jsx("select", { id: id, name: field.field, multiple: true, disabled: disabled || readOnly, value: selected, "aria-required": field.required, "aria-invalid": error != null && error.length > 0, "aria-describedby": errorId, onChange: (e) => {
                        const next = Array.from(e.target.selectedOptions).map((o) => o.value);
                        onChange(next);
                    }, children: options.map((o) => (_jsx("option", { value: String(o.id), children: o.label }, String(o.id)))) }), loading ? _jsx("span", { "aria-live": 'polite', children: "Loading\u2026" }) : null, fetchError ? _jsx("span", { role: 'alert', children: fetchError.message }) : null] }));
    }
    const current = value != null && typeof value === 'object'
        ? String(value.id ?? '')
        : value == null
            ? ''
            : String(value);
    return (_jsxs("div", { children: [_jsx("input", { type: 'search', placeholder: 'Search\u2026', value: search, disabled: disabled || readOnly, onChange: (e) => setSearch(e.target.value) }), _jsxs("select", { id: id, name: field.field, required: field.required, disabled: disabled || readOnly, value: current, "aria-required": field.required, "aria-invalid": error != null && error.length > 0, "aria-describedby": errorId, onChange: (e) => onChange(e.target.value === '' ? null : e.target.value), children: [_jsx("option", { value: '', children: "\u2014" }), options.map((o) => (_jsx("option", { value: String(o.id), children: o.label }, String(o.id))))] }), loading ? _jsx("span", { "aria-live": 'polite', children: "Loading\u2026" }) : null, fetchError ? _jsx("span", { role: 'alert', children: fetchError.message }) : null] }));
}
//# sourceMappingURL=RelationField.js.map
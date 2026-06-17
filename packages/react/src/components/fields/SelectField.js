import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
function extractChoices(options) {
    if (!options)
        return [];
    const raw = (options.choices ?? options.options);
    if (!Array.isArray(raw))
        return [];
    return raw
        .map((c) => {
        if (c && typeof c === 'object') {
            const obj = c;
            const value = (obj.value ?? obj.text);
            const text = (obj.text ?? obj.label ?? obj.value);
            if (value === undefined)
                return null;
            return { text: String(text ?? value), value: value };
        }
        if (typeof c === 'string' || typeof c === 'number') {
            return { text: String(c), value: c };
        }
        return null;
    })
        .filter((c) => c !== null);
}
export function SelectField({ field, value, onChange, error, disabled, readOnly, inputId, errorId }) {
    const id = inputId ?? field.field;
    const choices = extractChoices(field.options);
    // Use the normalized fieldType, not the raw interface string, to detect
    // multi-select — fieldType is already resolved by normalizeFieldType.
    const isMultiple = field.fieldType === 'checkbox-group';
    if (isMultiple) {
        const selected = Array.isArray(value) ? value.map(String) : [];
        return (_jsx("select", { id: id, name: field.field, multiple: true, required: field.required, disabled: disabled || readOnly, value: selected, "aria-required": field.required, "aria-invalid": error != null && error.length > 0, "aria-describedby": errorId, onChange: (e) => {
                const next = Array.from(e.target.selectedOptions).map((o) => o.value);
                onChange(next);
            }, children: choices.map((c) => (_jsx("option", { value: String(c.value), children: c.text }, String(c.value)))) }));
    }
    return (_jsxs("select", { id: id, name: field.field, required: field.required, disabled: disabled || readOnly, value: value == null ? '' : String(value), "aria-required": field.required, "aria-invalid": error != null && error.length > 0, "aria-describedby": errorId, onChange: (e) => onChange(e.target.value === '' ? null : e.target.value), children: [_jsx("option", { value: '', children: "\u2014" }), choices.map((c) => (_jsx("option", { value: String(c.value), children: c.text }, String(c.value))))] }));
}
//# sourceMappingURL=SelectField.js.map
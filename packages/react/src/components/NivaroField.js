import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useId } from 'react';
import { BooleanField } from './fields/BooleanField';
import { DateField } from './fields/DateField';
import { FileField } from './fields/FileField';
import { NumberField } from './fields/NumberField';
import { RelationField } from './fields/RelationField';
import { SelectField } from './fields/SelectField';
import { TextareaField } from './fields/TextareaField';
import { TextField } from './fields/TextField';
import { InlineGridField } from './InlineGridField';
const DEFAULT_RENDERERS = {
    text: TextField,
    textarea: TextareaField,
    integer: NumberField,
    float: NumberField,
    decimal: NumberField,
    boolean: BooleanField,
    date: DateField,
    datetime: DateField,
    select: SelectField,
    radio: SelectField,
    'checkbox-group': SelectField,
    'relation-m2o': RelationField,
    'relation-o2m': RelationField,
    'relation-m2m': RelationField,
    wysiwyg: TextareaField,
    file: FileField,
    uuid: TextField,
    json: TextareaField
};
/**
 * Selects and renders the correct field component for a single field based on
 * its normalized fieldType. Override any type via `components`; falls back to
 * `components.fallback` or a basic text input for unknown types.
 *
 * Uses React 18's useId() to generate a unique DOM id per field instance so
 * two forms with the same collection mounted simultaneously don't collide.
 */
export function NivaroField({ field, value, onChange, error, disabled = false, readOnly = false, components, className, itemId }) {
    const uid = useId();
    const inputId = `${uid}-${field.field}`;
    const errorId = error && error.length > 0 ? `${uid}-err` : undefined;
    // Inline-grid: completely separate rendering path — no label/renderer pattern
    if (field.interface === 'inline-grid' && field.relation?.type === 'o2m') {
        return (_jsx("div", { className: className, "data-nivaro-field": field.field, "data-field-type": 'inline-grid', children: _jsx(InlineGridField, { field: field, itemId: itemId ?? null }) }));
    }
    const override = components?.[field.fieldType];
    const Renderer = override ??
        DEFAULT_RENDERERS[field.fieldType] ??
        components?.fallback ??
        TextField;
    const props = {
        field,
        value,
        onChange,
        error,
        disabled,
        readOnly,
        inputId,
        errorId
    };
    return (_jsxs("div", { className: className, "data-nivaro-field": field.field, "data-field-type": field.fieldType, ...(field.note ? { 'data-nf-note': field.note } : {}), children: [_jsxs("label", { htmlFor: inputId, children: [field.label, field.required ? (_jsxs("span", { "aria-hidden": 'true', "data-nf-required": true, children: [' ', "*"] })) : null, field.note ? (_jsx("span", { "aria-label": field.note, title: field.note, "data-nf-note-icon": true, role: 'img', "aria-hidden": 'false', children: ' ?' })) : null] }), _jsx(Renderer, { ...props }), field.note ? _jsx("small", { "data-nf-note-text": true, children: field.note }) : null, error && error.length > 0 ? (_jsx("div", { id: errorId, role: 'alert', children: error.map((msg) => (_jsx("span", { children: msg }, msg))) })) : null] }));
}
//# sourceMappingURL=NivaroField.js.map
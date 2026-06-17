import { jsx as _jsx } from "react/jsx-runtime";
export function TextareaField({ field, value, onChange, error, disabled, readOnly, inputId, errorId }) {
    const id = inputId ?? field.field;
    return (_jsx("textarea", { id: id, name: field.field, value: value == null ? '' : String(value), required: field.required, disabled: disabled, readOnly: readOnly, "aria-required": field.required, "aria-invalid": error != null && error.length > 0, "aria-describedby": errorId, onChange: (e) => onChange(e.target.value) }));
}
//# sourceMappingURL=TextareaField.js.map
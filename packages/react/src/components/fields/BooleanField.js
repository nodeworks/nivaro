import { jsx as _jsx } from "react/jsx-runtime";
export function BooleanField({ field, value, onChange, error, disabled, readOnly, inputId, errorId }) {
    const id = inputId ?? field.field;
    return (_jsx("input", { type: 'checkbox', id: id, name: field.field, checked: !!value, disabled: disabled || readOnly, "aria-required": field.required, "aria-invalid": error != null && error.length > 0, "aria-describedby": errorId, onChange: (e) => onChange(e.target.checked) }));
}
//# sourceMappingURL=BooleanField.js.map
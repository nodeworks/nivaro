import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
import React from 'react';
import { NivaroField } from './NivaroField';
/**
 * Optional convenience wrapper that renders a <form> driven by useNivaroForm.
 * Provide `children` to fully control layout, or omit them to auto-render every
 * group and its fields via NivaroField.
 */
export function NivaroForm({ form, children, components, renderField, renderGroup, className, style }) {
    const { schema, values, errors, setValue, isVisible, isLocked, isSubmitting } = form;
    const renderOneField = (field) => {
        if (!isVisible(field.field))
            return null;
        const defaultRender = () => (_jsx(NivaroField, { field: field, value: values[field.field], onChange: (v) => setValue(field.field, v), error: errors[field.field], disabled: isSubmitting, readOnly: isLocked(field.field), components: components }, field.field));
        if (renderField)
            return _jsx(React.Fragment, { children: renderField(field, defaultRender) }, field.field);
        return defaultRender();
    };
    const renderGroupBlock = (group, fields) => {
        const renderedFields = _jsx(_Fragment, { children: fields.map((f) => renderOneField(f)) });
        if (renderGroup) {
            const key = group?.key ?? '__ungrouped__';
            return _jsx(React.Fragment, { children: renderGroup(group, renderedFields) }, key);
        }
        if (!group) {
            return _jsx(React.Fragment, { children: renderedFields }, '__ungrouped__');
        }
        return (_jsxs("fieldset", { "data-nivaro-group": group.key, "data-group-type": group.type, children: [_jsx("legend", { children: group.label }), renderedFields] }, group.key));
    };
    const autoBody = () => {
        if (!schema)
            return null;
        const ungrouped = form.fieldsByGroup.get(null) ?? [];
        return (_jsxs(_Fragment, { children: [ungrouped.length > 0 ? renderGroupBlock(null, ungrouped) : null, form.visibleGroups.map((g) => renderGroupBlock(g, form.fieldsByGroup.get(g.key) ?? []))] }));
    };
    return (_jsx("form", { className: className, style: style, onSubmit: form.handleSubmit, children: children ?? autoBody() }));
}
//# sourceMappingURL=NivaroForm.js.map
import React from 'react';
import type { ComponentOverrides, FormFieldDescriptor, FormGroupDescriptor, UseNivaroFormReturn } from '../types';
type NivaroFormProps = {
    /** the object returned by useNivaroForm */
    form: UseNivaroFormReturn;
    /** custom render children; if omitted the form auto-renders all fields/groups */
    children?: React.ReactNode;
    /** override specific field-type renderers */
    components?: ComponentOverrides;
    /** wrap/replace the rendering of a single field */
    renderField?: (field: FormFieldDescriptor, defaultRender: () => React.ReactNode) => React.ReactNode;
    /** wrap/replace the rendering of a group + its fields */
    renderGroup?: (group: FormGroupDescriptor | null, fields: React.ReactNode) => React.ReactNode;
    className?: string;
    style?: React.CSSProperties;
};
/**
 * Optional convenience wrapper that renders a <form> driven by useNivaroForm.
 * Provide `children` to fully control layout, or omit them to auto-render every
 * group and its fields via NivaroField.
 */
export declare function NivaroForm({ form, children, components, renderField, renderGroup, className, style }: NivaroFormProps): React.JSX.Element;
export {};
//# sourceMappingURL=NivaroForm.d.ts.map
import type React from 'react';
import type { ComponentOverrides, FormFieldDescriptor } from '../types';
type NivaroFieldProps = {
    field: FormFieldDescriptor;
    value: unknown;
    onChange: (value: unknown) => void;
    error?: string[];
    disabled?: boolean;
    readOnly?: boolean;
    components?: ComponentOverrides;
    className?: string;
    /** Parent item id — passed through to inline-grid fields */
    itemId?: string | number | null;
};
/**
 * Selects and renders the correct field component for a single field based on
 * its normalized fieldType. Override any type via `components`; falls back to
 * `components.fallback` or a basic text input for unknown types.
 *
 * Uses React 18's useId() to generate a unique DOM id per field instance so
 * two forms with the same collection mounted simultaneously don't collide.
 */
export declare function NivaroField({ field, value, onChange, error, disabled, readOnly, components, className, itemId }: NivaroFieldProps): React.JSX.Element;
export {};
//# sourceMappingURL=NivaroField.d.ts.map
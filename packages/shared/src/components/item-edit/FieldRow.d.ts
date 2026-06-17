import type { ReactNode } from 'react';
import { getColSpanClass } from './helpers';
import type { CMSField, CMSRelation, RenderFieldProps } from './types';
export declare function FieldRow({ field, draft, onChange, relations, collection, itemId, error, visible, locked, renderField }: {
    field: CMSField;
    draft: Record<string, unknown>;
    onChange: (field: string, value: unknown) => void;
    relations: CMSRelation[];
    collection: string;
    itemId: string;
    error?: string;
    visible: boolean;
    locked: boolean;
    renderField?: (props: RenderFieldProps) => ReactNode;
}): import("react").JSX.Element | null;
export { getColSpanClass };
//# sourceMappingURL=FieldRow.d.ts.map
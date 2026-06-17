import type { ReactNode } from 'react';
import type { CMSField, CMSRelation, FieldGroup, RenderFieldProps } from './types';
export declare function GroupSection({ group, fields, draft, onChange, relations, collection, itemId, errors, visibleFields, lockedFields, renderField }: {
    group: FieldGroup;
    fields: CMSField[];
    draft: Record<string, unknown>;
    onChange: (field: string, value: unknown) => void;
    relations: CMSRelation[];
    collection: string;
    itemId: string;
    errors: Record<string, string>;
    visibleFields: Set<string>;
    lockedFields: Set<string>;
    renderField?: (props: RenderFieldProps) => ReactNode;
}): import("react").JSX.Element;
//# sourceMappingURL=GroupSection.d.ts.map
import type { CMSField, CMSRelation } from './types';
export declare function FieldRenderer({ field, value, onChange, relations, collection, itemId, cascadeFilter, requiredParentLabel }: {
    field: CMSField;
    value: unknown;
    onChange: (v: unknown) => void;
    relations: CMSRelation[];
    collection: string;
    itemId: string;
    cascadeFilter?: Record<string, unknown>;
    requiredParentLabel?: string | null;
}): import("react").JSX.Element;
//# sourceMappingURL=FieldRenderer.d.ts.map
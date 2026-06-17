import type { CMSRelation } from './types';
export declare function M2MCombobox({ relation, parentId, allRelations, extraFilter, requiredParent }: {
    relation: CMSRelation;
    parentId: string;
    allRelations: CMSRelation[];
    extraFilter?: Record<string, unknown>;
    requiredParent?: string;
}): import("react").JSX.Element;
export declare function M2MSingleSelectCombobox({ relation, parentId, allRelations, extraFilter, requiredParent }: {
    relation: CMSRelation;
    parentId: string;
    allRelations: CMSRelation[];
    extraFilter?: Record<string, unknown>;
    requiredParent?: string;
}): import("react").JSX.Element;
//# sourceMappingURL=M2MCombobox.d.ts.map
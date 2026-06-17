import type { M2MStagingCtx } from './M2MStagingContext';
import type { CMSField, CMSRelation, FieldGroup, StepDef } from './types';
export declare function SummaryPanel({ allSteps, groupedMap, ungroupedFields, sectionGroups, draft, relations, collection, itemId, staging, onFieldClick }: {
    allSteps: StepDef[];
    groupedMap: Record<string, CMSField[]>;
    ungroupedFields: CMSField[];
    sectionGroups: FieldGroup[];
    draft: Record<string, unknown>;
    relations: CMSRelation[];
    collection: string;
    itemId: string;
    staging: M2MStagingCtx | null;
    onFieldClick: (stepKey: string, fieldKey: string) => void;
}): import("react").JSX.Element | null;
//# sourceMappingURL=SummaryPanel.d.ts.map
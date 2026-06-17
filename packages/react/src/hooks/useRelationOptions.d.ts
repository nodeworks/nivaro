import type { NivaroClient } from '@nivaro/sdk';
export type RelationOption = {
    id: string | number;
    label: string;
    raw: Record<string, unknown>;
};
/**
 * Fetch selectable options for a relation field's related collection.
 * Re-fetches when `search` changes. Pass `enabled: false` to skip fetching
 * (e.g. while the related collection name is still unknown).
 *
 * When `enabled` transitions to false, previously-loaded options are retained
 * so cascading pickers don't flash blank while a parent field is being cleared.
 */
export declare function useRelationOptions(client: NivaroClient | null, relatedCollection: string, options?: {
    search?: string;
    limit?: number;
    displayTemplate?: string | null;
    enabled?: boolean;
    filter?: Record<string, unknown>;
}): {
    options: RelationOption[];
    loading: boolean;
    error: Error | null;
};
//# sourceMappingURL=useRelationOptions.d.ts.map
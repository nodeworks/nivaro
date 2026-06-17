import type { NivaroClient } from '@nivaro/sdk';
import type { RelationOption } from '../types';
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
import type { NivaroClient } from '@nivaro/sdk';
import type { FormSchema } from '../types';
export { normalizeFieldType } from './schemaBuilder';
export declare function fetchSchema(client: NivaroClient, collection: string, includeHidden: boolean, layoutId?: number, layoutSlug?: string): Promise<FormSchema>;
/**
 * Fetch + cache a collection's form schema. Caches by client URL + collection +
 * includeHidden flag so re-mounts and sibling forms share one request.
 *
 * NOTE: Pass a stable `client` reference. A new object on every render resets
 * the cache key and re-fetches. Use `useMemo` or define the client outside the
 * component tree.
 */
export declare function useFormSchema(client: NivaroClient | null, collection: string, includeHidden?: boolean, layoutId?: number, layoutSlug?: string): {
    schema: FormSchema | null;
    loading: boolean;
    error: Error | null;
};
/** Clear the schema cache (e.g. after a schema change). */
export declare function clearFormSchemaCache(collection?: string): void;
//# sourceMappingURL=useFormSchema.d.ts.map
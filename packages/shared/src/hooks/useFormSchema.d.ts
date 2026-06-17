import type { NivaroClient } from '@nivaro/sdk';
import type { FormFieldDescriptor, FormFieldType, FormSchema } from '../types';
export declare function normalizeFieldType(rawType: string, iface: string | null, relation: FormFieldDescriptor['relation']): FormFieldType;
export declare function fetchSchema(client: NivaroClient, collection: string, includeHidden: boolean, layoutId?: number): Promise<FormSchema>;
export declare function useFormSchema(client: NivaroClient | null, collection: string, includeHidden?: boolean, layoutId?: number): {
    schema: FormSchema | null;
    loading: boolean;
    error: Error | null;
};
export declare function clearFormSchemaCache(collection?: string): void;
//# sourceMappingURL=useFormSchema.d.ts.map
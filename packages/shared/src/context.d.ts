import type { NivaroClient } from '@nivaro/sdk';
import type React from 'react';
export type GridFlushContextValue = {
    register: (key: string, fn: () => Promise<void>) => void;
    unregister: (key: string) => void;
};
export declare const GridFlushContext: React.Context<GridFlushContextValue | null>;
export declare function useGridFlush(): GridFlushContextValue | null;
export declare function NivaroProvider({ client, children }: {
    client: NivaroClient;
    children: React.ReactNode;
}): React.JSX.Element;
export declare function useNivaroClient(): NivaroClient;
export declare function useOptionalNivaroClient(): NivaroClient | null;
export type ItemEditAuthContextValue = {
    isAdmin: boolean;
    userId: string;
};
export declare const ItemEditAuthContext: React.Context<ItemEditAuthContextValue>;
export declare function useItemEditAuth(): ItemEditAuthContextValue;
//# sourceMappingURL=context.d.ts.map
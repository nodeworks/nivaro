import { jsx as _jsx } from "react/jsx-runtime";
import { createContext, useContext } from 'react';
export const GridFlushContext = createContext(null);
export function useGridFlush() {
    return useContext(GridFlushContext);
}
const NivaroFormContext = createContext(null);
export function NivaroProvider({ client, children }) {
    return _jsx(NivaroFormContext.Provider, { value: { client }, children: children });
}
export function useNivaroClient() {
    const ctx = useContext(NivaroFormContext);
    if (!ctx)
        throw new Error('useNivaroClient must be used within <NivaroProvider>');
    return ctx.client;
}
export function useOptionalNivaroClient() {
    const ctx = useContext(NivaroFormContext);
    return ctx?.client ?? null;
}
export const ItemEditAuthContext = createContext({
    isAdmin: false,
    userId: ''
});
export function useItemEditAuth() {
    return useContext(ItemEditAuthContext);
}
//# sourceMappingURL=context.js.map
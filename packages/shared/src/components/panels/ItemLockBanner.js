import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Lock } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useItemEditAuth, useNivaroClient } from '../../context';
import { del, post } from '../../lib/commands';
import { Button } from '../ui/button';
const HEARTBEAT_MS = 60_000;
export function useItemLock(collection, item, enabled) {
    const client = useNivaroClient();
    const { isAdmin } = useItemEditAuth();
    const [lockHolder, setLockHolder] = useState(null);
    const [acquired, setAcquired] = useState(false);
    const [takingOver, setTakingOver] = useState(false);
    const heartbeatRef = useRef(null);
    const acquiredRef = useRef(false);
    const stopHeartbeat = useCallback(() => {
        if (heartbeatRef.current) {
            clearInterval(heartbeatRef.current);
            heartbeatRef.current = null;
        }
    }, []);
    const acquire = useCallback(async () => {
        if (!collection || !item)
            return false;
        try {
            await client.request(post(`/item-locks/${collection}/${item}/lock`, {}));
            acquiredRef.current = true;
            setAcquired(true);
            setLockHolder(null);
            stopHeartbeat();
            heartbeatRef.current = setInterval(() => {
                client.request(post(`/item-locks/${collection}/${item}/heartbeat`, {})).catch(() => { });
            }, HEARTBEAT_MS);
            return true;
        }
        catch (err) {
            const resp = err?.response;
            if (resp?.status === 409 && resp.data) {
                acquiredRef.current = false;
                setAcquired(false);
                setLockHolder({
                    locked_by: resp.data.locked_by,
                    locked_by_name: resp.data.locked_by_name ?? null
                });
            }
            return false;
        }
    }, [client, collection, item, stopHeartbeat]);
    useEffect(() => {
        if (!enabled || !collection || !item)
            return;
        acquire();
        return () => {
            stopHeartbeat();
            if (acquiredRef.current) {
                acquiredRef.current = false;
                client.request(del(`/item-locks/${collection}/${item}/lock`)).catch(() => { });
            }
        };
    }, [enabled, collection, item, acquire, client, stopHeartbeat]);
    const takeOver = useCallback(async () => {
        if (!collection || !item)
            return;
        setTakingOver(true);
        try {
            await client.request(del(`/item-locks/${collection}/${item}/lock?force=1`));
            const ok = await acquire();
            if (ok)
                toast.success('You now hold the edit lock');
            else
                toast.error('Failed to take over the lock');
        }
        catch {
            toast.error('Failed to take over the lock');
        }
        finally {
            setTakingOver(false);
        }
    }, [client, collection, item, acquire]);
    return { lockHolder, acquired, isReadOnly: !!lockHolder, takeOver, takingOver, isAdmin };
}
export function ItemLockBanner({ lockHolder, onTakeOver, takingOver, isAdmin }) {
    if (!lockHolder)
        return null;
    const name = lockHolder.locked_by_name || 'Another user';
    return (_jsxs("div", { className: 'mb-4 flex items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900', children: [_jsx(Lock, { className: 'h-4 w-4 shrink-0 text-amber-500' }), _jsxs("span", { className: 'flex-1', children: [_jsx("span", { className: 'font-medium', children: name }), " is editing this item \u2014 fields are read-only until the lock is released."] }), isAdmin && (_jsx(Button, { size: 'sm', variant: 'outline', className: 'h-7 shrink-0 border-amber-300 bg-white text-[12px] text-amber-800 hover:bg-amber-100', onClick: onTakeOver, disabled: takingOver, children: takingOver ? 'Taking over…' : 'Take over' }))] }));
}
//# sourceMappingURL=ItemLockBanner.js.map
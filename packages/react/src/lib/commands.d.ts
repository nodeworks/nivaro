import type { Command } from '@nivaro/sdk';
export declare function get<T>(path: string, params?: Record<string, unknown>): Command<T>;
export declare function post<T>(path: string, body?: unknown): Command<T>;
export declare function patch<T>(path: string, body?: unknown): Command<T>;
export declare function del<T>(path: string): Command<T>;
//# sourceMappingURL=commands.d.ts.map
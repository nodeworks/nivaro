// Minimal command builders. Avoids importing SDK-internal `cmd` directly
// while keeping the three files that need HTTP commands DRY.
export function get(path, params) {
    return { _method: 'GET', _path: path, _params: params };
}
export function post(path, body) {
    return { _method: 'POST', _path: path, _body: body };
}
export function patch(path, body) {
    return { _method: 'PATCH', _path: path, _body: body };
}
export function del(path) {
    return { _method: 'DELETE', _path: path };
}
//# sourceMappingURL=commands.js.map
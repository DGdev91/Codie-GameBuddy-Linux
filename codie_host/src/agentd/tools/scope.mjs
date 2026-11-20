// A client's scope (spec §6.1): { tools: boolean, pair: boolean, api: string[] }.
// api lists device API path prefixes under /v1/api/; /admin/ and /auth/
// are never grantable, and tool-integrations belong to the daemon. pair lets
// the client scan for and pair devices.

const FORBIDDEN = ['/v1/api/admin/', '/v1/api/auth/', '/v1/api/data/user/tool-integrations'];

export function normalizeScope(raw) {
  if (raw === undefined || raw === null) return { tools: false, pair: false, api: [] };
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('scope must be an object');
  const tools = raw.tools === true;
  const pair = raw.pair === true;
  const api = raw.api ?? [];
  if (!Array.isArray(api) || api.some(p => typeof p !== 'string')) throw new Error('scope.api must be a list of path prefixes');
  for (const p of api) {
    if (!p.startsWith('/v1/api/') || p.includes('..')) throw new Error(`scope.api: ${p} is not a /v1/api/ path`);
    if (FORBIDDEN.some(f => p.startsWith(f) || f.startsWith(p))) throw new Error(`scope.api: ${p} is reserved`);
  }
  return { tools, pair, api: [...new Set(api)].sort() };
}

// True when every permission in `wanted` is already in `granted`.
export function scopeCovers(granted, wanted) {
  if (wanted.tools && !granted.tools) return false;
  if (wanted.pair && !granted.pair) return false;
  return wanted.api.every(p => granted.api.some(g => p.startsWith(g)));
}

export function allowsApiPath(scope, path) {
  if (FORBIDDEN.some(f => path.startsWith(f))) return false;
  return scope.api.some(prefix => path.startsWith(prefix));
}

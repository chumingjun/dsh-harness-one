export function resolveApiBase({ injected = '', assetBase = '/', pathname = '/' } = {}) {
  const explicit = String(injected || '').trim().replace(/\/$/, '');
  if (explicit) return explicit;

  const builtBase = String(assetBase || '/').trim().replace(/\/$/, '');
  if (builtBase && builtBase !== '/') return builtBase;

  return /^\/wf1(?:\/|$)/.test(String(pathname || '/')) ? '/wf1' : '';
}

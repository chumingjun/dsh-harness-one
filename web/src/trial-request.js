export function trialRequestUrls(url) {
  const source = String(url || '');
  const urls = [source];

  if (source.startsWith('/api/')) {
    urls.push(`/wf1${source}`);
  } else {
    try {
      const parsed = new URL(source);
      if (parsed.pathname.startsWith('/api/')) {
        parsed.pathname = `/wf1${parsed.pathname}`;
        urls.push(parsed.toString());
      }
    } catch {
      // Relative paths other than /api/* have no alternate dsh route.
    }
  }

  return [...new Set(urls)];
}

import React from 'react';
import { createRoot } from 'react-dom/client';
import { SchemeResultsTab } from './client.jsx';

const params = new URLSearchParams(window.location.search);
const sessionId = params.get('sessionId') || '';
const projectId = params.get('projectId') || '';

// Standalone pages reuse the results UI; mutations stay on the native user command channel.
const connection = { rpc: { async call(_channel, _endpoint, input) {
  const { action, ...payload } = input.args.payload;
  const path = { status: '', artifact: '/artifact', export: '/export' }[action];
  if (path === undefined) return { ok: false, error: { message: 'Unsupported results action' } };
  const url = new URL(`/ccpg-scheme/api${path}`, window.location.origin);
  for (const [key, value] of Object.entries(payload)) if (value) url.searchParams.set(key, value);
  const options = action === 'export'
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), credentials: 'same-origin' }
    : { credentials: 'same-origin' };
  const response = await fetch(url, options);
  const result = await response.json().catch(() => ({}));
  return response.ok ? { ok: true, value: result } : { ok: false, error: { code: result.code, message: result.error || response.statusText } };
} } };

createRoot(document.getElementById('ccpg-scheme-browser')).render(
  <div className="scheme-browser-host">
    <SchemeResultsTab sessionId={sessionId} projectId={projectId} connection={connection} readOnly />
  </div>,
);

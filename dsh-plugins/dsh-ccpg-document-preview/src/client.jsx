import React from 'react';
import { createRoot } from 'react-dom/client';
import { DocumentPreviewDialog } from './react.jsx';

const ROOT_ID = 'dsh-ccpg-document-preview-root';
let root;

function ensureRoot() {
  let element = window.document.getElementById(ROOT_ID);
  if (!element) {
    element = window.document.createElement('div');
    element.id = ROOT_ID;
    window.document.body.appendChild(element);
  }
  if (!root) root = createRoot(element);
  return root;
}

function close() {
  root?.render(null);
}

function open(document, options = {}) {
  ensureRoot().render(
    <DocumentPreviewDialog
      document={document}
      open
      title={options.title}
      maxTextBytes={options.maxTextBytes}
      onClose={() => {
        close();
        options.onClose?.();
      }}
    />,
  );
}

window.dshDocumentPreview = Object.assign(window.dshDocumentPreview || {}, { open, close });

export { open, close };

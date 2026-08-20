import React from 'react';
import { createRoot } from 'react-dom/client';
import { ReactFlowProvider } from '@xyflow/react';
import App from './App.jsx';
import { ToastProvider } from './ui.jsx';
import '@xyflow/react/dist/style.css';
import './styles.css';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ReactFlowProvider>
      <ToastProvider>
        <App />
      </ToastProvider>
    </ReactFlowProvider>
  </React.StrictMode>
);

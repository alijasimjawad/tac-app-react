import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/tokens.css'
import './index.css'
import App from './App.tsx'

// One-time cleanup: this domain previously served the old single-HTML TAC app,
// which registered a service worker with an offline/cache-first strategy. Some
// visitors' browsers may still have that stale service worker active, which can
// briefly serve an outdated cached page before the real network version loads
// (visible as a "flash of old content"). Unregister any legacy service workers
// and clear their caches so this app always loads fresh, for every visitor.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then(regs => {
    regs.forEach(reg => reg.unregister());
  });
}
if ('caches' in window) {
  caches.keys().then(keys => keys.forEach(key => caches.delete(key)));
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/tokens.css'
import './index.css'
import './lib/i18n'
import App from './App.tsx'

// One-time cleanup: this domain previously served the old single-HTML TAC app,
// which registered a service worker with an offline/cache-first strategy. Some
// visitors' browsers may still have that stale service worker active, which can
// briefly serve an outdated cached page before the real network version loads
// (visible as a "flash of old content"). Unregister any legacy service workers
// and clear their caches so this app always loads fresh.
//
// This must only run ONCE per browser — this app now registers its own
// intentional service worker (/sw.js, for push notifications + PWA installability)
// and re-running this cleanup on every load would keep unregistering that too.
const LEGACY_SW_CLEANUP_KEY = 'tac_legacy_sw_cleaned';
if (!localStorage.getItem(LEGACY_SW_CLEANUP_KEY)) {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then(regs => {
      regs.forEach(reg => reg.unregister());
    });
  }
  if ('caches' in window) {
    caches.keys().then(keys => keys.forEach(key => caches.delete(key)));
  }
  localStorage.setItem(LEGACY_SW_CLEANUP_KEY, '1');
}

// Register our own service worker unconditionally at boot. This is required
// for both push notification persistence (Phase 13) and "Add to Home Screen"
// installability — browsers require an active SW registration with a fetch
// handler before they'll offer the install prompt. NotificationBell.tsx also
// registers it lazily when a user enables push, but registration is idempotent
// (same scriptURL just resolves the existing registration), so doing both is safe.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Non-fatal: app still works without push/installability in this case.
    });
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

import { useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import tacLogo from '../assets/tac-logo.png';
import tacLogoLight from '../assets/tac-logo-light.png';
import styles from './Login.module.css';

function mapError(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes('invalid login credentials') || lower.includes('invalid credentials')) {
    return 'Incorrect username or password.';
  }
  if (
    lower.includes('failed to fetch') ||
    lower.includes('network') ||
    lower.includes('fetch failed') ||
    lower.includes('connection') ||
    lower.includes('timeout')
  ) {
    return 'Network connection error. Please check your internet connection.';
  }
  console.error('[Login] Supabase error:', raw);
  return 'Unable to sign in. Please try again.';
}

const IconUser = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="8" r="4"/>
    <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
  </svg>
);

const IconLock = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="11" width="18" height="11" rx="2"/>
    <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
  </svg>
);

const IconEye = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M1 12C3 6 7 3 12 3s9 3 11 9c-2 6-6 9-11 9S3 18 1 12z"/>
    <circle cx="12" cy="12" r="3"/>
  </svg>
);

const IconEyeOff = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-5 0-9-3-11-9a10.4 10.4 0 0 1 2.62-4.54M9.9 4.24A9.12 9.12 0 0 1 12 4c5 0 9 3 11 9a10.1 10.1 0 0 1-1.52 2.84M3 3l18 18"/>
  </svg>
);

const IconAlert = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="10"/>
    <line x1="12" y1="8" x2="12" y2="12"/>
    <line x1="12" y1="16" x2="12.01" y2="16"/>
  </svg>
);

const IconShield = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
  </svg>
);

const IconZap = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
  </svg>
);

const IconUsers = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
    <circle cx="9" cy="7" r="4"/>
    <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
    <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
  </svg>
);

const IconArrow = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 12h14M12 5l7 7-7 7"/>
  </svg>
);

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    const err = await login(username, password);
    setLoading(false);
    if (err) { setError(mapError(err)); return; }
    navigate('/attendance');
  }

  return (
    <div className={styles.page}>

      {/* LEFT: Branding Panel */}
      <div className={styles.brandPanel}>
        {/* Decorative: subtle blue glow accent over the photo — rendered first so content paints on top */}
        <div className={styles.bgGlow1} aria-hidden="true"/>

        <div className={styles.brandInner}>
          <div className={styles.brandMain}>
            {/* Brand lockup — real TAC logo (light variant for legibility on navy backdrop) */}
            <div className={styles.brand}>
              <img src={tacLogoLight} alt="TAC Network" className={styles.brandLogoImg} />
            </div>

            <h1 className={styles.headline}>
              <span className={styles.headlineLine}>Powering Connections.</span>
              <span className={styles.headlineLine}>Building <span className={styles.headlineAccent}>the Future.</span></span>
            </h1>

            <p className={styles.brandDesc}>
              TAC Network delivers reliable telecom infrastructure solutions that connect people and power progress.
            </p>

            <div className={styles.features}>
              <div className={styles.feature}>
                <div className={styles.featureIcon}><IconShield/></div>
                <div>
                  <div className={styles.featureTitle}>Secure Access</div>
                  <div className={styles.featureDesc}>Enterprise-grade security</div>
                </div>
              </div>
              <div className={styles.feature}>
                <div className={styles.featureIcon}><IconZap/></div>
                <div>
                  <div className={styles.featureTitle}>Reliable Platform</div>
                  <div className={styles.featureDesc}>Always available, always fast</div>
                </div>
              </div>
              <div className={styles.feature}>
                <div className={styles.featureIcon}><IconUsers/></div>
                <div>
                  <div className={styles.featureTitle}>Team Collaboration</div>
                  <div className={styles.featureDesc}>Built for field teams and partners</div>
                </div>
              </div>
            </div>
          </div>

          <p className={styles.brandFooter}>© 2026 TAC Network. All rights reserved.</p>
        </div>
      </div>

      {/* RIGHT: Login Panel */}
      <div className={styles.loginPanel}>
        {/* Mobile-only logo (hidden on desktop) */}
        <div className={styles.mobileBrand} aria-hidden="true">
          <img src={tacLogo} alt="TAC Network" className={styles.mobileBrandLogoImg} />
        </div>

        <div className={styles.card}>
          <div className={styles.cardHeader}>
            <h2 className={styles.heading}>Welcome back</h2>
            <p className={styles.subheading}>Sign in to your TAC Network account</p>
          </div>

          <form onSubmit={handleSubmit} className={styles.form}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="username">Username</label>
              <div className={styles.inputWrapper}>
                <span className={styles.inputIcon}><IconUser/></span>
                <input
                  id="username"
                  className={styles.input}
                  type="text"
                  value={username}
                  onChange={e => setUsername(e.target.value)}
                  placeholder="Enter your username"
                  autoComplete="username"
                  required
                />
              </div>
            </div>

            <div className={styles.field}>
              <label className={styles.label} htmlFor="password">Password</label>
              <div className={styles.inputWrapper}>
                <span className={styles.inputIcon}><IconLock/></span>
                <input
                  id="password"
                  className={`${styles.input} ${styles.inputPassword}`}
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="Enter your password"
                  autoComplete="current-password"
                  required
                />
                <button
                  type="button"
                  className={styles.eyeBtn}
                  onClick={() => setShowPassword(v => !v)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <IconEyeOff/> : <IconEye/>}
                </button>
              </div>
            </div>

            <div aria-live="polite" aria-atomic="true">
              {error && (
                <div className={styles.error}>
                  <span className={styles.errorIcon}><IconAlert/></span>
                  <span>{error}</span>
                </div>
              )}
            </div>

            <button className={styles.btn} type="submit" disabled={loading}>
              {loading ? (
                <>
                  <span className={styles.spinner} aria-hidden="true"/>
                  Signing in…
                </>
              ) : (
                <>
                  Sign in
                  <IconArrow/>
                </>
              )}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

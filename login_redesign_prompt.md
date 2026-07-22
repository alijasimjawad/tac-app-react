I want you to redesign and implement the TAC React login page with a premium, modern enterprise telecom style.

VERIFIED PROJECT CONTEXT (checked before writing this prompt — use this instead of re-discovering it)
- Project name: TAC React App (tac-app-react), stack: React 19 + Vite + TypeScript + Supabase.
- Production URL: https://tracker.al-ahmadi-group.com/login
- Login component: src/pages/Login.tsx
- Login styling: src/pages/Login.module.css (CSS Modules — this is the project's styling system; no Tailwind, no styled-components)
- Shared design tokens: src/styles/tokens.css — REUSE these instead of hardcoding new hex values. Mapping to this brief's suggested palette:
  - Primary blue #2563EB = var(--accent) / var(--blue-600)
  - Primary dark #1D4ED8 = var(--accent-hover) / var(--blue-700)
  - Dark navy #0F172A = var(--slate-900)
  - Secondary navy #1E293B = var(--slate-800)
  - Muted text #64748B = var(--slate-500) / var(--text-secondary)
  - Light text #94A3B8 = var(--slate-400) / var(--text-muted)
  - Border #E2E8F0 = var(--border)
  - Page background #F8FAFC = var(--bg)
  - Error #DC2626 = var(--red-600) / var(--red)
  - Radii: use var(--radius-lg) (16px) or var(--radius-xl) (20px) for the card, var(--radius-sm)/var(--radius) for inputs/buttons.
  It's fine to add a couple of NEW page-scoped variables inside Login.module.css for the deep-navy gradient (e.g. #04152F / #072B54 / #0B3F73) since nothing in tokens.css currently covers that — just don't duplicate values that already exist as tokens.
- Auth logic: src/context/AuthContext.tsx — `login(username, password)` calls `supabase.auth.signInWithPassword` with a synthesized `${username}@tac.internal` email, and currently returns the RAW `error.message` from Supabase on failure. Do NOT change AuthContext.tsx. Do the friendly-error-message mapping entirely inside Login.tsx (wrap the returned string, pattern-match on known Supabase messages like "Invalid login credentials" → "Incorrect username or password.", network failures → "Network connection error. Please check your internet connection.", anything unrecognized → "Unable to sign in. Please try again." — log the raw message to console.error for debugging).
- Icon library: NONE is installed (checked package.json — no lucide-react, react-icons, heroicons, etc.). Do not add one. Use small hand-written inline SVG icons (currentColor stroke, ~18-20px) for: user icon, lock icon, eye/eye-off toggle, shield, zap/activity, users. Keep them as simple inline `<svg>` markup in the component, or as tiny local components — whichever is less code.
- Logo: there is NO existing "TAC NETWORK" wordmark/lockup asset in this project (checked src/assets and public — only hero.png, react.svg, vite.svg, favicon.svg, icons.svg). The current Login.tsx fallback is a plain blue square with a "T" letterform. Note: there IS a logo.png elsewhere on disk (Tareeq Al-Ahmadi Company, black/gold, Arabic text) — that is a DIFFERENT, unrelated corporate asset. Do not use it. Recreate the branding lockup shown in the reference image as markup/CSS instead: a small triangle accent mark + "TAC" in bold white + "NETWORK" below in smaller letter-spaced type + "TELECOM INFRASTRUCTURE" as a thin tracked caption underneath. This can be plain HTML/CSS, no image needed.
- Localization: NONE exists in this project (no i18n system, no language context — checked). Per the brief below: OMIT the top-right language selector entirely. Do not add a non-functional placeholder for it.
- Component structure: every other page in this project (NetworkScopes.tsx, FinTeam.tsx, etc.) is a single .tsx + matching .module.css, not split into subcomponents. Follow that convention: keep this as Login.tsx + Login.module.css. It's fine to extract a tiny local PasswordInput bit inline within the same file if it keeps handleSubmit clean, but don't create a components/Login/ folder with 5 files for this — that would be over-engineering relative to how the rest of the app is built.
- Build/lint scripts (from package.json): `npm run build` (runs `tsc -b && vite build`), `npm run lint` (oxlint). There is no test script.

Do not change the current authentication logic, database logic, routing behavior, session handling, or Supabase integration unless strictly necessary. This task is mainly a UI/UX redesign of the existing login page. Reuse the existing login handler (`useAuth().login`) exactly as-is.

IMPORTANT — before editing anything:
1. Open src/pages/Login.tsx, src/pages/Login.module.css, and src/styles/tokens.css to confirm the above is still accurate.
2. Confirm nothing else imports Login.module.css or reaches into Login.tsx's internals (routing just renders <Login /> — check src/App.tsx for the route).
3. Tell me briefly which files you plan to modify before implementing (expected: src/pages/Login.tsx, src/pages/Login.module.css, possibly a couple of new small SVG-icon snippets inline — no new files, no new dependencies).

==================================================
DESIGN GOAL
==================================================
Create a premium split-screen login page for TAC Network. The page should feel modern, professional, enterprise-grade, telecom-focused, clean, and secure — suitable for a large internal company platform.

Desktop split-screen layout:
- LEFT: dark navy-blue branded visual panel, ~42–46% of width.
- RIGHT: clean light login area, remaining width.
- Fills full viewport (min-height: 100vh), no unnecessary scrolling on standard laptop/desktop screens, responsive on tablet and mobile.

==================================================
LEFT BRANDING PANEL
==================================================
Background: deep navy gradient (not flat), e.g. layered from #04152F → #072B54 → #0B3F73. Add a subtle soft blue glow in one or two areas, plus a very subtle CSS-only telecom/network pattern (faint connection lines, small glowing dots/nodes, thin circular signal rings, subtle grid lines). Keep it understated, not busy. No stock photo — CSS-generated only, per verified context above (keeps the page fast, no new asset to manage).

Brand lockup (recreated in markup/CSS, see verified context — no image asset exists for this):
- Small triangle accent mark in TAC blue
- "TAC" in bold white
- "NETWORK" below, smaller, letter-spaced
- "TELECOM INFRASTRUCTURE" thin tracked caption underneath

Headline:
"Powering Connections.
Building the Future."
— highlight "the Future." (or just "Future") in TAC primary blue.

Supporting paragraph:
"TAC Network delivers reliable telecom infrastructure solutions that connect people, teams, and operations."

Three compact feature rows below the paragraph, each with a small translucent icon container (inline SVG, see verified context), a title, and short supporting text:
1. Secure Access — Protected access for authorized employees
2. Reliable Platform — Built for daily telecom operations
3. Team Collaboration — Connecting office and field teams

Optional footer line, low contrast: "© 2026 TAC Network. All rights reserved."

==================================================
RIGHT LOGIN PANEL
==================================================
Very light background (var(--bg) / #F8FAFC or similar cool white). Vertically and horizontally center the login card.

Card:
- max-width ~460–520px
- White background, 1px solid var(--border), border-radius ~20–24px (var(--radius-xl) or close)
- Subtle shadow only (var(--shadow-lg) is close — don't go heavier)
- Comfortable internal padding

Heading: "Welcome back"
Subheading: "Sign in to your TAC Network account"

USERNAME FIELD
- Label "Username", placeholder "Enter your username"
- Keep username-based auth as-is — do NOT convert to email input type.
- Subtle user icon inside the input (inline SVG)
- Height ~50–54px, border-radius ~10–12px
- Clear focus ring in TAC blue (reuse the existing `.input:focus` box-shadow approach already in Login.module.css, just retuned to new sizing)
- Proper `<label htmlFor>` association, `autoComplete="username"`

PASSWORD FIELD
- Label "Password", placeholder "Enter your password"
- Lock icon inside input, eye/eye-off toggle button on the right to show/hide password
- Toggle must be keyboard-reachable (a real `<button type="button">`, not a div), with `aria-label` that changes between "Show password" / "Hide password"
- `autoComplete="current-password"`

Do NOT add: Google/Gmail sign-in, email login, social login, create-account/registration link, forgot-password link, contact-administrator link. (Reference image includes some of these — explicitly excluded per this brief; may come in a future phase.)

SIGN-IN BUTTON
- Full width, "Sign in" text, TAC blue (var(--accent), hover var(--accent-hover))
- Height ~50–54px, radius ~10–12px
- During submit: disabled, small loading spinner, text changes to "Signing in…" (component already tracks `loading` state — just wire it into the new markup)
- Visible keyboard focus state

ERROR MESSAGE
- Compact alert directly above the sign-in button: light red background, red border, small alert icon, readable text (reuse var(--red-100)/var(--red) tokens, just restyle the container)
- Map Supabase's raw error to a friendly message per the mapping described in "Auth logic" above. Never show the raw Supabase string to the user; console.error it instead.

==================================================
LANGUAGE SELECTOR
==================================================
Omit entirely — no i18n system exists in this project (verified above). Do not add a placeholder control.

==================================================
RESPONSIVE BEHAVIOR
==================================================
- Desktop: full split layout, left ~44% / right ~56%.
- Tablet: narrow the left panel, reduce text sizes/spacing, keep it balanced.
- Mobile (below ~900px, or whatever breakpoint pattern the rest of the app already uses — check Sidebar.module.css / AppLayout.module.css for the existing convention and match it): hide the large branding panel, show a compact TAC logo/wordmark above the form instead, full-width login layout, ~20–24px horizontal padding, card not touching screen edges, all touch targets ≥44px, no horizontal overflow.

==================================================
VISUAL STYLE
==================================================
Clean typography, strong spacing hierarchy, premium enterprise feel, subtle shadows/borders, smooth hover transitions, TAC blue accent, dark navy headings, cool gray supporting text. Avoid: excessive gradients, glassmorphism, heavy blur, oversized elements, excessive animation, generic SaaS clichés, neon colors.

==================================================
ACCESSIBILITY
==================================================
Semantic form markup, real `<label>` elements (not placeholder-only), full keyboard navigation, visible focus states, sufficient contrast, accessible password-visibility toggle with aria-label, `aria-live="polite"` (or similar) region for the error message so screen readers announce it, disabled button state during submit, respect `prefers-reduced-motion`.

==================================================
ANIMATION
==================================================
Minimal only: login card fades in gently on load, branding content can shift up a few px on load, smooth button-hover and input-focus transitions. Duration 150–350ms. Wrap in a `prefers-reduced-motion` media query. Do not install an animation library for this.

==================================================
TECHNICAL REQUIREMENTS (recap)
==================================================
1. Preserve existing authentication functionality, username/password method, Supabase integration, post-login redirect (`navigate('/attendance')`), and protected-route behavior.
2. No DB schema or Supabase table changes.
3. No Google OAuth, no email auth, no registration.
4. No new dependencies (no icon package, no animation library).
5. Reuse tokens.css variables wherever they already cover a value in this brief.
6. Keep to Login.tsx + Login.module.css, matching this project's existing single-file-page convention (see verified context).
7. Don't touch other pages, the sidebar, or global layout.

==================================================
IMPLEMENTATION PROCESS
==================================================
Step 1: Confirm the verified project context above still holds (quick look at the 3 files listed), then tell me the exact files you'll touch.
Step 2: Implement the new responsive design in Login.tsx / Login.module.css.
Step 3: Run `npm run build` and `npm run lint`. Fix anything they flag.
Step 4: Give me a concise completion summary: files modified, main UI changes, confirmation auth logic/Supabase integration is untouched, confirmation no Google/email login or language selector was added, build+lint results, any follow-ups worth doing later (e.g. forgot-password flow, i18n).
Step 5: Once the build and lint are clean, commit and push:
   git add -A
   git commit -m "Redesign login page: premium split-screen enterprise style"
   git push
   (this repo's `main` branch auto-deploys to production via Vercel — a real push will trigger a live deployment, so only do this after build/lint pass clean.)

Use the attached reference image as the primary visual target for layout, proportions, spacing, typography hierarchy, colors, and card dimensions — reproduced as closely as possible within the constraints above (no stock photo, no icon package, no Google/forgot-password/register/language-selector elements, recreated logo lockup instead of an image asset).

import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { ensureFullLoad as ensureSitesPreload } from '../lib/sitesCache';
import { FIELD_ROLE_DEFAULT_KEYS, LEGACY_ACTION_KEY, LEGACY_OPEN_ACTIONS } from '../lib/permissionsCatalog';

export interface UserProfile {
  id: string;
  username: string;
  full_name: string;
  role: string;
  permissions: Record<string, boolean>;
  auth_user_id: string;
  profile_photo_url: string | null;
  phone: string | null;
  national_id: string | null;
  date_of_birth: string | null;
  address: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  start_date: string | null;
  notes: string | null;
}

interface AuthState {
  session: Session | null;
  currentUser: UserProfile | null;
  loading: boolean;
}

interface AuthContextValue extends AuthState {
  login: (username: string, password: string) => Promise<string | null>;
  logout: () => Promise<void>;
  hasPerm: (key: string) => boolean;
  refreshProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

// Topbar/sidebar avatar is sourced only from the user's own `users.profile_photo_url`
// (set via the My Profile page). It is intentionally independent from
// `team_members.profile_photo_url` (set via HR Profiles) — the two are
// separate photos with no cross-linking, so HR photo changes never affect
// this, and vice versa.
async function fetchProfile(authUserId: string): Promise<UserProfile | null> {
  const { data, error } = await supabase
    .from('users')
    .select('id, username, full_name, role, permissions, auth_user_id, phone, national_id, date_of_birth, address, emergency_contact_name, emergency_contact_phone, start_date, notes, profile_photo_url')
    .eq('auth_user_id', authUserId)
    .single();
  if (error || !data) return null;
  return { ...data, profile_photo_url: data.profile_photo_url ?? null } as UserProfile;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    session: null,
    currentUser: null,
    loading: true,
  });

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      let currentUser: UserProfile | null = null;
      if (session) {
        currentUser = await fetchProfile(session.user.id);
        if (currentUser) ensureSitesPreload().catch(() => {}); // warm cache in background
      }
      setState({ session, currentUser, loading: false });
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (_event, session) => {
      let currentUser: UserProfile | null = null;
      if (session) {
        currentUser = await fetchProfile(session.user.id);
        if (currentUser) ensureSitesPreload().catch(() => {}); // warm cache on login
      }
      setState(prev => ({ ...prev, session, currentUser }));
    });

    return () => subscription.unsubscribe();
  }, []);

  async function login(username: string, password: string): Promise<string | null> {
    const email = `${username.trim().toLowerCase()}@tac.internal`;
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return error.message;
    if (!data.session) return 'Login failed — no session returned';
    const profile = await fetchProfile(data.session.user.id);
    if (!profile) return 'Login succeeded but user profile not found. Run the migration script first.';
    setState(prev => ({ ...prev, session: data.session, currentUser: profile }));
    return null;
  }

  async function logout(): Promise<void> {
    await supabase.auth.signOut();
    setState({ session: null, currentUser: null, loading: false });
  }

  async function refreshProfile(): Promise<void> {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;
    const profile = await fetchProfile(session.user.id);
    if (profile) setState(prev => ({ ...prev, currentUser: profile }));
  }

  function hasPerm(key: string): boolean {
    const u = state.currentUser;
    if (!u) return false;
    if (u.role === 'admin') return true;
    const roleLower = u.role?.toLowerCase();
    if (key === 'view_my_expenses' && (roleLower === 'engineer' || roleLower === 'technician')) return true;
    // Explicit true/false set by an admin in User Management always wins.
    const stored = u.permissions?.[key];
    if (typeof stored === 'boolean') return stored;
    // Scoped action keys (da_add_rows, sdb_add_rows, etc.) fall back to the
    // single global action key they replaced (add_rows, etc.) so any user
    // already granted that action keeps working identically on every page
    // until an admin explicitly sets one of the new scoped keys for them.
    const legacyKey = LEGACY_ACTION_KEY[key];
    if (legacyKey) {
      const legacyStored = u.permissions?.[legacyKey];
      if (typeof legacyStored === 'boolean') return legacyStored;
    }
    // Finance/HR/Sites-DB-master/Activity-Log action keys had no permission
    // check at all before they were added — anyone who could view the page
    // could already do everything. Default to "can view the parent page?" so
    // nobody's current access silently disappears; an admin can still lock a
    // specific user down by explicitly toggling the key off in User Management.
    const openFallbackViewKey = LEGACY_OPEN_ACTIONS[key];
    if (openFallbackViewKey) return hasPerm(openFallbackViewKey);
    // Otherwise fall back to the field-role default (Sites DB / My Attendance /
    // My Trips) so Engineer/Technician accounts keep their existing default
    // nav until an admin explicitly changes it — see permissionsCatalog.ts.
    if (FIELD_ROLE_DEFAULT_KEYS.includes(key) && (roleLower === 'engineer' || roleLower === 'technician')) return true;
    return false;
  }

  return (
    <AuthContext.Provider value={{ ...state, login, logout, hasPerm, refreshProfile }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

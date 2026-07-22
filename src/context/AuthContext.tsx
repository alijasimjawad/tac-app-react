import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { ensureFullLoad as ensureSitesPreload } from '../lib/sitesCache';

export interface UserProfile {
  id: string;
  username: string;
  full_name: string;
  role: string;
  permissions: Record<string, boolean>;
  auth_user_id: string;
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

async function fetchProfile(authUserId: string): Promise<UserProfile | null> {
  const { data, error } = await supabase
    .from('users')
    .select('id, username, full_name, role, permissions, auth_user_id')
    .eq('auth_user_id', authUserId)
    .single();
  if (error || !data) return null;
  return data as UserProfile;
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
    return u.permissions?.[key] === true;
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

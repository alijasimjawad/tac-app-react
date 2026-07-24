import { supabase } from './supabase';

/**
 * Insert a row into activity_log. Never throws — a logging failure
 * should never block the actual action the user just performed.
 */
export async function logActivity(params: {
  userFullName: string | null | undefined;
  action: string;
  projectName?: string | null;
  sectionName?: string | null;
  details?: string | null;
}) {
  try {
    const { error } = await supabase.from('activity_log').insert({
      user_full_name: params.userFullName ?? 'Unknown',
      action: params.action,
      project_name: params.projectName ?? null,
      section_name: params.sectionName ?? null,
      details: params.details ?? null,
    });
    // Supabase's client resolves (doesn't throw) on RLS/permission/schema
    // errors, so without this check an insert failure would be invisible —
    // the log would just silently stop updating.
    if (error) console.error('logActivity insert failed:', error.message, error);
  } catch (e) {
    console.error('logActivity threw:', e);
  }
}

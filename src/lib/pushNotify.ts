// Server-triggered web push helpers — mirrors old app's sendPushToUser/sendPushToRoles.
// All calls are fire-and-forget from the caller's perspective (errors are swallowed here
// and only logged), so a push failure never blocks or breaks the underlying user action.
import { supabase } from './supabase';

export async function sendPushToUser(userId: string, title: string, body: string, url?: string): Promise<void> {
  try {
    const { data } = await supabase
      .from('push_subscriptions')
      .select('subscription')
      .eq('user_id', userId)
      .single();
    if (!data?.subscription) return;
    await fetch('/api/send-push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: data.subscription, title, body, url }),
    });
  } catch (err) {
    console.warn('[Push] sendPushToUser failed:', err);
  }
}

export async function sendPushToRoles(roles: string[], title: string, body: string, url?: string): Promise<void> {
  try {
    const { data: users } = await supabase.from('users').select('id').in('role', roles);
    if (!users?.length) return;
    await Promise.all(users.map(u => sendPushToUser(u.id, title, body, url)));
  } catch (err) {
    console.warn('[Push] sendPushToRoles failed:', err);
  }
}

// team_members has no direct FK to users — resolve by matching full_name, same approach
// the old app used (_getMemberUserId), since usernames aren't stored on team_members.
export async function getMemberUserId(memberFullName: string | null | undefined): Promise<string | null> {
  if (!memberFullName) return null;
  try {
    const { data } = await supabase
      .from('users')
      .select('id')
      .eq('full_name', memberFullName)
      .limit(1)
      .single();
    return data?.id ?? null;
  } catch {
    return null;
  }
}

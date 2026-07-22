/**
 * One-off script: migrate TAC users table → Supabase Auth.
 *
 * RUN ONCE LOCALLY. Never deploy. Never commit the service role key.
 *
 * Usage:
 *   SUPABASE_SERVICE_ROLE_KEY=<key> npx tsx scripts/migrate-users-to-auth.ts
 *
 * The service role key is in Supabase Dashboard → Settings → API → service_role.
 * It must NEVER be put in .env, never bundled into the frontend, and never committed.
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://gauejhgitzcqjvzalshf.supabase.co';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SERVICE_ROLE_KEY) {
  console.error('ERROR: SUPABASE_SERVICE_ROLE_KEY env var is not set.');
  console.error('Set it with: SUPABASE_SERVICE_ROLE_KEY=xxx npx tsx scripts/migrate-users-to-auth.ts');
  process.exit(1);
}

// Admin client — uses service role key, bypasses RLS.
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

interface TacUser {
  id: string;
  username: string;
  password: string;
  full_name: string;
  role: string;
  auth_user_id: string | null;
}

async function main() {
  console.log('Fetching users from TAC users table…');

  const { data: users, error } = await supabase
    .from('users')
    .select('id, username, password, full_name, role, auth_user_id');

  if (error) {
    console.error('Failed to fetch users:', error.message);
    process.exit(1);
  }

  const all = (users || []) as TacUser[];
  console.log(`Found ${all.length} users total.`);

  let migrated = 0;
  let skipped  = 0;
  let failed   = 0;
  const failures: { username: string; reason: string }[] = [];

  for (const u of all) {
    if (u.auth_user_id) {
      console.log(`  SKIP  ${u.username} (auth_user_id already set)`);
      skipped++;
      continue;
    }

    if (!u.password) {
      console.log(`  SKIP  ${u.username} (no password in users table)`);
      skipped++;
      continue;
    }

    const email = `${u.username.trim().toLowerCase()}@tac.internal`;

    const { data: authData, error: authErr } = await supabase.auth.admin.createUser({
      email,
      password: u.password,
      email_confirm: true,
      user_metadata: { full_name: u.full_name, role: u.role },
    });

    if (authErr) {
      // Handle duplicate (already exists in Auth from a previous partial run)
      if (authErr.message.includes('already been registered') || authErr.code === 'email_exists') {
        // Try to look up the existing auth user by email
        const { data: list } = await (supabase.auth.admin as any).listUsers();
        const existing = list?.users?.find((au: { email?: string }) => au.email === email);
        if (existing) {
          await supabase.from('users').update({ auth_user_id: existing.id }).eq('id', u.id);
          console.log(`  LINK  ${u.username} (auth user already existed, linked)`);
          migrated++;
          continue;
        }
      }
      console.error(`  FAIL  ${u.username}: ${authErr.message}`);
      failures.push({ username: u.username, reason: authErr.message });
      failed++;
      continue;
    }

    const authUserId = authData.user?.id;
    if (!authUserId) {
      console.error(`  FAIL  ${u.username}: no user ID in response`);
      failures.push({ username: u.username, reason: 'no user ID returned' });
      failed++;
      continue;
    }

    const { error: updateErr } = await supabase
      .from('users')
      .update({ auth_user_id: authUserId })
      .eq('id', u.id);

    if (updateErr) {
      console.error(`  FAIL  ${u.username}: created in Auth but failed to update users row: ${updateErr.message}`);
      failures.push({ username: u.username, reason: `Auth OK but update failed: ${updateErr.message}` });
      failed++;
      continue;
    }

    console.log(`  OK    ${u.username} → ${email} (auth id: ${authUserId})`);
    migrated++;
  }

  console.log('\n── Summary ─────────────────────────────');
  console.log(`  Migrated : ${migrated}`);
  console.log(`  Skipped  : ${skipped}`);
  console.log(`  Failed   : ${failed}`);
  if (failures.length) {
    console.log('\n  Failures:');
    failures.forEach(f => console.log(`    ${f.username}: ${f.reason}`));
  }
  console.log('─────────────────────────────────────────');
}

main().catch(e => { console.error(e); process.exit(1); });

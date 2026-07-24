# Project instructions for Claude Code

## Auto-commit & push

After completing any code change task in this repo (UI edits, bug fixes, new
features, refactors, etc.):

1. Run `npx tsc -b` and make sure there are no TypeScript errors before
   committing. Fix any errors first.
2. Stage only the files you actually changed for this task (`git add <files>`
   — avoid `git add -A` unless you're sure everything staged is intentional).
3. Commit with a clear, descriptive message summarizing what changed and why.
4. Push to `origin main` (`git push`) automatically — do not wait for the
   user to ask.

Only skip the auto-push step if:
- The build/typecheck is failing and you couldn't fix it.
- The user explicitly says not to commit/push for this task.
- The change is exploratory/experimental and the user hasn't confirmed they
  want it kept.

If `git push` fails (e.g. diverged branch, auth issue), tell the user exactly
what happened and what command they need to run themselves — don't force-push
or silently retry with destructive flags.

## Notes

- Vercel auto-deploys on every push to `main`, so a successful push means the
  change goes live shortly after (usually 1-2 minutes).
- This app is a React 19 + Vite + TypeScript + Supabase project deployed to
  tracker.al-ahmadi-group.com.

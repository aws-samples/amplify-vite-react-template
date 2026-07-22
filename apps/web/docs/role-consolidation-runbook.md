# Role consolidation runbook — OWNER + TECH

_2026-07-20. Consolidates the four staff roles {OWNER, OFFICE, FINANCE, TECH}
down to two: **OWNER** (all office + money + admin work) and **TECH** (field
only). The **CUSTOMER** portal role is untouched. This is the deploy-side work
that has to happen around the code change; skipping the migration step locks
staff out._

## What changed in code

- `amplify/auth/resource.ts` — `groups` is now `["OWNER", "TECH", "CUSTOMER"]`.
  Removing `OFFICE`/`FINANCE` from this list **deletes those Cognito groups on
  deploy.**
- `shared/staffRoles.ts` — `STAFF_ROLES = ["OWNER", "TECH"]`.
- `shared/authz.ts` — `callerIsOffice`/`callerIsFinance` now both mean "is
  OWNER"; `STAFF_GROUPS = ["OWNER", "TECH"]`.
- `crm-billing/handler.ts` — the owner-only large-charge approval tier is gone
  (every login that can charge is an owner now). The absolute $20k fat-finger
  ceiling stays and applies to everyone.
- CRM `lib/auth.tsx` — `roles.office`/`roles.finance` are aliases of
  `roles.owner`, so existing UI branches keep working for the consolidated owner.
- `office/Staff.tsx` — invite/change-role offers only **Owner**, **Technician**,
  and **Owner + technician**.

## The migration (MUST run before / with the deploy)

Removing `OFFICE`/`FINANCE` from the group list deletes those groups. Any login
whose ONLY staff group is `OFFICE` or `FINANCE` would be left with no staff
access. So **before those groups disappear, every OFFICE/FINANCE member must be
added to OWNER.**

Staging user pool: `us-east-1_Y5nBQwvPn` (region `us-east-1`).

### 1. See who is affected (read-only)

```bash
POOL=us-east-1_Y5nBQwvPn
for G in OFFICE FINANCE; do
  echo "== $G =="
  aws cognito-idp list-users-in-group --region us-east-1 \
    --user-pool-id "$POOL" --group-name "$G" \
    --query 'Users[].Username' --output text
done
```

### 2. Add every OFFICE/FINANCE member to OWNER (idempotent)

Adding someone already in OWNER is a no-op, so this is safe to re-run.

```bash
POOL=us-east-1_Y5nBQwvPn
for G in OFFICE FINANCE; do
  for U in $(aws cognito-idp list-users-in-group --region us-east-1 \
      --user-pool-id "$POOL" --group-name "$G" \
      --query 'Users[].Username' --output text); do
    echo "Promoting $U (was $G) -> OWNER"
    aws cognito-idp admin-add-user-to-group --region us-east-1 \
      --user-pool-id "$POOL" --group-name OWNER --username "$U"
  done
done
```

> Decision (Jake, 2026-07-20): every former office/finance staffer becomes a
> full **owner**. A field-only person stays **TECH**. A working owner who also
> runs routes is in both OWNER and TECH.

### 3. Deploy the code

`OFFICE` and `FINANCE` are deleted as part of the Amplify deploy. Members are
already in OWNER (step 2), so no one loses access. Existing tokens still listing
`OFFICE`/`FINANCE` keep working until they expire — `callerIsOffice`/
`callerIsFinance` now key off OWNER, and every promoted user is an OWNER.

### 4. Verify

```bash
POOL=us-east-1_Y5nBQwvPn
# OFFICE / FINANCE should no longer exist:
aws cognito-idp get-group --region us-east-1 --user-pool-id "$POOL" \
  --group-name OFFICE 2>&1 | grep -q ResourceNotFound && echo "OFFICE gone: OK"
# Owners:
aws cognito-idp list-users-in-group --region us-east-1 \
  --user-pool-id "$POOL" --group-name OWNER \
  --query 'Users[].Username' --output text
```

Then sign in to the CRM as a promoted user and confirm the money/office actions
still work, and that Staff → Invite offers only Owner / Technician / Owner +
technician.

## Rollback

If you must revert: restore `OFFICE`/`FINANCE` in `auth/resource.ts` groups and
redeploy (recreates the groups, empty), then re-add the users to their prior
groups from your step-1 capture. Because owners retain every capability, leaving
everyone as OWNER is the safer forward path than re-splitting.

## Production

Same three steps against the production pool (get its id from the prod
`amplify_outputs.json` / Amplify console) during the go-live window. Run step 1
first so you have a record of who was in each group before the groups vanish.

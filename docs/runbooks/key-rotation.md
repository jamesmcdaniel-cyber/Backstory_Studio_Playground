# Encryption key rotation runbook

Expands the short procedure previously in `docs/runbooks/deploy.md`'s Secrets
section into full steps. Format and key ring: `src/lib/crypto/secrets.ts`.
Rotation script: `scripts/rotate-encryption-key.ts` (`npm run secrets:rotate`).

`ENCRYPTION_KEY` is **required in production** — the server refuses to boot
without it (`src/lib/env.ts`, enforced at startup via `instrumentation.ts`;
`src/lib/crypto/secrets.ts` hard-fails too). Payloads are stored as
`v2:<keyId>:<iv>:<tag>:<ciphertext>`, where `keyId` is a digest of the derived
key (never the key material itself), so a payload's key id can be inspected
without decrypting it.

## Preconditions

- You have the **new** key value ready (any non-empty string; treat it as a
  real secret regardless — `ENCRYPTION_KEY_PROVIDER=env` keeps it in
  plaintext in the environment, so this is also a good moment to consider
  `vault` or `aws-kms` instead — see the provider block in `.env.example`).
- You have access to set both `ENCRYPTION_KEY` and `ENCRYPTION_KEY_PREVIOUS`
  in the production environment (Vercel dashboard or `vercel env`) **and** to
  run `npm run secrets:rotate` against the production database — this needs
  `SYSTEM_DATABASE_URL` (or `DATABASE_URL`) pointed at production, since the
  script runs cross-tenant via `systemPrisma` (`scripts/rotate-encryption-key.ts`
  uses `systemPrisma`, like every other maintenance sweep — there is no
  per-workspace rotation).
- Nobody else is mid-rotation. The script is safe to interrupt and re-run
  (idempotent, per-row), but running two rotations concurrently against the
  same database is not a supported configuration.

## Steps

1. **Both keys live.** Set `ENCRYPTION_KEY` to the new key and
   `ENCRYPTION_KEY_PREVIOUS` to the outgoing key (comma-separate multiple
   retired keys if more than one is still in play). Deploy. From this point,
   reads succeed against either key and every new write uses the new one —
   nothing is broken yet, this step only widens what's readable.

2. **Dry run.**

   ```bash
   ENCRYPTION_KEY=<new> ENCRYPTION_KEY_PREVIOUS=<old> npm run secrets:rotate -- --dry-run
   ```

   This decrypts and re-encrypts every stored secret **in memory only** —
   `mcp_connections.authConfig`, `integration_secrets.authConfig`,
   `http_credentials.secretConfig`, `organizations.peopleAiWebhookSecret`, and
   `peopleai_connections` access/refresh tokens — and writes nothing. It
   prints a per-table tally (`scanned / rotated / current / failed`) and a
   list of any row whose payload no configured key can decrypt. **Do not
   proceed while it reports any failures** — add the missing key to
   `ENCRYPTION_KEY_PREVIOUS` and re-run the dry run until it reports zero.

3. **Rotate for real.**

   ```bash
   ENCRYPTION_KEY=<new> ENCRYPTION_KEY_PREVIOUS=<old> npm run secrets:rotate
   ```

   Re-encrypts every row not already on the active key, one row at a time
   (read-modify-write per row, so a concurrent write from the live app loses
   at most that one row — the next run fixes it). Payloads already on the
   active key are skipped, so this is safe to re-run if interrupted.

4. **Verify.** Re-run the same command (without `--dry-run`) until it reports
   `0` remaining / rotated — i.e. every payload is already current. This is
   the same command as step 3; "verification" here just means confirming
   convergence, not a separate script.

5. **Retire the old key.** Only once step 4 reports zero remaining, unset
   `ENCRYPTION_KEY_PREVIOUS` in the production environment and redeploy.

## Adding a new encrypted column

If a future column stores an encrypted secret, add it to
`scripts/rotate-encryption-key.ts` (either a new `rotateStringColumns` or
`rotateJsonConfig` call, following the existing five) and classify it in
`src/lib/__tests__/sensitive-columns.test.ts`. That test fails on any
unclassified sensitive-looking column, specifically so a new encrypted column
cannot be added and then silently stranded on the next rotation.

## Verification

- `npm run secrets:rotate -- --dry-run` reports `0 failed` across all five
  tables.
- Spot check in the app: open an integration/MCP connection that existed
  before rotation and confirm it still works (proves the ciphertext round-
  trips through the new key path, not just that the script's in-memory
  decrypt succeeded).
- `grep` a sample of rotated rows for the new key id prefix if you want DB-
  level confirmation — `activeKeyId()` (`src/lib/crypto/secrets.ts`) is a
  digest of the new key, and post-rotation payloads should start
  `v2:<that id>:`.

## Rollback

- **Before step 5 (old key still set):** rotation is non-destructive up to
  this point — every row not yet rotated is still readable via
  `ENCRYPTION_KEY_PREVIOUS`. If something looks wrong, just leave
  `ENCRYPTION_KEY_PREVIOUS` set (do not unset it) and investigate; nothing is
  lost.
- **To fully roll back the new key:** swap `ENCRYPTION_KEY` back to the old
  value and set `ENCRYPTION_KEY_PREVIOUS` to the (now newer, possibly
  partially-written) key, then run `npm run secrets:rotate` again to
  re-converge everything onto the old key. This only works if you have not
  yet unset the old key from `ENCRYPTION_KEY_PREVIOUS` (step 5) — once that
  happens, the old key is gone and rows already rotated onto the new key are
  unreadable without it. **Treat step 5 as the point of no return.**
- **If a row reports `failed` (undecryptable with any configured key):** it
  is left untouched by the script — it is reported, not corrupted. Add
  whatever key it actually needs to `ENCRYPTION_KEY_PREVIOUS` and re-run; do
  not unset any candidate key until the failure list is empty.

## Related

- `docs/runbooks/security-controls.md` §2 — the shorter operational summary
  this runbook expands on, kept in sync with these steps.
- `docs/runbooks/deploy.md` — Secrets section, links here.

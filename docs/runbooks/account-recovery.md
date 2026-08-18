# Account recovery runbook

What to do when someone cannot get past the multi-factor gate. The gate itself
lives in [`requireAuthContext`](../../src/lib/server/auth.ts): a platform-privileged
account, or any member of a workspace whose policy is `required`, is refused with
`MFA_REQUIRED` until their session satisfies the policy.

## Why there are no backup codes

Assurance level (`aal2`) is minted by Supabase, and only in exchange for a
verified factor challenge. A code we printed and stored ourselves could unlock a
page but could never raise the session's AAL, so every gated route would keep
refusing — a recovery path that appears to work and does not. Recovery is
therefore **admin-driven factor reset** plus self-service factor management, and
nothing in this codebase forges an AAL.

## 1. Lost device (TOTP, no SSO)

Symptom: the person reaches `/auth/mfa`, is asked for a code, and no longer has
the authenticator app. Nothing they can do alone will clear this — removing your
last factor is deliberately refused by
[`/api/auth/mfa/factors`](../../src/app/api/auth/mfa/factors/route.ts) for an
account under a required policy.

1. **The user contacts a platform administrator** through a channel that proves
   who they are. This is the whole security of the procedure: the reset hands the
   next person who signs in with those credentials an account with no second
   factor, so identifying the requester is not a formality. A message from an
   account that may itself be compromised (their platform email, a Slack DM from a
   session you cannot vouch for) is not identification.
2. **The administrator opens** Admin → Users, finds the account, and clicks
   **Reset MFA** in the detail panel.
3. The action deletes every factor on the account — verified and half-finished
   alike — through the Supabase service-role admin API
   ([`deleteAllFactors`](../../src/lib/auth/mfa-admin.ts)). It writes an audit row
   `platform.users.reset-mfa` naming the operator, the target, and how many
   factors were removed. A result of **0 factors removed** means the account had
   no authenticator, so whatever is blocking the person is *not* MFA — check
   `SSO_REQUIRED`, `ACCOUNT_DEACTIVATED` and `PLATFORM_ACCESS_REVOKED` before
   going further.
4. **The user signs in again.** With no factor their session is `aal1`, the gate
   refuses, and they are routed to `/auth/mfa`, which now offers enrollment: QR
   code, manual secret key, then a verification code. Once verified the session
   is `aal2` and access returns. Nothing was granted by the reset itself — no
   session is minted, and an account under a required policy still cannot reach
   anything until it has enrolled again.

Expect the person to be locked out for exactly as long as it takes them to scan
the new QR code. Tell them to keep the old authenticator entry only until the new
one works, then delete it.

## 2. Stale enrollment ("I get an error setting it up")

An abandoned enrollment leaves an *unverified* factor behind, and Supabase
refuses a fresh `enroll()` while one exists. `/auth/mfa` now clears that debris
and retries by itself, so this needs no operator action. If it recurs for one
account, run the Reset MFA action above — it removes unverified factors too.

## 3. Session that will not step up

Someone who is already enrolled and lands on `/auth/mfa` is asked for a code
against their existing factor (challenge/verify), not offered a new QR. If they
have the app and the code is rejected, the usual cause is clock drift on the
phone — have them enable automatic time on the device. If they no longer have
the app, this is case 1.

## 4. SSO / Okta users

Members whose sessions are brokered by the workspace identity provider satisfy
the MFA policy through the IdP
([`satisfiesMfaPolicy`](../../src/lib/auth/enterprise-policy.ts)), so they have no
TOTP factor for us to reset and **an MFA reset will not help them**. Recovery for
these accounts belongs to the IdP:

- Lost Okta factor → Okta admin resets it. We do nothing.
- Okta account disabled → they are blocked before they reach us.
- A `SSO_REQUIRED` refusal means they signed in a way the workspace does not
  accept (a password, or a personal Google account). Send them back through
  "Sign in with your identity provider" rather than resetting anything.

Company-domain Google sign-in counts as enterprise for the domains in
`COMPANY_EMAIL_DOMAINS` only, because those Workspaces federate to Okta. For any
other domain, Google alone does not satisfy the policy and the person must
enroll TOTP.

## 5. The platform owner

The two hardcoded OWNER emails are immutable at four layers, including a
users-table trigger, and the auth path deliberately exempts them from every
lockout so that a configuration mistake can never leave the platform with nobody
able to correct it.

- **Resetting the owner's MFA is allowed** and is the supported recovery for a
  lost owner device. It removes a factor, never access, and the audit row carries
  `isPlatformOwner: true`.
- Deactivation, role change, and anything else that could remove owner access
  stay refused (`OWNER_PROTECTED`) — the Reset MFA action does not weaken that.
- The owner is exempt from the privileged-MFA gate itself, so they are not
  bounced to `/auth/mfa`; if they are locked out, the cause is elsewhere and the
  reset is not the fix.

## 6. Self-service (no operator needed)

Settings → Account lists the caller's enrolled authenticators
([`MfaSection`](../../src/components/settings/mfa-section.tsx)) and can remove
one. Two guards, both enforced server-side and merely *displayed* by the UI:

- **Step-up** — the session must be `aal2` and, where the token exposes an `amr`
  timestamp, the verification must be within 15 minutes
  ([`mfa-session.ts`](../../src/lib/auth/mfa-session.ts)). A stolen but still-warm
  session cannot quietly strip the second factor that would contain it. The fix
  is to re-verify at `/auth/mfa` and come back.
- **Last factor** — removing the only verified factor from an account whose
  policy requires MFA is refused (`LAST_FACTOR`). Adding a second authenticator
  first is the self-service route; otherwise it is case 1.

Both refusals are decided by
[`removalWouldLockOut`](../../src/lib/auth/mfa-factors.ts) and
[`stepUpSatisfied`](../../src/lib/auth/mfa-session.ts), and every successful
removal writes an `account.mfa.factor_removed` audit row.

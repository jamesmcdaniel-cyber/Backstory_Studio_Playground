# Okta ↔ Supabase SAML setup (Okta on every sign-in)

Goal: Backstory Studio sign-ins for `people.ai` / `backstory.ai` go **directly
to Okta** (not through Google's session), and Okta prompts for verification on
**every** sign-in.

The app side is already live: the login page shows "Sign in with Okta" buttons
for the company domains, which call Supabase's SAML SSO by domain
(`signInWithSSO`). Until the connection below is registered, those buttons fall
back to Google with a notice — nothing breaks in the gap. The moment the
connection exists, the same buttons start landing on Okta.

Server-side, a SAML session carries `sso/saml` in the JWT `amr` claim, which
`satisfiesMfaPolicy` already accepts as MFA-complete — no other code changes
are needed when the connection goes live.

## 1. Enable SAML SSO on the Supabase project

SAML SSO is available on Supabase Pro and above. In the Supabase dashboard for
the production project: **Authentication → Sign In / Up → SSO (SAML 2.0)** →
enable it. Note the two URLs Supabase derives from the project ref
(`<project-ref>` = the subdomain of your `NEXT_PUBLIC_SUPABASE_URL`):

- Entity ID / metadata: `https://<project-ref>.supabase.co/auth/v1/sso/saml/metadata`
- ACS (reply) URL:      `https://<project-ref>.supabase.co/auth/v1/sso/saml/acs`

## 2. Create the Okta app

Okta Admin → **Applications → Create App Integration → SAML 2.0**:

- Single sign-on URL (ACS): the ACS URL above (check "Use this for Recipient
  URL and Destination URL")
- Audience URI (SP Entity ID): the metadata URL above
- Name ID format: `EmailAddress`; Application username: `Email`
- Attribute statements: `email` → `user.email` (add `name` → `user.displayName`
  if you want names synced)

Assign the app to the people who should have access (or the relevant Okta
groups). Copy the app's **metadata URL** (Sign On tab → SAML Setup →
"Identity Provider metadata").

## 3. Register the connection with Supabase

With the Supabase CLI (logged in, against the prod project ref):

```sh
supabase sso add --project-ref <project-ref> \
  --type saml \
  --metadata-url '<okta-metadata-url>' \
  --domains people.ai,backstory.ai \
  --attribute-mapping-file <(echo '{"keys":{"email":{"name":"email"}}}')
```

`--domains` is what makes `signInWithSSO({ domain: 'people.ai' })` resolve to
this connection. Verify with `supabase sso list --project-ref <project-ref>`.

## 4. Make Okta prompt on every sign-in

This is the piece Google could never give us. Okta Admin → the new app →
**Sign On → Authentication policy**: assign (or create) a policy whose rule
sets **"Prompt for authentication: Every sign-in attempt"** (in newer Okta:
re-authentication frequency "Every sign-in"). MFA requirements come from the
same policy — set the factors you want prompted.

## 5. Verify

1. Open a private window → backstory-studio.vercel.app → "Sign in with Okta ·
   @people.ai" → should land on Okta, prompt, and return signed in.
2. Sign out, sign in again immediately → Okta should prompt **again** (step 4
   is working).
3. `Settings → Enterprise Security → Require SSO` can then be enabled per
   workspace (needs the domain verified under the same screen) to refuse
   non-Okta sessions outright — flip it only after step 5.1 works.

## Rollback

`supabase sso remove <connection-id> --project-ref <project-ref>` removes the
connection; the login buttons fall back to Google automatically.

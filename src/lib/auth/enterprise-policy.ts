export function emailDomain(email: string | null | undefined): string | null {
  const normalized = email?.trim().toLowerCase()
  const at = normalized?.lastIndexOf('@') ?? -1
  return at > 0 && at < (normalized?.length ?? 0) - 1 ? normalized!.slice(at + 1) : null
}

// Only identities brokered by the workspace IdP count. Supabase marks SAML
// sign-ins 'sso/saml' in the JWT's amr claim and 'sso:<provider-uuid>' in the
// identity provider field. Plain social OAuth (google, azure, …) is explicitly
// NOT enterprise: "Continue with Google" bypasses the org's Okta policy unless
// the Workspace itself federates to it, which we cannot verify from here.
const SSO_METHODS = new Set(['sso', 'saml', 'sso/saml'])

export function isEnterpriseIdentity(methods: readonly string[]): boolean {
  return methods.some((method) => {
    const normalized = method.toLowerCase()
    return SSO_METHODS.has(normalized) || normalized.startsWith('sso:') || normalized.startsWith('saml:')
  })
}

/** Method names from a JWT `amr` claim, tolerating both string and object entries. */
export function amrMethods(amr: unknown): string[] {
  if (!Array.isArray(amr)) return []
  return amr.flatMap((entry) => {
    if (typeof entry === 'string') return [entry]
    if (entry && typeof entry === 'object' && typeof (entry as { method?: unknown }).method === 'string') {
      return [(entry as { method: string }).method]
    }
    return []
  })
}

/**
 * An enterprise-brokered session satisfies an MFA requirement: the workspace
 * IdP (Okta) enforces its own MFA policy at sign-in, so demanding a TOTP
 * factor on top forces employees to carry an authenticator app for a session
 * that already passed a second factor. TOTP (aal2) remains the path for
 * accounts outside the IdP — password and social sign-ins carry no such
 * guarantee, so they still must enroll.
 */
export function satisfiesMfaPolicy(
  policy: string,
  assuranceLevel: string | null,
  methods: readonly string[] = [],
): boolean {
  if (policy !== 'required') return true
  return assuranceLevel === 'aal2' || isEnterpriseIdentity(methods)
}

/**
 * Minimum password length, shared by every surface that sets one.
 *
 * Defined once because it was defined twice: the recovery page required 8 while
 * Settings required 6, so the weaker rule governed the path people actually use
 * to choose a password and the stricter one only applied to resets. Client-side
 * validation is a courtesy either way — Supabase's own project policy is the
 * enforcing boundary, and this should not be looser than it.
 */
export const MIN_PASSWORD_LENGTH = 8

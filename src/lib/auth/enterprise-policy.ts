export function emailDomain(email: string | null | undefined): string | null {
  const normalized = email?.trim().toLowerCase()
  const at = normalized?.lastIndexOf('@') ?? -1
  return at > 0 && at < (normalized?.length ?? 0) - 1 ? normalized!.slice(at + 1) : null
}

const SSO_METHODS = new Set(['sso', 'saml', 'google', 'azure', 'okta', 'oidc'])

export function isEnterpriseIdentity(methods: readonly string[]): boolean {
  return methods.some((method) => {
    const normalized = method.toLowerCase()
    return SSO_METHODS.has(normalized) || normalized.startsWith('sso:') || normalized.startsWith('saml:')
  })
}

export function satisfiesMfaPolicy(policy: string, assuranceLevel: string | null): boolean {
  return policy !== 'required' || assuranceLevel === 'aal2'
}

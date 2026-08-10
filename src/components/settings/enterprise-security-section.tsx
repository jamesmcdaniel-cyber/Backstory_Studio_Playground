'use client'

/**
 * Enterprise security: MFA policy, verified domains, SSO enforcement, SCIM.
 *
 * Every control here previously existed as a bare button whose label doubled as
 * its state ("MFA: loading"), and three of the four backing endpoints were only
 * half-reachable from the UI:
 *
 *   - the domain TXT challenge was pushed to the clipboard and NOWHERE else, so
 *     a failed clipboard write (insecure origin, denied permission) left the
 *     admin with a claimed domain they could never verify. GET returns the
 *     token; it is now rendered.
 *   - DELETE /api/organizations/domains and DELETE /api/organizations/scim-tokens
 *     had no caller at all — a mistyped domain or leaked token was permanent.
 *   - GET /api/organizations/scim-tokens had no caller, so minted tokens were
 *     invisible the moment the one-time reveal was dismissed.
 *
 * The MFA switch also carries a guard the old button did not: `mfaPolicy:
 * 'required'` is enforced by requireAuthContext on essentially every route, and
 * assurance is derived from whether the caller has a VERIFIED factor. An admin
 * with no authenticator who flipped this locked themselves — and everyone else —
 * out of the workspace, with no link anywhere in Settings to the enrollment
 * page that would let them back in. Enrollment now has to come first.
 */

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { AlertTriangle, ExternalLink, Globe, KeyRound, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { EmptyState } from '@/components/ui/empty-state'
import { ConfirmDialog, CopyButton, PromptDialog, SecretDialog, SettingsRow } from '@/components/settings/dialogs'

type Policy = { mfaPolicy: 'optional' | 'required'; ssoEnforced: boolean }
type Domain = { id: string; domain: string; status: string; verificationToken: string; verifiedAt?: string | null }
type ScimToken = {
  id: string
  name: string
  prefix: string
  lastUsedAt: string | null
  expiresAt: string | null
  revokedAt: string | null
  createdAt: string
}

const dnsName = (domain: string) => `_backstory-verification.${domain}`
const dnsValue = (token: string) => `backstory-verification=${token}`

const fmtDate = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : null

export function EnterpriseSecuritySection({ selfHasMfa }: { selfHasMfa: boolean | null }) {
  const [policy, setPolicy] = useState<Policy | null>(null)
  const [domains, setDomains] = useState<Domain[]>([])
  const [tokens, setTokens] = useState<ScimToken[]>([])
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [claimOpen, setClaimOpen] = useState(false)
  const [mintOpen, setMintOpen] = useState(false)
  const [secret, setSecret] = useState<string | null>(null)
  const [removeDomain, setRemoveDomain] = useState<Domain | null>(null)
  const [revokeToken, setRevokeToken] = useState<ScimToken | null>(null)

  const load = useCallback(async () => {
    const [security, scim] = await Promise.all([
      fetch('/api/organizations/security', { cache: 'no-store' }).then((r) => r.json()).catch(() => null),
      fetch('/api/organizations/scim-tokens', { cache: 'no-store' }).then((r) => r.json()).catch(() => null),
    ])
    if (security?.success) { setPolicy(security.policy); setDomains(security.domains ?? []) }
    if (scim?.success) setTokens(scim.tokens ?? [])
    setLoaded(true)
  }, [])
  useEffect(() => { void load() }, [load])

  const verifiedDomains = domains.filter((domain) => domain.status === 'verified')
  const liveTokens = tokens.filter((token) => !token.revokedAt)

  const update = async (body: Partial<Policy>, key: string) => {
    setBusy(key)
    try {
      const response = await fetch('/api/organizations/security', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data.success) return toast.error(data.error || 'Security policy update failed.')
      setPolicy(data.policy)
      toast.success('Security policy saved.')
    } finally { setBusy(null) }
  }

  const claim = async (domain: string) => {
    setBusy('claim')
    try {
      const response = await fetch('/api/organizations/domains', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) return toast.error(data.error || 'Could not claim that domain.')
      setClaimOpen(false)
      toast.success('Domain claimed — add the TXT record below, then verify.')
      await load()
    } finally { setBusy(null) }
  }

  const verify = async (domain: Domain) => {
    setBusy(domain.id)
    try {
      const response = await fetch(`/api/organizations/domains/${domain.id}/verify`, { method: 'POST' })
      const data = await response.json().catch(() => ({}))
      if (response.ok) toast.success(`${domain.domain} verified.`)
      else toast.error(data.error || 'That TXT record has not propagated yet.')
      await load()
    } finally { setBusy(null) }
  }

  const dropDomain = async (domain: Domain) => {
    setBusy(domain.id)
    try {
      const response = await fetch('/api/organizations/domains', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: domain.id }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) return toast.error(data.error || 'Could not remove that domain.')
      setRemoveDomain(null)
      toast.success('Domain removed.')
      await load()
    } finally { setBusy(null) }
  }

  const mint = async (name: string) => {
    setBusy('mint')
    try {
      const response = await fetch('/api/organizations/scim-tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) return toast.error(data.error || 'Could not create that token.')
      setMintOpen(false)
      setSecret(data.token.secret)
      await load()
    } finally { setBusy(null) }
  }

  const revoke = async (token: ScimToken) => {
    setBusy(token.id)
    try {
      const response = await fetch('/api/organizations/scim-tokens', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: token.id }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) return toast.error(data.error || 'Could not revoke that token.')
      setRevokeToken(null)
      toast.success('SCIM token revoked.')
      await load()
    } finally { setBusy(null) }
  }

  const scimBase = typeof window !== 'undefined' ? `${window.location.origin}/api/scim/v2` : '/api/scim/v2'
  // Turning the policy on with no authenticator of your own is a lockout, not a
  // policy change: every gated route would start refusing the person who set it.
  const mfaWouldLockOut = policy?.mfaPolicy !== 'required' && selfHasMfa === false

  return (
    <div className="space-y-6">
      {/* ------------------------------ Sign-in ------------------------------ */}
      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Sign-in policy</h3>
          <p className="text-xs text-muted-foreground">Applies to everyone in this workspace.</p>
        </div>

        <SettingsRow
          title="Require multi-factor authentication"
          description={
            mfaWouldLockOut
              ? 'Set up your own authenticator first — this policy would lock you out of the workspace immediately.'
              : 'Members without a verified authenticator are sent to enrollment before they can use Backstory.'
          }
        >
          <div className="flex items-center gap-2">
            {mfaWouldLockOut && (
              <Button asChild variant="outline" size="sm">
                <a href="/auth/mfa"><AlertTriangle className="h-3.5 w-3.5" /> Set up yours</a>
              </Button>
            )}
            <Switch
              checked={policy?.mfaPolicy === 'required'}
              disabled={!loaded || busy === 'mfa' || mfaWouldLockOut}
              aria-label="Require multi-factor authentication"
              onCheckedChange={(checked) => void update({ mfaPolicy: checked ? 'required' : 'optional' }, 'mfa')}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title="Enforce SSO"
          description={
            verifiedDomains.length
              ? 'Members on a verified domain must sign in through your identity provider.'
              : 'Verify a domain below before SSO can be enforced.'
          }
        >
          <Switch
            checked={Boolean(policy?.ssoEnforced)}
            disabled={!loaded || busy === 'sso' || (!policy?.ssoEnforced && verifiedDomains.length === 0)}
            aria-label="Enforce SSO"
            onCheckedChange={(checked) => void update({ ssoEnforced: checked }, 'sso')}
          />
        </SettingsRow>
      </section>

      {/* ------------------------------ Domains ------------------------------ */}
      <section className="space-y-3 border-t pt-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Verified domains</h3>
            <p className="text-xs text-muted-foreground">Prove you own a domain to enforce SSO across it.</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => setClaimOpen(true)}>
            <Globe className="h-3.5 w-3.5" /> Claim domain
          </Button>
        </div>

        {!loaded ? (
          <div className="h-16 animate-pulse rounded-lg border bg-muted/40" />
        ) : domains.length === 0 ? (
          <EmptyState
            icon={Globe}
            title="No domains claimed"
            description="Claim a domain to unlock SSO enforcement and directory sync."
          />
        ) : (
          <ul className="space-y-2">
            {domains.map((domain) => (
              <li key={domain.id} className="rounded-lg border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{domain.domain}</span>
                    {domain.status === 'verified' ? (
                      <Badge variant="good">Verified{fmtDate(domain.verifiedAt) ? ` · ${fmtDate(domain.verifiedAt)}` : ''}</Badge>
                    ) : (
                      <Badge variant="warn">Pending DNS</Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    {domain.status !== 'verified' && (
                      <Button size="sm" variant="outline" loading={busy === domain.id} onClick={() => void verify(domain)}>
                        Verify DNS
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Remove ${domain.domain}`}
                      disabled={busy === domain.id}
                      onClick={() => setRemoveDomain(domain)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>

                {domain.status !== 'verified' && (
                  <div className="mt-3 space-y-2 rounded-md bg-muted/50 p-3">
                    <p className="text-xs text-muted-foreground">
                      Add this TXT record at your DNS provider, then verify. Propagation can take a few minutes.
                    </p>
                    <dl className="space-y-1 font-mono text-xs">
                      <div className="flex gap-2"><dt className="w-14 shrink-0 text-muted-foreground">Name</dt><dd className="break-all">{dnsName(domain.domain)}</dd></div>
                      <div className="flex gap-2"><dt className="w-14 shrink-0 text-muted-foreground">Type</dt><dd>TXT</dd></div>
                      <div className="flex gap-2"><dt className="w-14 shrink-0 text-muted-foreground">Value</dt><dd className="break-all">{dnsValue(domain.verificationToken)}</dd></div>
                    </dl>
                    <CopyButton value={`${dnsName(domain.domain)} TXT ${dnsValue(domain.verificationToken)}`} label="Copy record" />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* -------------------------------- SCIM ------------------------------- */}
      <section className="space-y-3 border-t pt-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Directory sync (SCIM 2.0)</h3>
            <p className="text-xs text-muted-foreground">Bearer tokens for your identity provider to provision members.</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => setMintOpen(true)}>
            <KeyRound className="h-3.5 w-3.5" /> Create token
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-2 rounded-lg border p-3">
          <span className="text-xs text-muted-foreground">Base URL</span>
          <code className="break-all font-mono text-xs">{scimBase}</code>
          <CopyButton value={scimBase} className="ml-auto" />
        </div>

        {loaded && liveTokens.length > 0 && (
          <ul className="divide-y rounded-lg border">
            {liveTokens.map((token) => (
              <li key={token.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{token.name}</div>
                  <div className="truncate font-mono text-xs text-muted-foreground">
                    {token.prefix}…
                    {token.lastUsedAt ? ` · last used ${fmtDate(token.lastUsedAt)}` : ' · never used'}
                  </div>
                </div>
                <Button size="sm" variant="ghost" disabled={busy === token.id} onClick={() => setRevokeToken(token)}>
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        )}

        <p className="text-xs text-muted-foreground">
          Configure the SAML/OIDC provider in Supabase Auth, then point your IdP&rsquo;s SCIM connector at the base URL
          above using a token from this list.{' '}
          <a
            className="inline-flex items-center gap-0.5 underline underline-offset-2"
            href="https://supabase.com/docs/guides/auth/enterprise-sso/auth-sso-saml"
            target="_blank"
            rel="noreferrer"
          >
            SSO setup <ExternalLink className="h-3 w-3" />
          </a>
        </p>
      </section>

      <PromptDialog
        open={claimOpen}
        onOpenChange={setClaimOpen}
        title="Claim a domain"
        description="We'll give you a TXT record to publish. Nothing is enforced until it verifies."
        label="Domain"
        placeholder="example.com"
        confirmLabel="Claim domain"
        busy={busy === 'claim'}
        onSubmit={claim}
      />

      <PromptDialog
        open={mintOpen}
        onOpenChange={setMintOpen}
        title="Create a SCIM token"
        description="Name it after the identity provider that will use it, so you can revoke the right one later."
        label="Token name"
        placeholder="Okta production"
        confirmLabel="Create token"
        busy={busy === 'mint'}
        onSubmit={mint}
      />

      <SecretDialog
        open={secret !== null}
        onOpenChange={(open) => { if (!open) setSecret(null) }}
        title="Your SCIM token"
        secret={secret ?? ''}
      />

      <ConfirmDialog
        open={removeDomain !== null}
        onOpenChange={(open) => { if (!open) setRemoveDomain(null) }}
        title={`Remove ${removeDomain?.domain ?? ''}?`}
        description="SSO enforcement turns off automatically if this was your last verified domain."
        confirmLabel="Remove domain"
        destructive
        busy={busy === removeDomain?.id}
        onConfirm={() => removeDomain && dropDomain(removeDomain)}
      />

      <ConfirmDialog
        open={revokeToken !== null}
        onOpenChange={(open) => { if (!open) setRevokeToken(null) }}
        title={`Revoke ${revokeToken?.name ?? ''}?`}
        description="Any directory sync using this token stops immediately."
        confirmLabel="Revoke token"
        destructive
        busy={busy === revokeToken?.id}
        onConfirm={() => revokeToken && revoke(revokeToken)}
      />
    </div>
  )
}

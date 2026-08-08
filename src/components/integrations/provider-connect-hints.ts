/**
 * What the provider's consent flow will ask for, surfaced BEFORE the user
 * clicks Connect. The Nango iframe collects these (subdomain, environment,
 * account picks) without warning, which reads as "random" — this names it.
 * Keyed by the catalog provider slug; partial on purpose.
 *
 * Shared by the Integrations grid and the /credentials connect picker so both
 * surfaces give the same guidance.
 */
export const PROVIDER_CONNECT_HINTS: Record<string, string> = {
  salesforce: 'Salesforce asks production vs sandbox — sandbox logins go through test.salesforce.com.',
  'salesforce-sandbox': 'Connects against test.salesforce.com (sandbox orgs).',
  zendesk: 'Have your Zendesk subdomain ready — the “company” in company.zendesk.com.',
  jira: 'Sign in with Atlassian and pick your site (yourteam.atlassian.net) when asked.',
  confluence: 'Sign in with Atlassian and pick your site (yourteam.atlassian.net) when asked.',
  slack: 'Grants this workspace’s Slack app scopes — invite the bot to any channel it should post in.',
  notion: 'During Notion’s consent step, share the pages and databases the integration may read — unshared pages stay invisible.',
  airtable: 'Airtable grants only the bases you pick during consent.',
  hubspot: 'Pick which HubSpot account to grant when HubSpot asks.',
  github: 'Authorizes github.com accounts — GitHub Enterprise servers are not supported here.',
  gmail: 'Google may warn about an unverified app while the OAuth app is in testing — continue with your workspace account.',
  google_drive: 'Google may warn about an unverified app while the OAuth app is in testing — continue with your workspace account.',
  google_sheets: 'Google may warn about an unverified app while the OAuth app is in testing — continue with your workspace account.',
  granola: 'Have your Granola API token (grn_…) ready — create one in Granola under Settings → API keys.',
}

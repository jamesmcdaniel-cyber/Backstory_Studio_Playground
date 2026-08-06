/**
 * The email an author receives when a reviewer decides their catalogue
 * submission. Pure — the route owns lookup and delivery — so copy and
 * escaping are unit-testable without a mail provider.
 */

export type CatalogueDecision = 'approved' | 'changes_requested' | 'rejected'

export interface DecisionEmailInput {
  decision: CatalogueDecision
  /** Submission title as the author wrote it. */
  title: string
  /** Reviewer's note — required by the API for anything but an approval. */
  note?: string | null
  /** Origin for links, e.g. https://app.example.com (no trailing slash). */
  appUrl: string
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const HEADLINES: Record<CatalogueDecision, { subject: (title: string) => string; lead: string }> = {
  approved: {
    subject: (title) => `"${title}" is now in the catalogue`,
    lead: 'Your submission was approved and is now published to the shared catalogue for everyone to use.',
  },
  changes_requested: {
    subject: (title) => `"${title}" needs changes before it can be published`,
    lead: 'A reviewer looked at your submission and asked for changes before it can join the catalogue.',
  },
  rejected: {
    subject: (title) => `"${title}" was not accepted to the catalogue`,
    lead: 'A reviewer looked at your submission and did not accept it for the shared catalogue.',
  },
}

export function buildDecisionEmail(input: DecisionEmailInput): { subject: string; html: string; text: string } {
  const { subject, lead } = {
    subject: HEADLINES[input.decision].subject(input.title),
    lead: HEADLINES[input.decision].lead,
  }
  const note = input.note?.trim()
  const link = `${input.appUrl}/templates`

  const htmlParts = [
    `<p>${lead}</p>`,
    note
      ? `<p style="margin:12px 0;padding:10px 14px;border-left:3px solid #d1d5db;color:#374151;white-space:pre-wrap">${escapeHtml(note)}</p>`
      : null,
    input.decision === 'approved'
      ? `<p><a href="${link}">See it in the catalogue</a></p>`
      : `<p><a href="${link}">Open your templates</a> to revise and resubmit.</p>`,
    `<p style="color:#6b7280;font-size:12px">You are receiving this because you submitted "${escapeHtml(input.title)}" to the catalogue.</p>`,
  ].filter(Boolean)

  const textParts = [
    lead,
    note ? `Reviewer's note:\n${note}` : null,
    link,
  ].filter(Boolean)

  return { subject, html: htmlParts.join('\n'), text: textParts.join('\n\n') }
}

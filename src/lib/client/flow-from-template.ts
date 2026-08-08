'use client'

export type UseFlowTemplateResult =
  | { ok: true; href: string; message: string }
  | { ok: false; error: string }

/**
 * Instantiate a flow template into a draft flow and return where to send the
 * user plus the toast copy describing how much setup remains.
 *
 * Templates go through the instantiate endpoint rather than a plain POST so
 * bindings resolve against this workspace and the unfilled ones come back as a
 * setup list instead of silently landing as empty steps.
 */
export async function createFlowFromTemplate(templateId: string): Promise<UseFlowTemplateResult> {
  const response = await fetch(`/api/flow-templates/${templateId}/use`, { method: 'POST' })
  const data = (await response.json().catch(() => ({}))) as {
    flow?: { id?: unknown }
    setup?: unknown[]
    error?: string
  }
  if (!response.ok || typeof data.flow?.id !== 'string') {
    return { ok: false, error: data.error || 'Could not create the flow. Please try again.' }
  }
  const outstanding = Array.isArray(data.setup) ? data.setup.length : 0
  return {
    ok: true,
    href: `/flows/${data.flow.id}`,
    message:
      outstanding > 0
        ? `Created as a draft — ${outstanding} thing${outstanding === 1 ? '' : 's'} left to set up.`
        : 'Created as a draft, ready to run.',
  }
}

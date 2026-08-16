import { GUARDRAIL_RULE } from '@/lib/security/guardrails'
import { UNTRUSTED_DATA_RULE } from '@/lib/security/prompt'
import { z } from 'zod'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { generateStructured } from '@/lib/llm/model-runner'
import { assertAiCallAllowed, recordEstimatedUsage } from '@/lib/usage/ai-guard'

export const runtime = 'nodejs'

const schema = z.object({
  language: z.enum(['javascript', 'python']),
  mode: z.enum(['all', 'each']).default('all'),
  prompt: z.string().min(1).max(2000),
  // A hint of the shape of `input` (e.g. a sample from the last run), to ground
  // the generated code in the real data — trimmed server-side.
  inputSample: z.string().max(4000).optional(),
})

const CODE_SCHEMA = {
  type: 'object',
  properties: {
    code: { type: 'string', description: 'The complete function body only — no fences, no prose.' },
  },
  required: ['code'],
  additionalProperties: false,
}

/**
 * "Ask AI" for the Code node (n8n parity): turn a natural-language description
 * into a code-step body. The contract mirrors the flow Code node runtime — the
 * body receives `input` and `context` ({trigger, steps, variables, now, run})
 * and must `return` (JS) / assign `result` (Python) a JSON-compatible value.
 */
export const POST = withAuthenticatedApi(async (request, auth) => {
  const body = schema.parse(await request.json())
  await assertAiCallAllowed({ organizationId: auth.organizationId, rateKey: `flow-code-assist:${auth.dbUser.id}`, limit: 20 })

  const jsContract = [
    'You write the BODY of a JavaScript function for a no-code flow "Code" step.',
    'Available in scope: `input` (the step input), `context` ({ trigger, steps, variables, now, run }), and `console`.',
    body.mode === 'each' ? '`input` is a SINGLE item (the step runs once per item).' : '`input` is the whole step input.',
    'You MUST `return` a JSON-compatible value. No imports, no network, no filesystem — pure computation only.',
    'Output ONLY the function body (statements), no code fences, no explanation.',
  ].join('\n')
  const pyContract = [
    'You write the BODY of a Python snippet for a no-code flow "Code" step.',
    'Available: `input` (the step input), `context` (dict: trigger, steps, variables, now, run).',
    body.mode === 'each' ? '`input` is a SINGLE item (the step runs once per item).' : '`input` is the whole step input.',
    'Assign the JSON-compatible result to a variable named `result`. No imports, no I/O — pure computation only.',
    'Output ONLY the snippet, no code fences, no explanation.',
  ].join('\n')

  const system = `${body.language === 'python' ? pyContract : jsContract}\n\n${UNTRUSTED_DATA_RULE}\n\n${GUARDRAIL_RULE}`
  const user = [
    `Task: ${body.prompt}`,
    body.inputSample ? `\nSample of \`input\`:\n${body.inputSample.slice(0, 4000)}` : '',
  ].join('\n')

  const raw = await generateStructured({ system, user, schema: CODE_SCHEMA, schemaName: 'flow_code', maxTokens: 1500 })
  recordEstimatedUsage(auth.organizationId, system, user, raw)
  let code = ''
  try {
    code = String((JSON.parse(raw) as { code?: unknown }).code ?? '')
  } catch {
    code = ''
  }
  // Defensive: strip any stray code fences the model added despite instructions.
  code = code.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim()
  if (!code) return { success: false as const, error: 'The assistant could not generate code — try rephrasing.' }
  return { success: true as const, code }
}, { permission: 'flow.write' })

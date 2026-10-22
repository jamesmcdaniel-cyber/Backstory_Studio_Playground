import { ArtifactValidatorUnavailableError } from '@/lib/artifacts/preflight'

export type AgentDeliverablePublication<T> = {
  published: T | null
  /** Shown on the run when the deliverable was not saved as it was produced. */
  warning: string | null
  /** The rendered app did not save; the agent's own draft did. */
  usedDraft: boolean
}

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 500)
const sentence = (text: string) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`)

/**
 * Publishing a run's deliverable. By now the run has done its work (sent the
 * email, posted to Slack), so a version that does not save never fails it:
 * the rendered app falls back to the agent's own draft, and when neither
 * saves, or the validator is down, the run completes with a warning that says
 * so. Ordinary answers keep best-effort registration, quietly.
 */
export async function publishAgentDeliverable<T>(params: {
  required: boolean
  publish: () => Promise<T | null>
  /** The draft the renderer started from, when the deliverable was rendered. */
  draft?: () => Promise<T | null>
}): Promise<AgentDeliverablePublication<T>> {
  let failure: string
  let unavailable = false
  try {
    const published = await params.publish()
    if (published || !params.required) return { published, warning: null, usedDraft: false }
    failure = 'no artifact version was published'
  } catch (error) {
    if (!params.required) return { published: null, warning: null, usedDraft: false }
    failure = reasonOf(error)
    unavailable = error instanceof ArtifactValidatorUnavailableError
  }
  // An unavailable validator would refuse the draft just the same.
  if (params.draft && !unavailable) {
    try {
      const published = await params.draft()
      if (published) return { published, warning: `The finished app could not be saved, so the agent's draft was saved instead: ${sentence(failure)}`, usedDraft: true }
    } catch (error) {
      failure = reasonOf(error)
    }
  }
  return { published: null, warning: `Not saved as an artifact: ${sentence(failure)} The answer is kept on this run.`, usedDraft: false }
}

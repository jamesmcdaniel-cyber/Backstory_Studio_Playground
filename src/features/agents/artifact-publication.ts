/** An executable deliverable is not complete until its validated version is
 * addressable. Non-artifact answers keep best-effort registration semantics. */
export async function publishAgentDeliverable<T>(required: boolean, publish: () => Promise<T | null>): Promise<T | null> {
  try {
    const result = await publish()
    if (required && !result) throw new Error('No artifact version was published')
    return result
  } catch (error) {
    if (required) throw new Error(`Artifact publication failed: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

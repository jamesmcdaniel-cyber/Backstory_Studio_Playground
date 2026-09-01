/**
 * How completely a repository document has been embedded.
 *
 * This is the column that stops a document from being silently unretrievable:
 * anything other than 'indexed' means the vector path cannot see some of its
 * chunks, so `retrieveKnowledge` supplements it with a keyword pass and the
 * repository UI shows the state instead of a bare "ready".
 */
export type IndexState = 'indexed' | 'partial' | 'unindexed' | 'pending'

export function deriveIndexState(totalChunks: number, embeddedChunks: number): IndexState {
  if (totalChunks <= 0) return 'pending'
  if (embeddedChunks <= 0) return 'unindexed'
  if (embeddedChunks >= totalChunks) return 'indexed'
  return 'partial'
}

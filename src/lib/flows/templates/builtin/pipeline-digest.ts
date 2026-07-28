import type { FlowTemplateDef } from '@/lib/flows/templates/types'

/**
 * The shortest useful shape in the catalogue: pull real records, hand them to
 * one agent, deliver the result. No fan-out, no branching, nothing clever —
 * four steps that a workspace with Backstory and Slack connected can run on
 * Monday morning without configuring anything but a channel name.
 *
 * It exists to make the point that a flow does not have to be elaborate to be
 * worth scheduling; the elaborate ones are elsewhere in this catalogue.
 */
export const PIPELINE_DIGEST: FlowTemplateDef = {
  id: 'pipeline-digest',
  name: 'Monday pipeline digest',
  description:
    'Every Monday morning, pull your live pipeline from Backstory, have your forecast agent write the state-of-play, and post it to the sales channel before the week starts.',
  category: 'Pipeline & Forecasting',
  icon: '📊',
  integrations: ['backstory', 'slack'],
  tags: ['weekly', 'agents', 'pipeline', 'digest'],
  graph: {
    nodes: [
      {
        id: 'trigger',
        type: 'trigger',
        data: { trigger: { type: 'schedule', schedule: { type: 'weekly', day: 'monday', time: '08:00', timezone: 'UTC', isActive: true } } },
      },
      {
        id: 'pull',
        type: 'tool',
        data: {
          label: 'Pull the live pipeline from Backstory',
          connectionId: '',
          toolName: 'top_records',
          args: '{}',
          retries: 2,
          timeoutMs: 60000,
          note: 'Reads your most relevant accounts and opportunities from Backstory. Retried twice — a Monday with no digest is worse than a Monday with a late one.',
        },
      },
      {
        id: 'digest',
        type: 'agent',
        data: {
          label: 'Write the state of the pipeline',
          agentId: '',
          input:
            'Write this week\'s pipeline digest from the records below. Cover where the number stands, what moved since last week, and the two or three deals that decide the quarter.\n\nPipeline:\n{{step.pull.output}}',
          includeUpstreamContext: true,
          retries: 1,
          timeoutMs: 300000,
          note: 'One agent run over the whole pipeline rather than one per deal — the digest is about the shape of the set, which is lost if each record is summarised alone.',
        },
      },
      {
        id: 'post',
        type: 'tool',
        data: {
          label: 'Post it to the sales channel',
          connectionId: '',
          toolName: 'send_message',
          args: '{"channel":"#sales","text":"{{step.digest.output}}"}',
          retries: 2,
          onError: 'continue',
          note: 'Set to continue on error: a Slack outage should not lose the digest, which is still returned as a named result below.',
        },
      },
      {
        id: 'out',
        type: 'output',
        data: {
          label: 'Return the digest',
          outputs: [{ name: 'digest', value: '{{step.digest.output}}', type: 'text' }],
          note: 'Named result, so another flow can run this one as a step — or an email flow can pick the digest up and send it on to leadership.',
        },
      },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'pull' },
      { id: 'e1', source: 'pull', target: 'digest' },
      { id: 'e2', source: 'digest', target: 'post' },
      { id: 'e3', source: 'post', target: 'out' },
    ],
  },
  bindings: [
    {
      nodeId: 'pull',
      kind: 'connection',
      label: 'Pick the Backstory connection to read the pipeline from',
      match: { provider: 'backstory', toolName: 'top_records' },
    },
    {
      nodeId: 'digest',
      kind: 'agent',
      label: 'Pick the agent that writes the pipeline digest',
      // Matches the "Pipeline & Forecast Digest" agent template.
      match: { agentName: 'Pipeline & Forecast Digest' },
    },
    {
      nodeId: 'post',
      kind: 'connection',
      label: 'Pick the Slack workspace to post the digest to',
      match: { provider: 'slack', toolName: 'send_message' },
    },
  ],
  notes: {
    objective:
      'Have the week\'s pipeline picture waiting in the sales channel before anyone asks for it. It worked if the Monday stand-up starts from this post rather than from someone rebuilding the same view by hand.',
    inputs: [],
    steps: [
      { nodeId: 'pull', title: 'Pull the live pipeline from Backstory', what: 'Reads your most relevant accounts and opportunities.' },
      {
        nodeId: 'digest',
        title: 'Write the state of the pipeline',
        what: 'Hands the whole set to your forecast agent, which writes where the number stands and what moved.',
        why: 'Run over the whole pipeline at once, because the story is in the shape of the set — per-deal summaries would lose it.',
      },
      { nodeId: 'post', title: 'Post it to the sales channel', what: 'Sends the digest to Slack, and carries on if Slack is down.' },
      { nodeId: 'out', title: 'Return the digest', what: 'Returns the digest text as a named result.' },
    ],
    failureHandling:
      'The pipeline read retries twice and fails the run if it cannot succeed, so an empty digest is never posted as though it were the truth. The agent retries once. Posting to Slack continues on error, and the digest still comes back as a named output.',
    setup: [
      { label: 'Set the channel name on the Post it to the sales channel step', kind: 'value', ref: 'post' },
      { label: 'Check the Monday 08:00 run time and timezone on the trigger', kind: 'value', ref: 'trigger' },
    ],
    customize: [
      'Move the run time so the digest lands before your stand-up rather than at 08:00 UTC.',
      'Change what the digest covers by editing the instruction on the agent step, or the agent itself.',
      'Add an email step after the Slack post to send the same digest to leadership.',
      'Point the trigger at a daily schedule if a week is too coarse for your motion.',
    ],
    testPlan:
      'Run it by hand on a Thursday. Check the pipeline read returns real records and that every number in the digest appears somewhere in that output before you switch the Monday schedule on.',
  },
}

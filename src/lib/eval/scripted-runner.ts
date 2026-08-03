/**
 * A ModelRunner that replays authored turns instead of calling a provider.
 *
 * It builds the transcript in the SAME provider-native (Anthropic) message shape
 * the real AnthropicRunner uses, so replaying a fixture exercises the actual
 * transcript-construction and tool-loop code paths — a refactor there (e.g. the
 * provider-neutral IR in #5) is caught by fixture asserts, offline and free.
 */
import { emptyUsage, type ModelRunner, type ModelTurn, type ToolDefinition, type ToolResult } from '@/lib/llm/model-runner'
import type { ScriptedTurn } from './types'

export class ScriptedRunner implements ModelRunner {
  readonly model: string
  private cursor = 0

  constructor(private readonly script: ScriptedTurn[], model = 'scripted') {
    this.model = model
  }

  start(input: string): unknown[] {
    return [{ role: 'user', content: input }]
  }

  appendUserMessage(transcript: unknown[], content: string) {
    transcript.push({ role: 'user', content })
  }

  appendToolResults(transcript: unknown[], results: ToolResult[]) {
    transcript.push({
      role: 'user',
      content: results.map((result) => ({
        type: 'tool_result',
        tool_use_id: result.toolCallId,
        content: result.content,
        ...(result.isError ? { is_error: true } : {}),
      })),
    })
  }

  async next(transcript: unknown[], _system: string, _tools: ToolDefinition[]): Promise<ModelTurn> {
    // Past the end of the script → behave like a model that has nothing more to
    // do (empty final turn), which ends the loop cleanly.
    const turn = this.script[this.cursor]
    this.cursor += 1
    const text = turn?.text ?? ''
    const toolCalls = (turn?.toolCalls ?? []).map((call, i) => ({
      // Deterministic, unique-per-run ids so tool_result blocks line up.
      id: `scripted_${this.cursor - 1}_${i}`,
      name: call.name,
      input: (call.input ?? {}) as Record<string, unknown>,
    }))

    // Mirror the real runner: append the assistant message to the transcript in
    // provider-native shape (text + tool_use blocks).
    const content: unknown[] = []
    if (text) content.push({ type: 'text', text })
    for (const call of toolCalls) content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input })
    transcript.push({ role: 'assistant', content })

    return { text, toolCalls, usage: emptyUsage(), provider: 'anthropic', servedModel: 'scripted' }
  }
}

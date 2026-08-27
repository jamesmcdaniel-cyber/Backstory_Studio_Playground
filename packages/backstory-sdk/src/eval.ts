export type EvalCase<TInput = unknown, TExpected = unknown> = { id: string; input: TInput; expected?: TExpected; tags?: string[] }
export type EvalScore = { score: number; reason?: string; metadata?: Record<string, unknown> }
export type EvalResult<TOutput = unknown> = { caseId: string; output?: TOutput; error?: string; score?: EvalScore; durationMs: number }

export type EvalSuite<TInput = unknown, TOutput = unknown, TExpected = unknown> = {
  name: string
  cases: EvalCase<TInput, TExpected>[]
  run: (input: TInput) => Promise<TOutput>
  score?: (output: TOutput, expected: TExpected | undefined, testCase: EvalCase<TInput, TExpected>) => Promise<EvalScore> | EvalScore
  concurrency?: number
}

export async function runEvalSuite<TInput, TOutput, TExpected>(suite: EvalSuite<TInput, TOutput, TExpected>): Promise<EvalResult<TOutput>[]> {
  const concurrency = Math.max(1, Math.min(20, Math.round(suite.concurrency ?? 4)))
  const results: EvalResult<TOutput>[] = new Array(suite.cases.length)
  let cursor = 0
  const worker = async () => {
    while (cursor < suite.cases.length) {
      const index = cursor++
      const testCase = suite.cases[index]
      const started = Date.now()
      try {
        const output = await suite.run(testCase.input)
        const score = suite.score ? await suite.score(output, testCase.expected, testCase) : undefined
        results[index] = { caseId: testCase.id, output, ...(score ? { score } : {}), durationMs: Date.now() - started }
      } catch (error) {
        results[index] = { caseId: testCase.id, error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - started }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, suite.cases.length) }, worker))
  return results
}

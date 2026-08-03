/**
 * Turn a real production run into a committed regression fixture.
 *
 *   npm run eval:capture -- <agentExecutionId>
 *
 * Writes a fixture module under src/lib/eval/fixtures/. Add a rubric, register
 * it in fixtures/index.ts, and commit — the failure can never silently return.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { systemPrisma } from '@/lib/prisma'
import { fixtureFromTranscript } from './from-transcript'

async function main() {
  const executionId = process.argv[2]
  if (!executionId) {
    console.error('Usage: npm run eval:capture -- <agentExecutionId>')
    process.exit(1)
  }

  // systemPrisma: operator CLI run outside any request, capturing a run by id.
  const execution = await systemPrisma.agentExecution.findUnique({
    where: { id: executionId },
    select: { id: true, transcript: true, input: true, agentType: true },
  })
  if (!execution) {
    console.error(`No execution ${executionId}.`)
    process.exit(1)
  }
  if (!Array.isArray(execution.transcript)) {
    console.error('That execution has no transcript to replay.')
    process.exit(1)
  }

  const name = `captured-${execution.id.slice(-8)}`
  const fixture = fixtureFromTranscript({
    name,
    // The live system prompt is assembled per run and not persisted verbatim,
    // so the operator pastes the real one in before committing.
    system: 'REPLACE ME: paste the system prompt this run used.',
    transcript: execution.transcript as unknown[],
    rubric: 'REPLACE ME: what must a correct run of this scenario do?',
  })

  const identifier = name.replace(/-/g, '_')
  const path = join(process.cwd(), 'src/lib/eval/fixtures', `${name}.ts`)
  writeFileSync(
    path,
    `import type { EvalFixture } from '../types'\n\n` +
      `export const ${identifier}: EvalFixture = ${JSON.stringify(fixture, null, 2)}\n`,
  )

  console.log(`Wrote ${path}`)
  console.log('Next: replace the system prompt and rubric, then add it to fixtures/index.ts.')
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(() => systemPrisma.$disconnect())

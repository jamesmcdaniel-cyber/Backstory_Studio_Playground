/**
 * Dead-letter queue operator CLI.
 *
 *   npm run queue:dlq -- counts
 *   npm run queue:dlq -- list [--queue <dlq>] [--limit 50] [--json]
 *   npm run queue:dlq -- show <id> [--json]
 *   npm run queue:dlq -- replay <id> --confirm
 *   npm run queue:dlq -- drop <id> --confirm
 *
 * `<id>` is what `list` prints: `<dead-letter-queue>:<jobId>`, e.g.
 * `agent-dead-letter:41`.
 *
 * Requires REDIS_URL — the same one the producer enqueues to. Pointing this at
 * the wrong Redis is the split-brain failure documented in
 * docs/runbooks/queue-incident.md §2; it will simply report an empty backlog.
 *
 * `replay` and `drop` mutate the queue plane and refuse to run without
 * `--confirm`. Replay re-enqueues onto the ORIGINAL queue with a fresh attempt
 * budget and only then removes the DLQ record, so an interrupted replay can
 * duplicate a job but can never lose one. Prefer re-running from the app when
 * the run is user-visible — see the runbook.
 */

import {
  DEAD_LETTER_QUEUES,
  DeadLetterOperationError,
  closeDeadLetterHandles,
  countDeadLetters,
  dropDeadLetter,
  listDeadLetters,
  replayDeadLetter,
  showDeadLetter,
} from '../src/lib/queue/dead-letter-admin'

const argv = process.argv.slice(2)
const flags = new Set(argv.filter((arg) => arg.startsWith('--')))
const positional = argv.filter((arg) => !arg.startsWith('--'))
const [command, target] = positional

function option(name: string): string | undefined {
  const index = argv.indexOf(`--${name}`)
  if (index !== -1 && argv[index + 1] && !argv[index + 1].startsWith('--')) return argv[index + 1]
  const inline = argv.find((arg) => arg.startsWith(`--${name}=`))
  return inline?.slice(name.length + 3)
}

const asJson = flags.has('--json')

function print(value: unknown, human: () => void) {
  if (asJson) console.log(JSON.stringify(value, null, 2))
  else human()
}

const USAGE = `queue-dlq — inspect and repair the dead-letter queues

  counts                              backlog size per dead-letter queue
  list [--queue <dlq>] [--limit N]    parked records, newest first
  show <id>                           one record, full payload
  replay <id> --confirm               re-enqueue onto its original queue, then remove
  drop <id> --confirm                 discard the record permanently

  --json                              machine-readable output

  dead-letter queues: ${DEAD_LETTER_QUEUES.join(', ')}
  ids look like: agent-dead-letter:41
`

function requireTarget(): string {
  if (!target) {
    console.error(`${command} needs an id (see \`list\`).`)
    process.exit(2)
  }
  return target
}

function requireConfirm(action: string): void {
  if (!flags.has('--confirm')) {
    console.error(`Refusing to ${action} without --confirm. This mutates the production queue plane.`)
    process.exit(2)
  }
}

async function main(): Promise<void> {
  if (!process.env.REDIS_URL) {
    console.error('REDIS_URL is required — this tool reads the live queue plane.')
    process.exit(2)
  }

  switch (command) {
    case 'counts': {
      const counts = await countDeadLetters()
      print(counts, () => {
        for (const row of counts.queues) console.log(`${String(row.waiting).padStart(6)}  ${row.queue}`)
        console.log(`${String(counts.total).padStart(6)}  TOTAL`)
      })
      return
    }

    case 'list': {
      const records = await listDeadLetters({
        dlq: option('queue'),
        limit: option('limit') ? Number(option('limit')) : undefined,
      })
      print(records, () => {
        if (!records.length) return console.log('No dead-lettered jobs.')
        for (const record of records) {
          const owner = record.executionId ?? record.flowRunId ?? '-'
          console.log(
            [
              record.id,
              `queue=${record.queue ?? '?'}`,
              `job=${record.jobName ?? '?'}`,
              `run=${owner}`,
              `org=${record.organizationId ?? '-'}`,
              `at=${record.timestamps.enqueuedAt ?? '?'}`,
              record.replayable ? 'replayable' : 'NOT-replayable',
            ].join('  '),
          )
          console.log(`    error: ${record.failedReason ?? '(none recorded)'}`)
          console.log(`    payload: ${record.payloadSummary}`)
        }
        console.log(`\n${records.length} record(s).`)
      })
      return
    }

    case 'show': {
      const record = await showDeadLetter(requireTarget())
      print(record, () => console.log(JSON.stringify(record, null, 2)))
      return
    }

    case 'replay': {
      requireConfirm('replay')
      const result = await replayDeadLetter(requireTarget())
      print(result, () =>
        console.log(`Replayed ${result.id} → ${result.queue} (job ${result.jobName}, new id ${result.newJobId ?? '?'}).`),
      )
      return
    }

    case 'drop': {
      requireConfirm('drop')
      const result = await dropDeadLetter(requireTarget())
      print(result, () => console.log(`Dropped ${result.id}.`))
      return
    }

    default:
      console.log(USAGE)
      // An unrecognised command is an error; a bare `--help` is not.
      if (command && command !== 'help') process.exit(2)
  }
}

main()
  .then(() => closeDeadLetterHandles())
  .then(() => process.exit(0))
  .catch(async (error) => {
    if (error instanceof DeadLetterOperationError) console.error(error.message)
    else console.error(error)
    await closeDeadLetterHandles().catch(() => {})
    process.exit(1)
  })

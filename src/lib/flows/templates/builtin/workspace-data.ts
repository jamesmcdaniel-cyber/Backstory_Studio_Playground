import type { FlowTemplateDef } from '@/lib/flows/templates/types'

/**
 * Document-and-data pipelines: Sheets as a dataset to watch, Drive as a
 * changelog, Airtable as a work queue, Notion as a destination for structured
 * writing. These flows treat the workspace tools as data sources with shapes —
 * code steps do the arithmetic, AI steps only ever phrase or judge.
 */

export const SHEET_ANOMALY_WATCH: FlowTemplateDef = {
  id: 'sheet-anomaly-watch',
  name: 'Spreadsheet anomaly watch',
  description:
    'Every morning, read a range from the tracking spreadsheet, run deterministic checks for blanks, duplicates, and negative numbers, and alert the channel only when something is off.',
  category: 'Docs & Data',
  icon: '🔍',
  integrations: ['google_sheets', 'slack'],
  tags: ['daily', 'google-sheets', 'data-quality', 'monitoring'],
  graph: {
    nodes: [
      {
        id: 'trigger',
        type: 'trigger',
        data: { trigger: { type: 'schedule', schedule: { type: 'daily', time: '09:00', timezone: 'UTC', isActive: true } } },
      },
      {
        id: 'read',
        type: 'tool',
        data: {
          label: 'Read the tracking range',
          connectionId: '',
          toolName: 'google_sheets_read_range',
          args: '{"spreadsheetId":"","range":"Sheet1!A1:F200"}',
          retries: 2,
          timeoutMs: 60000,
          note: 'Reads the range as raw values, header row included — the checks below treat row one as column names.',
        },
      },
      {
        id: 'check',
        type: 'code',
        data: {
          label: 'Run the anomaly checks',
          language: 'javascript',
          mode: 'all',
          input: '{{step.read.output}}',
          timeoutMs: 10000,
          code: [
            'const values = (input && input.values) || []',
            'if (values.length < 2) return [{ row: 0, problem: "sheet is empty or header-only" }]',
            'const header = values[0]',
            'const problems = []',
            'const seen = new Map()',
            'values.slice(1).forEach((row, i) => {',
            '  const rowNum = i + 2',
            '  if (row.length === 0 || row.every((cell) => String(cell ?? "").trim() === "")) return',
            '  row.forEach((cell, col) => {',
            '    const text = String(cell ?? "").trim()',
            '    if (text === "") problems.push({ row: rowNum, problem: `blank ${header[col] || `column ${col + 1}`}` })',
            '    else if (/^-\\d+(\\.\\d+)?$/.test(text)) problems.push({ row: rowNum, problem: `negative value in ${header[col] || `column ${col + 1}`}` })',
            '  })',
            '  const key = String(row[0] ?? "").trim().toLowerCase()',
            '  if (key) {',
            '    if (seen.has(key)) problems.push({ row: rowNum, problem: `duplicate of row ${seen.get(key)}` })',
            '    else seen.set(key, rowNum)',
            '  }',
            '})',
            'return problems',
          ].join('\n'),
          note: 'Three fixed checks — blanks, negatives, first-column duplicates — as arithmetic, so what counts as an anomaly is identical every day and editable in one place.',
        },
      },
      {
        id: 'any',
        type: 'condition',
        data: {
          label: 'Anything off?',
          clauses: [{ left: '{{step.check.output}}', op: 'isNotEmpty', right: '' }],
          note: 'A clean sheet ends the run silently. The alert only exists when there are rows to fix.',
        },
      },
      {
        id: 'alert',
        type: 'ai',
        data: {
          aiOp: 'summarize',
          label: 'Write the alert',
          input: '{{step.check.output}}',
          instructions:
            'Write a short data-quality alert from these problems. Lead with the count, then group by problem type with the row numbers. Keep it under 120 words — this is a to-fix list, not a report. State row numbers exactly as given.',
          note: 'Phrasing only: every row number and problem in the alert came from the deterministic check above.',
        },
      },
      {
        id: 'post',
        type: 'tool',
        data: {
          label: 'Post the alert',
          connectionId: '',
          toolName: 'send_message',
          args: '{"channel":"#data-quality","text":"{{step.alert.output}}"}',
          retries: 2,
          onError: 'continue',
          note: 'Set to continue on error: the problem list is still returned as a named result even when Slack is down.',
        },
      },
      {
        id: 'clean',
        type: 'stop',
        data: {
          label: 'Sheet is clean',
          reason: 'No blanks, duplicates, or negative values found today.',
          note: 'The run still shows in history, so a silent morning provably means clean, not skipped.',
        },
      },
      {
        id: 'out',
        type: 'output',
        data: {
          label: 'Return the problems',
          outputs: [{ name: 'problems', value: '{{step.check.output}}', type: 'list' }],
          note: 'Named result, so a weekly flow can trend whether the sheet is getting cleaner.',
        },
      },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'read' },
      { id: 'e1', source: 'read', target: 'check' },
      { id: 'e2', source: 'check', target: 'any' },
      { id: 'e3', source: 'any', target: 'alert', branch: 'true' },
      { id: 'e4', source: 'any', target: 'clean', branch: 'false' },
      { id: 'e5', source: 'alert', target: 'post' },
      { id: 'e6', source: 'post', target: 'out' },
    ],
  },
  bindings: [
    {
      nodeId: 'read',
      kind: 'connection',
      label: 'Pick the Google Sheets account with the tracking spreadsheet',
      match: { provider: 'google_sheets', toolName: 'google_sheets_read_range' },
    },
    {
      nodeId: 'post',
      kind: 'connection',
      label: 'Pick the Slack workspace to alert in',
      match: { provider: 'slack', toolName: 'send_message' },
    },
  ],
  notes: {
    objective:
      'The shared spreadsheet everyone relies on gets checked every morning by rules, not by whoever happens to scroll past the bad row. It worked if data problems get fixed the day they appear instead of at month-end.',
    inputs: [],
    steps: [
      { nodeId: 'read', title: 'Read the tracking range', what: 'Reads the configured range as raw values, header row included.' },
      {
        nodeId: 'check',
        title: 'Run the anomaly checks',
        what: 'Flags blank cells, negative numbers, and duplicate first-column keys, each with its row number.',
        why: 'The checks are arithmetic in a code step, so the definition of an anomaly is fixed and editable — not a model\'s judgement call.',
      },
      { nodeId: 'any', title: 'Anything off?', what: 'Ends the run silently when the problem list is empty.' },
      { nodeId: 'alert', title: 'Write the alert', what: 'Turns the problem list into a short grouped to-fix post.' },
      { nodeId: 'post', title: 'Post the alert', what: 'Sends it to Slack, and carries on if Slack is down.' },
      { nodeId: 'clean', title: 'Sheet is clean', what: 'Stops the run when nothing was flagged.' },
      { nodeId: 'out', title: 'Return the problems', what: 'Returns the problem list as a named result.' },
    ],
    decisionRules:
      'A cell is a problem if it is blank or a negative number inside a non-empty row; a row is a problem if its first-column key repeats an earlier row. All three rules live in the Run the anomaly checks step.',
    failureHandling:
      'The sheet read retries twice and fails the run rather than reporting clean on a sheet it never read. Posting continues on error, and the problem list is still returned.',
    setup: [
      { label: 'Set the spreadsheet id and range on the Read the tracking range step', kind: 'value', ref: 'read' },
      { label: 'Set the channel name on the Post the alert step', kind: 'value', ref: 'post' },
    ],
    customize: [
      'Edit the checks to match your sheet — allow negatives in a refunds column, key duplicates on a different column.',
      'Widen the range as the sheet grows; the header row drives the column names in alerts.',
      'Add an email step for a sheet whose owner does not live in Slack.',
    ],
    testPlan:
      'Plant one blank cell, one negative number, and one duplicate row in a copy of the sheet, point the read at it, and run by hand. The alert must name all three rows — then remove them and confirm the run ends at Sheet is clean.',
  },
}

export const DRIVE_FRESH_DOCS_DIGEST: FlowTemplateDef = {
  id: 'drive-fresh-docs-digest',
  name: 'What changed in Drive this week',
  description:
    'Every Friday afternoon, list the team Drive folder, keep the files modified in the last seven days, and email a digest of what changed so nobody discovers a rewritten doc three weeks late.',
  category: 'Docs & Data',
  icon: '🗂️',
  integrations: ['google_drive', 'email'],
  tags: ['weekly', 'google-drive', 'digest', 'documents'],
  graph: {
    nodes: [
      {
        id: 'trigger',
        type: 'trigger',
        data: { trigger: { type: 'schedule', schedule: { type: 'weekly', day: 'friday', time: '16:00', timezone: 'UTC', isActive: true } } },
      },
      {
        id: 'list',
        type: 'tool',
        data: {
          label: 'List the Drive files',
          connectionId: '',
          toolName: 'google_drive_list_files',
          args: '{"q":"trashed = false","pageSize":100}',
          retries: 2,
          timeoutMs: 60000,
          note: 'Lists files with name, type, and modified time. The seven-day cut happens in the next step so the freshness rule is visible and editable.',
        },
      },
      {
        id: 'recent',
        type: 'code',
        data: {
          label: 'Keep the files touched this week',
          language: 'javascript',
          mode: 'all',
          input: '{{step.list.output}}',
          timeoutMs: 10000,
          code: [
            'const files = (input && input.files) || []',
            'const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000',
            'return files',
            '  .filter((f) => f && f.modifiedTime && new Date(f.modifiedTime).getTime() > weekAgo)',
            '  .sort((a, b) => new Date(b.modifiedTime) - new Date(a.modifiedTime))',
            '  .map((f) => ({ name: f.name, type: f.mimeType, modified: f.modifiedTime }))',
          ].join('\n'),
          note: 'Seven days is arithmetic — the code step applies it identically every Friday, newest first.',
        },
      },
      {
        id: 'digest',
        type: 'ai',
        data: {
          aiOp: 'summarize',
          label: 'Write the changes digest',
          input: '{{step.recent.output}}',
          instructions:
            'Write a short weekly digest of these recently modified files. Group by document type in plain words (docs, sheets, slides, other), newest first, with each file\'s name exactly as given. Lead with the count. If the list is empty, say the folder was quiet this week.',
          note: 'Every filename in the digest comes from the filtered list — the model only groups and phrases.',
        },
      },
      {
        id: 'send',
        type: 'tool',
        data: {
          label: 'Email the digest',
          connectionId: '',
          toolName: 'send',
          args: '{"to":"","subject":"Drive changes this week","body":"{{step.digest.output}}"}',
          retries: 2,
          onError: 'continue',
          timeoutMs: 60000,
          note: 'Sends via the workspace email integration. Set to continue on error — the digest is still returned as a named result below.',
        },
      },
      {
        id: 'out',
        type: 'output',
        data: {
          label: 'Return the digest',
          outputs: [
            { name: 'digest', value: '{{step.digest.output}}', type: 'text' },
            { name: 'changedFiles', value: '{{step.recent.output}}', type: 'list' },
          ],
          note: 'Named results, so a Slack flow can post the same digest without re-reading Drive.',
        },
      },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'list' },
      { id: 'e1', source: 'list', target: 'recent' },
      { id: 'e2', source: 'recent', target: 'digest' },
      { id: 'e3', source: 'digest', target: 'send' },
      { id: 'e4', source: 'send', target: 'out' },
    ],
  },
  bindings: [
    {
      nodeId: 'list',
      kind: 'connection',
      label: 'Pick the Google Drive account to watch',
      match: { provider: 'google_drive', toolName: 'google_drive_list_files' },
    },
    {
      nodeId: 'send',
      kind: 'connection',
      label: 'Pick the email integration that sends the digest',
      match: { provider: 'email', toolName: 'send' },
    },
  ],
  notes: {
    objective:
      'Everyone finds out on Friday what changed in the shared folder this week, instead of discovering a rewritten doc when it bites them. It worked if "wait, when did this change?" stops appearing in standups.',
    inputs: [],
    steps: [
      { nodeId: 'list', title: 'List the Drive files', what: 'Lists the files with their names, types, and modified times.' },
      {
        nodeId: 'recent',
        title: 'Keep the files touched this week',
        what: 'Filters to the last seven days and sorts newest first.',
        why: 'The freshness bar is arithmetic in a code step — visible, fixed, and editable in one place.',
      },
      { nodeId: 'digest', title: 'Write the changes digest', what: 'Groups the fresh files by type into a short email body.' },
      { nodeId: 'send', title: 'Email the digest', what: 'Sends the digest, and carries on if email is down.' },
      { nodeId: 'out', title: 'Return the digest', what: 'Returns the digest and the changed-file list as named results.' },
    ],
    failureHandling:
      'The Drive listing retries twice and fails the run rather than mailing a "quiet week" it never verified. The email continues on error, and the digest is still returned as a named output.',
    setup: [
      { label: 'Set the recipient on the Email the digest step', kind: 'value', ref: 'send' },
      { label: 'Check the Friday 16:00 run time and timezone on the trigger', kind: 'value', ref: 'trigger' },
    ],
    customize: [
      'Narrow the Drive query to one folder by adding a parent clause to the listing step\'s query.',
      'Change the seven-day window in Keep the files touched this week.',
      'Send to a mailing list, or add a Slack step to post the same digest.',
    ],
    testPlan:
      'Run it by hand after editing one test file. The digest must include that file with today\'s date and exclude anything older than a week.',
  },
}

export const AIRTABLE_REVIEW_QUEUE: FlowTemplateDef = {
  id: 'airtable-review-queue',
  name: 'Content review queue',
  description:
    'Every morning, pull the drafts waiting in your Airtable content base, have AI review each against your quality bar, and post which ones are ready to ship and which need another pass — with the reasons.',
  category: 'Docs & Data',
  icon: '📝',
  integrations: ['airtable', 'slack'],
  tags: ['daily', 'airtable', 'content', 'review'],
  graph: {
    nodes: [
      {
        id: 'trigger',
        type: 'trigger',
        data: { trigger: { type: 'schedule', schedule: { type: 'daily', time: '10:00', timezone: 'UTC', isActive: true } } },
      },
      {
        id: 'pull',
        type: 'tool',
        data: {
          label: 'Pull the waiting drafts',
          connectionId: '',
          toolName: 'airtable_list_records',
          args: '{"baseId":"","table":"","maxRecords":50}',
          retries: 2,
          timeoutMs: 60000,
          note: 'Reads the records from your content table. Point it at a view that holds only drafts awaiting review, so the queue is defined in Airtable, not here.',
        },
      },
      {
        id: 'review',
        type: 'ai',
        data: {
          aiOp: 'extract',
          label: 'Review each draft',
          input: '{{item}}',
          instructions:
            'Review this content record against a publish bar: the title says what the piece delivers, the draft is complete rather than outline-shaped, and no placeholder text remains. Return the record\'s title as given, a verdict of exactly ready or needs-work, and one specific sentence of feedback naming the weakest part.',
          outputFields: [
            { name: 'title', type: 'string' },
            { name: 'verdict', type: 'string' },
            { name: 'feedback', type: 'string' },
          ],
          perItem: { over: '{{step.pull.output.records}}', itemError: 'collect', concurrency: 4 },
          retries: 1,
          note: 'One review per record, four at a time, with a two-value verdict so the split below is exact. A malformed record leaves a placeholder instead of killing the run.',
        },
      },
      {
        id: 'ready',
        type: 'data',
        data: {
          op: 'filterArray',
          label: 'Keep the ready ones',
          input: '{{step.review.output}}',
          clauses: [{ left: '{{item.verdict}}', op: 'eq', right: 'ready' }],
          note: 'Deterministic split on the fixed verdict vocabulary — the ship list cannot drift with phrasing.',
        },
      },
      {
        id: 'digest',
        type: 'ai',
        data: {
          aiOp: 'summarize',
          label: 'Write the queue post',
          input: 'Ready to ship: {{step.ready.output}}\n\nAll reviews: {{step.review.output}}',
          instructions:
            'Write a short morning post for the content team. First the ready-to-ship list by title, then the needs-work list with each one\'s feedback sentence. Lead with both counts, stated exactly as given. Keep it scannable.',
          note: 'The model formats two lists it was handed — every verdict and feedback line was produced per-record upstream.',
        },
      },
      {
        id: 'post',
        type: 'tool',
        data: {
          label: 'Post to the content channel',
          connectionId: '',
          toolName: 'send_message',
          args: '{"channel":"#content","text":"{{step.digest.output}}"}',
          retries: 2,
          onError: 'continue',
          note: 'Set to continue on error: the reviews are still returned as named results even when Slack is down.',
        },
      },
      {
        id: 'out',
        type: 'output',
        data: {
          label: 'Return the reviews',
          outputs: [
            { name: 'readyToShip', value: '{{step.ready.output}}', type: 'list' },
            { name: 'allReviews', value: '{{step.review.output}}', type: 'list' },
          ],
          note: 'Named results, so a publish flow can take the ready list and a writer-feedback flow can take the rest.',
        },
      },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'pull' },
      { id: 'e1', source: 'pull', target: 'review' },
      { id: 'e2', source: 'review', target: 'ready' },
      { id: 'e3', source: 'ready', target: 'digest' },
      { id: 'e4', source: 'digest', target: 'post' },
      { id: 'e5', source: 'post', target: 'out' },
    ],
  },
  bindings: [
    {
      nodeId: 'pull',
      kind: 'connection',
      label: 'Pick the Airtable base with the content table',
      match: { provider: 'airtable', toolName: 'airtable_list_records' },
    },
    {
      nodeId: 'post',
      kind: 'connection',
      label: 'Pick the Slack workspace to post the queue to',
      match: { provider: 'slack', toolName: 'send_message' },
    },
  ],
  notes: {
    objective:
      'The review queue empties on a cadence instead of when someone remembers it: every draft gets a same-day verdict with one concrete piece of feedback. It worked if writers stop asking "did anyone look at my draft?"',
    inputs: [],
    steps: [
      { nodeId: 'pull', title: 'Pull the waiting drafts', what: 'Reads the records from the configured Airtable table or view.' },
      {
        nodeId: 'review',
        title: 'Review each draft',
        what: 'Gives every record a ready or needs-work verdict plus one specific feedback sentence.',
        why: 'Per-record review with a two-value verdict, so the split is an exact comparison rather than a re-read of prose.',
      },
      { nodeId: 'ready', title: 'Keep the ready ones', what: 'Splits out the records whose verdict is ready.' },
      { nodeId: 'digest', title: 'Write the queue post', what: 'Formats the ship list and the needs-work list with feedback into one post.' },
      { nodeId: 'post', title: 'Post to the content channel', what: 'Sends it to Slack, and carries on if Slack is down.' },
      { nodeId: 'out', title: 'Return the reviews', what: 'Returns the ready list and the full review set as named results.' },
    ],
    decisionRules:
      'Ready means the title states what the piece delivers, the draft is complete, and no placeholder text remains — the bar lives in the review instruction. Everything else is needs-work with a named weakest part.',
    failureHandling:
      'The Airtable read retries twice and fails the run rather than reporting an empty queue it never saw. Per-record review failures are collected instead of aborting. Posting continues on error, and the reviews still come back.',
    setup: [
      { label: 'Set the base id and table on the Pull the waiting drafts step', kind: 'value', ref: 'pull' },
      { label: 'Set the channel name on the Post to the content channel step', kind: 'value', ref: 'post' },
    ],
    customize: [
      'Point the pull at a view filtered to "awaiting review" so the queue is curated in Airtable.',
      'Tighten the publish bar by editing the review instruction — add tone, length, or SEO checks.',
      'Add an Airtable update step after the post to write each verdict back to its record, once you trust the reviews.',
    ],
    testPlan:
      'Run it by hand against a table with one finished draft and one obvious stub. The finished one should come back ready, the stub needs-work with feedback naming what is missing.',
  },
}

export const NOTES_TO_NOTION: FlowTemplateDef = {
  id: 'notes-to-notion',
  name: 'Meeting notes to Notion',
  description:
    'Paste raw meeting notes, and the flow distills the decisions, action items with owners, and open questions, then files the result as a new page in your Notion meetings section.',
  category: 'Docs & Data',
  icon: '🗒️',
  integrations: ['notion'],
  tags: ['on-demand', 'notion', 'meetings', 'notes'],
  graph: {
    nodes: [
      {
        id: 'trigger',
        type: 'trigger',
        data: {
          trigger: {
            type: 'manual',
            inputFields: [
              { name: 'meetingTitle', type: 'string', required: true, description: 'What the meeting was.' },
              { name: 'notes', type: 'string', required: true, description: 'The raw notes, pasted as-is.' },
            ],
          },
        },
      },
      {
        id: 'distill',
        type: 'ai',
        data: {
          aiOp: 'summarize',
          label: 'Distill the notes',
          input: '{{trigger.input.notes}}',
          instructions:
            'Distill these raw meeting notes into three sections: Decisions (what was actually agreed, not discussed), Action items (each with its owner if one is named — never assign an owner the notes do not name), and Open questions. Keep every name and number exactly as written. If a section is empty, include it with "none recorded".',
          note: 'The never-invent-an-owner rule is the load-bearing one: a fabricated assignment in a filed page becomes a real dispute two weeks later.',
        },
      },
      {
        id: 'page',
        type: 'tool',
        data: {
          label: 'Create the Notion page',
          connectionId: '',
          toolName: 'notion_create_page',
          args: '{"parentId":"","title":"{{trigger.input.meetingTitle}}"}',
          retries: 2,
          timeoutMs: 60000,
          note: 'Creates the page under your meetings parent page first; the content lands in the next step. Two calls because that is how Notion\'s API shapes it.',
        },
      },
      {
        id: 'fill',
        type: 'tool',
        data: {
          label: 'Write the distilled notes into the page',
          connectionId: '',
          toolName: 'notion_update_page',
          args: '{"pageId":"{{step.page.output.id}}","text":"{{step.distill.output}}"}',
          retries: 2,
          timeoutMs: 60000,
          note: 'Appends the distilled sections to the page created above, reading its id from that step\'s output.',
        },
      },
      {
        id: 'out',
        type: 'output',
        data: {
          label: 'Return the page and summary',
          outputs: [
            { name: 'page', value: '{{step.page.output}}', type: 'any' },
            { name: 'summary', value: '{{step.distill.output}}', type: 'text' },
          ],
          note: 'The page object includes its URL, so whatever ran the flow can link straight to the filed notes.',
        },
      },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'distill' },
      { id: 'e1', source: 'distill', target: 'page' },
      { id: 'e2', source: 'page', target: 'fill' },
      { id: 'e3', source: 'fill', target: 'out' },
    ],
  },
  bindings: [
    {
      nodeId: 'page',
      kind: 'connection',
      label: 'Pick the Notion workspace to file meeting pages in',
      match: { provider: 'notion', toolName: 'notion_create_page' },
    },
    {
      nodeId: 'fill',
      kind: 'connection',
      label: 'Pick the Notion workspace that writes the page content',
      match: { provider: 'notion', toolName: 'notion_update_page' },
    },
  ],
  notes: {
    objective:
      'Raw notes become a filed, structured Notion page in under a minute, so decisions and owners are findable next quarter instead of buried in someone\'s scratch doc. It worked if "what did we decide about X?" is answered by search.',
    inputs: [
      { name: 'meetingTitle', description: 'What the meeting was — becomes the page title.', example: 'Q3 pricing review' },
      { name: 'notes', description: 'The raw notes, pasted as-is. Mess is fine; that is the point.' },
    ],
    steps: [
      {
        nodeId: 'distill',
        title: 'Distill the notes',
        what: 'Extracts decisions, action items with only the owners actually named, and open questions.',
        why: 'The instruction forbids inventing owners — a fabricated assignment in a filed page becomes a real dispute later.',
      },
      { nodeId: 'page', title: 'Create the Notion page', what: 'Creates a page titled after the meeting under your meetings parent.' },
      { nodeId: 'fill', title: 'Write the distilled notes into the page', what: 'Appends the three sections to the new page.' },
      { nodeId: 'out', title: 'Return the page and summary', what: 'Returns the page (with its URL) and the distilled text.' },
    ],
    failureHandling:
      'Both Notion writes retry twice; if page creation fails the run stops before the content step, so there is never a filled page nobody can find or an orphaned title. The distillation itself never sends anywhere — a bad run costs nothing.',
    setup: [
      { label: 'Set the parent page id on the Create the Notion page step', kind: 'value', ref: 'page' },
    ],
    customize: [
      'Add a date prefix to the page title if your meetings section sorts chronologically.',
      'Add a Slack step after filing to post the page link to the team channel.',
      'Change the sections in the distillation instruction to match your meeting template.',
    ],
    testPlan:
      'Run it with real notes from a recent meeting. Check the page lands under the right parent, every owner named in the actions actually appears in the raw notes, and unowned items carry no owner.',
  },
}

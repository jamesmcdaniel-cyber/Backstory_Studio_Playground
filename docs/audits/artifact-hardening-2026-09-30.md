# Artifact runtime and agent directive hardening

This audit records artifact fixes and live verification from September 30 through October 1. The release adds explicit artifact generation, worker Python, private durable application state, and safer version saves. Live Chrome testing has resumed. These checks do not establish that arbitrary generated websites are production-ready.

## Using the directive

Put `@artifact` or `@ artifact` in agent instructions or the run request. The Instructions field also has an insertion button. For example:

```text
@artifact Build a deal tracker with editable records, search, sorting,
CSV export, responsive CSS, TypeScript UI, and Python forecast calculations.
Save application data across reloads and keep the artifact linked to this agent.
```

The directive requests a complete executable HTML or React/TSX artifact. A run that returns only prose instead fails explicitly. The existing artifact registration path links the result to its producing agent for copilot edits. This is a generation directive, not an existing-artifact mention picker.

## Runtime contract

React artifacts import `useArtifactState`, `runPython`, and `cancelPython` from `@backstory/artifact`; HTML uses `window.BackstoryArtifact`.

- Python initializes lazily in an isolated Web Worker. Calls have bounded queues and deadlines; cancellation terminates computation. Python inputs and results cross the boundary as JSON-compatible values. Worker Python has no DOM.
- Durable state is private to each signed-in user and artifact. Stable schema-versioned keys survive source revisions. There are 32 keys per artifact/user and a 256 KB limit per value. Saves use revisions to reject stale writes. Applications must show loading, saving, and errors.
- An authenticated parent-frame bridge binds requests to the exact opaque-origin frame and trusted artifact/version props. Messages cannot select other artifacts, users, URLs, or versions. Anonymous and historical frames cannot use the bridge.
- JavaScript/TypeScript/React and inline Python syntax are validated before version publication. Unsupported compiled imports and oversize source are rejected. Concurrent saves allocate unique version numbers transactionally; conditional saves reject outdated source revisions.
- Substantial interactive drafts avoid a redundant model rewrite. Artifact copilot prompts use smaller initial source excerpts and targeted edit guidance. Optional assistant context has a bounded wait; independent tool discovery is parallel. Configuration-only flow diagnosis uses the checker without a model call.

## Verification evidence

The latest full local suite passed 4,099 tests with zero failures and 99 environment-dependent skips. Actual Pyodide execution of the first-party worker code returned mean 20 for values 10, 20, 30, and division by zero returned a Python error. Type checking, lint, production build, and the production WASM asset smoke check passed.

Isolated production database checks confirmed three simultaneous saves with unique version numbers; invalid JavaScript and inline Python rejected without changing the current version; stale source and state writes rejected; application data isolated by user; and state preserved across source revisions. The fixture is [Hardened artifact integrity](https://backstory-studio.vercel.app/artifacts/cmup2hexn0001q7jv5avr77dz).

A fresh agent run using the platform provider, `claude-sonnet-5-5`, completed in 75.6 seconds and saved a 24,973-character [synthetic deal tracker](https://backstory-studio.vercel.app/artifacts/cmup2j15v000lq7irhgjdpx9t). Its source uses `runPython` and `useArtifactState`, and remains linked to the producing agent. This proves generation and persistence, not correctness of every rendered interaction. The separate [SDK fixture](https://backstory-studio.vercel.app/artifacts/cmup2hf1p0001q7kf7ipxj321) provides saved-counter, Python, NumPy, cancellation, and deadline controls for live retesting.

## Deployment

The producing agent's artifact copilot then made a targeted edit in 10.9 seconds and saved version 2. The requested note appeared in stored source; the `deals-v1` storage key and Python implementation were preserved. The linked agent remained unchanged. This is a successful live orchestration/source-version check, not a rendered browser check.

- Vercel production: `dpl_7JpQdTEnUiDNC4LhWHzFWgReTYtN`, Ready and promoted to [Backstory Studio](https://backstory-studio.vercel.app). Remote build duration: 3 minutes 40 seconds.
- Fly worker: `deployment-01M3TX7B0EJ2RM8CQC29K2NKQT`; rolling deployment and machine health checks passed.
- The additive `20261001110000_artifact_app_state` migration applied during the staged production build. Production state checks exercised the resulting table.
- Public health returned `status: ok`. The worker JavaScript asset returned HTTP 200 with the required cross-origin header. A deployment-specific 15-minute error-log query returned no logs; this is not evidence of exercised authenticated browser routes. Drain configuration and broader monitoring coverage were not audited in this pass.

## Remaining work and limits

1. Chrome verifies the generated tracker add/edit validation, reload persistence, source-version persistence, Python parity, filtering and CSV export. Phone-width artifact navigation, copilot edits, history and Python calculations were also exercised. Physical iOS/Android devices and a second signed-in user's browser isolation remain unverified.
2. A required isolated browser startup gate now rejects startup exceptions, empty rendered artifacts and infinite-loop startup before database publication. It is not a proof of business logic, every interaction, delayed errors or dynamically constructed Python. The single-machine validator rejects excess concurrency with retryable errors; prolonged load and high availability remain unverified.
3. The compatibility decision is worker-only Python, including inline blocks. DOM-dependent historical source is retained but must be migrated before it can run or be restored successfully. The one current inline-DOM artifact found in the user's non-archived artifact inventory was migrated through its producing agent.
4. Existing applications must adopt the durable-state hook. Previously lost in-memory edits cannot be recovered or automatically migrated.
5. Custom Backstory MCP reconnection succeeded after user sign-in: 17 tools were discovered and `top_records` returned successfully. Verified health was repaired, and OAuth callbacks now clear stale error/health metadata after a successful handshake. Generic HTTP nodes do not gain arbitrary Nango authentication from this release.
6. A manual-only n8n parity workflow now verifies transformation, looping, ordered partial-failure collection and merging without external writes. Backstory passed a 15-minute, 48-execution soak. The original Morning Brief workflow still requires approval to enable MCP access for deeper inspection; customer Slack delivery was not exercised. These bounded tests do not establish all-workflow parity or prolonged production capacity.

## Live Chrome and isolated validation follow up

The SDK fixture retained counter 1 across a reload and a source revision. Python and NumPy both returned mean 20. A runaway Python task hit its deadline without freezing the browser; another calculation then succeeded. Explicit cancellation also stopped a running task, followed by a successful mean calculation.

The generated tracker rejected probability 101, accepted changing deal A to 150 at 50 percent, and retained total 650 and weighted 155 after reload. Adding synthetic QA-D at 50 and 20 percent produced four records, total 700 and weighted 165. A live copilot edit fixed CSV exporting all records despite a filter: version 3 retained all four saved records and exported only the visible QA-D row, with an explicit one-row count.

The existing Revenue Operations Lab was upgraded through its producing agent to durable state and the worker Python API. Chrome showed an actual Python 3.14.2 parity result matching JavaScript: 12 records, total 565,000 and weighted 332,950. Previously lost session data was not recovered.

With explicit hosting-cost approval, `backstory-artifact-validator` was provisioned on Fly as a separate 1 GB machine. It contains first-party runtime assets and a scoped validator token, but no database, integration or model-provider credentials. Each job uses a distinct unprivileged UID, an isolated mount/network namespace with only loopback, and Chromium's sandbox. Jobs receive no inherited secrets, cannot reach external networks, and are killed as a process group at the deadline. The Fly control socket is hidden. Unauthenticated validation requests returned 401.

Live tests accepted the same compiled React/state runtime used by production, rejected an uncaught exception and an empty artifact, timed out an infinite JavaScript loop, and accepted the next working artifact. Cold compiled React validation took 16.2 seconds; warm simple checks took about 2.5 seconds. These are observed examples, not latency guarantees. The validator adds startup validation latency to executable saves.

Production worker/database checks confirmed that runtime failure leaves the current version unchanged, failed creation leaves no orphan artifact, and stale agent/flow results cannot overwrite a newer source revision. New artifacts and their first version are created in one transaction. Agent and flow edit requests now carry the source version they started from.

- Validator image: `deployment-01M3TZSYY3529K9163DRABSW65`; machine `2870231c6373e8`.
- Queue worker image: `deployment-01M3TZYSNDHT2DFWCKRMNHGWJE`; both machines passed deployment health checks.
- Required production settings: `ARTIFACT_VALIDATOR_URL`, sensitive `ARTIFACT_VALIDATOR_TOKEN`, and `ARTIFACT_RUNTIME_PREFLIGHT=required`. Development without configured validation retains syntax checks only.
- Runtime publication fixture: [Runtime publishing gate](https://backstory-studio.vercel.app/artifacts/cmup43aff0001q7jqmdhzbaqt).

## October 1 closure verification

Inline Python now shares the cancellable worker API with React. Sequential inline blocks retain their Python namespace; ordinary SDK calls keep separate namespaces. Output is bounded to 64 KiB per stream per job and delivered with completion, preventing print floods from overwhelming the UI message queue. Cancel and timeout reset the worker. The startup validator waits for inline Python to finish, so a visible heading cannot hide an unfinished or failed startup computation.

Live isolated validation accepted shared-scope inline Python and compiled React, rejected legacy DOM imports, infinite Python, infinite JavaScript, an uncaught exception and an empty page, then accepted a recovery page. Unauthenticated access remained rejected. Cold inline Python validation took 19.4 seconds; the infinite Python check was rejected after 22.5 seconds. This is startup verification, not coverage of every button or delayed computation.

The [four-language QA artifact](https://backstory-studio.vercel.app/artifacts/cmup126mg0001q7rb215naeik) was migrated to worker Python as version 3. On a 390px Chrome-emulated viewport, JavaScript incremented, TypeScript displayed sum 30, Python returned sum 60 and mean 20 for `10,20,30`, and NaN input was rejected. A mobile copilot edit saved responsive version 4; the same calculations passed at 360px. A separate platform side-panel sizing fix prevents long agent titles from expanding the grid beyond the phone viewport.

The [isolated n8n parity workflow](https://backstoryai.app.n8n.cloud/workflow/YyvMVlEggAc4CBFG) uses only synthetic values, a manual trigger and code/loop/merge nodes. Execution 4215 completed successfully with both assertions passing and zero external writes. n8n used JavaScript for its transform; the corresponding Backstory test also executed Python. This does not claim language-by-language equivalence or validate customer-facing integrations.

Backstory soak testing ran three independent flows concurrently every minute for 16 cycles, from 07:05 to 07:20 UTC on October 1. All 48 executions succeeded. Cases covered JavaScript to Python to conditional merge, isolated per-item failure, and concurrent loops with ordered output. Synthetic assertions ran inside the workflows, not merely against HTTP status. No schedules, emails, Slack posts or customer records were changed.

The final local suite passed 4,099 tests with 99 environment-dependent skips, including the new callback regression test covering verified creation/reconnection and confirming that failed handshakes never write credentials. Three simultaneous validation requests produced one successful validation and two retryable 429 responses, confirming bounded admission. The separate validator remains a single machine; high availability and multi-day endurance are not claimed.

Three more n8n executions, 4216 through 4218, were submitted concurrently; all completed successfully with both assertions passing. Two additional Backstory UI runs of the ordered-loop fixture succeeded, including a run initiated at 360px. At 768px, the builder exposed its compact Actions and Panels menus. On the new production deployment, the 360px artifact side panel fit without horizontal overflow, settings loaded, and Tab/Return triggered the expected Python calculation.

Release verification: commit `1dca72b2` was pushed to main. Vercel deployment `dpl_D28MVPKmnCtfnk9dCa6CkReHzSw1` built successfully in 3 minutes 50 seconds and is Ready; inspection of the primary domain confirmed that deployment. The queue worker image is `deployment-01M3V5CHKGF0FR69JBF81K3W98`, and the validator image is `deployment-01M3V5185JG1M6YDN09MBWGWBD`. Fly deployment health checks passed. Production health returned `ok`, the new worker asset was served, and the SDK fixture, generated tracker and Revenue Lab all passed isolated startup validation after rollout.

# Artifact runtime and agent directive hardening

This audit records the artifact fixes released after the September 30 live QA session. The release adds explicit artifact generation, worker Python, private durable application state, and safer version saves. It does not establish that arbitrary generated websites are production-ready. The final live Chrome retest was blocked by a locked Mac.

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

The full local suite passed 4,096 tests with zero failures and 99 environment-dependent skips. A subsequent targeted six-test suite also passed, including actual Pyodide execution of the first-party worker code: values 10, 20, 30 returned mean 20, and division by zero returned a Python error. Type checking, lint, production build, and the production WASM asset smoke check passed. These are not browser execution results.

Isolated production database checks confirmed three simultaneous saves with unique version numbers; invalid JavaScript and inline Python rejected without changing the current version; stale source and state writes rejected; application data isolated by user; and state preserved across source revisions. The fixture is [Hardened artifact integrity](https://backstory-studio.vercel.app/artifacts/cmup2hexn0001q7jv5avr77dz).

A fresh agent run using the platform provider, `claude-sonnet-5-5`, completed in 75.6 seconds and saved a 24,973-character [synthetic deal tracker](https://backstory-studio.vercel.app/artifacts/cmup2j15v000lq7irhgjdpx9t). Its source uses `runPython` and `useArtifactState`, and remains linked to the producing agent. This proves generation and persistence, not correctness of every rendered interaction. The separate [SDK fixture](https://backstory-studio.vercel.app/artifacts/cmup2hf1p0001q7kf7ipxj321) provides saved-counter, Python, NumPy, cancellation, and deadline controls for live retesting.

## Deployment

The producing agent's artifact copilot then made a targeted edit in 10.9 seconds and saved version 2. The requested note appeared in stored source; the `deals-v1` storage key and Python implementation were preserved. The linked agent remained unchanged. This is a successful live orchestration/source-version check, not a rendered browser check.

- Vercel production: `dpl_7JpQdTEnUiDNC4LhWHzFWgReTYtN`, Ready and promoted to [Backstory Studio](https://backstory-studio.vercel.app). Remote build duration: 3 minutes 40 seconds.
- Fly worker: `deployment-01M3TX7B0EJ2RM8CQC29K2NKQT`; rolling deployment and machine health checks passed.
- The additive `20261001110000_artifact_app_state` migration applied during the staged production build. Production state checks exercised the resulting table.
- Public health returned `status: ok`. The worker JavaScript asset returned HTTP 200 with the required cross-origin header. A deployment-specific 15-minute error-log query returned no logs; this is not evidence of exercised authenticated browser routes. Drain configuration and broader monitoring coverage were not audited in this pass.

## Remaining work and limits

1. Unlock Chrome and test the new generated tracker end to end: add/edit, reload persistence, version-change persistence, Python parity, cancellation/deadline recovery, CSV export, keyboard operation, mobile viewport, and a second user's isolation. Browser CSP and worker loading remain unverified in this release.
2. Syntax validation is not semantic/runtime validation. Valid JavaScript that throws, bad application logic, event-handler bugs, and dynamically constructed Python may still be saved. A browser-tested candidate/promotion lifecycle remains a separate hardening task.
3. Legacy inline Python retains main-thread DOM compatibility. New worker computations are cancellable; the legacy DOM path does not have the same termination guarantee.
4. Existing applications must adopt the durable-state hook. Previously lost in-memory edits cannot be recovered or automatically migrated.
5. The previously observed custom Backstory MCP 401 still requires reconnecting or correcting that connection. Native Backstory access worked in the prior tests. Generic HTTP nodes do not gain arbitrary Nango authentication from this release.
6. The earlier n8n comparison inspected workflow metadata without executing production workflows. ROI/research live paths and prolonged load/soak coverage remain unverified. No blanket claim that all session findings are closed is made.

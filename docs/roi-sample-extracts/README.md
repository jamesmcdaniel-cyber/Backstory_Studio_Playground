# ROI sample extracts

Synthetic files, one per extract kind, that satisfy the ROI data contract (see `../roi-data-contract.md`). No real people, accounts or deals. `src/lib/roi/__tests__/samples.test.ts` runs the ROI prep over them, so they stay in step with what the report reads.

Use them to check a new data flow before pointing it at real data: load one with the ROI plane's `roi_load_extract` step (or the "ROI data pull · from files" template with a raw link to a file here) for a scratch account, and confirm the ROI page lists the account with no missing required columns.

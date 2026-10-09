# ROI analysis: data contract

How the ROI analysis page (sidebar → ROI analysis, `/roi`) gets an account's data, what the files must look like, and how to feed it from a flow.

## Where the data lives

The page reads **datasets in the workspace Repository** (CSV or TSV) that carry the tag

```
sourceMetadata.roi = { account: "<account as the page names it>", kind: "<extract kind>", loadedAt: "<ISO date>" }
```

Nothing else matters: not the file name, not a folder, not who loaded it. The **newest dataset per account and kind** is the one a run reads, so reloading never needs cleanup and a failed load leaves the previous extract in place. `src/lib/roi/sources.ts` (`listRoiSources`, `loadRoiSource`) is the only code that writes or reads the tag.

## One report, one contract

Every account runs the single **standard** report (`ROI_TEMPLATES.standard`). It draws each section only when the extract that feeds it is loaded, so an account may supply any subset. The seven extract kinds, and what each must carry, live in `src/lib/roi/source-kinds.ts` (`ROI_EXTRACT_CONTRACT`); the prep that reads them is `src/lib/roi/prep.ts` (rep engagement) and `src/lib/roi/account360/prep.ts` (Account 360). Column detection is by name with fallbacks: a renamed optional column empties one metric; a missing required column makes the file unrecognisable as that extract.

| Kind | One row per | Required columns | Feeds |
| --- | --- | --- | --- |
| `activity` | rep × month | `email`, `months`, `meeting_count` | Activity trends, leading indicators, cohorts, roster |
| `usage` | user | `email` + any numeric usage columns (EDB_*/GLASS_*) | Adoption tiers, users vs non-users |
| `engagement` | opportunity | an opportunity id, an outcome (`won`), an engagement score | Deal engagement vs win rate and velocity |
| `stages` | closed opp × stage × activity type | `activity_match_stage`, `opportunity_crm_id`, `opportunity_is_won` | Stage × persona |
| `clickstream` | Account 360 event | user/email, session, time, event type, an account-name column | Account engagement |
| `accounts` | parent account | account id, account name | Account engagement scope |
| `opportunities` | opportunity | created, close_date, stage, amount | Pipeline per account per month |

The full recognised column list per kind is in `ROI_EXTRACT_CONTRACT[kind].columns`. The SQL that produces `activity`, `engagement` and `stages` from the People.ai warehouse is in `src/lib/roi/warehouse-queries.ts` (org id substituted per run, 30-month window).

The one account outside the contract today is **Backstory** itself: its report is the imported value readout (`POST /api/roi/readout`, operators only). Load Backstory's extracts and press **Refresh data** to move it onto the same path.

## Three ways to load extracts

1. **Connect a flow as the page's data source.** ☰ Filters → *Data source and analyst* → *Data flow*. Each *Run analysis* then starts the flow with `{ account, analysisId, reason, config }`, waits for it (the progress card shows *Fetching data*), resolves the freshly tagged extracts and builds. Contract in `src/lib/roi/data-source.ts`.
2. **Any flow, any trigger, calling the ROI plane's `roi_load_extract` step.** Inputs: `account`, `kind`, and exactly one of `url` (a CSV/TSV link the platform fetches itself, any size up to 200 MB, the workspace's saved HTTP credential for that host applied when there is one), `storedFileId`, `csv` (inline text) or `rows` (JSON objects). Returns the dataset id, row count, header and `missingColumns` (required columns the header lacks). A nightly scheduled flow looping over an account list keeps every account fresh with the page left on *Loaded extracts*. Implementation: `src/lib/roi/load-extract.ts`.
3. **Operator loader.** ☰ Filters → *Data source and analyst* → *Load extracts* (platform admins): name the account, choose a file per kind. Same tag.

Built-in templates to copy (Flows → Templates, operator edition only):

- **ROI data pull · Databricks** (`roi-data-pull-databricks`): resolves the account's warehouse org id, runs the three queries on a SQL warehouse, loads each result. Needs a host-bound HTTP credential holding a Databricks PAT.
- **ROI data pull · from files** (`roi-data-pull-files`): takes the account and a link per extract, fetches and loads each. Replace the *Collect* step with whatever produces your links.

`roi_databricks_pull` and `roi_load_extract` both throw on failure so a flow step fails rather than succeeding with nothing loaded.

## Timing

| Run | About |
| --- | --- |
| Build from loaded extracts | 90 s |
| Settings rewrite (no recompute) | 60 s |
| With a data flow connected | flow time + 90 s |

The page goes asynchronous after 3 minutes: the progress card stays on the page and a notification fires when the run lands. Settings stay in the side panel; there is no separate settings page.

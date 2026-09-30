import { runFlowCode, type CodeDataset, DATASET_TIMEOUT_MAX_MS } from '@/features/flows/code-runner'

/**
 * The Account 360 ROI prep: which accounts a customer's team actually works
 * in Backstory's Account 360, and what pipeline those accounts carry.
 *
 * Ported from the HP Account 360 ROI suite. Three extracts:
 *   - clickstream  — one row per Account 360 event (user, session, time, event type, account name)
 *   - accounts     — the parent accounts in scope (id, name; a name may carry several ids)
 *   - opportunities — the opportunity pull (account id, created date, close date, stage, amount)
 *
 * The method, exactly as the original analysis ran it:
 *   - Flagged users are excluded before anything is counted: anyone who
 *     touched `breadthCutoff` or more accounts (enablement staff and admins
 *     browse everywhere and would inflate engagement on accounts they don't
 *     work), plus any the requester names.
 *   - Each event belongs to the account its session was on: account-page
 *     visits name the account, and the clicks in the same session inherit it.
 *   - Deep actions are opportunity, metrics and activity actions (the event
 *     type names one); page visits, filter, sort and time-range changes and
 *     everything else are not.
 *   - Cohorts split engaged accounts on the medians of sessions and of the
 *     deep-action share: Power Users (both at or above), Frequent Browsers
 *     (sessions only), Focused Diggers (depth only), Light Touch (neither).
 *     Accounts with no events are No Engagement.
 *   - Pipeline is by month over the click-stream's full months: created by
 *     the opportunity's created date, closed-won by close date on a Won stage.
 *
 * The output is the dashboard's data bundle as it is — the page recomputes
 * every timeframe from the per-month arrays — plus META for its text.
 */

export const ACCOUNT360_PREP_CODE = String.raw`
frames = input["frames"]
notes = []
BREADTH_CUTOFF = int(input.get("breadthCutoff") or 5)
EXTRA_EXCLUDED = set(str(u).strip().lower() for u in (input.get("excludeUsers") or []) if str(u).strip())
COHORTS = ["Power Users", "Frequent Browsers", "Focused Diggers", "Light Touch", "No Engagement"]
DEEP = ["opportunit", "metric", "activit"]

def cols(df):
    return [str(c) for c in df.columns]

def find_col(df, needles, exclude=()):
    for c in cols(df):
        low = c.lower()
        if all(n in low for n in needles) and not any(x in low for x in exclude):
            return c
    return None

clicks = accounts = opps = None
for name, df in frames.items():
    if find_col(df, ["opportunity"]) is not None:
        opps = df
    elif find_col(df, ["session"]) is not None and find_col(df, ["event"]) is not None:
        clicks = df
    elif find_col(df, ["account"]) is not None:
        accounts = df
if clicks is None:
    raise ValueError("No click-stream extract (a frame with session and event columns).")
if opps is None:
    raise ValueError("No opportunity extract (a frame with opportunity columns).")

def norm(series):
    return series.astype(str).str.lower().str.replace(r"[^a-z0-9]", "", regex=True)

# ---------------------------------------------------------------- accounts
o = opps.copy()
o_acct_id = find_col(o, ["account_id"], exclude=["parent"])
o_parent_id = find_col(o, ["parent_account_id"])
o_acct_name = find_col(o, ["account_name"])
o_created = find_col(o, ["created"])
o_close = find_col(o, ["close_date"]) or find_col(o, ["close"])
o_stage = find_col(o, ["stage"])
o_amount = find_col(o, ["amount"])
for label, col in [("created date", o_created), ("close date", o_close), ("stage", o_stage), ("amount", o_amount)]:
    if col is None:
        raise ValueError("The opportunity extract has no " + label + " column.")

if accounts is not None:
    a_name = find_col(accounts, ["name"])
    a_id = find_col(accounts, ["id"])
    if a_name is None or a_id is None:
        raise ValueError("The accounts extract needs an account id and an account name column.")
    acc = accounts[[a_id, a_name]].dropna()
    acc = acc.assign(id=acc[a_id].astype(str).str.replace(r"\.0$", "", regex=True), name=acc[a_name].astype(str).str.strip())
else:
    if o_acct_id is None or o_acct_name is None:
        raise ValueError("Without an accounts extract, the opportunity extract needs account id and account name columns.")
    acc = o[[o_acct_id, o_acct_name]].dropna().drop_duplicates()
    acc = acc.assign(id=acc[o_acct_id].astype(str).str.replace(r"\.0$", "", regex=True), name=acc[o_acct_name].astype(str).str.strip())
    notes.append("No accounts extract: every account in the opportunity pull is in scope.")
names = sorted(acc["name"].unique())
id_to_name = dict(zip(acc["id"], acc["name"]))
key_to_name = dict(zip(norm(pd.Series(names)), names))

# ---------------------------------------------------------------- click-stream
c = clicks.copy()
c_user = find_col(c, ["email"]) or find_col(c, ["user"])
c_session = find_col(c, ["session"])
c_time = find_col(c, ["time"]) or find_col(c, ["date"])
c_type = find_col(c, ["event_type"]) or find_col(c, ["type"])
c_names = [col for col in cols(c) if "name" in col.lower() and "user" not in col.lower()]
for label, col in [("user", c_user), ("session", c_session), ("event time", c_time), ("event type", c_type)]:
    if col is None:
        raise ValueError("The click-stream extract has no " + label + " column.")
events_total = int(len(c))
c["_user"] = c[c_user].astype(str).str.strip().str.lower()
c["_session"] = c[c_session].astype(str)
c["_t"] = pd.to_datetime(c[c_time], errors="coerce")
c["_type"] = c[c_type].astype(str)
c = c[c["_t"].notna()]
acct = pd.Series([None] * len(c), index=c.index, dtype="object")
for col in c_names:
    hit = norm(c[col].fillna("")).map(key_to_name)
    acct = acct.where(acct.notna(), hit)
c["_acct"] = acct
c = c.sort_values(["_session", "_t"])
c["_acct"] = c.groupby("_session")["_acct"].transform(lambda s: s.ffill().bfill())

breadth = c.dropna(subset=["_acct"]).groupby("_user")["_acct"].nunique()
flagged = set(breadth[breadth >= BREADTH_CUTOFF].index) | EXTRA_EXCLUDED
excluded = sorted(u for u in flagged if u in set(c["_user"]))
e = c[~c["_user"].isin(flagged)].dropna(subset=["_acct"]).copy()
low = e["_type"].str.lower()
deep = pd.Series(False, index=e.index)
for word in DEEP:
    deep = deep | low.str.contains(word, regex=False)
e["_deep"] = deep
unattributed = int(c[~c["_user"].isin(flagged)]["_acct"].isna().sum())
if unattributed:
    notes.append(str(unattributed) + " events could not be tied to an in-scope account and are left out.")

click_start = c["_t"].min()
click_end = c["_t"].max()
# Full months only: a click-stream starting mid-month starts at the next one.
# (Plain arithmetic — scalar strftime lazily imports, which the sandbox refuses.)
year, month = int(click_start.year), int(click_start.month)
if int(click_start.day) != 1:
    month += 1
if month > 12:
    year, month = year + 1, 1
months = []
while (year, month) <= (int(click_end.year), int(click_end.month)):
    months.append(str(year) + "-" + ("0" if month < 10 else "") + str(month))
    month += 1
    if month > 12:
        year, month = year + 1, 1

per = e.groupby("_acct").agg(unique_sessions=("_session", "nunique"), deep=("_deep", "mean"), unique_users=("_user", "nunique"))
per["deep_action_ratio"] = per["deep"].round(3)
session_median = float(per["unique_sessions"].median()) if len(per) else 0.0
depth_median = round(float(per["deep_action_ratio"].median()), 3) if len(per) else 0.0

def cohort_of(name):
    if name not in per.index:
        return "No Engagement"
    row = per.loc[name]
    often = row["unique_sessions"] >= session_median
    deep = row["deep_action_ratio"] >= depth_median
    if often and deep:
        return "Power Users"
    if often:
        return "Frequent Browsers"
    if deep:
        return "Focused Diggers"
    return "Light Touch"

# ---------------------------------------------------------------- pipeline
o["_id"] = (o[o_parent_id].where(o[o_parent_id].notna(), o[o_acct_id]) if o_parent_id and o_acct_id else o[o_acct_id]).astype(str).str.replace(r"\.0$", "", regex=True)
o["_acct"] = o["_id"].map(id_to_name)
if o_acct_name is not None:
    o["_acct"] = o["_acct"].where(o["_acct"].notna(), norm(o[o_acct_name].fillna("")).map(key_to_name))
o = o[o["_acct"].notna()]
o["_amount"] = pd.to_numeric(o[o_amount], errors="coerce").fillna(0.0)
o["_cm"] = pd.to_datetime(o[o_created], errors="coerce", utc=True).dt.strftime("%Y-%m")
o["_wm"] = pd.to_datetime(o[o_close], errors="coerce").dt.strftime("%Y-%m")
o["_won"] = o[o_stage].astype(str).str.lower().str.contains("won", regex=False) & ~o[o_stage].astype(str).str.lower().str.contains("lost", regex=False)
created = o[o["_cm"].isin(months)].pivot_table(index="_acct", columns="_cm", values="_amount", aggfunc="sum").reindex(columns=months).fillna(0.0)
won = o[o["_won"] & o["_wm"].isin(months)].pivot_table(index="_acct", columns="_wm", values="_amount", aggfunc="sum").reindex(columns=months).fillna(0.0)
won_beyond = float(o[o["_won"] & (o["_wm"] > months[-1])]["_amount"].sum()) if months else 0.0

rows = []
for name in names:
    sessions = float(per.loc[name, "unique_sessions"]) if name in per.index else 0.0
    rows.append({
        "account": name,
        "cohort": cohort_of(name),
        "unique_sessions": sessions,
        "deep_action_ratio": float(per.loc[name, "deep_action_ratio"]) if name in per.index else 0.0,
        "unique_users": float(per.loc[name, "unique_users"]) if name in per.index else 0.0,
        "created_by_month": [round(float(v), 2) for v in (created.loc[name].tolist() if name in created.index else [0.0] * len(months))],
        "closed_won_by_month": [round(float(v), 2) for v in (won.loc[name].tolist() if name in won.index else [0.0] * len(months))],
    })

cohorts_static = []
for cohort in COHORTS:
    members = [r for r in rows if r["cohort"] == cohort]
    tc = sum(sum(r["created_by_month"]) for r in members)
    tw = sum(sum(r["closed_won_by_month"]) for r in members)
    n = len(members)
    cohorts_static.append({"cohort": cohort, "n": n, "avg_created": tc / n if n else 0.0, "avg_closed_won": tw / n if n else 0.0, "total_created": tc, "total_closed_won": tw})

def total(r):
    return sum(r["created_by_month"]) + sum(r["closed_won_by_month"])

low_volume = sorted([r for r in rows if r["cohort"] in ("Focused Diggers", "Light Touch") and total(r) > 0], key=total, reverse=True)
whale_names = [r["account"] for r in low_volume[:5]]
dark_names = [r["account"] for r in sorted([r for r in rows if r["cohort"] == "No Engagement" and total(r) > 0], key=total, reverse=True)]

users = e.groupby("_user").agg(total_events=("_type", "size"), unique_accounts=("_acct", "nunique"), unique_sessions=("_session", "nunique")).reset_index()
users = users.sort_values(["unique_accounts", "total_events"], ascending=[False, False]).head(12)
top_users = [{"user": r["_user"], "total_events": int(r["total_events"]), "unique_accounts": int(r["unique_accounts"]), "unique_sessions": int(r["unique_sessions"])} for _, r in users.iterrows()]

last_day = click_end.normalize()
month_end = (last_day + pd.offsets.MonthEnd(0)).normalize()
META = {
    "accounts": len(names),
    "engaged": int(len(per)),
    "noEngagement": sum(1 for r in rows if r["cohort"] == "No Engagement"),
    "clickStart": str(click_start.date()),
    "clickEnd": str(click_end.date()),
    "excludedUsers": excluded,
    "breadthCutoff": BREADTH_CUTOFF,
    "eventsTotal": events_total,
    "eventsUsed": int(len(e)),
    "usersActive": int(e["_user"].nunique()),
    "wonBeyondWindow": won_beyond,
    "lastMonthPartial": bool(last_day < month_end),
}
BUNDLE = {
    "months": months,
    "cohorts_static": cohorts_static,
    "accounts": rows,
    "whale_names": whale_names,
    "dark_names": dark_names,
    "top_users": top_users,
    "session_median": session_median,
    "depth_ratio_median": depth_median,
}
return {"BUNDLE": BUNDLE, "META": META, "notes": notes}
`

export type Account360Row = {
  account: string
  cohort: string
  unique_sessions: number
  deep_action_ratio: number
  unique_users: number
  created_by_month: number[]
  closed_won_by_month: number[]
}

export type Account360Facts = {
  BUNDLE: {
    months: string[]
    cohorts_static: Array<{ cohort: string; n: number; avg_created: number; avg_closed_won: number; total_created: number; total_closed_won: number }>
    accounts: Account360Row[]
    whale_names: string[]
    dark_names: string[]
    top_users: Array<{ user: string; total_events: number; unique_accounts: number; unique_sessions: number }>
    session_median: number
    depth_ratio_median: number
  }
  META: {
    accounts: number
    engaged: number
    noEngagement: number
    clickStart: string
    clickEnd: string
    excludedUsers: string[]
    breadthCutoff: number
    eventsTotal: number
    eventsUsed: number
    usersActive: number
    wonBeyondWindow: number
    lastMonthPartial: boolean
  }
  notes: string[]
}

export type Account360Options = { excludeUsers?: string[]; breadthCutoff?: number }

/** Run the prep over the mounted datasets. */
export async function runAccount360Prep(datasets: CodeDataset[], options: Account360Options = {}): Promise<Account360Facts> {
  const { output } = await runFlowCode({
    language: 'python',
    mode: 'all',
    analysis: true,
    datasets,
    code: ACCOUNT360_PREP_CODE,
    input: { excludeUsers: options.excludeUsers ?? [], breadthCutoff: options.breadthCutoff ?? 5 },
    timeoutMs: DATASET_TIMEOUT_MAX_MS,
  })
  const facts = output as Account360Facts
  if (!facts?.BUNDLE?.accounts?.length) throw new Error(`The Account 360 prep found no accounts. ${(facts?.notes ?? []).join(' ')}`)
  return facts
}

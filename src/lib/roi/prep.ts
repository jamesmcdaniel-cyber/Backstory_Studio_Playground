import { runFlowCode, type CodeDataset, DATASET_TIMEOUT_MAX_MS } from '@/features/flows/code-runner'

/**
 * The ROI prep: deterministic pandas over the extracts, producing exactly
 * the data objects the dashboard's script consumes (U, OPP, ST, META) —
 * per-rep × month matrices for the leading indicators (so the page can
 * recompute windows and populations live), deal-engagement deciles and
 * levels per deal type, and the stage/persona profiles with the
 * survivorship control.
 *
 * Ported from the Method section of the original analysis. The model never
 * touches this: it gets a compact summary of the result (facts.ts) and
 * writes the narrative. Runs in the same sandbox as run_code (no imports,
 * no network), which is why the script is written against the sandbox's
 * builtins — pd and np are provided, nothing else is.
 *
 * Column detection is by name, with fallbacks, so an extract with a
 * renamed column degrades to "that section is missing" (reported in
 * `notes`), never to a wrong number.
 */

export const ROI_PREP_CODE = String.raw`
frames = input["frames"]
notes = []
# Adding a metric only changes the activity section; the deal and stage
# sections are carried over from the existing facts, so skip them.
ONLY_ACTIVITY = bool(input.get("onlyActivity"))
PERSONAS = [
    ("Director", "director_activity_count"), ("VP", "vp_activity_count"), ("Executive", "executive_activity_count"),
    ("Management/Admin", "mgmt_activity_count"), ("Legal/Procurement", "legal_proc_activity_count"), ("Finance", "finance_activity_count"),
    ("IT", "it_activity_count"), ("Engineering", "eng_activity_count"), ("Ops/Product/Supply chain", "other_activity_count"),
]
METRICS = [
    ("meeting_count", "Meetings"), ("sent_email_count", "Emails sent"), ("dir_vp_exec", "Director + VP + Exec meetings"),
    ("vp_meeting_count", "VP meetings"), ("executive_meeting_count", "Executive meetings"), ("people_engaged", "People engaged"),
    ("pipeline_created", "Pipeline created"), ("pipeline_created_owned", "Pipeline created (owned)"),
]
# Breakdowns the activity tab draws (meeting channel, email direction, the
# senior mix) — matrices like the metrics, but not metrics of their own.
BREAKDOWNS = [
    ("director_meeting_count", "Director meetings"), ("in_person_meeting_count", "In-person meetings"),
    ("conference_call_count", "Conference calls"), ("received_email_count", "Emails received"),
]
ROLE_RULES = [
    ("SDR / BDR", ["sdr", "bdr", "business development", "sales development", "inside sales", "isr"]),
    ("Solutions engineering", ["solution", "sales engineer", "presales", "pre-sales", "-se-", " se "]),
    ("CS / PS", ["csm", "customer success", "success", "professional services", "consult", "onboarding", "implementation", "support", "renewal"]),
    ("Account executives", ["account exec", "account manag", "-ae", " ae", "gam", "gar", "-am-", "-am", "sales", "seller", "territory", "rep"]),
    ("Leadership", ["director", "-dir", "head", "vice president", "-vp", " vp", "chief", "cro", "manager", "mgr", "lead"]),
]
LEADER_TAIL = ["director", "dir", "head", "vp", "manager", "mgr", "lead", "chief", "cro"]

def role_group(role, title, team=""):
    role = "" if str(role or "").lower() in ("nan", "none") else str(role or "")
    title = "" if str(title or "").lower() in ("nan", "none") else str(title or "")
    # A CRM hierarchy path ("…:NA-US-CSM-Director6:NA-US-CSM-Director6-Rep")
    # names the seat in its last segment when the role column is empty.
    seat = role or str(team or "").split(":")[-1]
    text = (" " + title + " " + seat + " ").lower()
    if not text.strip():
        return "Other"
    tail = seat.lower().replace(" ", "-").split("-")[-1].strip()
    if tail and any(tail.startswith(x) for x in LEADER_TAIL):
        return "Leadership"
    for label, needles in ROLE_RULES:
        if any(n in text for n in needles):
            return label
    return "Other"

def cols(df):
    return [str(c) for c in df.columns]

def has(df, name):
    return name in cols(df)

def find_col(df, needles, exclude=()):
    for c in cols(df):
        low = c.lower()
        if all(n in low for n in needles) and not any(x in low for x in exclude):
            return c
    return None

def classify():
    activity = usage = opp = stages = None
    for name, df in frames.items():
        if has(df, "activity_match_stage"):
            stages = df
        elif has(df, "months") and has(df, "email") and has(df, "meeting_count"):
            activity = df
        elif find_col(df, ["engagement"]) is not None and (find_col(df, ["won"]) is not None or find_col(df, ["close"]) is not None):
            opp = df
        elif find_col(df, ["email"]) is not None:
            usage = df
    return activity, usage, opp, stages

activity, usage, opp, stages = classify()

def fnum(series):
    return pd.to_numeric(series, errors="coerce")

def r1(x):
    return None if x is None or (isinstance(x, float) and np.isnan(x)) else round(float(x), 1)

def med(series):
    s = fnum(series).dropna()
    return None if len(s) == 0 else float(s.median())

# ---------------------------------------------------------------- U (activity)
U = None
META = {}
if activity is None:
    notes.append("No activity extract (a frame with email, months and meeting_count) — leading indicators and cohorts are unavailable.")
else:
    a = activity.copy()
    a["email_l"] = a["email"].astype(str).str.strip().str.lower()
    a["month"] = pd.to_datetime(a["months"], errors="coerce").dt.strftime("%Y-%m")
    a = a[a["month"].notna()]
    months = sorted(a["month"].unique())[-24:]
    a = a[a["month"].isin(months)]
    for c in ["director_meeting_count", "vp_meeting_count", "executive_meeting_count", "meeting_count", "sent_email_count", "pipeline_created", "pipeline_created_owned"]:
        if has(a, c):
            a[c] = fnum(a[c])
        else:
            a[c] = np.nan
            notes.append("Activity extract has no " + c + " column; that metric is empty.")
    a["dir_vp_exec"] = a[["director_meeting_count", "vp_meeting_count", "executive_meeting_count"]].sum(axis=1, min_count=1)
    people_c = "external_people_touched" if has(a, "external_people_touched") else ("external_people_met_with" if has(a, "external_people_met_with") else None)
    if people_c is not None:
        a["people_engaged"] = fnum(a[people_c])
    else:
        a["people_engaged"] = np.nan
        METRICS = [mk for mk in METRICS if mk[0] != "people_engaged"]
        notes.append("Activity extract has no external_people_touched column; people engaged is unavailable.")
    breakdowns = [(c, l) for c, l in BREAKDOWNS if has(a, c)]
    for c, l in breakdowns:
        a[c] = fnum(a[c])
    # Metrics the viewer asked for: a sum of activity-extract columns.
    money_keys = []
    for extra in (input.get("extraMetrics") or []):
        present = [c for c in extra.get("columns", []) if has(a, c)]
        if not present:
            notes.append("Added metric " + str(extra.get("label")) + " has none of its columns in the activity extract; skipped.")
            continue
        a[extra["key"]] = a[present].apply(fnum).sum(axis=1, min_count=1)
        METRICS.append((extra["key"], extra["label"]))
        if extra.get("format") == "currency":
            money_keys.append(extra["key"])
    # Pipeline cleaning: reps reporting in another currency dwarf everyone
    # else (medians hundreds of times the org's); drop them from pipeline
    # metrics only, then cap rep-months at the 95th percentile of non-zero.
    for c, key in [("pipeline_created", "capP"), ("pipeline_created_owned", "capPO")]:
        nz = a[a[c] > 0]
        if len(nz):
            rep_med = nz.groupby("email_l")[c].median()
            org_med = float(rep_med.median()) if len(rep_med) else 0.0
            outliers = set(rep_med[rep_med > org_med * 25].index) if org_med > 0 else set()
            if outliers:
                a.loc[a["email_l"].isin(outliers), c] = np.nan
                notes.append(str(len(outliers)) + " reps excluded from " + c + " (pipeline reported in another currency, median >25x the org's).")
            cap = float(a[a[c] > 0][c].quantile(0.95)) if (a[c] > 0).any() else 0.0
            META[key] = cap
            a.loc[a[c] > cap, c] = cap
        else:
            META[key] = 0.0
    users = list(pd.unique(a["email_l"]))
    uidx = {u: i for i, u in enumerate(users)}
    team_col = "team_full_name" if has(a, "team_full_name") else ("team_name" if has(a, "team_name") else None)
    teams = {}
    if team_col:
        t = a[[ "email_l", team_col ]].dropna().drop_duplicates("email_l")
        teams = dict(zip(t["email_l"], t[team_col].astype(str)))
    # Matrices travel compact — rows joined by ";", values by ",", empty for
    # no activity that month — because the report embeds every rep × month
    # (2,000 reps × 24 months × a dozen series is megabytes as JSON arrays).
    # decodeMatrix (facts.ts) and the report's script read it back.
    def cell(v, digits):
        if np.isnan(v):
            return ""
        f = float(v)
        return str(int(f)) if f.is_integer() else str(round(f, digits))
    def matrix_of(key, digits):
        piv = a.pivot_table(index="email_l", columns="month", values=key, aggfunc="mean")
        piv = piv.reindex(index=users, columns=months)
        return ";".join(",".join(cell(v, digits) for v in row) for row in piv.values)
    matrices = {}
    for key, label in METRICS:
        matrices[key] = matrix_of(key, 3)
    extra_matrices = {}
    for key, label in breakdowns:
        extra_matrices[key] = matrix_of(key, 2)
    name_c = "full_name" if has(a, "full_name") else None
    role_c = "role_name" if has(a, "role_name") else None
    title_c = "title" if has(a, "title") else None
    people = {}
    info_cols = [c for c in [name_c, role_c, title_c] if c]
    if info_cols:
        latest = a.sort_values("month").drop_duplicates("email_l", keep="last").set_index("email_l")
        for e in users:
            if e in latest.index:
                row = latest.loc[e]
                people[e] = {
                    "n": str(row[name_c]) if name_c and str(row[name_c]) not in ("nan", "None") else "",
                    "ti": str(row[title_c] if title_c else (row[role_c] if role_c else "")).replace("nan", ""),
                    "r": role_group(row[role_c] if role_c else "", row[title_c] if title_c else "", teams.get(e, "")),
                }
    tier = {}
    flag = {}
    usage_detail = {}
    tier_cuts = []
    n_usage = 0
    n_bottom = 0
    has_usage = False
    if usage is not None:
        ucol = find_col(usage, ["email"])
        u = usage.copy()
        u["email_l"] = u[ucol].astype(str).str.strip().str.lower()
        numeric = []
        for c in cols(u):
            low = c.lower()
            if c == "email_l" or c == ucol or "date" in low or "time" in low or low.endswith("id") or "_id" in low:
                continue
            s = fnum(u[c])
            if s.notna().mean() > 0.5:
                numeric.append(c)
        preferred = [c for c in numeric if any(n in c.lower() for n in ["edb", "glass", "event", "usage", "session", "action", "view", "count", "total"])]
        score_cols = preferred if preferred else numeric
        if not score_cols:
            notes.append("Usage cohort has no numeric usage columns; adoption tiers are unavailable.")
        else:
            u["score"] = u[score_cols].apply(fnum).sum(axis=1)
            date_col = find_col(u, ["last"]) or find_col(u, ["date"])
            if date_col:
                u["last_dt"] = pd.to_datetime(u[date_col], errors="coerce")
            else:
                u["last_dt"] = pd.NaT
            acct_c = find_col(u, ["account"], exclude=["id"])
            opp_c = find_col(u, ["opp"], exclude=["id"])
            u["acct_v"] = fnum(u[acct_c]) if acct_c else np.nan
            u["opp_v"] = fnum(u[opp_c]) if opp_c else np.nan
            g = u.groupby("email_l").agg(score=("score", "sum"), last_dt=("last_dt", "max"), acct_v=("acct_v", "sum"), opp_v=("opp_v", "sum")).reset_index()
            g = g[g["email_l"].isin(uidx)]
            usage_detail = {}
            g["last_s"] = g["last_dt"].dt.strftime("%Y-%m-%d")
            for _, row in g.iterrows():
                usage_detail[row["email_l"]] = {
                    "ev": int(row["score"]) if not np.isnan(row["score"]) else 0,
                    "a": None if not acct_c or np.isnan(row["acct_v"]) else int(row["acct_v"]),
                    "o": None if not opp_c or np.isnan(row["opp_v"]) else int(row["opp_v"]),
                    "last": row["last_s"] if isinstance(row["last_s"], str) else None,
                }
            n_usage = int(len(g))
            if n_usage >= 6:
                has_usage = True
                g = g.sort_values(["score", "last_dt"], ascending=[True, True], na_position="first")
                n_bottom = int(round(n_usage * 0.05))
                bottom = set(g["email_l"].iloc[:n_bottom])
                q1 = float(g["score"].quantile(1 / 3))
                q2 = float(g["score"].quantile(2 / 3))
                tier_cuts = [int(round(q1)), int(round(q2))]
                for _, row in g.iterrows():
                    e = row["email_l"]
                    sc = float(row["score"])
                    tier[e] = "High" if sc > q2 else ("Medium" if sc > q1 else "Low")
                    flag[e] = "Non-user" if e in bottom else "User"
                notes.append(str(n_usage) + " of " + str(len(usage)) + " usage records matched a rep in the activity extract; usage score = " + " + ".join(score_cols[:6]) + ".")
            else:
                notes.append("Only " + str(n_usage) + " usage records matched an activity rep; adoption cohorts are unavailable.")
    else:
        notes.append("No usage cohort file — adoption tiers and users vs non-users are unavailable.")
    def user_row(e):
        row = {"t": tier.get(e), "f": (flag.get(e, "Non-user") if has_usage else None), "g": str(teams.get(e, "")).split(":")[-1].strip()}
        p = people.get(e)
        if p:
            row["n"] = p["n"]
            row["ti"] = p["ti"]
            row["r"] = p["r"]
        if e in usage_detail:
            row["u"] = usage_detail[e]
        return row
    U = {
        "months": months,
        "users": [user_row(e) for e in users],
        "m": matrices,
        "mx": extra_matrices,
        "mxLabels": {k: l for k, l in breakdowns},
        "labels": {k: l for k, l in METRICS},
        "tierCuts": tier_cuts,
        "nUsage": n_usage,
        "nBottom": n_bottom,
        "hasUsage": has_usage,
        "usageRecords": int(len(usage)) if usage is not None else 0,
        "moneyKeys": money_keys,
        "activityColumns": [c for c in cols(activity) if fnum(activity[c]).notna().mean() > 0.5 and c not in ("email", "months")],
    }

# ---------------------------------------------------------------- opportunities
def opp_level_frame(df, source):
    idc = "opportunity_crm_id" if has(df, "opportunity_crm_id") else (find_col(df, ["opportunity", "id"]) or find_col(df, ["opp", "id"]) or find_col(df, ["crm_id"]) or ("id" if has(df, "id") else None))
    won_c = "opportunity_is_won" if has(df, "opportunity_is_won") else find_col(df, ["is_won"]) or find_col(df, ["won"])
    type_c = "opportunity_type" if has(df, "opportunity_type") else find_col(df, ["type"], exclude=["activity"])
    score_c = "opportunity_engagement_level" if has(df, "opportunity_engagement_level") else (find_col(df, ["engagement", "score"]) or find_col(df, ["engagement", "level"]) or find_col(df, ["engagement"], exclude=["account"]))
    amt_c = "opportunity_amount" if has(df, "opportunity_amount") else find_col(df, ["amount"])
    created_c = find_col(df, ["created"], exclude=["by"])
    close_c = "opportunity_close_date" if has(df, "opportunity_close_date") else find_col(df, ["close", "date"])
    name_c = "opportunity_name" if has(df, "opportunity_name") else find_col(df, ["opportunity", "name"])
    closed_c = "opportunity_is_closed" if has(df, "opportunity_is_closed") else find_col(df, ["is_closed"])
    if idc is None or won_c is None or score_c is None:
        notes.append(source + ": could not find opportunity id, outcome and engagement score columns; deal engagement is unavailable from it.")
        return None
    o = df.drop_duplicates(idc).copy()
    o["id"] = o[idc].astype(str)
    w = o[won_c].astype(str).str.strip().str.lower()
    o["won"] = w.isin(["true", "1", "yes", "t", "won"])
    if closed_c is not None:
        cl = o[closed_c].astype(str).str.strip().str.lower()
        o = o[cl.isin(["true", "1", "yes", "t"]) | cl.isin(["nan", "none", ""])]
    # One decimal: the report re-buckets deals in the browser from scores
    # carried at that precision, and must land every deal where this does.
    o["score"] = fnum(o[score_c]).round(1)
    o = o[o["score"].notna()]
    o["type"] = o[type_c].astype(str).str.strip() if type_c else "All"
    o["amount"] = fnum(o[amt_c]) if amt_c else np.nan
    if name_c:
        o = o[~o[name_c].astype(str).str.lower().str.contains("framework", na=False)]
    o = o[~o["type"].str.lower().str.contains("framework", na=False)]
    days_c = find_col(df, ["open_to_close"]) or find_col(df, ["cycle"]) or find_col(df, ["days_to_close"])
    if days_c:
        o["days"] = fnum(o[days_c])
    elif created_c and close_c:
        cr = pd.to_datetime(o[created_c], errors="coerce")
        cl = pd.to_datetime(o[close_c], errors="coerce")
        o["days"] = (cl - cr).dt.days
    else:
        o["days"] = np.nan
    o.loc[o["days"] < 0, "days"] = np.nan
    # Close dates limited to the activity window, as the reference does, so
    # the deal story and the behaviour story describe the same period.
    if close_c and activity is not None:
        cl = pd.to_datetime(o[close_c], errors="coerce")
        lo_m = pd.to_datetime(months[0] + "-01")
        hi_m = pd.to_datetime(months[-1] + "-01") + pd.offsets.MonthEnd(1)
        keep = cl.isna() | ((cl >= lo_m) & (cl <= hi_m))
        o = o[keep]
    o["close"] = pd.to_datetime(o[close_c], errors="coerce").dt.strftime("%Y-%m") if close_c else None
    return o[["id", "won", "score", "type", "amount", "days", "close"]]

def bucket_rows(o, key_col, label_fn):
    rows = []
    for k, grp in o.groupby(key_col, sort=True):
        won = grp[grp["won"]]
        lost = grp[~grp["won"]]
        rows.append({
            **label_fn(k, grp),
            "n": float(len(grp)), "won": float(len(won)),
            "win_rate": round(len(won) / len(grp) * 100, 1) if len(grp) else None,
            "med_days_won": r1(med(won["days"])), "avg_days_won": r1(fnum(won["days"]).mean()) if won["days"].notna().any() else None,
            "med_days_lost": r1(med(lost["days"])),
            "lo": round(float(grp["score"].min()), 1), "hi": round(float(grp["score"].max()), 1),
        })
    return rows

def deal_table(o):
    if len(o) < 20:
        return None
    o = o.copy()
    o["dec"] = pd.qcut(o["score"].rank(method="first"), 10, labels=False) + 1
    deciles = bucket_rows(o, "dec", lambda k, g: {"dec": int(k)})
    o["lvl"] = pd.cut(o["score"], [-0.001, 30, 70, 10 ** 9], labels=["Low (0–30)", "Medium (31–70)", "High (71+)"])
    levels = bucket_rows(o, "lvl", lambda k, g: {"level": str(k)})
    x = [d["dec"] for d in deciles]
    y = [d["win_rate"] for d in deciles]
    r = float(np.corrcoef(x, y)[0, 1]) if len(deciles) > 2 else None
    return {"deciles": deciles, "levels": levels, "n": float(len(o)), "win_rate": round(float(o["won"].mean() * 100), 1), "r_win": None if r is None or np.isnan(r) else round(r, 2)}

OPP = None
DEALS = None
opp_frame = None
if opp is not None and not ONLY_ACTIVITY:
    opp_frame = opp_level_frame(opp, "Opportunity engagement")
if opp_frame is not None and stages is not None and opp_frame["amount"].isna().all() and has(stages, "opportunity_amount") and has(stages, "opportunity_crm_id"):
    amounts = stages.drop_duplicates("opportunity_crm_id").set_index(stages.drop_duplicates("opportunity_crm_id")["opportunity_crm_id"].astype(str))["opportunity_amount"]
    opp_frame["amount"] = fnum(opp_frame["id"].map(amounts))
if opp_frame is None and stages is not None and not ONLY_ACTIVITY:
    opp_frame = opp_level_frame(stages, "Closed deals by stage")
    if opp_frame is not None:
        notes.append("Deal engagement computed from the closed-deals-by-stage file (no separate opportunity engagement file): win rates by decile and level are exact; cycle times are unavailable.")
if opp_frame is not None and len(opp_frame) >= 20:
    has_days = opp_frame["days"].notna().any()
    if has_days:
        opp_frame["transactional"] = opp_frame["days"] <= 7
    else:
        opp_frame["transactional"] = False
        notes.append("No creation dates, so transactional (≤7 day) deals cannot be separated and velocity is unavailable.")
    types = ["All (excl. renewals)"] + [t for t, n in opp_frame["type"].value_counts().items() if n >= 20][:6]
    OPP = {}
    for t in types:
        if t == "All (excl. renewals)":
            sub = opp_frame[~opp_frame["type"].str.lower().str.contains("renewal", na=False)]
        else:
            sub = opp_frame[opp_frame["type"] == t]
        excl = deal_table(sub[~sub["transactional"]])
        incl = deal_table(sub) if has_days else excl
        if excl and incl:
            OPP[t] = {"excl": excl, "incl": incl}
    if not OPP:
        OPP = None
    all_excl = opp_frame[(~opp_frame["type"].str.lower().str.contains("renewal", na=False)) & (~opp_frame["transactional"])]
    won_amt = fnum(all_excl[all_excl["won"]]["amount"]).dropna()
    if len(won_amt):
        META["medWon"] = float(won_amt.median())
        capw = float(won_amt.quantile(0.95))
        META["meanWonCap"] = float(won_amt.clip(upper=capw).mean())
    META["transactionalShare"] = round(float(opp_frame["transactional"].mean() * 100), 1) if has_days else None
    META["hasVelocity"] = bool(has_days)
    # Every closed deal, column-wise and compact, so the report can slice by
    # fiscal year, quarter, close month and deal type in the browser. Deciles
    # recomputed there use the same equal-count bins over rank as deal_table.
    d_types = [t for t, n in opp_frame["type"].value_counts().items()]
    t_idx = {t: i for i, t in enumerate(d_types)}
    d_months = sorted([m for m in opp_frame["close"].dropna().unique() if isinstance(m, str)])
    m_idx = {m: i for i, m in enumerate(d_months)}
    # Encoded compact (decodeDeals in facts.ts): s = score × 10 as two base-36
    # characters, t = type as one (at most 36 types; the rarest fold into the
    # last), m = close month as two ("zz" unknown), w/x = "0"/"1" strings,
    # d = days as integers (-1 unknown).
    B36 = "0123456789abcdefghijklmnopqrstuvwxyz"
    def b36(n, width):
        n = max(0, min(int(n), 36 ** width - 1))
        out = ""
        for _ in range(width):
            out = B36[n % 36] + out
            n //= 36
        return out
    if len(d_types) > 36:
        d_types = d_types[:35] + ["Other"]
        t_idx = {t: min(i, 35) for i, t in enumerate([t for t, n in opp_frame["type"].value_counts().items()])}
    DEALS = {
        "types": d_types,
        "months": d_months,
        "n": int(len(opp_frame)),
        "s": "".join(b36(round(float(v) * 10), 2) for v in opp_frame["score"]),
        "w": "".join("1" if v else "0" for v in opp_frame["won"]),
        "d": [-1 if (v is None or np.isnan(v)) else int(round(float(v))) for v in fnum(opp_frame["days"])],
        "t": "".join(B36[t_idx.get(v, 0)] for v in opp_frame["type"]),
        "m": "".join(b36(m_idx[v], 2) if isinstance(v, str) and v in m_idx else "zz" for v in opp_frame["close"]),
        "x": "".join("1" if v else "0" for v in opp_frame["transactional"]),
    }
elif not ONLY_ACTIVITY:
    notes.append("No opportunity-level data with an engagement score — deal engagement is unavailable.")

# ---------------------------------------------------------------- ST (stages & personas)
ST = None
ACC = None
d_months_all = DEALS["months"] if DEALS else []
if stages is None or ONLY_ACTIVITY:
    if not ONLY_ACTIVITY:
        notes.append("No closed-deals-by-stage file — the stage and persona analysis is unavailable.")
else:
    s = stages.copy()
    s = s[s["activity_match_stage"].notna() & (s["activity_match_stage"].astype(str).str.lower() != "null")]
    s["stage"] = s["activity_match_stage"].astype(str).str.replace(" - ", " ", regex=False).str.strip()
    s["acts"] = fnum(s["activity_count"]).fillna(0) if has(s, "activity_count") else 1.0
    s["da"] = fnum(s["dir_above_activity_count"]).fillna(0) if has(s, "dir_above_activity_count") else 0.0
    for label, c in PERSONAS:
        s[c] = fnum(s[c]).fillna(0) if has(s, c) else 0.0
    s["id"] = s["opportunity_crm_id"].astype(str)
    w = s["opportunity_is_won"].astype(str).str.strip().str.lower()
    s["won"] = w.isin(["true", "1", "yes", "t"])
    s["type"] = s["opportunity_type"].astype(str) if has(s, "opportunity_type") else ""
    s = s[~s["type"].str.lower().str.contains("renewal", na=False)]
    s["amount"] = fnum(s["opportunity_amount"]) if has(s, "opportunity_amount") else np.nan
    s["atype"] = s["activity_type"].astype(str).str.lower() if has(s, "activity_type") else "unknown"
    opp_days = {}
    transactional = set()
    if opp_frame is not None and opp_frame["days"].notna().any():
        for _, row in opp_frame.iterrows():
            if not np.isnan(row["days"]):
                opp_days[row["id"]] = float(row["days"])
                if row["days"] <= 7:
                    transactional.add(row["id"])
    def stage_key(name):
        head = name.split(" ")[0]
        return (0, int(head)) if head.isdigit() else (1, name.lower())
    stage_names = sorted(s["stage"].unique(), key=stage_key)
    post = set(n for n in stage_names if (n.split(" ")[0].isdigit() and int(n.split(" ")[0]) >= 5) or n.lower().startswith("lost") or n.lower().startswith("closed"))
    pre_stages = [n for n in stage_names if n not in post]
    total_acts = float(s["acts"].sum()) or 1.0
    opp_won = s.drop_duplicates("id").set_index("id")["won"].to_dict()
    opp_amt = s.drop_duplicates("id").set_index("id")["amount"].to_dict()
    st_rows = []
    for n in stage_names:
        g = s[s["stage"] == n]
        acts = float(g["acts"].sum())
        won_ids = set(g[g["won"]]["id"])
        lost_ids = set(g[~g["won"]]["id"])
        wg = g[g["won"]]
        lg = g[~g["won"]]
        st_rows.append({
            "stage": n, "acts": int(acts), "opps": int(g["id"].nunique()), "share": round(acts / total_acts * 100, 1),
            "dir_above_pct": round(float(g["da"].sum()) / acts * 100, 1) if acts else 0.0,
            "persona_pct": {label: round(float(g[c].sum()) / acts * 100, 1) if acts else 0.0 for label, c in PERSONAS},
            "type_pct": {k: round(float(v) / acts * 100, 1) for k, v in g.groupby("atype")["acts"].sum().items()} if acts else {},
            "won_acts": round(float(wg["acts"].sum()) / len(won_ids), 1) if won_ids else None,
            "won_da": round(float(wg["da"].sum()) / len(won_ids), 1) if won_ids else None,
            "won_n": int(len(won_ids)),
            "lost_acts": round(float(lg["acts"].sum()) / len(lost_ids), 1) if lost_ids else None,
            "lost_da": round(float(lg["da"].sum()) / len(lost_ids), 1) if lost_ids else None,
            "lost_n": int(len(lost_ids)),
        })
    pre = s[s["stage"].isin(pre_stages) & ~s["id"].isin(transactional)]
    pre_ids = list(pd.unique(pre["id"]))
    pre_won = {i: bool(opp_won.get(i, False)) for i in pre_ids}
    def wr(ids):
        ids = list(ids)
        return round(sum(1 for i in ids if pre_won.get(i)) / len(ids) * 100, 1) if ids else None
    def med_days_won(ids):
        vals = [opp_days[i] for i in ids if pre_won.get(i) and i in opp_days]
        return round(float(np.median(vals)), 1) if vals else None
    def med_amt(ids):
        vals = [opp_amt[i] for i in ids if i in opp_amt and not (isinstance(opp_amt[i], float) and np.isnan(opp_amt[i]))]
        return round(float(np.median(vals)), 1) if vals else None
    per_persona = {}
    for label, c in PERSONAS:
        per_persona[label] = pre.groupby("id")[c].sum()
    won_pre = [i for i in pre_ids if pre_won.get(i)]
    personas_rows = []
    for label, c in PERSONAS:
        counts = per_persona[label]
        with_ids = [i for i in pre_ids if counts.get(i, 0) > 0]
        without_ids = [i for i in pre_ids if counts.get(i, 0) <= 0]
        wr_with = wr(with_ids)
        wr_without = wr(without_ids)
        personas_rows.append({
            "persona": label, "wr_with": wr_with, "wr_without": wr_without,
            "lift_pts": round(wr_with - wr_without, 1) if wr_with is not None and wr_without is not None else None,
            "prevalence": round(len(with_ids) / len(pre_ids) * 100, 1) if pre_ids else None,
            "won_share": round(sum(1 for i in with_ids if pre_won.get(i)) / len(won_pre) * 100, 1) if won_pre else None,
            "days_with": med_days_won(with_ids), "days_without": med_days_won(without_ids),
            "amt_with": med_amt(with_ids), "amt_without": med_amt(without_ids),
        })
    early_stages = pre_stages[:2]
    late_stages = pre_stages[2:4] if len(pre_stages) >= 4 else pre_stages[-2:]
    late_ids = set(pre[pre["stage"].isin(late_stages)]["id"])
    early = pre[pre["stage"].isin(early_stages)]
    surv = []
    for label, c in [("Any activity", "acts")] + PERSONAS:
        e_counts = early.groupby("id")[c].sum()
        early_ids = [i for i in late_ids if e_counts.get(i, 0) > 0]
        no_ids = [i for i in late_ids if e_counts.get(i, 0) <= 0]
        a_ = wr(early_ids)
        b_ = wr(no_ids)
        surv.append({"persona": label, "wr_early": a_, "wr_no_early": b_, "n_early": len(early_ids), "n_no": len(no_ids), "lift": round(a_ - b_, 1) if a_ is not None and b_ is not None else None})
    breadth_k = {}
    for i in pre_ids:
        k = sum(1 for label, c in PERSONAS if per_persona[label].get(i, 0) > 0)
        breadth_k.setdefault(min(k, 6), []).append(i)
    breadth = [{"k": k, "n": len(ids), "win_rate": wr(ids), "med_days_won": med_days_won(ids)} for k, ids in sorted(breadth_k.items())]
    early_tot = early.groupby("id")["acts"].sum()
    # Quintiles among deals that had early activity at all: a deal with none
    # is the transactional / late-entry case, not a low-intensity one.
    eq_series = pd.Series({i: float(early_tot.get(i, 0)) for i in pre_ids})
    eq_series = eq_series[eq_series > 0]
    early_q = []
    if len(eq_series) >= 25:
        q = pd.qcut(eq_series.rank(method="first"), 5, labels=False)
        for qi in range(5):
            ids = list(eq_series[q == qi].index)
            vals = eq_series[q == qi]
            early_q.append({"q": ["Q1 lowest", "Q2", "Q3", "Q4", "Q5 highest"][qi], "lo": int(vals.min()), "hi": int(vals.max()), "n": len(ids), "win_rate": wr(ids), "med_days_won": med_days_won(ids)})
    # Stage × persona cells: per (stage, won, deal type, close month), the
    # deals present, their activities, each persona's activities and how
    # many of those deals had the persona at all. The report filters these
    # by fiscal year, quarter and deal type, and draws the heatmap (won and
    # lost averages, the difference, the win rate when the persona is
    # present), win rate by stage and the won/lost persona lines from them.
    s["close"] = pd.to_datetime(s["opportunity_close_date"], errors="coerce").dt.strftime("%Y-%m") if has(s, "opportunity_close_date") else None
    pcols = [c for label, c in PERSONAS]
    per = s.groupby(["id", "stage"], sort=False).agg(**{"acts": ("acts", "sum"), **{c: (c, "sum") for c in pcols}}).reset_index()
    first = s.drop_duplicates("id").set_index("id")
    per["won"] = per["id"].map(first["won"]).fillna(False)
    per["type"] = per["id"].map(first["type"]).fillna("")
    per["close"] = per["id"].map(first["close"]) if has(s, "opportunity_close_date") else None
    c_types = sorted([t for t in per["type"].unique() if isinstance(t, str)])
    # Close months outside the analysis window (stray far-future dates in
    # CRM data) are kept in the totals but carry no month, so they never
    # become a fiscal year of their own.
    if has(s, "opportunity_close_date"):
        lo_c = months[0] if activity is not None else (d_months_all[0] if d_months_all else None)
        hi_c = months[-1] if activity is not None else (d_months_all[-1] if d_months_all else None)
        if lo_c and hi_c:
            per["close"] = per["close"].where(per["close"].between(lo_c, hi_c))
    c_months = sorted([m for m in per["close"].dropna().unique() if isinstance(m, str)]) if has(s, "opportunity_close_date") else []
    st_idx = {n: i for i, n in enumerate(stage_names)}
    ct_idx = {t: i for i, t in enumerate(c_types)}
    cm_idx = {m: i for i, m in enumerate(c_months)}
    per["st_i"] = per["stage"].map(st_idx)
    per["t_i"] = per["type"].map(ct_idx).fillna(0)
    per["m_i"] = per["close"].map(cm_idx).fillna(-1) if c_months else -1
    per["w_i"] = per["won"].astype(int)
    for c in pcols:
        per["has_" + c] = (per[c] > 0).astype(int)
    agg_spec = {"n": ("id", "count"), "acts": ("acts", "sum")}
    for c in pcols:
        agg_spec["s_" + c] = (c, "sum")
        agg_spec["h_" + c] = ("has_" + c, "sum")
    cells_df = per.groupby(["st_i", "w_i", "t_i", "m_i"]).agg(**agg_spec).reset_index()
    cells = []
    for _, r in cells_df.iterrows():
        cells.append([int(r["st_i"]), int(r["w_i"]), int(r["t_i"]), int(r["m_i"]), int(r["n"]), round(float(r["acts"]), 1)]
            + [round(float(r["s_" + c]), 1) for c in pcols] + [int(r["h_" + c]) for c in pcols])
    # Accounts: deal engagement per account (non-renewal closed deals), the
    # report's account-level view — win rate against average engagement.
    ACC = None
    acct_c = "account_name" if has(s, "account_name") else None
    score_c = "opportunity_engagement_level" if has(s, "opportunity_engagement_level") else None
    if acct_c:
        o2 = s.drop_duplicates("id")[["id", acct_c, "won"] + ([score_c] if score_c else [])].copy()
        o2["acct"] = o2[acct_c].astype(str).str.strip()
        o2["eng"] = fnum(o2[score_c]) if score_c else np.nan
        o2["days"] = o2["id"].map(opp_days) if opp_days else np.nan
        acts_by_opp = s.groupby("id").agg(**{"acts": ("acts", "sum"), **{c: (c, "sum") for c in pcols}})
        o2 = o2.join(acts_by_opp, on="id")
        o2 = o2[(o2["acct"] != "") & (o2["acct"].str.lower() != "nan")]
        counts = o2.groupby("acct")["id"].count()
        keep_accts = list(counts[counts >= 2].sort_values(ascending=False).index[:300])
        rows = []
        for acct in keep_accts:
            g = o2[o2["acct"] == acct]
            n = len(g)
            acts = float(g["acts"].sum())
            rows.append({
                "account": acct, "opps": int(n), "won": int(g["won"].sum()),
                "win_rate": round(float(g["won"].mean() * 100), 1),
                "eng": r1(fnum(g["eng"]).mean()) if score_c else None,
                "days": r1(med(g["days"])) if opp_days else None,
                "acts": int(acts), "exec": int(g["executive_activity_count"].sum()), "vp": int(g["vp_activity_count"].sum()), "dir": int(g["director_activity_count"].sum()),
                "depth": round(acts / n, 1) if n else None,
                "breadth": int(sum(1 for c in pcols if float(g[c].sum()) > 0)),
            })
        if rows:
            ACC = {"accounts": rows, "nAccounts": int(o2["acct"].nunique()), "nShown": len(rows)}
    ST = {
        "cells": cells,
        "cellTypes": c_types,
        "cellMonths": c_months,
        "personaKeys": [label for label, c in PERSONAS],
        "stages": st_rows,
        "personas": personas_rows,
        "surv": surv,
        "breadth": breadth,
        "early_q": early_q,
        "base": {"n_opps": int(s["id"].nunique()), "n_pre": len(pre_ids), "wr_pre": wr(pre_ids)},
        "n_late": len(late_ids),
        "earlyStages": early_stages,
        "lateStages": late_stages,
        "postStages": sorted(post, key=stage_key),
        "cycleMatch": round(sum(1 for i in pre_ids if i in opp_days) / len(pre_ids) * 100, 1) if pre_ids and opp_days else None,
    }

return {"U": U, "OPP": OPP, "DEALS": DEALS, "ST": ST, "ACC": ACC, "META": META, "notes": notes}
`

export type RoiUser = {
  /** Adoption tier (High/Medium/Low) or null. */
  t: string | null
  /** User / Non-user, or null without a usage file. */
  f: string | null
  /** Team. */
  g: string
  /** Full name, title or CRM role, and role group (best effort) — newer facts only. */
  n?: string
  ti?: string
  r?: string
  /** Usage detail: usage score, account and opportunity views, last active day. */
  u?: { ev: number; a: number | null; o: number | null; last: string | null }
  /**
   * Readout facts (see ./readout-import.ts) hold group rows, not reps: the
   * whole team, each adoption cohort, each role. `k` says which, `w` how many
   * reps the row stands for — averages weight rows by it.
   */
  k?: 'org' | 'cohort' | 'role'
  w?: number
}

/**
 * What a value readout carries that per-rep and per-deal facts would compute:
 * the roster as the readout reports it (window totals), whole-team meeting
 * channels, deal outcomes by month, fiscal year, decile and type, and the
 * stage × persona tables. Present only on facts imported from a readout.
 */
export type RoiReadoutAgg = {
  source: 'readout'
  /** Active users in scope. */
  reps: number
  roster: Array<{ n: string; ti: string; r: string; t: string | null; f: 'User' | 'Non-user'; ev: number | null; a: number | null; o: number | null; last: string | null; meetings: number | null; emails: number | null; vp: number | null; exec: number | null; pipeline: number | null }>
  /** Whole-team monthly series the cohort rows lack (meeting channels, emails received). */
  org: Record<string, Array<number | null>>
  /**
   * The readout's own cohort comparisons: per-rep totals over its last 6 and
   * 12 months (quiet months count), by cohort (High, Medium, Low, Non-user,
   * User). Cohort views over those windows use them, so they match the readout.
   */
  cohortWindows?: Record<'l6' | 'l12', Record<string, Record<string, number | null>>>
  fys: string[]
  types: string[]
  deals: {
    monthly: Array<{ m: string; fy: string; fq: string; l: number; t: string; n: number; won: number; vel: number | null }>
    fy: Array<{ fy: string; l: number; t: string; n: number; won: number; vel: number | null }>
    decileFy: Array<{ fy: string; dec: number; t: string; n: number; won: number; vel: number | null; eng: number | null }>
  }
  stages: {
    /** The deal stages the stage views draw, in order. */
    order: string[]
    personas: string[]
    wr: Array<{ stage: string; n: number; won: number }>
    wrFy: Array<{ fy: string; stage: string; t: string; n: number; won: number }>
    /** Average activities per deal with each persona (personas order), won and lost, by stage. */
    persona: Array<{ stage: string; won: boolean; n: number; p: number[] }>
    personaFy: Array<{ fy: string; stage: string; won: boolean; n: number; p: number[] }>
    /** [persona][stage] in order: average activities on won / lost deals, won − lost, win rate when present (%). */
    heat: { won: Array<Array<number | null>>; lost: Array<Array<number | null>>; diff: Array<Array<number | null>>; wr: Array<Array<number | null>> }
  }
}

/**
 * Every closed deal, column-wise and encoded compact (see the prep; decode
 * with decodeDeals in facts.ts). Absent from facts computed before the ROI page.
 */
export type RoiDeals = {
  types: string[]
  months: string[]
  n: number
  /** Engagement score × 10, two base-36 characters per deal. */
  s: string
  /** Won "1" / lost "0", one character per deal. */
  w: string
  /** Days from creation to close, -1 when unknown. */
  d: number[]
  /** Index into types, one base-36 character per deal. */
  t: string
  /** Index into months (close month), two base-36 characters per deal, "zz" unknown. */
  m: string
  /** Transactional (closed within 7 days), "1"/"0". */
  x: string
}

/** A rep × month matrix: rows of months (null = no activity), or the prep's compact string. */
export type RoiMatrix = Array<Array<number | null>> | string

export type RoiAccountRow = { account: string; opps: number; won: number; win_rate: number; eng: number | null; days: number | null; acts: number; exec: number; vp: number; dir: number; depth: number | null; breadth: number }

export type RoiFacts = {
  U: {
    months: string[]
    users: RoiUser[]
    m: Record<string, RoiMatrix>
    /** Breakdown matrices (director, in-person, conference, received) and their labels. */
    mx?: Record<string, RoiMatrix>
    mxLabels?: Record<string, string>
    labels: Record<string, string>
    tierCuts: number[]
    nUsage: number
    nBottom: number
    hasUsage: boolean
    usageRecords: number
    moneyKeys?: string[]
    activityColumns?: string[]
  } | null
  OPP: Record<string, { excl: DealTable; incl: DealTable }> | null
  DEALS?: RoiDeals | null
  ACC?: { accounts: RoiAccountRow[]; nAccounts: number; nShown: number } | null
  ST: {
    /** [stage, won, type, month, deals, activities, ...persona activities, ...deals with persona] — see the prep. */
    cells?: number[][]
    cellTypes?: string[]
    cellMonths?: string[]
    personaKeys?: string[]
    stages: Array<Record<string, unknown> & { stage: string; share: number; dir_above_pct: number; won_acts: number | null; lost_acts: number | null; won_n: number; lost_n: number }>
    personas: Array<{ persona: string; wr_with: number | null; wr_without: number | null; lift_pts: number | null; prevalence: number | null; won_share: number | null; days_with: number | null; days_without: number | null; amt_with: number | null; amt_without: number | null }>
    surv: Array<{ persona: string; wr_early: number | null; wr_no_early: number | null; n_early: number; n_no: number; lift: number | null }>
    breadth: Array<{ k: number; n: number; win_rate: number | null; med_days_won: number | null }>
    early_q: Array<{ q: string; lo: number; hi: number; n: number; win_rate: number | null; med_days_won: number | null }>
    base: { n_opps: number; n_pre: number; wr_pre: number | null }
    n_late: number
    earlyStages: string[]
    lateStages: string[]
    postStages: string[]
    cycleMatch: number | null
  } | null
  META: { capP?: number; capPO?: number; medWon?: number; meanWonCap?: number; transactionalShare?: number | null; hasVelocity?: boolean }
  notes: string[]
  /** Facts imported from a value readout (aggregates, not reps and deals). */
  AGG?: RoiReadoutAgg | null
}

export type DealTable = {
  /** `avg_days` (every closed deal) appears on readout tables, which carry no won/lost medians. */
  deciles: Array<{ dec: number; n: number; won: number; win_rate: number | null; med_days_won: number | null; avg_days_won: number | null; med_days_lost: number | null; avg_days?: number | null; lo: number; hi: number }>
  levels: Array<{ level: string; n: number; won: number; win_rate: number | null; med_days_won: number | null; avg_days_won: number | null; med_days_lost: number | null; avg_days?: number | null; lo: number; hi: number }>
  n: number
  win_rate: number
  r_win: number | null
}

/** Run the prep over the mounted datasets. Minutes, not seconds, on a real extract. */
export async function runRoiPrep(datasets: CodeDataset[], options: { extraMetrics?: Array<{ key: string; label: string; columns: string[]; format?: string }>; onlyActivity?: boolean } = {}): Promise<RoiFacts> {
  const { output } = await runFlowCode({
    language: 'python',
    mode: 'all',
    analysis: true,
    datasets,
    code: ROI_PREP_CODE,
    input: { extraMetrics: options.extraMetrics ?? [], onlyActivity: options.onlyActivity === true },
    timeoutMs: DATASET_TIMEOUT_MAX_MS,
  })
  const facts = output as RoiFacts
  if (!facts || typeof facts !== 'object') throw new Error('The ROI prep returned nothing.')
  if (!facts.U && !facts.OPP && !facts.ST && !options.onlyActivity) {
    throw new Error(`None of the datasets could be used: ${(facts.notes ?? []).join(' ')}`)
  }
  return facts
}

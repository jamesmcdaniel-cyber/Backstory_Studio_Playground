/**
 * A small value readout with the shape of Backstory's own (the "Value
 * Readout · People.ai" page), made up from scratch: the real one names real
 * people. Its DATA is JavaScript, NaN included.
 */
const MONTHS = ['2025-08', '2025-09', '2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07']
const fyOf = (m: string) => { const y = Number(m.slice(0, 4)); const mo = Number(m.slice(5, 7)); return `FY${mo >= 2 ? y + 1 : y}` }
const fqOf = (m: string) => `FQ${Math.floor(((Number(m.slice(5, 7)) - 2 + 12) % 12) / 3) + 1}`
const STAGES = ['0 - Qualification', '1 - Discovery', '2 - Scoping', '3 - Validation', '4 - Proposal', '5 - Negotiation', '6 - Closing', '7 - Pending Closed Won']
const P = ['executive_activity_count', 'vp_activity_count', 'director_activity_count', 'finance_activity_count', 'it_activity_count', 'eng_activity_count']

export function readoutData() {
  const metrics = (base: number, i: number) => ({ meeting_count: base + i, sent_email_count: 3 * base + i, director_meeting_count: base / 2, vp_meeting_count: base / 4, executive_meeting_count: base / 10, pipeline_created: base * 1000 + i * 100, received_email_count: 2 * base })
  const cohortBase: Record<string, number> = { High: 30, Medium: 20, Low: 12, 'Non-User': 8 }
  const roleBase: Record<string, number> = { AE: 25, 'CS/PS': 15, Leadership: 18 }
  const levels = [['High', 0.6, 300, 40], ['Medium', 0.4, 280, 30], ['Low', 0.1, 360, 60]] as const
  return {
    monthly_activity: MONTHS.map((m, i) => ({ month: m, fy: fyOf(m), fq: fqOf(m), ...metrics(18, i), in_person_meeting_count: 2, conference_call_count: 16 + i })),
    monthly_trend: MONTHS.map((m, i) => ({ months: m, ...metrics(18, i) })),
    cohort_monthly: Object.keys(cohortBase).flatMap((cohort) => MONTHS.map((m, i) => ({ month_str: m, fy: fyOf(m), fq: fqOf(m), cohort, ...metrics(cohortBase[cohort], i) }))),
    role_monthly: Object.keys(roleBase).flatMap((role) => MONTHS.map((m, i) => ({ month_str: m, fy: fyOf(m), fq: fqOf(m), role, ...metrics(roleBase[role], i) }))),
    cohort_sizes: { High: 3, Medium: 3, Low: 2, 'Non-User': 2 },
    cohort_l6: { High: { meeting_count: 180, sent_email_count: 540, director_meeting_count: 90, vp_meeting_count: 60, executive_meeting_count: 12, pipeline_created: 300000 }, Medium: { meeting_count: 120, sent_email_count: 360, director_meeting_count: 60, vp_meeting_count: 30, executive_meeting_count: 12, pipeline_created: 120000 }, Low: { meeting_count: 72, sent_email_count: 216, director_meeting_count: 36, vp_meeting_count: 18, executive_meeting_count: 6, pipeline_created: 0 }, 'Non-User': { meeting_count: 60, sent_email_count: 60, director_meeting_count: 20, vp_meeting_count: 6, executive_meeting_count: 3, pipeline_created: 0 } },
    cohort_l12: { High: { meeting_count: 360, sent_email_count: 1080, director_meeting_count: 180, vp_meeting_count: 120, executive_meeting_count: 24, pipeline_created: 600000 } },
    user_l6: { User: { meeting_count: 130, sent_email_count: 400, director_meeting_count: 66, vp_meeting_count: 40, executive_meeting_count: 10, pipeline_created: 150000 }, 'Non-User': { meeting_count: 60, sent_email_count: 60, director_meeting_count: 20, vp_meeting_count: 6, executive_meeting_count: 3, pipeline_created: 0 } },
    user_l12: {},
    user_list: [
      { email: 'ada@example.com', full_name: 'Ada Example', title: 'Account Executive', function: 'Sales', total_events: 900, account_visits: 700, opp_visits: 200, last_active: '2026-07-20', cohort: 'High', meetings: 60, sent_emails: 300, vp_meetings: 20, exec_meetings: 4, pipeline: 120000 },
      { email: 'bo@example.com', full_name: 'Bo Example', title: 'Customer Success Manager', function: 'CS/PS', total_events: 500, account_visits: 400, opp_visits: 100, last_active: '2026-07-01', cohort: 'High', meetings: 50, sent_emails: 200, vp_meetings: 10, exec_meetings: 2, pipeline: 0 },
      { email: 'cy@example.com', full_name: 'Cy Example', title: 'VP, Sales', function: 'Sales', total_events: 300, account_visits: 200, opp_visits: 100, last_active: '2026-06-11', cohort: 'Medium', meetings: 40, sent_emails: 100, vp_meetings: 12, exec_meetings: 5, pipeline: 60000 },
      { email: 'di@example.com', full_name: 'Di Example', title: 'Account Executive', function: 'Sales', total_events: 120, account_visits: 100, opp_visits: 20, last_active: '2026-05-02', cohort: 'Low', meetings: 20, sent_emails: 60, vp_meetings: 4, exec_meetings: 1, pipeline: 0 },
      { email: 'ed@example.com', full_name: 'Ed Example', title: 'Engagement Manager', function: 'CS/PS', total_events: 0, account_visits: 0, opp_visits: 0, last_active: 'NaN-marker', cohort: 'Non-User', meetings: 10, sent_emails: 10, vp_meetings: 1, exec_meetings: 0, pipeline: 0 },
    ],
    acct_list_v2: [
      { account_name: 'Globex', total_opps: 6, won: 3, win_rate: 0.5, avg_engagement: 62.5, avg_velocity: 210.4, total_activity: 900, exec_activity: 90, vp_activity: 200, dir_activity: 300, depth: 150, breadth: 7 },
      { account_name: 'Initech', total_opps: 4, won: 1, win_rate: 0.25, avg_engagement: 20.1, avg_velocity: 400, total_activity: 100, exec_activity: 2, vp_activity: 10, dir_activity: 30, depth: 25, breadth: 3 },
    ],
    level_stats: levels.map(([level, win_rate, avg_velocity, count]) => ({ level, win_rate, avg_velocity, count, avg_engagement: level === 'High' ? 90 : level === 'Medium' ? 50 : 10 })),
    decile_stats: Array.from({ length: 10 }, (_, k) => ({ decile: `D${k + 1}`, win_rate: 0.05 + k * 0.06, avg_velocity: 400 - k * 10, count: 13, avg_engagement: 5 + k * 10 })),
    opp_monthly_wr: MONTHS.flatMap((m) => levels.flatMap(([level, wr]) => ['New Business', 'Customer Renewal'].map((type) => ({ close_month: m, fy: fyOf(m), fq: fqOf(m), eng_level: level, opportunity_type: type, deals: 2, won: Math.round(2 * wr), avg_vel: 300, win_rate: Math.round(2 * wr) / 2 })))),
    opp_fy_wr: ['FY2026', 'FY2027'].flatMap((fy) => levels.flatMap(([level, wr, vel]) => ['New Business', 'Customer Renewal'].map((type) => ({ fy, eng_level: level, opportunity_type: type, deals: 12, won: Math.round(12 * wr), avg_vel: vel, avg_eng: 50, win_rate: Math.round(12 * wr) / 12 })))),
    decile_fy: ['FY2026', 'FY2027'].flatMap((fy) => Array.from({ length: 10 }, (_, k) => ['New Business', 'Customer Renewal'].map((type) => ({ fy, decile: `D${k + 1}`, opportunity_type: type, deals: 3, won: k > 4 ? 2 : 0, avg_vel: 300, avg_eng: 5 + k * 10, win_rate: k > 4 ? 0.667 : 0 }))).flat()),
    stage_wr: [...STAGES, 'Closed Won'].map((stage, i) => ({ activity_match_stage: stage, total: 60 - i * 4, won: 10 + i * 3, win_rate: (10 + i * 3) / (60 - i * 4) })),
    stage_wr_fy: ['FY2026', 'FY2027'].flatMap((fy) => STAGES.map((stage, i) => ({ fy, activity_match_stage: stage, opportunity_type: 'New Business', total: 30, won: fy === 'FY2026' ? 8 + i : 6 + i * 2, win_rate: 0 }))),
    persona_by_stage: STAGES.flatMap((stage, i) => [true, false].map((won) => ({ activity_match_stage: stage, opportunity_is_won: won, opps: won ? 10 : 20, exec: won ? 5 + i : 2, vp: won ? 10 : 4, director: 20 - i, finance: 1, it: 3, eng: 4 }))),
    persona_by_stage_fy: [],
    heatmap_won: Object.fromEntries(STAGES.map((stage, i) => [stage, Object.fromEntries(P.map((p, k) => [p, 10 + i + k]))])),
    heatmap_lost: Object.fromEntries(STAGES.map((stage) => [stage, Object.fromEntries(P.map((p) => [p, 5]))])),
    heatmap_diff: Object.fromEntries(STAGES.map((stage, i) => [stage, Object.fromEntries(P.map((p, k) => [p, 5 + i + k]))])),
    heatmap_wr_pct: Object.fromEntries(STAGES.map((stage, i) => [stage, Object.fromEntries(P.map((p, k) => [p, Math.min(0.95, 0.1 + i * 0.1 + k * 0.01)]))])),
    available_fys: ['FY2026', 'FY2027'],
    available_opp_types: ['New Business', 'Customer Renewal'],
    findings: { total_active_users: 5, backstory_users: 4, pipeline_high: 300000 },
    findings_yoy: { eng_yoy: { Low: { FY2026: { win_rate: 0.13, deals: 40 }, FY2027: { win_rate: 0.08, deals: 30 } } } },
  }
}

/** The page: hero line, then the data as JavaScript (with a NaN, a brace inside a string). */
export function readoutHtml(headline = 'Engaged deals win and users build pipeline.', data: unknown = readoutData()): string {
  const json = JSON.stringify(data).replace('"NaN-marker"', 'NaN').replace('"Globex"', '"Globex {Corp}"')
  return `<!DOCTYPE html><html><body><div class="hero-hl">${headline}</div><script>\nconst DATA = ${json};\nconst F = DATA.findings;\n</script></body></html>`
}

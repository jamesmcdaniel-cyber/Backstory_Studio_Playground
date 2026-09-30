/**
 * The Account 360 ROI dashboard: the HP Account 360 ROI suite as a template.
 *
 * The page is the original suite — three tabs, month-range sliders, cohort
 * charts, the account table — with its data bundle, its per-run text (account,
 * windows, cutoffs, counts) and its callouts driven by the prep's output
 * rather than written in. Everything a timeframe changes is recomputed in the
 * page from the per-month arrays, so one render serves every range.
 *
 * Styled to the Backstory brand (Graphite masthead, Cardo/Roboto/Chivo Mono,
 * the brand's data hues). Chart.js comes from the platform's own copy; the
 * CDN URL here is rewritten when the page is served (vendor-scripts.ts).
 */

import type { Account360Facts } from './prep'

function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** JSON for a <script> block: no sequence in the data can close the tag. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value ?? null).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTH_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

function monthLabel(key: string): string {
  const [year, month] = key.split('-')
  return `${MONTH_NAMES[Number(month) - 1] ?? month} ${year}`
}

function monthLabelLong(key: string): string {
  const [year, month] = key.split('-')
  return `${MONTH_LONG[Number(month) - 1] ?? month} ${year}`
}

function dayLabel(iso: string): string {
  const [year, month, day] = iso.split('-')
  return `${MONTH_NAMES[Number(month) - 1] ?? month} ${Number(day)}, ${year}`
}

function money(value: number): string {
  const abs = Math.abs(value)
  if (abs >= 1e9) return `$${(abs / 1e9).toFixed(2)}B`
  if (abs >= 1e6) return `$${(abs / 1e6).toFixed(1)}M`
  if (abs >= 1e3) return `$${(abs / 1e3).toFixed(0)}K`
  return `$${abs.toFixed(0)}`
}

export type Account360DashboardOptions = {
  account: string
  generatedAt?: string
  /** One or two sentences from the analyst, shown under the title. */
  lede?: string
}

const STYLE = `
:root{
  --navy:#171721; --accent:#447C93; --accent-subtle:#DBEBF2; --surface:#F5F5F5;
  --c-power:#275198; --c-browser:#5BA779; --c-digger:#C05527; --c-light:#B08FA2; --c-none:#BBBCBC;
  --bg:#FFFFFF; --card:#FFFFFF; --text:#171721; --muted:#55555E; --border:#E3E3E5; --green:#3F7F58;
  --serif:'Cardo','LL Kleisch',Georgia,serif;
  --sans:'KMR Waldenburg','Roboto',system-ui,-apple-system,'Segoe UI',Arial,sans-serif;
  --mono:'Chivo Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
*{box-sizing:border-box;}
body{margin:0;font-family:var(--sans);background:var(--bg);color:var(--text);}
.wrap{max-width:1360px;margin:0 auto;padding:24px 26px 56px;}

.suite-header{margin:0 -26px 14px;padding:22px 26px 20px;background:var(--navy);color:#fff;border-radius:0 0 12px 12px;}
.suite-header h1{margin:0 0 6px;font-family:var(--serif);font-weight:400;font-size:30px;letter-spacing:-0.5px;color:#fff;}
.suite-header p{margin:0;color:#BBBCBC;font-size:13.5px;max-width:960px;}
.suite-header .lede{margin-top:10px;color:#fff;font-size:15px;}

.tab-bar{display:flex;gap:6px;margin:16px 0 18px;border-bottom:2px solid var(--navy);flex-wrap:wrap;}
.tab-btn{background:none;border:none;padding:10px 18px;font-size:14px;font-weight:600;color:var(--muted);cursor:pointer;border-radius:8px 8px 0 0;transition:all .15s;}
.tab-btn:hover{color:var(--navy);background:var(--accent-subtle);}
.tab-btn.active{color:#fff;background:var(--navy);}
.tab-panel{display:none;}
.tab-panel.active{display:block;}

header.section-header{margin-bottom:16px;padding-bottom:14px;border-bottom:1px solid var(--border);}
header.section-header h2{margin:0 0 5px;font-size:20px;color:var(--navy);}
header.section-header p{margin:0;color:var(--muted);font-size:13.5px;max-width:900px;}

/* ---- Month range slider ---- */
.month-slider{background:#fff;border:1px solid var(--border);border-radius:10px;padding:14px 20px 16px;margin-bottom:18px;}
.ms-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:8px;}
.ms-title{font-size:13px;font-weight:700;color:var(--navy);}
.ms-title span{font-weight:400;color:var(--muted);}
.ms-range-label{font-size:13px;font-weight:700;color:var(--navy);background:var(--accent-subtle);padding:4px 12px;border-radius:20px;}
.ms-track-wrap{position:relative;height:24px;margin:0 9px;}
.ms-track{position:absolute;top:10px;left:0;right:0;height:5px;background:var(--border);border-radius:3px;}
.ms-track-highlight{position:absolute;top:10px;height:5px;background:var(--navy);border-radius:3px;}
input.ms-range{position:absolute;width:100%;top:0;left:0;margin:0;height:24px;background:transparent;-webkit-appearance:none;appearance:none;pointer-events:none;}
input.ms-range::-webkit-slider-thumb{-webkit-appearance:none;pointer-events:auto;width:18px;height:18px;border-radius:50%;background:var(--navy);border:3px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,0.35);cursor:pointer;}
input.ms-range::-moz-range-thumb{pointer-events:auto;width:18px;height:18px;border-radius:50%;background:var(--navy);border:3px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,0.35);cursor:pointer;}
input.ms-range::-webkit-slider-runnable-track{background:transparent;height:24px;}
input.ms-range::-moz-range-track{background:transparent;height:24px;}
.ms-ticks{display:flex;justify-content:space-between;margin:8px 9px 0;font-size:10.5px;color:var(--muted);}

.filters select{padding:8px 12px;border-radius:8px;border:1px solid var(--border);background:#fff;font-size:13.5px;color:var(--text);cursor:pointer;}
.header-row{display:flex;justify-content:space-between;align-items:flex-end;flex-wrap:wrap;gap:16px;}

.kpi-row{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:20px;}
.kpi-card,.callout{background:linear-gradient(180deg,#fff,#FAFAFA);border:1px solid var(--border);border-left:4px solid var(--navy);border-radius:10px;padding:14px 16px;box-shadow:0 1px 3px rgba(23,23,33,0.05);}
.kpi-card .kpi-label,.kpi-card .num{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px;margin-bottom:6px;}
.kpi-card .num,.kpi-card .kpi-value{font-size:22px;font-weight:800;color:var(--navy);margin-bottom:3px;}
.kpi-card .lbl,.kpi-card .kpi-sub{font-size:12px;color:var(--muted);line-height:1.4;}
.kpi-sub.good{color:var(--green);font-weight:600;}
.callout .num{font-size:22px;font-weight:800;color:var(--navy);margin-bottom:3px;}
.callout .lbl{font-size:12px;color:var(--muted);line-height:1.4;}

.section-title{font-size:18px;color:var(--navy);font-weight:700;margin:26px 0 3px;}
.section-cap{font-size:13px;color:var(--muted);margin:0 0 14px;}

.card{background:var(--card);border-radius:12px;padding:18px 20px;box-shadow:0 1px 3px rgba(23,23,33,0.06);border:1px solid var(--border);margin-bottom:16px;}
.card h3{margin:0 0 4px;font-size:15px;color:var(--navy);}
.card .cap{font-size:12px;color:var(--muted);margin:0 0 14px;}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px;}
.chart-box{position:relative;height:300px;}
.chart-box.tall{height:360px;}

.quad-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:8px;}
.quad-cell{border-radius:10px;padding:14px 16px;border:1px solid var(--border);}
.quad-cell h4{margin:0 0 4px;font-size:13.5px;}
.quad-cell p{margin:0;font-size:12px;color:var(--muted);line-height:1.4;}
.q-power{background:var(--accent-subtle);border-left:4px solid var(--c-power);}
.q-browser{background:#EAF4EE;border-left:4px solid var(--c-browser);}
.q-digger{background:#F8E9E2;border-left:4px solid var(--c-digger);}
.q-light{background:#F4EEF1;border-left:4px solid var(--c-light);}

table{width:100%;border-collapse:collapse;font-size:13px;}
th{text-align:left;padding:9px 10px;background:var(--surface);color:var(--navy);border-bottom:2px solid var(--border);font-size:11.5px;text-transform:uppercase;letter-spacing:.3px;position:sticky;top:0;}
th[data-key]{cursor:pointer;user-select:none;}
th[data-key]:hover{background:#EDEDEF;}
th.num, td.num{text-align:right;}
td{padding:8px 10px;border-bottom:1px solid var(--border);}
tr:hover td{background:#FAFAFA;}
.table-wrap{max-height:460px;overflow:auto;border-radius:8px;border:1px solid var(--border);}
.badge{display:inline-block;padding:2px 9px;border-radius:20px;font-size:11px;font-weight:700;color:#fff;white-space:nowrap;}
.b-power{background:var(--c-power);} .b-browser{background:var(--c-browser);color:var(--navy);} .b-digger{background:var(--c-digger);} .b-light{background:var(--c-light);color:var(--navy);} .b-none{background:var(--c-none);color:var(--navy);}
.rank1{background:var(--navy);color:#fff;} .rank2{background:var(--accent);color:#fff;} .rank3{background:#6397AD;color:#fff;} .rankother{background:var(--accent-subtle);color:var(--navy);}
.mono{font-family:var(--mono);font-size:12.5px;}
.swatch{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px;vertical-align:0;}
td.num,.kpi-card .num,.kpi-card .kpi-value,.callout .num{font-family:var(--mono);font-variant-numeric:tabular-nums;}
header.section-header h2,.section-title{font-family:var(--serif);font-weight:400;}
.notes{margin:18px 0 0;padding:14px 18px;background:var(--surface);border-radius:10px;font-size:12.5px;color:var(--muted);}
.notes li{margin:3px 0 3px 16px;}
footer{margin-top:26px;font-size:12px;color:var(--muted);text-align:center;}
@media(max-width:1000px){.kpi-row{grid-template-columns:1fr 1fr;} .grid2,.quad-grid{grid-template-columns:1fr;}}
`

const SCRIPT = `const MONTHS = BUNDLE.months;
const COHORT_ORDER = ["Power Users","Frequent Browsers","Focused Diggers","Light Touch","No Engagement"];
const COHORT_COLORS = {"Power Users":"#275198","Frequent Browsers":"#5BA779","Focused Diggers":"#C05527","Light Touch":"#B08FA2","No Engagement":"#BBBCBC"};
const COHORT_BADGE = {"Power Users":"b-power","Frequent Browsers":"b-browser","Focused Diggers":"b-digger","Light Touch":"b-light","No Engagement":"b-none"};

function fmtMoney(v){
  const sign = v<0 ? "-" : "";
  const a = Math.abs(v);
  if(a>=1e9) return sign+"$"+(a/1e9).toFixed(2)+"B";
  if(a>=1e6) return sign+"$"+(a/1e6).toFixed(1)+"M";
  if(a>=1e3) return sign+"$"+(a/1e3).toFixed(0)+"K";
  return sign+"$"+a.toFixed(0);
}
function fmtNum(v){ return Number(v).toLocaleString(); }
function fmtPct(v){ return (v*100).toFixed(1)+"%"; }
function monthLabel(m){
  const [y,mo] = m.split('-');
  const names = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return names[parseInt(mo,10)-1] + " '" + y.slice(2);
}

/* ---------- Callouts: written from the numbers in range, not fixed text ---------- */
function nuanceText(power, browser, digger, light){
  const freqWins = browser.avg_created >= digger.avg_created;
  const first = freqWins
    ? \`frequency beats depth on its own — Frequent Browsers (\${fmtMoney(browser.avg_created)} avg created) out-produce Focused Diggers (\${fmtMoney(digger.avg_created)}) despite clicking shallower, because they show up more often.\`
    : \`depth beats frequency on its own — Focused Diggers (\${fmtMoney(digger.avg_created)} avg created) out-produce Frequent Browsers (\${fmtMoney(browser.avg_created)}) despite logging in less.\`;
  const liftHigh = power.avg_created > browser.avg_created, liftLow = digger.avg_created > light.avg_created;
  const second = liftHigh && liftLow
    ? \`Depth still adds a consistent lift on top of frequency: Power Users out-produce Frequent Browsers at the <em>same</em> visit cadence, and Focused Diggers out-produce Light Touch at the <em>same</em> (low) cadence.\`
    : liftHigh
      ? \`Depth adds a lift among frequent visitors (Power Users over Frequent Browsers), but not among infrequent ones (Focused Diggers vs. Light Touch) in this range.\`
      : liftLow
        ? \`Depth adds a lift among infrequent visitors (Focused Diggers over Light Touch), but not among frequent ones (Power Users vs. Frequent Browsers) in this range.\`
        : \`In this range depth does not add a lift at either cadence — the accounts that go deeper do not carry more created pipeline.\`;
  return \`<strong>The nuance:</strong> \${first} \${second}\`;
}
function dayLabel(iso){
  const [y,m,d] = String(iso).split('-');
  const names = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return names[parseInt(m,10)-1] + ' ' + parseInt(d,10) + ', ' + y;
}
function trendText(labels, createdVals, powerCreated, totalCreated, hi){
  if(!labels.length) return '';
  const peak = createdVals.indexOf(Math.max(...createdVals));
  const share = totalCreated > 0 ? Math.round(powerCreated / totalCreated * 100) : 0;
  const partial = META.lastMonthPartial && hi === MONTHS.length - 1
    ? \` \${labels[labels.length - 1]} is a partial month (data through \${dayLabel(META.clickEnd)}) — treat it as directional.\` : '';
  return \`<strong>Reading the trend:</strong> \${labels[peak]} is the largest month for created pipeline in this range (\${fmtMoney(createdVals[peak])}).\${partial} Power User accounts created \${fmtMoney(powerCreated)} of it — \${share}% of the total — so compare their curve with the others' to see whether engagement holds up when creation slows. Use the slider above to zoom into any sub-range.\`;
}

/* ---------- Month range slider component ---------- */
function setupMonthSlider(prefix, onChange){
  const minEl = document.getElementById(prefix+'_sliderMin');
  const maxEl = document.getElementById(prefix+'_sliderMax');
  const labelEl = document.getElementById(prefix+'_sliderLabel');
  const highlightEl = document.getElementById(prefix+'_sliderHighlight');
  const ticksEl = document.getElementById(prefix+'_sliderTicks');
  const n = MONTHS.length;

  minEl.min = 0; minEl.max = n-1; minEl.step = 1; minEl.value = 0;
  maxEl.min = 0; maxEl.max = n-1; maxEl.step = 1; maxEl.value = n-1;
  ticksEl.innerHTML = MONTHS.map(m=>\`<span>\${monthLabel(m)}</span>\`).join('');

  function update(){
    let lo = parseInt(minEl.value,10), hi = parseInt(maxEl.value,10);
    const pct1 = n>1 ? (lo/(n-1))*100 : 0;
    const pct2 = n>1 ? (hi/(n-1))*100 : 100;
    highlightEl.style.left = pct1+'%';
    highlightEl.style.width = Math.max(pct2-pct1,0)+'%';
    labelEl.textContent = lo===hi ? monthLabel(MONTHS[lo]) : \`\${monthLabel(MONTHS[lo])} – \${monthLabel(MONTHS[hi])}\`;
    onChange(lo, hi);
  }
  minEl.addEventListener('input', ()=>{
    if(parseInt(minEl.value,10) > parseInt(maxEl.value,10)) minEl.value = maxEl.value;
    update();
  });
  maxEl.addEventListener('input', ()=>{
    if(parseInt(maxEl.value,10) < parseInt(minEl.value,10)) maxEl.value = minEl.value;
    update();
  });
  update();
  return update;
}

function computeFiltered(lo, hi){
  const accounts = BUNDLE.accounts.map(a=>{
    const created = a.created_by_month.slice(lo,hi+1).reduce((s,v)=>s+v,0);
    const closedWon = a.closed_won_by_month.slice(lo,hi+1).reduce((s,v)=>s+v,0);
    return Object.assign({}, a, {created_amount:created, closed_won_amount:closedWon});
  });
  const cohortAgg = {};
  COHORT_ORDER.forEach(c=>{
    const rows = accounts.filter(a=>a.cohort===c);
    const n = rows.length;
    const totalCreated = rows.reduce((s,a)=>s+a.created_amount,0);
    const totalClosed = rows.reduce((s,a)=>s+a.closed_won_amount,0);
    cohortAgg[c] = { cohort:c, n, total_created:totalCreated, total_closed_won:totalClosed,
      avg_created: n? totalCreated/n:0, avg_closed_won: n? totalClosed/n:0 };
  });
  const whales = accounts.filter(a=>BUNDLE.whale_names.includes(a.account)).sort((a,b)=>b.created_amount-a.created_amount);
  const darks = accounts.filter(a=>BUNDLE.dark_names.includes(a.account)).sort((a,b)=>b.created_amount-a.created_amount);
  return {accounts, cohortAgg, whales, darks};
}

function valueLabelPlugin(){
  return { id:'valueLabels', afterDatasetsDraw(chart){
    const {ctx} = chart; const meta = chart.getDatasetMeta(0);
    chart.data.datasets[0].data.forEach((val, i)=>{
      const bar = meta.data[i];
      ctx.save(); ctx.fillStyle = '#171721'; ctx.font = "500 12px 'Chivo Mono', ui-monospace, monospace"; ctx.textAlign = 'center';
      ctx.fillText(fmtMoney(val), bar.x, bar.y - 7); ctx.restore();
    });
  }};
}
function baseBarOptions(){
  return { responsive:true, maintainAspectRatio:false,
    plugins:{ legend:{display:false}, tooltip:{ callbacks:{ label:(ctx)=> fmtMoney(ctx.parsed.y) } } },
    scales:{ x:{grid:{display:false}, ticks:{font:{size:11.5}}}, y:{ beginAtZero:true, ticks:{ callback:(v)=>fmtMoney(v) } } } };
}

/* ============ TAB 1 ============ */
let tab1Init = false;
let t1CreatedChart, t1ClosedWonChart, t1Lo=0, t1Hi=MONTHS.length-1;

function renderTab1Pipeline(lo, hi){
  t1Lo=lo; t1Hi=hi;
  const {accounts, cohortAgg, whales, darks} = computeFiltered(lo, hi);
  const power = cohortAgg["Power Users"], browser = cohortAgg["Frequent Browsers"], digger = cohortAgg["Focused Diggers"], light = cohortAgg["Light Touch"], none = cohortAgg["No Engagement"];

  const gapCreated = none.avg_created>0 ? (power.avg_created/none.avg_created).toFixed(1) : "—";
  const gapClosed = none.avg_closed_won>0 ? (power.avg_closed_won/none.avg_closed_won).toFixed(1) : "—";
  const depthLiftHighVol = browser.avg_created>0 ? ((power.avg_created/browser.avg_created - 1)*100).toFixed(0) : "—";
  const depthLiftLowVol = light.avg_created>0 ? ((digger.avg_created/light.avg_created - 1)*100).toFixed(0) : "—";

  document.getElementById('t1_calloutRow').innerHTML = [
    {num: fmtMoney(power.avg_created), lbl:\`Avg pipeline CREATED per Power User account — \${gapCreated}x the \${fmtMoney(none.avg_created)} for zero-engagement accounts\`},
    {num: fmtMoney(power.avg_closed_won), lbl:\`Avg pipeline CLOSED-WON per Power User account — \${gapClosed}x the \${fmtMoney(none.avg_closed_won)} for zero-engagement accounts\`},
    {num: \`\${depthLiftHighVol}%\`, lbl:\`Created-pipeline lift from going "deep" vs. just browsing, at the SAME visit frequency (Power Users vs. Frequent Browsers)\`},
    {num: \`\${depthLiftLowVol}%\`, lbl:\`Same depth-lift shows up even among infrequent visitors (Focused Diggers vs. Light Touch)\`},
  ].map(i=>\`<div class="kpi-card"><div class="num">\${i.num}</div><div class="lbl">\${i.lbl}</div></div>\`).join('');

  const cohortsArr = COHORT_ORDER.map(c=>cohortAgg[c]);
  const colors = COHORT_ORDER.map(c=>COHORT_COLORS[c]);
  if(!t1CreatedChart){
    t1CreatedChart = new Chart(document.getElementById('t1_createdChart'), {
      type:'bar', data:{ labels: COHORT_ORDER, datasets:[{ data: cohortsArr.map(c=>c.avg_created), backgroundColor: colors, borderRadius:6, barPercentage:0.6 }]},
      options: baseBarOptions(), plugins:[valueLabelPlugin()]
    });
    t1ClosedWonChart = new Chart(document.getElementById('t1_closedWonChart'), {
      type:'bar', data:{ labels: COHORT_ORDER, datasets:[{ data: cohortsArr.map(c=>c.avg_closed_won), backgroundColor: colors, borderRadius:6, barPercentage:0.6 }]},
      options: baseBarOptions(), plugins:[valueLabelPlugin()]
    });
  } else {
    t1CreatedChart.data.datasets[0].data = cohortsArr.map(c=>c.avg_created); t1CreatedChart.update();
    t1ClosedWonChart.data.datasets[0].data = cohortsArr.map(c=>c.avg_closed_won); t1ClosedWonChart.update();
  }

  document.getElementById('t1_nuanceCallout').innerHTML = nuanceText(power, browser, digger, light);

  document.querySelector('#t1_whaleTable tbody').innerHTML = whales.map(w=>\`
    <tr><td>\${w.account}</td><td><span class="badge \${COHORT_BADGE[w.cohort]}">\${w.cohort}</span></td>
    <td class="num">\${w.unique_sessions}</td><td class="num">\${fmtMoney(w.created_amount)}</td><td class="num">\${fmtMoney(w.closed_won_amount)}</td></tr>\`).join('') || '<tr><td colspan="5" style="text-align:center;color:var(--muted);">No pipeline in this timeframe</td></tr>';

  document.querySelector('#t1_darkTable tbody').innerHTML = darks.filter(d=>d.created_amount+d.closed_won_amount>0).map(d=>\`
    <tr><td>\${d.account}</td><td class="num">\${fmtMoney(d.created_amount)}</td><td class="num">\${fmtMoney(d.closed_won_amount)}</td></tr>\`).join('') || '<tr><td colspan="3" style="text-align:center;color:var(--muted);">No pipeline in this timeframe</td></tr>';
}

function renderTab1(){
  if(tab1Init) return;
  tab1Init = true;
  setupMonthSlider('t1', renderTab1Pipeline);

  const users = BUNDLE.top_users;
  const maxSessions = Math.max(...users.map(u=>u.unique_sessions));
  new Chart(document.getElementById('t1_userBubbleChart'), {
    type:'bubble',
    data:{ datasets:[{
      label:'Users',
      data: users.map(u=>({ x:u.unique_accounts, y:u.total_events, r: 6 + (u.unique_sessions/maxSessions)*22, user:u.user, sessions:u.unique_sessions })),
      backgroundColor: users.map((u,i)=> i<2 ? '#447C93CC' : '#99C1D1AA'),
      borderColor: users.map((u,i)=> i<2 ? '#447C93' : '#6397AD'),
      borderWidth:1.5,
    }]},
    options:{ responsive:true, maintainAspectRatio:false,
      plugins:{ legend:{display:false}, tooltip:{ callbacks:{ label:(ctx)=> \`\${ctx.raw.user}: \${ctx.raw.x} accounts, \${ctx.raw.y} events, \${ctx.raw.sessions} sessions\` } } },
      scales:{
        x:{ title:{display:true, text:'Breadth — distinct accounts touched'}, beginAtZero:true, grid:{color:'#EDEDEF'} },
        y:{ title:{display:true, text:'Depth — total events logged'}, beginAtZero:true, grid:{color:'#EDEDEF'} }
      } }
  });

  document.querySelector('#t1_userTable tbody').innerHTML = users.map((u,i)=>{
    const rankClass = i===0?'rank1':i===1?'rank2':i===2?'rank3':'rankother';
    return \`<tr><td><span class="badge \${rankClass}">#\${i+1}</span></td><td class="mono">\${u.user}</td>
    <td class="num">\${u.unique_accounts}</td><td class="num">\${u.total_events}</td><td class="num">\${u.unique_sessions}</td></tr>\`;
  }).join('');

  const [u1, u2] = users;
  document.getElementById('t1_userCallout').innerHTML = \`<strong>Callout:</strong> among remaining users\${META.excludedUsers.length ? \` (\${META.excludedUsers.length} flagged users excluded)\` : ''}, <span class="mono">\${u1.user}</span> and <span class="mono">\${u2.user}</span> lead the pack — \${u1.user.split('@')[0]} touched <strong>\${u1.unique_accounts} distinct accounts</strong> (\${u1.total_events} events, \${u1.unique_sessions} sessions) and \${u2.user.split('@')[0]} touched <strong>\${u2.unique_accounts} accounts</strong> (\${u2.total_events} events, \${u2.unique_sessions} sessions).\`;
}

/* ============ TAB 2 ============ */
let tab2Init = false;
let t2CreatedChart, t2ClosedWonChart, t2ScatterChart;
let currentCohort = "all";
let sortKey = 'created_amount', sortDir = -1;
let t2Lo=0, t2Hi=MONTHS.length-1;
let t2AccountsCache = [];

function getFilteredAccounts(){
  return currentCohort==="all" ? t2AccountsCache.slice() : t2AccountsCache.filter(a=>a.cohort===currentCohort);
}
function renderT2AcctTable(){
  let rows = getFilteredAccounts();
  rows.sort((a,b)=>{ const va=a[sortKey], vb=b[sortKey]; if(typeof va==='string') return va.localeCompare(vb)*sortDir; return (va-vb)*sortDir; });
  document.querySelector('#t2_acctTable tbody').innerHTML = rows.map(a=>\`
    <tr>
      <td>\${a.account}</td>
      <td><span class="badge \${COHORT_BADGE[a.cohort]}">\${a.cohort}</span></td>
      <td class="num">\${fmtNum(a.unique_sessions)}</td>
      <td class="num">\${fmtPct(a.deep_action_ratio)}</td>
      <td class="num">\${fmtNum(a.unique_users)}</td>
      <td class="num">\${fmtMoney(a.created_amount)}</td>
      <td class="num">\${fmtMoney(a.closed_won_amount)}</td>
    </tr>\`).join('');
}

function renderTab2Pipeline(lo, hi){
  t2Lo=lo; t2Hi=hi;
  const {accounts, cohortAgg} = computeFiltered(lo, hi);
  t2AccountsCache = accounts;
  const power = cohortAgg["Power Users"], browser = cohortAgg["Frequent Browsers"], digger = cohortAgg["Focused Diggers"], light = cohortAgg["Light Touch"], none = cohortAgg["No Engagement"];
  const totalAccounts = COHORT_ORDER.reduce((s,c)=>s+cohortAgg[c].n,0);
  const totalCreated = COHORT_ORDER.reduce((s,c)=>s+cohortAgg[c].total_created,0);
  const totalClosedWon = COHORT_ORDER.reduce((s,c)=>s+cohortAgg[c].total_closed_won,0);
  const gapCreated = none.avg_created>0 ? (power.avg_created/none.avg_created).toFixed(1) : "—";

  document.getElementById('t2_kpiRow').innerHTML = [
    {label:"Total pipeline created", value:fmtMoney(totalCreated), sub:\`Across \${totalAccounts} parent accounts\`},
    {label:"Power Users avg pipeline created", value:fmtMoney(power.avg_created), sub:\`vs \${fmtMoney(none.avg_created)} for zero-engagement (\${gapCreated}x gap)\`, good:true},
    {label:"Total pipeline closed-won", value:fmtMoney(totalClosedWon), sub:\`\${fmtMoney(power.total_closed_won)} of it from Power User accounts\`},
    {label:"Power Users avg pipeline closed-won", value:fmtMoney(power.avg_closed_won), sub:\`vs \${fmtMoney(none.avg_closed_won)} for zero-engagement accounts\`, good:true},
  ].map(c=>\`<div class="kpi-card"><div class="kpi-label">\${c.label}</div><div class="kpi-value">\${c.value}</div>
    <div class="kpi-sub \${c.good?'good':''}">\${c.sub}</div></div>\`).join('');

  const cohortsArr = COHORT_ORDER.map(c=>cohortAgg[c]);
  const colors = COHORT_ORDER.map(c=>COHORT_COLORS[c]);

  if(!t2CreatedChart){
    t2CreatedChart = new Chart(document.getElementById('t2_createdChart'), {
      type:'bar', data:{ labels: COHORT_ORDER, datasets:[{ data: cohortsArr.map(c=>c.avg_created), backgroundColor: colors, borderRadius:6 }]},
      options: baseBarOptions(), plugins:[valueLabelPlugin()]
    });
    t2ClosedWonChart = new Chart(document.getElementById('t2_closedWonChart'), {
      type:'bar', data:{ labels: COHORT_ORDER, datasets:[{ data: cohortsArr.map(c=>c.avg_closed_won), backgroundColor: colors, borderRadius:6 }]},
      options: baseBarOptions(), plugins:[valueLabelPlugin()]
    });
  } else {
    t2CreatedChart.data.datasets[0].data = cohortsArr.map(c=>c.avg_created); t2CreatedChart.update();
    t2ClosedWonChart.data.datasets[0].data = cohortsArr.map(c=>c.avg_closed_won); t2ClosedWonChart.update();
  }

  const scatterDatasets = COHORT_ORDER.map(c=>({
    label:c,
    data: accounts.filter(a=>a.cohort===c).map(a=>({x:a.unique_sessions, y: Math.max(a.created_amount+a.closed_won_amount, 1000), acct:a.account})),
    backgroundColor: COHORT_COLORS[c]+"CC", borderColor: COHORT_COLORS[c], pointRadius:6, pointHoverRadius:9,
  }));
  if(!t2ScatterChart){
    t2ScatterChart = new Chart(document.getElementById('t2_scatterChart'), {
      type:'scatter', data:{ datasets: scatterDatasets },
      options:{ responsive:true, maintainAspectRatio:false,
        plugins:{ legend:{position:'top', labels:{usePointStyle:true}}, tooltip:{ callbacks:{ label:(ctx)=> \`\${ctx.raw.acct}: \${ctx.raw.x} sessions, pipeline \${fmtMoney(ctx.raw.y)}\` } } },
        scales:{
          x:{ title:{display:true, text:'Sessions'}, grid:{display:false} },
          y:{ type:'logarithmic', title:{display:true, text:'Combined pipeline (log scale)'},
              ticks:{ callback:(v)=>{ const s=String(v); if(['1000','10000','100000','1000000','10000000','100000000','1000000000'].includes(s)) return fmtMoney(v); return null; } } }
        } }
    });
  } else {
    t2ScatterChart.data.datasets.forEach((ds,i)=>{ ds.data = scatterDatasets[i].data; });
    t2ScatterChart.update();
  }

  document.getElementById('t2_nuanceCallout').innerHTML = nuanceText(power, browser, digger, light);

  renderT2AcctTable();
}

function renderTab2(){
  if(tab2Init) return;
  tab2Init = true;
  document.querySelectorAll('#t2_acctTable th[data-key]').forEach(th=>{
    th.addEventListener('click', ()=>{
      const key = th.dataset.key;
      if(sortKey===key) sortDir *= -1; else { sortKey = key; sortDir = -1; }
      renderT2AcctTable();
    });
  });
  document.getElementById('t2_cohortFilter').addEventListener('change', (e)=>{ currentCohort = e.target.value; renderT2AcctTable(); });
  setupMonthSlider('t2', renderTab2Pipeline);
}

/* ============ TAB 3 ============ */
let tab3Init = false;
let t3CreatedChart, t3ClosedChart, t3CohortChart;

function renderTab3Range(lo, hi){
  const labels = MONTHS.slice(lo,hi+1).map(m=>monthLabel(m));
  const createdVals = MONTHS.map((m,i)=> BUNDLE.accounts.reduce((s,a)=>s+a.created_by_month[i],0)).slice(lo,hi+1);
  const closedVals = MONTHS.map((m,i)=> BUNDLE.accounts.reduce((s,a)=>s+a.closed_won_by_month[i],0)).slice(lo,hi+1);

  const totalCreated = createdVals.reduce((a,b)=>a+b,0);
  const totalClosed = closedVals.reduce((a,b)=>a+b,0);
  const peakIdx = createdVals.indexOf(Math.max(...createdVals));
  const powerCreatedInRange = BUNDLE.accounts.filter(a=>a.cohort==="Power Users")
    .reduce((s,a)=>s + a.created_by_month.slice(lo,hi+1).reduce((x,y)=>x+y,0), 0);

  let changeLbl = "—";
  if(createdVals.length>=2 && createdVals[0]>0){
    changeLbl = (((createdVals[createdVals.length-1]-createdVals[0])/createdVals[0])*100).toFixed(0)+"%";
  }

  document.getElementById('t3_kpiRow').innerHTML = [
    {num: fmtMoney(totalCreated), lbl:\`Total pipeline created in selected range\`},
    {num: fmtMoney(totalClosed), lbl:\`Total pipeline closed-won in selected range\`},
    {num: labels.length? labels[peakIdx] : "—", lbl:\`Peak month for created pipeline — \${createdVals.length?fmtMoney(createdVals[peakIdx]):''}\`},
    {num: changeLbl, lbl:\`Change in created pipeline, first vs. last month in range\`},
  ].map(i=>\`<div class="kpi-card"><div class="num">\${i.num}</div><div class="lbl">\${i.lbl}</div></div>\`).join('');

  const createdData = { labels, datasets:[{ label:'Pipeline Created', data: createdVals, borderColor:'#447C93', backgroundColor:'#447C9322', borderWidth:2.5, fill:true, tension:0.3, pointRadius:5, pointBackgroundColor:'#447C93', pointHoverRadius:7 }] };
  const closedData = { labels, datasets:[{ label:'Pipeline Closed-Won', data: closedVals, borderColor:'#5BA779', backgroundColor:'#5BA77922', borderWidth:2.5, fill:true, tension:0.3, pointRadius:5, pointBackgroundColor:'#5BA779', pointHoverRadius:7 }] };

  if(!t3CreatedChart){
    t3CreatedChart = new Chart(document.getElementById('t3_createdTrendChart'), {
      type:'line', data: createdData,
      options:{ responsive:true, maintainAspectRatio:false,
        plugins:{ legend:{display:false}, tooltip:{ callbacks:{ label:(ctx)=> \`Pipeline created: \${fmtMoney(ctx.parsed.y)}\` } } },
        scales:{ x:{grid:{display:false}}, y:{ beginAtZero:true, ticks:{ callback:(v)=>fmtMoney(v) } } } }
    });
    t3ClosedChart = new Chart(document.getElementById('t3_closedTrendChart'), {
      type:'line', data: closedData,
      options:{ responsive:true, maintainAspectRatio:false,
        plugins:{ legend:{display:false}, tooltip:{ callbacks:{ label:(ctx)=> \`Pipeline closed-won: \${fmtMoney(ctx.parsed.y)}\` } } },
        scales:{ x:{grid:{display:false}}, y:{ beginAtZero:true, ticks:{ callback:(v)=>fmtMoney(v) } } } }
    });
  } else {
    t3CreatedChart.data.labels = labels; t3CreatedChart.data.datasets[0].data = createdVals; t3CreatedChart.update();
    t3ClosedChart.data.labels = labels; t3ClosedChart.data.datasets[0].data = closedVals; t3ClosedChart.update();
  }

  const cohortDatasets = COHORT_ORDER.map(c=>{
    const vals = MONTHS.map((m,i)=> BUNDLE.accounts.filter(a=>a.cohort===c).reduce((s,a)=>s+a.created_by_month[i],0)).slice(lo,hi+1);
    return { label:c, data: vals, borderColor: COHORT_COLORS[c], backgroundColor: COHORT_COLORS[c]+"22", borderWidth:2.2, fill:false, tension:0.3, pointRadius:4, pointHoverRadius:6 };
  });
  if(!t3CohortChart){
    t3CohortChart = new Chart(document.getElementById('t3_cohortTrendChart'), {
      type:'line', data:{ labels, datasets: cohortDatasets },
      options:{ responsive:true, maintainAspectRatio:false,
        plugins:{ legend:{position:'top', labels:{usePointStyle:true}}, tooltip:{ callbacks:{ label:(ctx)=> \`\${ctx.dataset.label}: \${fmtMoney(ctx.parsed.y)}\` } } },
        scales:{ x:{grid:{display:false}}, y:{ beginAtZero:true, ticks:{ callback:(v)=>fmtMoney(v) } } } }
    });
  } else {
    t3CohortChart.data.labels = labels;
    t3CohortChart.data.datasets.forEach((ds,i)=>{ ds.data = cohortDatasets[i].data; });
    t3CohortChart.update();
  }

  document.getElementById('t3_trendCallout').innerHTML = trendText(labels, createdVals, powerCreatedInRange, totalCreated, hi);
}

function renderTab3(){
  if(tab3Init) return;
  tab3Init = true;
  setupMonthSlider('t3', renderTab3Range);
}

document.querySelectorAll('.tab-btn').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p=>p.classList.remove('active'));
    btn.classList.add('active');
    const tabId = btn.dataset.tab;
    document.getElementById(tabId).classList.add('active');
    if(tabId==='tab1') renderTab1();
    if(tabId==='tab2') renderTab2();
    if(tabId==='tab3') renderTab3();
  });
});

renderTab1();
`

export function renderAccount360Dashboard(facts: Account360Facts, options: Account360DashboardOptions): string {
  const b = facts.BUNDLE
  const m = facts.META
  const account = options.account
  const generated = options.generatedAt ? new Date(options.generatedAt) : new Date()
  const generatedLabel = Number.isNaN(generated.getTime()) ? '' : generated.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
  const clickRange = `${dayLabel(m.clickStart)} – ${dayLabel(m.clickEnd)}`
  const monthRange = b.months.length ? `${monthLabel(b.months[0])} – ${monthLabel(b.months[b.months.length - 1])}` : ''
  const excluded = m.excludedUsers.length
  const excludedClause = excluded ? ` (excl. ${excluded} flagged user${excluded === 1 ? '' : 's'})` : ''
  const excludedSentence = excluded ? ` ${excluded} flagged user${excluded === 1 ? '' : 's'} excluded (${m.breadthCutoff}+ accounts touched, or named for exclusion).` : ''
  const sessions = String(Math.round(b.session_median * 10) / 10)
  const depth = `${(b.depth_ratio_median * 100).toFixed(1)}%`
  const lastMonth = b.months[b.months.length - 1]
  const partialSentence = m.lastMonthPartial && lastMonth ? ` ${esc(monthLabelLong(lastMonth))} is a partial month (data through ${esc(dayLabel(m.clickEnd))}).` : ''
  const beyondSentence = m.wonBeyondWindow > 0 && lastMonth ? ` Excludes ~${money(m.wonBeyondWindow)} of Won opportunities with close dates recorded after ${esc(monthLabelLong(lastMonth))} (often multi-year renewal dates).` : ''
  const lede = options.lede?.trim() ? `\n    <p class="lede">${esc(options.lede.trim())}</p>` : ''
  const notes = [
    `Deep actions are opportunity, metrics and activity actions; page visits, filters, sorting and time-range changes are not. Each event belongs to the account its session was on.`,
    `Pipeline is by month over the click-stream's full months: created by the opportunity's created date, closed-won by close date on a Won stage.`,
    ...(excluded ? [`Excluded users: ${m.excludedUsers.join(', ')}.`] : []),
    `${m.eventsUsed.toLocaleString('en-US')} of ${m.eventsTotal.toLocaleString('en-US')} events counted, from ${m.usersActive.toLocaleString('en-US')} users.`,
    ...facts.notes,
    `These are correlations: teams that engage more may already be working the larger accounts.`,
  ]
  const notesBlock = `<div class="notes"><strong>Method and data notes</strong><ul>${notes.map((note) => `<li>${esc(note)}</li>`).join('')}</ul></div>`

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(account)} Account 360 ROI</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cardo:wght@400;700&family=Chivo+Mono:wght@400;500;700&family=Roboto:wght@300;400;500;700&display=swap" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.js"></script>
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
  <div class="suite-header">
    <h1>${esc(account)} Account 360 — engagement to pipeline</h1>
    <p>${m.accounts} parent accounts · click-stream ${clickRange}${excludedClause} · pipeline created and closed-won, ${monthRange}. Use the timeframe slider on each tab to zoom into a month range.</p>${lede}
  </div>

  <div class="tab-bar">
    <button class="tab-btn active" data-tab="tab1">Interaction Cohorts &amp; Pipeline Bump</button>
    <button class="tab-btn" data-tab="tab2">Engagement ROI Dashboard</button>
    <button class="tab-btn" data-tab="tab3">Pipeline Created Trend</button>
  </div>

  <!-- ============ TAB 1 ============ -->
  <div class="tab-panel active" id="tab1">
    <header class="section-header">
      <h2>Interaction Cohorts → Pipeline Bump</h2>
      <p>Accounts cohorted by <strong>how often</strong> a team logs into Account 360 and <strong>what they do once they're in</strong> — not just raw click volume.</p>
    </header>

    <div class="month-slider">
      <div class="ms-header"><span class="ms-title">Pipeline timeframe <span>— created or closed-won within:</span></span><span class="ms-range-label" id="t1_sliderLabel"></span></div>
      <div class="ms-track-wrap">
        <div class="ms-track"></div><div class="ms-track-highlight" id="t1_sliderHighlight"></div>
        <input type="range" class="ms-range" id="t1_sliderMin">
        <input type="range" class="ms-range" id="t1_sliderMax">
      </div>
      <div class="ms-ticks" id="t1_sliderTicks"></div>
    </div>

    <div class="callout-row kpi-row" id="t1_calloutRow"></div>

    <div class="section-title">A more distinguishable cohort model</div>
    <p class="section-cap">Accounts are split on two independent signals: how <strong>often</strong> the team logs in (session volume) and how <strong>deep</strong> they go once there (share of clicks that are opportunity/metrics/activity actions vs. simple page visits or filter changes)</p>
    <div class="card">
      <div class="quad-grid">
        <div class="quad-cell q-power"><h4><span class="swatch" style="background:var(--c-power)"></span>Power Users</h4><p>≥${sessions} sessions <strong>and</strong> ≥${depth} deep-action clicks. Log in often <em>and</em> dig into opportunities/metrics when they do.</p></div>
        <div class="quad-cell q-browser"><h4><span class="swatch" style="background:var(--c-browser)"></span>Frequent Browsers</h4><p>≥${sessions} sessions but &lt;${depth} deep-action clicks. Log in often, but mostly just look around — page visits, filters, sorting.</p></div>
        <div class="quad-cell q-digger"><h4><span class="swatch" style="background:var(--c-digger)"></span>Focused Diggers</h4><p>&lt;${sessions} sessions but ≥${depth} deep-action clicks. Rarely log in, but when they do, they go straight for opportunities and metrics.</p></div>
        <div class="quad-cell q-light"><h4><span class="swatch" style="background:var(--c-light)"></span>Light Touch</h4><p>&lt;${sessions} sessions and &lt;${depth} deep-action clicks. Infrequent and shallow — a quick look, nothing more.</p></div>
      </div>
      <p style="font-size:12px;color:var(--muted);margin:8px 0 0;">Cutoffs are the sample medians (${sessions} sessions, ${depth} deep-action ratio) among the ${m.engaged} accounts with any recorded engagement. A 5th group, <strong>No Engagement</strong> (${m.noEngagement} accounts), had zero clicks in the period.</p>
    </div>

    <div class="grid2">
      <div class="card">
        <h3>Avg pipeline CREATED per account</h3>
        <p class="cap">New opportunities opened within the selected timeframe</p>
        <div class="chart-box tall"><canvas id="t1_createdChart"></canvas></div>
      </div>
      <div class="card">
        <h3>Avg pipeline CLOSED-WON per account</h3>
        <p class="cap">Opportunities that reached a Won stage within the selected timeframe</p>
        <div class="chart-box tall"><canvas id="t1_closedWonChart"></canvas></div>
      </div>
    </div>

    <div class="callout" id="t1_nuanceCallout" style="margin-top:4px;"></div>

    <div class="section-title">Who's driving the platform: breadth vs. depth</div>
    <p class="section-cap">Breadth = distinct accounts touched · Depth = total clicks logged. Bubble size = sessions. Not affected by the timeframe slider above (this reflects the full ${clickRange} click-stream).${excludedSentence}</p>
    <div class="grid2">
      <div class="card">
        <h3>User breadth vs. depth</h3>
        <p class="cap">Top-right = widest reach + heaviest usage. Hover for details.</p>
        <div class="chart-box tall"><canvas id="t1_userBubbleChart"></canvas></div>
      </div>
      <div class="card">
        <h3>Top users by breadth + depth</h3>
        <p class="cap">Ranked by distinct accounts touched, then total events</p>
        <div style="max-height:380px;overflow:auto;">
          <table id="t1_userTable">
            <thead><tr><th>Rank</th><th>User</th><th class="num">Accounts</th><th class="num">Events</th><th class="num">Sessions</th></tr></thead>
            <tbody></tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="callout" id="t1_userCallout" style="margin-top:4px;"></div>

    <div class="section-title">Where to focus</div>
    <p class="section-cap">Accounts where pipeline value and platform usage are mismatched, within the selected timeframe</p>
    <div class="grid2">
      <div class="card">
        <h3>Low-volume accounts with real pipeline</h3>
        <p class="cap">Focused Diggers / Light Touch cohorts carrying meaningful created or closed-won pipeline</p>
        <div class="table-wrap">
          <table id="t1_whaleTable">
            <thead><tr><th>Account</th><th>Cohort</th><th class="num">Sessions</th><th class="num">Created</th><th class="num">Closed-Won</th></tr></thead>
            <tbody></tbody>
          </table>
        </div>
      </div>
      <div class="card">
        <h3>Zero-engagement accounts with pipeline at stake</h3>
        <p class="cap">No recorded Account 360 clicks at all, yet carrying real pipeline</p>
        <div class="table-wrap">
          <table id="t1_darkTable">
            <thead><tr><th>Account</th><th class="num">Created</th><th class="num">Closed-Won</th></tr></thead>
            <tbody></tbody>
          </table>
        </div>
      </div>
    </div>
  </div>

  <!-- ============ TAB 2 ============ -->
  <div class="tab-panel" id="tab2">
    <header class="section-header header-row">
      <div>
        <h2>Engagement → Pipeline ROI Dashboard</h2>
        <p>Full account-level detail: cohort assignment, session/depth stats, and pipeline created vs. closed-won.</p>
      </div>
      <div class="filters">
        <select id="t2_cohortFilter">
          <option value="all">All cohorts</option>
          <option value="Power Users">Power Users</option>
          <option value="Frequent Browsers">Frequent Browsers</option>
          <option value="Focused Diggers">Focused Diggers</option>
          <option value="Light Touch">Light Touch</option>
          <option value="No Engagement">No Engagement</option>
        </select>
      </div>
    </header>

    <div class="month-slider">
      <div class="ms-header"><span class="ms-title">Pipeline timeframe <span>— created or closed-won within:</span></span><span class="ms-range-label" id="t2_sliderLabel"></span></div>
      <div class="ms-track-wrap">
        <div class="ms-track"></div><div class="ms-track-highlight" id="t2_sliderHighlight"></div>
        <input type="range" class="ms-range" id="t2_sliderMin">
        <input type="range" class="ms-range" id="t2_sliderMax">
      </div>
      <div class="ms-ticks" id="t2_sliderTicks"></div>
    </div>

    <section class="kpi-row" id="t2_kpiRow"></section>

    <section class="grid2">
      <div class="card">
        <h3>Avg pipeline CREATED per account, by cohort</h3>
        <p class="cap">Within the selected timeframe</p>
        <div class="chart-box tall"><canvas id="t2_createdChart"></canvas></div>
      </div>
      <div class="card">
        <h3>Avg pipeline CLOSED-WON per account, by cohort</h3>
        <p class="cap">Within the selected timeframe</p>
        <div class="chart-box tall"><canvas id="t2_closedWonChart"></canvas></div>
      </div>
    </section>

    <div class="callout" id="t2_nuanceCallout"></div>

    <div class="card">
      <h3>Session volume vs. total pipeline (log scale)</h3>
      <p class="cap">Each dot is one account, colored by cohort. Combined pipeline = created + closed-won within the selected timeframe.</p>
      <div class="chart-box tall"><canvas id="t2_scatterChart"></canvas></div>
    </div>

    <div class="section-title">Account detail</div>
    <p class="section-cap">Sortable — click any column header. Filter by cohort using the dropdown above.</p>
    <div class="card">
      <div class="table-wrap">
        <table id="t2_acctTable">
          <thead>
            <tr>
              <th data-key="account">Account</th>
              <th data-key="cohort">Cohort</th>
              <th data-key="unique_sessions" class="num">Sessions</th>
              <th data-key="deep_action_ratio" class="num">Deep-Action %</th>
              <th data-key="unique_users" class="num">Users</th>
              <th data-key="created_amount" class="num">Pipeline Created</th>
              <th data-key="closed_won_amount" class="num">Pipeline Closed-Won</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
      </div>
    </div>
  </div>

  <!-- ============ TAB 3 ============ -->
  <div class="tab-panel" id="tab3">
    <header class="section-header">
      <h2>Pipeline — Monthly Trend</h2>
      <p>New opportunity value opened, and opportunity value closed-won, each month from ${esc(monthLabelLong(b.months[0]))}.${partialSentence} Slider below zooms the charts and KPIs to a sub-range of months.</p>
    </header>

    <div class="month-slider">
      <div class="ms-header"><span class="ms-title">Zoom to months:</span><span class="ms-range-label" id="t3_sliderLabel"></span></div>
      <div class="ms-track-wrap">
        <div class="ms-track"></div><div class="ms-track-highlight" id="t3_sliderHighlight"></div>
        <input type="range" class="ms-range" id="t3_sliderMin">
        <input type="range" class="ms-range" id="t3_sliderMax">
      </div>
      <div class="ms-ticks" id="t3_sliderTicks"></div>
    </div>

    <div class="kpi-row" id="t3_kpiRow"></div>

    <div class="card">
      <h3>Pipeline created per month</h3>
      <p class="cap">All ${m.accounts} accounts combined</p>
      <div class="chart-box tall"><canvas id="t3_createdTrendChart"></canvas></div>
    </div>

    <div class="card">
      <h3>Pipeline closed-won per month</h3>
      <p class="cap">All ${m.accounts} accounts combined.${beyondSentence}</p>
      <div class="chart-box tall"><canvas id="t3_closedTrendChart"></canvas></div>
    </div>

    <div class="card">
      <h3>Pipeline created per month, by cohort</h3>
      <p class="cap">Toggle a cohort in the legend to isolate it</p>
      <div class="chart-box tall"><canvas id="t3_cohortTrendChart"></canvas></div>
    </div>

    <div class="callout" id="t3_trendCallout"></div>
  </div>

  ${notesBlock}
  <footer>${esc(account)} Account 360 engagement ROI · Engagement window ${clickRange}${excludedClause} · Pipeline created and closed-won, ${monthRange}${generatedLabel ? ` · Generated ${esc(generatedLabel)}` : ''} · computed by the ROI Analyst</footer>
</div>


<script>
const BUNDLE = ${scriptJson(b)};
const META = ${scriptJson(m)};
</script>
<script>${SCRIPT}</script>
</body>
</html>`
}

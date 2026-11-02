/**
 * The CRO dashboard page: Shreyas Gore's cro-dashboard plugin template
 * (v0.5.0), whose layout, interactions and visual design are binding. Every
 * run only supplies data (see ./schema); never restyle or rewrite it per run.
 *
 * What differs from the plugin, all forced by running here on the Backstory
 * MCP alone: no Google Fonts (the sandbox loads none; the stacks fall back), a
 * full document wrapper, the seller's name from the run instead of a literal
 * "Backstory", the Add-quarter button asks the assistant (a page has no
 * network and no window.claude), and no "no meetings scheduled" line, because
 * Backstory cannot see the calendar and absence would be a false claim.
 */
export const CRO_DASHBOARD_TEMPLATE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CRO Pipeline Health</title>
<style>
/* Concept: a control-room ledger. One horizontal bar states the verdict (on track vs not), everything below explains it: why, who has to move, which deals. */
:root{
  --bg:#f2f4f7; --surface:#ffffff; --surface-2:#eaeef3; --line:#d5dbe3; --line-soft:#e4e8ee;
  --ink:#141d28; --ink-2:#4a5866; --ink-3:#77838f;
  --accent:#2350c8; --accent-soft:#e3eafb;
  --ok:#1b7f55; --ok-soft:#dcf1e7;
  --warn:#b4690a; --warn-soft:#fbead0;
  --bad:#b93027; --bad-soft:#f9dfdc;
  --idle:#8b95a1; --idle-soft:#e6e9ed;
  --shadow:0 1px 2px rgba(20,29,40,.06),0 8px 24px rgba(20,29,40,.08);
  --f-display:"Familjen Grotesk","Helvetica Neue",Arial,sans-serif;
  --f-body:"Public Sans",system-ui,-apple-system,"Segoe UI",sans-serif;
  --f-mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --bg:#0e141b; --surface:#151d27; --surface-2:#1c2632; --line:#293545; --line-soft:#212c3a;
  --ink:#e8edf3; --ink-2:#a6b2bf; --ink-3:#7c8896;
  --accent:#7aa2ff; --accent-soft:#1d2b4d;
  --ok:#4cc38a; --ok-soft:#13332a;
  --warn:#e8a54a; --warn-soft:#3a2b12;
  --bad:#f07a70; --bad-soft:#40201e;
  --idle:#8b95a1; --idle-soft:#232d39;
  --shadow:0 1px 2px rgba(0,0,0,.4),0 8px 24px rgba(0,0,0,.35);
  color-scheme:dark}}
:root[data-theme="dark"]{
  --bg:#0e141b; --surface:#151d27; --surface-2:#1c2632; --line:#293545; --line-soft:#212c3a;
  --ink:#e8edf3; --ink-2:#a6b2bf; --ink-3:#7c8896;
  --accent:#7aa2ff; --accent-soft:#1d2b4d;
  --ok:#4cc38a; --ok-soft:#13332a;
  --warn:#e8a54a; --warn-soft:#3a2b12;
  --bad:#f07a70; --bad-soft:#40201e;
  --idle:#8b95a1; --idle-soft:#232d39;
  --shadow:0 1px 2px rgba(0,0,0,.4),0 8px 24px rgba(0,0,0,.35);
  color-scheme:dark}
body{background:var(--bg);color:var(--ink);font-family:var(--f-body);font-size:14px;line-height:1.45}
*{box-sizing:border-box}
.wrap{max-width:1360px;margin:0 auto;padding-inline:20px;padding-block:0 48px}
h1,h2,h3{font-family:var(--f-display);margin:0;text-wrap:balance;letter-spacing:-.01em}
.num{font-family:var(--f-mono);font-variant-numeric:tabular-nums}
button{font:inherit;color:inherit;cursor:pointer}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}

/* header */
.top{position:sticky;top:env(safe-area-inset-top,0px);z-index:20;background:var(--bg);border-bottom:1px solid var(--line);padding-block:12px}
.top-in{display:flex;flex-wrap:wrap;align-items:center;gap:10px 18px;justify-content:space-between}
.brand h1{font-size:22px;font-weight:700}
.brand .sub{color:var(--ink-3);font-size:12px;margin-top:2px}
.scope{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.qchip{display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border:1px solid var(--line);border-radius:999px;background:var(--surface);font-size:12px;font-weight:600}
.qchip small{font-weight:500;color:var(--ink-3)}
.qchip{cursor:pointer;color:var(--ink)}
.qchip:hover{border-color:var(--accent)}
.qchip.on{background:var(--accent);border-color:var(--accent);color:#fff}
.qchip.on small{color:inherit;opacity:.85}
:root[data-theme="dark"] .qchip.on{color:#0b1220}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]) .qchip.on{color:#0b1220}}
.qchip.ext{border-style:dashed}
.btn{display:inline-flex;align-items:center;gap:6px;padding:7px 12px;border-radius:8px;border:1px solid var(--line);background:var(--surface);font-weight:600;font-size:13px}
.btn:hover{border-color:var(--accent)}
.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}
[data-theme="dark"] .btn.primary,:root:not([data-theme="light"]) .btn.primary{color:#0b1220}
.btn[disabled]{opacity:.55;cursor:default}
.btn.ghost{background:transparent}
.notes{margin-top:10px;padding:8px 12px;border:1px solid var(--line-soft);border-radius:8px;background:var(--surface);color:var(--ink-2);font-size:12px;display:flex;flex-wrap:wrap;gap:4px 16px}
.notes b{color:var(--ink)}
.banner{margin-top:10px;padding:10px 12px;border-radius:8px;font-size:13px;display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap}
.banner.info{background:var(--accent-soft);border:1px solid var(--accent)}
.banner.err{background:var(--bad-soft);border:1px solid var(--bad)}

/* verdict */
.verdict{margin-top:20px;background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:20px;box-shadow:var(--shadow)}
.verdict-head{display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px 24px;align-items:flex-end}
.verdict h2{font-size:15px;color:var(--ink-2);font-weight:600;text-transform:uppercase;letter-spacing:.06em}
.big{display:flex;flex-wrap:wrap;gap:6px 28px;margin-top:8px}
.big .k{font-size:12px;color:var(--ink-3);text-transform:uppercase;letter-spacing:.05em}
.big .v{font-family:var(--f-display);font-size:34px;font-weight:700;line-height:1.1}
.big .v small{font-size:14px;font-weight:500;color:var(--ink-3);font-family:var(--f-body);margin-left:6px}
.bar{display:flex;height:22px;border-radius:6px;overflow:hidden;margin-top:16px;background:var(--surface-2);gap:2px}
.bar>i{display:block;min-width:2px}
.legend{display:flex;flex-wrap:wrap;gap:6px 18px;margin-top:10px;font-size:12px;color:var(--ink-2)}
.legend span{display:inline-flex;align-items:center;gap:6px}
.sw{width:10px;height:10px;border-radius:2px;display:inline-block}
.c-ok{background:var(--ok)} .c-warn{background:var(--warn)} .c-bad{background:var(--bad)} .c-idle{background:var(--idle)}

/* insights */
.two{display:grid;grid-template-columns:minmax(0,3fr) minmax(0,2fr);gap:14px;margin-top:14px}
@media (max-width:900px){.two{grid-template-columns:1fr}}
.panel{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:16px;min-width:0}
.panel h2{font-size:16px}
.panel .hint{color:var(--ink-3);font-size:12px;margin-top:2px}
.rr{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,1.6fr) auto;gap:6px 12px;align-items:center;padding:9px 0;border-top:1px solid var(--line-soft)}
.rr:first-of-type{border-top:0}
.rr .nm{font-weight:600;font-size:13px}
.rr .ac{font-size:12px;color:var(--ink-2);margin-top:2px}
.rr .tr{height:10px;background:var(--surface-2);border-radius:5px;overflow:hidden}
.rr .tr i{display:block;height:100%;border-radius:5px;background:var(--bad)}
.rr .am{text-align:right;font-size:12px;white-space:nowrap}
.rr .am b{display:block;font-size:13px}
.side{display:inline-block;font-size:10px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;padding:1px 6px;border-radius:4px;margin-left:6px;vertical-align:1px}
.side.cust{background:var(--warn-soft);color:var(--warn)}
.side.int{background:var(--accent-soft);color:var(--accent)}
.side.both{background:var(--surface-2);color:var(--ink-2)}
.dep{display:grid;gap:12px;margin-top:12px}
.dep .drow .dh{display:flex;justify-content:space-between;align-items:baseline;gap:8px}
.dep .drow .dn{font-weight:600}
.dep .drow .db{height:12px;background:var(--surface-2);border-radius:6px;overflow:hidden;margin-top:6px}
.dep .drow .db i{display:block;height:100%;border-radius:6px}
.dep .drow p{margin:6px 0 0;color:var(--ink-2);font-size:12px}
.empty{color:var(--ink-3);padding:14px 0;font-size:13px}

/* filters */
.fbar{margin-top:14px;display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.fbar .grow{flex:1}
.ms{position:relative}
.ms>button{display:inline-flex;gap:6px;align-items:center;padding:6px 10px;border:1px solid var(--line);background:var(--surface);border-radius:8px;font-size:13px}
.ms>button.on{border-color:var(--accent);background:var(--accent-soft)}
.ms>button .cnt{font-family:var(--f-mono);font-size:11px;background:var(--accent);color:#fff;border-radius:999px;padding:0 6px}
.ms .menu{position:absolute;top:calc(100% + 4px);left:0;z-index:15;min-width:220px;max-height:300px;overflow:auto;background:var(--surface);border:1px solid var(--line);border-radius:10px;box-shadow:var(--shadow);padding:6px}
.ms .menu label{display:flex;gap:8px;align-items:center;padding:5px 8px;border-radius:6px;font-size:13px;cursor:pointer}
.ms .menu label:hover{background:var(--surface-2)}
.ms .menu .n{margin-left:auto;color:var(--ink-3);font-size:11px;font-family:var(--f-mono)}
.search{padding:6px 10px;border:1px solid var(--line);background:var(--surface);border-radius:8px;font:inherit;color:var(--ink);min-width:170px}
.showing{color:var(--ink-2);font-size:12px}
.linkbtn{background:none;border:0;color:var(--accent);padding:0;font-weight:600;font-size:12px;text-decoration:underline;text-underline-offset:2px}
.clr-all{font-size:13px;padding:6px 4px}
.clr-all:hover{text-decoration-thickness:2px}

/* table */
.tw{margin-top:10px;background:var(--surface);border:1px solid var(--line);border-radius:12px;overflow:auto;max-height:70vh}
table{border-collapse:separate;border-spacing:0;width:100%;min-width:1080px}
thead th{position:sticky;top:0;background:var(--surface-2);text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--ink-2);padding:9px 10px;border-bottom:1px solid var(--line);white-space:nowrap;z-index:2}
thead th.sort{cursor:pointer}
thead th.sort:hover{color:var(--ink)}
tbody td{padding:9px 10px;border-bottom:1px solid var(--line-soft);vertical-align:top;font-size:13px}
tbody tr{cursor:pointer}
tbody tr:hover td{background:var(--surface-2)}
td.r,th.r{text-align:right}
.acct{font-weight:600}
.opn{color:var(--ink-3);font-size:12px;max-width:260px}
.pill{display:inline-flex;align-items:center;gap:6px;padding:2px 9px;border-radius:999px;font-size:12px;font-weight:600;white-space:nowrap}
.pill i{width:7px;height:7px;border-radius:50%}
.pill.ok{background:var(--ok-soft);color:var(--ok)} .pill.ok i{background:var(--ok)}
.pill.warn{background:var(--warn-soft);color:var(--warn)} .pill.warn i{background:var(--warn)}
.pill.bad{background:var(--bad-soft);color:var(--bad)} .pill.bad i{background:var(--bad)}
.pill.idle{background:var(--idle-soft);color:var(--ink-2)} .pill.idle i{background:var(--idle)}
.tier{font-size:11px;font-weight:600;color:var(--ink-2)}
.tier.s{color:var(--accent)}
.watch{font-size:10px;font-weight:700;color:var(--bad);text-transform:uppercase;letter-spacing:.04em;margin-left:6px}
.out{color:var(--ink-2);font-size:12px;max-width:230px}
.zero{color:var(--ink-3)}
.stripe{box-shadow:inset 3px 0 0 var(--stripe,transparent)}

/* bucket -> list */
[data-bk]{cursor:pointer}
.rr[data-bk]:hover,.drow[data-bk]:hover{background:var(--surface-2)}
.rr[data-bk],.drow[data-bk]{margin-inline:-8px;padding-inline:8px;border-radius:8px}
.drow[data-bk]{padding-block:6px}
.active[data-bk]{background:var(--accent-soft)}
.legend button.active{padding:2px 8px;border-radius:999px;outline:1px solid var(--accent)}
.bar>i.active{outline:2px solid var(--ink);outline-offset:1px}
#fbar{scroll-margin-top:110px}
.legend [data-bk]:hover{color:var(--ink);text-decoration:underline;text-underline-offset:3px}
.bar>i[data-bk]:hover{filter:brightness(1.12)}
.legend button{background:none;border:0;padding:0;font:inherit;color:inherit;display:inline-flex;align-items:center;gap:6px}
.pscrim{position:fixed;inset:0;background:rgba(10,16,24,.5);z-index:30}
.pop{position:fixed;z-index:31;top:50%;left:50%;transform:translate(-50%,-50%);width:min(940px,calc(100% - 32px));max-height:min(82vh,760px);display:flex;flex-direction:column;background:var(--surface);border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow)}
.pop-h{padding:16px 18px 12px;border-bottom:1px solid var(--line);display:flex;gap:12px;justify-content:space-between;align-items:flex-start}
.pop-h h2{font-size:18px}
.pop-h .sub{color:var(--ink-2);font-size:12px;margin-top:4px}
.pop-h .acts{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px}
.pop-b{overflow:auto}
.pop-b table{min-width:760px}
/* stakeholders + meetings */
.eng{list-style:none;margin:8px 0 0;padding:8px 0 0;border-top:1px dashed var(--line);display:grid;gap:6px}
.eng .eh{font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-3)}
.eng li{font-size:12px;line-height:1.35}
.eng li b{font-weight:600;color:var(--ink)}
.eng .tt{color:var(--ink-2)}
.eng .rl{display:inline-block;margin-left:4px;padding:0 6px;border-radius:4px;font-size:10px;font-weight:700;letter-spacing:.03em;text-transform:uppercase;background:var(--surface-2);color:var(--ink-2)}
.eng .st{display:inline-block;margin-left:4px;font-size:10px;font-weight:600;color:var(--ok)}
.eng .st.no{color:var(--warn)} .eng .st.tbd{color:var(--ink-3)}
.eng .wy{color:var(--ink-2);margin-top:1px}
.evt{margin-top:8px;padding:8px 10px;border-radius:8px;background:var(--surface-2);font-size:12px}
.evt .et{font-weight:600;color:var(--ink)}
.evt .ed{font-family:var(--f-mono);font-variant-numeric:tabular-nums;color:var(--accent);margin-top:2px}
.evt .ew{color:var(--ink-2);margin-top:2px}
.meet{display:grid;gap:8px}
.meet .evt{margin-top:0}
.people{display:flex;flex-wrap:wrap;gap:6px}
.person{border:1px solid var(--line-soft);border-radius:8px;padding:6px 9px;font-size:12px;background:var(--surface)}
.person .pr{display:block;font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--ink-3)}
.person b{font-weight:600}
.person span.pt{color:var(--ink-2)}
/* drawer */
.scrim{position:fixed;inset:0;background:rgba(10,16,24,.5);z-index:40}
.drawer{position:fixed;top:0;right:0;bottom:0;width:min(640px,100%);background:var(--surface);z-index:41;box-shadow:var(--shadow);display:flex;flex-direction:column;border-left:1px solid var(--line)}
.dh-top{padding:calc(16px + env(safe-area-inset-top,0px)) 20px 14px;border-bottom:1px solid var(--line);display:flex;gap:12px;justify-content:space-between;align-items:flex-start}
.dh-top h2{font-size:20px}
.meta{display:flex;flex-wrap:wrap;gap:4px 14px;margin-top:8px;color:var(--ink-2);font-size:12px}
.meta b{color:var(--ink);font-weight:600}
.x{background:var(--surface-2);border:1px solid var(--line);border-radius:8px;width:32px;height:32px;line-height:1}
.db-body{overflow:auto;padding:16px 20px calc(28px + env(safe-area-inset-bottom,0px));display:grid;gap:18px}
.sec h3{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-3);margin-bottom:8px}
.sec p{margin:0}
.callout{padding:10px 12px;border-radius:8px;background:var(--surface-2);font-size:13px}
.lst{display:grid;gap:8px}
.item{border:1px solid var(--line-soft);border-radius:8px;padding:9px 11px;font-size:13px}
.item .it{font-weight:600}
.item .sm{color:var(--ink-2);font-size:12px;margin-top:3px}
.item .src{color:var(--ink-3);font-size:11px;margin-top:4px;font-style:italic}
.grp{border-radius:10px;padding:12px;border:1px solid var(--line)}
.grp.cust{background:color-mix(in srgb,var(--warn-soft) 55%,var(--surface))}
.grp.int{background:color-mix(in srgb,var(--accent-soft) 55%,var(--surface))}
.grp h4{margin:0 0 8px;font-family:var(--f-display);font-size:14px;display:flex;justify-content:space-between;gap:8px}
.grp h4 span{font-family:var(--f-body);font-weight:500;font-size:11px;color:var(--ink-2)}
.grp .item{background:var(--surface)}
.kv{display:flex;flex-wrap:wrap;gap:6px}
.chip{font-size:11px;padding:2px 8px;border-radius:999px;background:var(--surface-2);color:var(--ink-2)}
.jira-t{font-family:var(--f-mono);font-size:12px;color:var(--accent)}
@media (prefers-reduced-motion:no-preference){.drawer{animation:in .18s ease-out}@keyframes in{from{transform:translateX(24px);opacity:.4}to{transform:none;opacity:1}}}
</style>
</head>
<body>

<div class="top"><div class="wrap" style="padding-block:0"><div class="top-in">
  <div class="brand"><h1>CRO Pipeline Health</h1><div class="sub" id="built"></div></div>
  <div class="scope" id="scope"></div>
</div>
<div id="banner"></div>
</div></div>

<main class="wrap">
  <div class="notes" id="notes"></div>
  <section class="verdict" id="verdict"></section>
  <section class="two">
    <div class="panel" id="reasons"></div>
    <div class="panel" id="deps"></div>
  </section>
  <section>
    <div class="fbar" id="fbar"></div>
    <div class="tw"><table><thead id="thead"></thead><tbody id="tbody"></tbody></table></div>
  </section>
</main>
<div id="overlay"></div>

<script>
const DATA = /*__DATA__*/null;
</script>
<script>
(function(){
"use strict";
const TODAY = DATA.today;
const REASON_SIDE = {"Procurement & Legal":"cust","Budget & Pricing":"both","Stakeholder Access":"cust","Customer Priority & Resourcing":"cust","Competitive":"both","Product Gap":"int","Technical / Integration":"both","Deal Execution Gap":"int","Low Engagement":"both"};
const SELLER = DATA.seller||"";
const SIDE_LABEL = {cust:"Customer",int:SELLER||"Internal",both:"Shared"};
const TIER_RANK = {"Strategic":3,"Enterprise":2,"Mid-Market":1};
const TYPE_MAP = {"New Business":"New Business","Upsell/Cross sell":"Upsell","Customer Renewal":"Renewal","Renewal + Upsell/Cross-sell":"Renewal + Upsell"};
const TYPES = ["New Business","Upsell","Renewal","Renewal + Upsell"];
const STATUS_LABEL = {at_risk:"At-Risk",slipping:"Slipping",on_track:"On Track",unanalyzed:"Not analyzed"};

const state = {deals: DATA.deals.slice(), quarters: DATA.quarters.slice(), filters:{ae:new Set(),csm:new Set(),tier:new Set(),q:new Set(),type:new Set(),status:new Set(),reason:new Set(),acct:""}, sort:{key:"rank",dir:1}, open:null, bucket:null, loading:false, msg:null};

// ---------- helpers
const $ = (s,r)=> (r||document).querySelector(s);
function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function money(n){if(n==null)return "—"; const a=Math.abs(n); if(a>=1e6)return "$"+(n/1e6).toFixed(a>=1e7?1:2).replace(/\.?0+$/,"")+"M"; if(a>=1e3)return "$"+Math.round(n/1e3)+"K"; return "$"+Math.round(n)}
function fdate(d){if(!d)return "—"; const [y,m,dd]=d.split("-").map(Number); return new Date(Date.UTC(y,m-1,dd)).toLocaleDateString("en-US",{month:"short",day:"numeric",timeZone:"UTC"})}
function statusKey(d){return d.status==="on_track"?"on_track":d.status==="not_on_track"?(d.severity==="at_risk"?"at_risk":"slipping"):"unanalyzed"}
function pillCls(k){return k==="on_track"?"ok":k==="slipping"?"warn":k==="at_risk"?"bad":"idle"}
function pillHtml(d){const k=statusKey(d);const lab=k==="on_track"?"On Track":k==="unanalyzed"?"Not analyzed":"Not On Track · "+STATUS_LABEL[k];return '<span class="pill '+pillCls(k)+'"><i></i>'+lab+'</span>'}
function stripeVar(k){return k==="on_track"?"var(--ok)":k==="slipping"?"var(--warn)":k==="at_risk"?"var(--bad)":"var(--idle)"}
function sum(a,f){return a.reduce((s,x)=>s+(f(x)||0),0)}
function isPast(d){return d.close < TODAY}

// ---------- filtering
function facets(){
  const by=(f)=>{const m=new Map();state.deals.forEach(d=>{const v=f(d);if(v)m.set(v,(m.get(v)||0)+1)});return [...m.entries()].sort((a,b)=>a[0].localeCompare(b[0]))};
  return {
    ae:by(d=>d.owner), csm:by(d=>d.csm),
    tier:[["Strategic",0],["Enterprise",0],["Mid-Market",0],["Unassigned",0]].map(([t])=>[t,state.deals.filter(d=>(d.tier||"Unassigned")===t||(t==="Unassigned"&&d.tier==="Not A Fit")).length]).filter(x=>x[1]),
    q:state.quarters.map(q=>[q.key,state.deals.filter(d=>d.q===q.key).length]),
    type:TYPES.map(t=>[t,state.deals.filter(d=>d.dtype===t).length]).filter(x=>x[1]),
    reason:Object.keys(REASON_SIDE).map(r=>[r,state.deals.filter(d=>d.reason===r).length]).filter(x=>x[1]),
    status:["at_risk","slipping","on_track","unanalyzed"].map(s=>[s,state.deals.filter(d=>statusKey(d)===s).length]).filter(x=>x[1])
  };
}
function tierOf(d){return (d.tier&&d.tier!=="Not A Fit")?d.tier:"Unassigned"}
function passes(d){
  const f=state.filters;
  if(f.ae.size&&!f.ae.has(d.owner))return false;
  if(f.csm.size&&!f.csm.has(d.csm))return false;
  if(f.tier.size&&!f.tier.has(tierOf(d)))return false;
  if(f.q.size&&!f.q.has(d.q))return false;
  if(f.type.size&&!f.type.has(d.dtype))return false;
  if(f.status.size&&!f.status.has(statusKey(d)))return false;
  if(f.reason.size&&!f.reason.has(d.reason))return false;
  if(f.acct&&!(d.acct||"").toLowerCase().includes(f.acct.toLowerCase())&&!(d.name||"").toLowerCase().includes(f.acct.toLowerCase()))return false;
  return true;
}
function filtered(){return state.deals.filter(passes)}
function anyFilter(){const f=state.filters;return f.ae.size||f.csm.size||f.tier.size||f.q.size||f.type.size||f.status.size||f.reason.size||f.acct}

// ---------- rank
function rank(d){const k=statusKey(d);const sev={at_risk:0,slipping:1,unanalyzed:2,on_track:3}[k];return sev*100000 + (3-(TIER_RANK[d.tier]||0))*10000 - Math.min(9999,Math.round((d.amt||0)/1000))/1}
function priorityWatch(d){return d.status==="not_on_track"&&d.tier==="Strategic"}

// ---------- header + notes
function renderHeader(){
  $("#built").textContent="Built "+DATA.builtAt+" · Backstory pipeline as of now · evidence window ~30 days";
  const sc=$("#scope");sc.innerHTML="";
  state.quarters.forEach((q,i)=>{const on=state.filters.q.has(q.key);const n=state.deals.filter(d=>d.q===q.key).length;const s=document.createElement("button");s.type="button";s.className="qchip"+(q.ext?" ext":"")+(on?" on":"");s.setAttribute("aria-pressed",on?"true":"false");s.title=on?"Showing only "+q.label+". Click to clear.":"Filter the whole view to "+q.label;s.innerHTML=esc(q.label)+" <small>"+esc(q.role)+" · "+n+"</small>";s.addEventListener("click",()=>{on?state.filters.q.delete(q.key):state.filters.q.add(q.key);renderAll()});sc.appendChild(s)});
  const nx=nextQuarter();
  const b=document.createElement("button");b.className="btn primary";b.id="addq";
  b.textContent=state.loading?"Loading "+nx.label+"…":"+ Add "+nx.label;
  b.disabled=state.loading||!nx;
  b.title="Ask the assistant to rebuild this dashboard with "+nx.label;
  b.addEventListener("click",()=>addQuarter(nx));
  sc.appendChild(b);
  if(state.quarters.some(q=>q.ext)){const r=document.createElement("button");r.className="btn ghost";r.textContent="Reset to current + next";r.addEventListener("click",resetQuarters);sc.appendChild(r)}
  const bn=$("#banner");bn.innerHTML="";
  if(state.msg){const d=document.createElement("div");d.className="banner "+state.msg.kind;d.innerHTML="<span>"+state.msg.html+"</span>";if(state.msg.copy){const c=document.createElement("button");c.className="btn";c.textContent="Copy prompt";c.addEventListener("click",()=>copyText(state.msg.copy,c));d.appendChild(c)}bn.appendChild(d)}
}
function renderNotes(){
  const n=$("#notes");
  const items=DATA.notes.map(t=>"<span>"+t+"</span>");
  const un=state.deals.filter(d=>statusKey(d)==="unanalyzed").length;
  if(un)items.push("<span><b>"+un+(un===1?" deal</b> has":" deals</b> have")+" pipeline data only: past the analysis limit or could not be scored. Ask the assistant to refresh."+"</span>");
  n.innerHTML=items.join("");
}

// ---------- verdict
function renderVerdict(){
  const ds=filtered();const tot=sum(ds,d=>d.amt);
  const g=k=>ds.filter(d=>statusKey(d)===k);
  const on=g("on_track"),sl=g("slipping"),ar=g("at_risk"),un=g("unanalyzed");
  const not=[...sl,...ar];
  const a=x=>sum(x,d=>d.amt);
  const pct=x=>tot>0?(a(x)/tot*100):(ds.length?x.length/ds.length*100:0);
  const analyzed=on.length+not.length;
  const el=$("#verdict");
  const scopeTxt=anyFilter()?'Showing '+ds.length+' of '+state.deals.length+' deals · <button class="linkbtn" id="clr">clear filters</button>':state.deals.length+' open deals across '+state.quarters.length+' quarters';
  el.innerHTML=
   '<div class="verdict-head"><h2>Portfolio verdict</h2><div class="showing">'+scopeTxt+'</div></div>'+
   '<div class="big">'+
     '<div><div class="k">Open pipeline</div><div class="v">'+money(tot)+'<small>'+ds.length+' deals</small></div></div>'+
     '<div><div class="k">On track</div><div class="v" style="color:var(--ok)">'+money(a(on))+'<small>'+on.length+' deals</small></div></div>'+
     '<div><div class="k">Not on track</div><div class="v" style="color:var(--bad)">'+money(a(not))+'<small>'+not.length+' deals</small></div></div>'+
     (un.length?'<div><div class="k">Not analyzed</div><div class="v" style="color:var(--ink-2)">'+money(a(un))+'<small>'+un.length+' deals</small></div></div>':'')+
   '</div>'+
   '<div class="bar" role="img" aria-label="Pipeline split by health">'+
     '<i class="c-ok" data-bk="status" data-bv="on_track" style="width:'+pct(on)+'%" title="On track: click to list"></i>'+
     '<i class="c-warn" data-bk="status" data-bv="slipping" style="width:'+pct(sl)+'%" title="Slipping: click to list"></i>'+
     '<i class="c-bad" data-bk="status" data-bv="at_risk" style="width:'+pct(ar)+'%" title="At-Risk: click to list"></i>'+
     '<i class="c-idle" data-bk="status" data-bv="unanalyzed" style="width:'+pct(un)+'%" title="Not analyzed: click to list"></i></div>'+
   '<div class="legend"><button type="button" data-bk="status" data-bv="on_track"><i class="sw c-ok"></i>On track '+on.length+'</button><button type="button" data-bk="status" data-bv="slipping"><i class="sw c-warn"></i>Slipping '+sl.length+' · '+money(a(sl))+'</button><button type="button" data-bk="status" data-bv="at_risk"><i class="sw c-bad"></i>At-Risk '+ar.length+' · '+money(a(ar))+'</button>'+(un.length?'<button type="button" data-bk="status" data-bv="unanalyzed"><i class="sw c-idle"></i>Not analyzed '+un.length+'</button>':'')+'<span style="margin-left:auto;color:var(--ink-3)">Bar width = $ amount</span></div>';
  const c=$("#clr");if(c)c.addEventListener("click",()=>{Object.values(state.filters).forEach(v=>v instanceof Set?v.clear():0);state.filters.acct="";state.bucket=null;renderAll()});
}

// ---------- reasons + dependencies (follow filters)
function renderReasons(){
  const ds=filtered().filter(d=>d.status==="not_on_track"&&d.reason);
  const m=new Map();ds.forEach(d=>{const r=m.get(d.reason)||{n:0,a:0,list:[]};r.n++;r.a+=d.amt||0;r.list.push(d);m.set(d.reason,r)});
  const arr=[...m.entries()].sort((a,b)=>b[1].a-a[1].a||b[1].n-a[1].n);
  const mx=Math.max(1,...arr.map(x=>x[1].a));
  const el=$("#reasons");
  let h='<h2>Why deals are not on track</h2><div class="hint">One primary reason per deal, ranked by $ at stake. '+ds.length+' deals.</div>';
  if(!arr.length)h+='<div class="empty">No not-on-track deals in the current view.</div>';
  arr.forEach(([name,r])=>{
    const accts=[...new Set(r.list.sort((a,b)=>(b.amt||0)-(a.amt||0)).map(d=>d.acct))].slice(0,3);
    const owners=new Set(r.list.map(d=>d.owner));
    const conc=owners.size===1?"All on "+[...owners][0]:(()=>{const c=new Map();r.list.forEach(d=>c.set(d.owner,(c.get(d.owner)||0)+1));const t=[...c.entries()].sort((a,b)=>b[1]-a[1])[0];return t[1]/r.n>=.5&&r.n>=3?"Concentrated on "+t[0]+" ("+t[1]+" of "+r.n+")":"Spread across "+owners.size+" AEs"})();
    h+='<div class="rr" role="button" tabindex="0" data-bk="reason" data-bv="'+esc(name)+'"><div><div class="nm">'+esc(name)+'<span class="side '+REASON_SIDE[name]+'">'+SIDE_LABEL[REASON_SIDE[name]]+'</span></div><div class="ac">'+esc(accts.join(", "))+' · '+esc(conc)+'</div></div>'+
      '<div class="tr"><i style="width:'+(r.a/mx*100)+'%"></i></div><div class="am num"><b>'+money(r.a)+'</b>'+r.n+' deal'+(r.n>1?'s':'')+'</div></div>';
  });
  el.innerHTML=h;
}
function renderDeps(){
  const ds=filtered().filter(d=>d.status==="not_on_track");
  const grp=s=>ds.filter(d=>(REASON_SIDE[d.reason]||"both")===s);
  const rows=[["cust","Waiting on the buyer","The primary blocker sits with the customer or prospect. Our lever is follow-up and executive pull.","var(--warn)"],["int","Ours to fix now","Fully within "+(SELLER?SELLER+"'s":"our")+" control: product, deal desk, exec sponsor, our own cadence.","var(--accent)"],["both","Shared","Needs movement on both sides.","var(--idle)"]];
  const tot=Math.max(1,sum(ds,d=>d.amt));
  const nc=sum(ds,d=>(d.customerActions||[]).length),ni=sum(ds,d=>(d.internalActions||[]).length);
  let h='<h2>Who has to move</h2><div class="hint">Not-on-track deals by who owns the primary blocker. '+ds.length+' deals, '+nc+' buyer-side and '+ni+' internal recommended steps.</div><div class="dep">';
  if(!ds.length)h+='<div class="empty">No not-on-track deals in the current view.</div>';
  else rows.forEach(([s,t,p,c])=>{const x=grp(s);const a=sum(x,d=>d.amt);h+='<div class="drow" role="button" tabindex="0" data-bk="side" data-bv="'+s+'"><div class="dh"><span class="dn">'+t+'</span><span class="num">'+money(a)+' · '+x.length+' deals</span></div><div class="db"><i style="width:'+(a/tot*100)+'%;background:'+c+'"></i></div><p>'+p+'</p></div>'});
  h+='</div>';$("#deps").innerHTML=h;
}

// ---------- filter bar
function msHtml(id,label,opts,sel,fmt){
  const on=sel.size>0;
  return '<div class="ms" data-ms="'+id+'"><button class="'+(on?'on':'')+'" aria-haspopup="true">'+label+(on?' <span class="cnt">'+sel.size+'</span>':'')+' ▾</button><div class="menu" hidden>'+
   opts.map(([v,n])=>'<label><input type="checkbox" value="'+esc(v)+'" '+(sel.has(v)?'checked':'')+'> '+esc(fmt?fmt(v):v)+'<span class="n">'+n+'</span></label>').join("")+'</div></div>';
}
function renderFilters(){
  const f=facets(),S=state.filters;
  const qopts=f.q.map(([k,n])=>[k,n]);
  const el=$("#fbar");
  const openId=(document.querySelector(".ms .menu:not([hidden])")||{}).parentNode;
  const openKey=openId?openId.getAttribute("data-ms"):null;
  el.innerHTML=
    '<input class="search" id="acs" type="search" placeholder="Search account or opp" value="'+esc(S.acct)+'" aria-label="Search account or opportunity">'+
    msHtml("ae","AE",f.ae,S.ae)+msHtml("csm","CSM",f.csm,S.csm)+msHtml("tier","Tier",f.tier,S.tier)+
    msHtml("q","Quarter",qopts,S.q,v=>(state.quarters.find(q=>q.key===v)||{}).label||v)+msHtml("type","Deal type",f.type,S.type)+
    msHtml("status","Status",f.status,S.status,v=>STATUS_LABEL[v])+msHtml("reason","Primary reason",f.reason,S.reason)+'<button type="button" class="linkbtn clr-all" id="clrall">Clear all filters</button>'+
    (state.bucket?'<span class="qchip on" id="bchip" style="cursor:default">Showing: '+esc(bucketLabel(state.bucket))+' <button class="linkbtn" id="bx" style="color:inherit">clear</button></span>':'')+'<span class="grow"></span><span class="showing">'+listDeals().length+' of '+state.deals.length+' deals</span>';
  const ca=$("#clrall");if(ca)ca.addEventListener("click",clearAll);
  const bx=$("#bx");if(bx)bx.addEventListener("click",()=>{state.bucket=null;renderAll()});
  const inp=$("#acs");
  inp.addEventListener("input",e=>{S.acct=e.target.value;const pos=e.target.selectionStart;renderAll(true);const n=$("#acs");n.focus();try{n.setSelectionRange(pos,pos)}catch(_){}});
  el.querySelectorAll(".ms").forEach(ms=>{
    const id=ms.getAttribute("data-ms"),btn=ms.querySelector("button"),menu=ms.querySelector(".menu");
    if(openKey===id)menu.hidden=false;
    btn.addEventListener("click",e=>{e.stopPropagation();const wasHidden=menu.hidden;document.querySelectorAll(".ms .menu").forEach(m=>m.hidden=true);menu.hidden=!wasHidden});
    menu.addEventListener("click",e=>e.stopPropagation());
    menu.querySelectorAll("input").forEach(cb=>cb.addEventListener("change",()=>{const set=S[id];cb.checked?set.add(cb.value):set.delete(cb.value);renderAll()}));
  });
}
document.addEventListener("click",()=>document.querySelectorAll(".ms .menu").forEach(m=>m.hidden=true));

// ---------- table
const COLS=[
 {k:"acct",t:"Account / opportunity"},{k:"tier",t:"Tier"},{k:"owner",t:"AE"},{k:"csm",t:"CSM"},{k:"q",t:"Quarter"},{k:"dtype",t:"Type"},
 {k:"amt",t:"Amount",r:1},{k:"stage",t:"Stage"},{k:"close",t:"Close"},{k:"rank",t:"Status",s:1},{k:"reason",t:"Primary reason"},{k:"outcome",t:"Likely outcome"}];
function sortVal(d,k){if(k==="rank")return rank(d);if(k==="tier")return -(TIER_RANK[d.tier]||0);if(k==="amt")return -(d.amt||0);return (d[k]||"").toString().toLowerCase()}
function renderTable(){
  const th=$("#thead");th.innerHTML="<tr>"+COLS.map(c=>'<th class="sort'+(c.r?' r':'')+'" data-k="'+c.k+'" tabindex="0" aria-sort="'+(state.sort.key===c.k?(state.sort.dir>0?'ascending':'descending'):'none')+'">'+c.t+(state.sort.key===c.k?(state.sort.dir>0?' ↑':' ↓'):'')+'</th>').join("")+"</tr>";
  th.querySelectorAll("th").forEach(h=>{const go=()=>{const k=h.getAttribute("data-k");state.sort=state.sort.key===k?{key:k,dir:-state.sort.dir}:{key:k,dir:1};renderTable()};h.addEventListener("click",go);h.addEventListener("keydown",e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();go()}})});
  const ds=listDeals().slice().sort((a,b)=>{const x=sortVal(a,state.sort.key),y=sortVal(b,state.sort.key);const c=x<y?-1:x>y?1:0;return (c||rank(a)-rank(b))*state.sort.dir});
  const tb=$("#tbody");
  if(!ds.length){tb.innerHTML='<tr><td colspan="'+COLS.length+'" class="empty" style="padding:24px">No deals match these filters.</td></tr>';return}
  tb.innerHTML=ds.map(d=>{const k=statusKey(d);const q=(state.quarters.find(x=>x.key===d.q)||{}).label||d.q;
    return '<tr class="stripe" style="--stripe:'+stripeVar(k)+'" data-id="'+esc(d.id)+'" tabindex="0"><td><div class="acct">'+esc(d.acct)+(priorityWatch(d)?'<span class="watch">priority</span>':'')+'</div><div class="opn">'+esc(d.name)+'</div></td>'+
     '<td><span class="tier '+(d.tier==='Strategic'?'s':'')+'">'+esc(tierOf(d))+'</span></td><td>'+esc(d.owner||"—")+'</td><td>'+esc(d.csm||"—")+'</td><td class="num">'+esc(q)+'</td><td>'+esc(d.dtype)+'</td>'+
     '<td class="r num'+(d.amt?'':' zero')+'">'+(d.amt?money(d.amt):(d.amt===0?"$0":"—"))+'</td><td>'+esc(d.stage)+'</td><td class="num'+(isPast(d)?'" style="color:var(--bad)" title="Close date has passed':'')+'">'+fdate(d.close)+'</td>'+
     '<td>'+pillHtml(d)+'</td><td>'+(d.reason?esc(d.reason):'<span class="zero">—</span>')+'</td><td class="out">'+esc(d.outcome||"")+'</td></tr>'}).join("");
  tb.querySelectorAll("tr[data-id]").forEach(r=>{const open=()=>openDeal(r.getAttribute("data-id"),r);r.addEventListener("click",open);r.addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();open()}})});
}

// ---------- drawer
function fmtWhen(s,e){try{const a=new Date(s),b=e?new Date(e):null;let out=a.toLocaleString("en-US",{weekday:"short",month:"short",day:"numeric",hour:"numeric",minute:"2-digit",timeZoneName:"short"});if(b&&!isNaN(b)){const m=Math.round((b-a)/60000);if(m>0)out+=" · "+(m>=60?(m/60)+" hr":m+" min")}return out}catch(_){return s||""}}
function evtBox(ev){return '<div class="evt"><div class="et">'+esc(ev.title)+'</div><div class="ed">'+esc(fmtWhen(ev.start,ev.end))+'</div><div class="ew">'+(ev.contact?'With <b>'+esc(ev.contact)+'</b>'+(ev.contactTitle?' ('+esc(ev.contactTitle)+')':'')+' · ':'')+(SELLER?SELLER+' host: ':'Host: ')+esc(ev.owner||"—")+(ev.location?' · '+esc(ev.location):'')+'</div></div>'}
function engHtml(a){
  if(!a.engage||!a.engage.length)return "";
  const stl={engaged:['st','Engaged in last 30 days'],not_engaged:['st no','Named, not recently engaged'],to_identify:['st tbd','Role to identify']};
  return '<ul class="eng"><li class="eh">Stakeholders to engage</li>'+a.engage.map(p=>{const s=stl[p.status]||null;return '<li><b>'+esc(p.name)+'</b>'+(p.title?' <span class="tt">'+esc(p.title)+'</span>':'')+(p.role?'<span class="rl">'+esc(p.role)+'</span>':'')+(s?'<span class="'+s[0]+'">'+s[1]+'</span>':'')+(p.why?'<div class="wy">'+esc(p.why)+'</div>':'')+'</li>'}).join("")+'</ul>';
}
let lastFocus=null;
function openDeal(id,from){
  const d=state.deals.find(x=>x.id===id);if(!d)return;lastFocus=from||null;state.open=id;
  const k=statusKey(d);
  const acts=(arr,cls,title,sub)=>{ if(!arr||!arr.length)return ""; return '<div class="grp '+cls+'"><h4>'+title+'<span>'+sub+'</span></h4><div class="lst">'+arr.map(a=>'<div class="item"><div class="it">'+esc(a.action)+'</div><div class="sm">Owner: <b>'+esc(a.owner||"—")+'</b> · By: <b>'+esc(a.by||"—")+'</b> · Unblocks: '+esc(a.unblocks||"—")+'</div>'+engHtml(a)+(a.eventId&&(d.upcoming||[]).some(x=>x.id===a.eventId)?evtBox((d.upcoming||[]).find(x=>x.id===a.eventId)):(a.eventNote?'<div class="evt"><div class="ew">'+esc(a.eventNote)+'</div></div>':''))+'<div class="src">'+(/rubric/i.test(a.source||"")?'Rubric-based':'Similar situation: '+esc(a.source||""))+'</div></div>').join("")+'</div></div>'};
  let body="";
  if(k==="unanalyzed"){
    body+='<div class="sec"><div class="callout">This deal has pipeline fields only: it was past the analysis limit or could not be scored. Ask the assistant to refresh it for risks, a reason and recommended steps.</div></div>';
    const flags=[];if(isPast(d))flags.push("Close date has passed ("+fdate(d.close)+")");if(!d.amt)flags.push("No amount on the opportunity");if(!d.csm)flags.push("No CSM assigned");if(!d.tier)flags.push("No account tier");
    if(flags.length)body+='<div class="sec"><h3>Data flags</h3><div class="kv">'+flags.map(f=>'<span class="chip">'+esc(f)+'</span>').join("")+'</div></div>';
  } else if(k==="on_track"){
    body+='<div class="sec"><h3>Why it is on track</h3><div class="callout">'+esc(d.onTrackNote||d.evidence||"")+'</div></div>';
    if(d.recordedNextStep)body+='<div class="sec"><h3>Recorded next step</h3><div class="callout">'+esc(d.recordedNextStep)+'</div></div>';
  } else {
    body+='<div class="sec"><h3>Why not on track</h3><div class="callout"><b>'+esc(d.reason||"Cause not identified")+'</b>'+(d.reason?'<span class="side '+REASON_SIDE[d.reason]+'">'+SIDE_LABEL[REASON_SIDE[d.reason]]+'</span>':'')+'<br>'+esc(d.evidence||"")+(d.secondary&&d.secondary.length?'<div class="kv" style="margin-top:8px">'+d.secondary.map(s=>'<span class="chip">'+esc(s)+'</span>').join("")+'</div>':'')+'</div></div>';
    if(d.recordedNextStep)body+='<div class="sec"><h3>Recorded next step</h3><div class="callout">'+esc(d.recordedNextStep)+'</div></div>';
    const c=acts(d.customerActions,"cust","Customer / Prospect dependent","what we need from the buyer");
    const i=acts(d.internalActions,"int",SELLER?SELLER+" internal":"Internal","what we can do ourselves");
    if(c||i)body+='<div class="sec"><h3>Recommended steps</h3><div class="lst">'+c+i+'</div>'+(d.situationNote?'<p class="sm" style="margin-top:8px;color:var(--ink-3);font-size:12px">'+esc(d.situationNote)+'</p>':'')+'</div>';
  }
  if(k!=="unanalyzed"){
    const up=d.upcoming||[];
    if(up.length)body+='<div class="sec"><h3>Upcoming meetings</h3><div class="meet">'+up.map(evtBox).join("")+'</div>'+((d.upcomingCount||0)>up.length?'<p class="sm" style="margin-top:8px;color:var(--ink-3);font-size:12px">+ '+((d.upcomingCount||0)-up.length)+' more scheduled</p>':'')+'</div>';
    const pp=d.people||{};const P=[["Champion",pp.champion],["Economic buyer",pp.economicBuyer]].filter(x=>x[1]&&x[1].name).map(x=>'<div class="person"><span class="pr">'+x[0]+'</span><b>'+esc(x[1].name)+'</b>'+(x[1].title?' <span class="pt">'+esc(x[1].title)+'</span>':'')+'</div>')
      .concat([["Exec sponsor",pp.execSponsor],["Solutions engineer",pp.se],["CSM",pp.csm],["AE",pp.owner]].filter(x=>x[1]).map(x=>'<div class="person"><span class="pr">'+x[0]+'</span><b>'+esc(x[1])+'</b></div>'));
    if(P.length)body+='<div class="sec"><h3>People on this deal</h3><div class="people">'+P.join("")+'</div></div>';
  }
  if(d.backstoryRisks&&d.backstoryRisks.length)body+='<div class="sec"><h3>Backstory risks</h3><div class="lst">'+d.backstoryRisks.map(r=>'<div class="item">'+esc(r)+'</div>').join("")+'</div></div>';
  if(d.slack&&d.slack.length)body+='<div class="sec"><h3>Slack signals</h3><div class="lst">'+d.slack.map(s=>'<div class="item"><div class="it">'+esc(s.gist)+'</div><div class="sm">#'+esc(String(s.channel||"").replace(/^#/,""))+' · '+esc(s.date||"")+' · '+esc(s.author||"")+'</div></div>').join("")+'</div></div>';
  if(d.jira&&d.jira.length)body+='<div class="sec"><h3>Jira tickets</h3><div class="lst">'+d.jira.map(j=>'<div class="item"><div><span class="jira-t">'+esc(j.key)+'</span> <span class="chip">'+esc(j.tag||"")+'</span> <span class="chip">'+esc(j.status||"")+'</span></div><div class="it" style="margin-top:4px">'+esc(j.summary)+'</div><div class="sm">'+esc(j.why||"")+'</div></div>').join("")+'</div></div>';
  const q=(state.quarters.find(x=>x.key===d.q)||{}).label||d.q;
  const html='<div class="scrim" id="scrim"></div><aside class="drawer" role="dialog" aria-modal="true" aria-label="Deal detail"><div class="dh-top"><div style="min-width:0"><h2>'+esc(d.acct)+'</h2><div class="opn" style="max-width:none">'+esc(d.name)+'</div><div style="margin-top:8px">'+pillHtml(d)+'</div>'+
   '<div class="meta"><span>Tier <b>'+esc(tierOf(d))+'</b></span><span>AE <b>'+esc(d.owner||"—")+'</b></span><span>CSM <b>'+esc(d.csm||"—")+'</b></span>'+(d.se?'<span>SE <b>'+esc(d.se)+'</b></span>':'')+'<span>'+esc(d.dtype)+'</span><span>'+esc(d.stage)+'</span><span><b>'+(d.amt?money(d.amt):(d.amt===0?"$0":"—"))+'</b></span><span>Close <b>'+fdate(d.close)+'</b> · '+esc(q)+'</span></div>'+
   (k!=="unanalyzed"&&d.outcome?'<div class="meta"><span>Likely outcome: <b>'+esc(d.outcome)+'</b></span></div>':'')+'</div><button class="x" id="xbtn" aria-label="Close">✕</button></div><div class="db-body">'+body+'</div></aside>';
  $("#overlay").innerHTML=html;
  $("#scrim").addEventListener("click",closeDeal);$("#xbtn").addEventListener("click",closeDeal);$("#xbtn").focus();
}
function closeDeal(){state.open=null;$("#overlay").innerHTML="";if(lastFocus&&lastFocus.focus)lastFocus.focus()}
// ---------- bucket -> deal list (same drill-in as the list rows)
function bucketPred(b){
  if(!b)return ()=>true;const k=b.kind,v=b.val;
  if(k==="reason")return d=>d.status==="not_on_track"&&d.reason===v;
  if(k==="side")return d=>d.status==="not_on_track"&&(REASON_SIDE[d.reason]||"both")===v;
  return d=>statusKey(d)===v;
}
function bucketLabel(b){
  if(b.kind==="reason")return b.val;
  if(b.kind==="side")return {cust:"Waiting on the buyer",int:"Ours to fix now",both:"Shared"}[b.val];
  return b.val==="on_track"?"On Track":b.val==="unanalyzed"?"Not analyzed":"Not On Track · "+STATUS_LABEL[b.val];
}
function listDeals(){return filtered().filter(bucketPred(state.bucket))}
function setBucket(kind,val){
  const b=state.bucket;state.bucket=(b&&b.kind===kind&&b.val===val)?null:{kind:kind,val:val};
  renderAll();
  if(state.bucket){let rm=false;try{rm=window.matchMedia("(prefers-reduced-motion: reduce)").matches}catch(_){}$("#fbar").scrollIntoView({behavior:rm?"auto":"smooth",block:"start"})}
}
function markActiveBuckets(){
  const b=state.bucket;
  document.querySelectorAll("[data-bk]").forEach(el=>{const on=!!b&&el.getAttribute("data-bk")===b.kind&&el.getAttribute("data-bv")===b.val;el.classList.toggle("active",on);if(el.getAttribute("role")==="button")el.setAttribute("aria-pressed",on?"true":"false")});
}
document.addEventListener("click",e=>{const el=e.target.closest&&e.target.closest("[data-bk]");if(el)setBucket(el.getAttribute("data-bk"),el.getAttribute("data-bv"))});
document.addEventListener("keydown",e=>{const el=e.target;if((e.key==="Enter"||e.key===" ")&&el&&el.getAttribute&&el.getAttribute("role")==="button"&&el.hasAttribute("data-bk")){e.preventDefault();setBucket(el.getAttribute("data-bk"),el.getAttribute("data-bv"))}});
document.addEventListener("keydown",e=>{if(e.key==="Escape"&&state.open)closeDeal()});

// ---------- quarters: extend / reset
function fiscalQuarterAfter(q){ // quarters are 3 months; the year is named for the year it ends
  const [y,m]=q.end.split("-").map(Number);
  let sy=y,sm=m+1; if(sm>12){sm=1;sy++}
  const start=sy+"-"+String(sm).padStart(2,"0")+"-01";
  let ey=sy,em=sm+2; if(em>12){em-=12;ey++}
  const endDay=new Date(Date.UTC(ey,em,0)).getUTCDate();
  const end=ey+"-"+String(em).padStart(2,"0")+"-"+String(endDay).padStart(2,"0");
  const fs=DATA.fiscalYearStartMonth||1;const sm0=Number(start.slice(5,7));const fq=Math.floor(((sm0-fs+12)%12)/3)+1;
  let fy=Number(start.slice(0,4)); if(fs>1&&sm0>=fs)fy=fy+1; // Feb 2027 -> FY28 when the year starts in February
  return {key:"FY"+String(fy).slice(2)+"Q"+fq,label:"FY"+String(fy).slice(2)+" Q"+fq,start,end,role:"Added",ext:true};
}
function nextQuarter(){return fiscalQuarterAfter(state.quarters[state.quarters.length-1])}
function resetQuarters(){state.bucket=null;state.quarters=DATA.quarters.slice();state.deals=DATA.deals.slice();state.filters.q.clear();state.msg=null;renderAll()}
function copyText(t,btn){try{navigator.clipboard.writeText(t).then(()=>{btn.textContent="Copied"},()=>{btn.textContent="Copy failed"})}catch(_){btn.textContent="Copy failed"}}
function addQuarter(q){
  const prompt="Refresh my CRO dashboard and include "+q.label+" ("+q.start+" to "+q.end+") with full evidence, reasons and recommendations.";
  state.msg={kind:"info",html:"This page cannot reach your data on its own, so the assistant adds quarters. Ask it beside this page: <b>"+esc(prompt)+"</b>",copy:prompt};
  renderHeader();
}

// ---------- boot
function clearAll(){Object.values(state.filters).forEach(v=>{if(v instanceof Set)v.clear()});state.filters.acct="";state.bucket=null;renderAll()}
function syncClear(){const b=$("#clrall");if(b)b.hidden=!(anyFilter()||state.bucket)}
function renderAll(keepFilters){
  renderHeader();renderNotes();renderVerdict();renderReasons();renderDeps();if(!keepFilters)renderFilters();else{const el=$(".showing:last-child");}renderTable();markActiveBuckets();syncClear();
  if(keepFilters){const f=$("#fbar .showing");if(f)f.textContent=listDeals().length+" of "+state.deals.length+" deals"}
}
renderAll();
})();
</script>
</body>
</html>
`

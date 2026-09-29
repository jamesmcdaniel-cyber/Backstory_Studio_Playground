import type { RoiNarrative } from './contract'
import type { RoiFacts } from './prep'

/**
 * The ROI dashboard document — the original analysis's page, made
 * account-agnostic.
 *
 * Structure, styles and chart code are the reference dashboard's own
 * (Plotly, seven tabs, a "What this shows" aside beside every chart, the
 * upside calculator, the Method tab). What changed: the data objects come
 * from the prep (U, OPP, ST, META), the account-specific prose is filled
 * from the agent's narrative, sections whose data is missing are left out
 * rather than drawn empty, and Plotly loads from /vendor because the
 * frame's CSP allows nothing off our origin (fonts excepted).
 */

export type RoiDashboardOptions = {
  account: string
  generatedAt?: string
  timeframePreset?: string
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char)
}

/** JSON that is safe inside a <script> block: no way to close the tag early. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/<\//g, '<\\/')
    .replace(/<!--/g, '<\\!--')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

/** Narrative paragraphs: escaped, with **bold** allowed for the numbers. */
function paragraphs(items: string[] | undefined): string {
  if (!items?.length) return ''
  return items.map((item) => `<p>${inline(item)}</p>`).join('')
}

function inline(text: string): string {
  return escapeHtml(text).replace(/\*\*(.+?)\*\*/g, '<b class="num">$1</b>')
}

function monthLabel(month: string): string {
  const [year, mm] = month.split('-')
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(mm) - 1]} ${year}`
}

const CSS = String.raw`
:root{
  --page:#FFFFFF; --surface:#F5F5F5; --raised:#FFFFFF; --text:#171721; --text2:#55555E; --text3:#7F7F85;
  --rule:#E3E3E5; --rule-strong:#BBBCBC; --mast:#171721; --mast-text:#FFFFFF; --mast-sub:#BBBCBC;
  --horizon:#6296AD; --horizon-deep:#447C93; --accent-subtle:#DBEBF2;
  --d1:#6296AD; --d2:#5BA779; --d3:#B08FA2; --d4:#9FDFFF; --d5:#CEB375; --neg:#C05527; --pos:#5BA779;
  --serif:'Cardo',Georgia,'Times New Roman',serif;
  --sans:'Roboto',system-ui,-apple-system,'Segoe UI',Arial,sans-serif;
  --mono:'Chivo Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  box-sizing:border-box;
}
@media (prefers-color-scheme: dark){
  :root:not([data-theme="light"]){
    --page:#171721; --surface:#22222C; --raised:#31313C; --text:#F5F5F5; --text2:#ABABAD; --text3:#8C8C92;
    --rule:#31313C; --rule-strong:#55555E; --mast:#000000; --mast-text:#FFFFFF; --mast-sub:#ABABAD;
    --horizon:#7DACC0; --horizon-deep:#99C1D1; --accent-subtle:#0A2F3F;
    --d1:#7DACC0; --d2:#8FCDA8; --d3:#E8DDE3; --d4:#21B5FF; --d5:#CEB375; --neg:#E07B4F; --pos:#8FCDA8;
  }
}
:root[data-theme="dark"]{
  --page:#171721; --surface:#22222C; --raised:#31313C; --text:#F5F5F5; --text2:#ABABAD; --text3:#8C8C92;
  --rule:#31313C; --rule-strong:#55555E; --mast:#000000; --mast-text:#FFFFFF; --mast-sub:#ABABAD;
  --horizon:#7DACC0; --horizon-deep:#99C1D1; --accent-subtle:#0A2F3F;
  --d1:#7DACC0; --d2:#8FCDA8; --d3:#E8DDE3; --d4:#21B5FF; --d5:#CEB375; --neg:#E07B4F; --pos:#8FCDA8;
}
*,*::before,*::after{box-sizing:inherit;margin:0;padding:0}
html{-webkit-text-size-adjust:100%}
body{background:var(--page);color:var(--text);font-family:var(--sans);font-size:16px;line-height:1.5}
a{color:var(--horizon-deep)}
:focus-visible{outline:2px solid var(--horizon);outline-offset:2px}
.wrap{max-width:1240px;margin:0 auto;padding:0 28px}
.num{font-family:var(--mono);font-variant-numeric:tabular-nums}
.mast{background:var(--mast);color:var(--mast-text);padding:40px 0 36px}
.brand{display:flex;align-items:center;gap:10px;font-weight:500;font-size:15px;letter-spacing:.01em}
.brand svg{width:22px;height:18px}
.mast-meta{color:var(--mast-sub);font-size:13px;margin-top:4px}
.mast-grid{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);gap:48px;align-items:end;margin-top:36px}
.mast h1{font-family:var(--serif);font-weight:400;font-size:clamp(34px,4.6vw,56px);line-height:1.06;letter-spacing:-.02em;max-width:17ch}
.mast .lede{color:var(--mast-sub);font-size:17px;margin-top:18px;max-width:52ch}
.strip-wrap figcaption{color:var(--mast-sub);font-size:13px;margin-top:6px}
#heroStrip{height:230px}
nav.tabs{position:sticky;top:0;z-index:20;background:var(--page);border-bottom:1px solid var(--rule)}
nav.tabs .wrap{display:flex;gap:4px;overflow-x:auto;scrollbar-width:none}
nav.tabs button{font:500 14px var(--sans);color:var(--text2);background:none;border:0;padding:16px 14px 14px;border-bottom:2px solid transparent;cursor:pointer;white-space:nowrap}
nav.tabs button[aria-selected="true"]{color:var(--text);border-bottom-color:var(--horizon)}
nav.tabs button:hover{color:var(--text)}
section.panel{display:none;padding:40px 0 72px}
section.panel.active{display:block}
.panel h2{font-family:var(--serif);font-weight:400;font-size:clamp(28px,3vw,40px);line-height:1.1;letter-spacing:-.01em;max-width:28ch}
.panel .intro{color:var(--text2);font-size:17px;max-width:70ch;margin-top:10px}
.panel h3{font-size:18px;font-weight:500;margin-bottom:4px}
.sub{color:var(--text2);font-size:14px;max-width:68ch}
.block{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:36px;margin-top:40px;padding-top:28px;border-top:1px solid var(--rule)}
.block.full{grid-template-columns:minmax(0,1fr)}
.chart{height:380px;margin-top:14px}
.chart.tall{height:460px}
.chart.short{height:300px}
aside.note{font-size:15px;color:var(--text2);border-left:2px solid var(--horizon);padding:2px 0 2px 18px;align-self:start}
aside.note h4{font-size:14px;font-weight:500;color:var(--text);margin-bottom:8px}
aside.note p+p{margin-top:10px}
aside.note b{color:var(--text);font-weight:500}
.twocol{display:grid;grid-template-columns:1fr 1fr;gap:28px}
.controls{display:flex;flex-wrap:wrap;gap:18px 28px;align-items:flex-end;margin-top:24px}
.ctl{display:flex;flex-direction:column;gap:6px}
.ctl>span{font-size:13px;color:var(--text2)}
.seg{display:inline-flex;border:1px solid var(--rule-strong);border-radius:6px;overflow:hidden}
.seg button{font:400 14px var(--sans);background:var(--raised);color:var(--text2);border:0;padding:7px 12px;cursor:pointer;border-right:1px solid var(--rule-strong)}
.seg button:last-child{border-right:0}
.seg button[aria-pressed="true"]{background:var(--text);color:var(--page)}
select,input[type=number]{font:400 14px var(--sans);color:var(--text);background:var(--raised);border:1px solid var(--rule-strong);border-radius:6px;padding:7px 10px}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chips button{font:400 13px var(--sans);background:transparent;color:var(--text2);border:1px solid var(--rule-strong);border-radius:999px;padding:5px 12px;cursor:pointer}
.chips button[aria-pressed="true"]{background:var(--horizon);border-color:var(--horizon);color:#000}
.custom{display:none;gap:18px;flex-wrap:wrap}
.custom.on{display:flex}
.toggle{display:flex;align-items:center;gap:8px;font-size:14px;color:var(--text2);cursor:pointer}
.tbl-wrap{overflow-x:auto;margin-top:14px}
table{border-collapse:collapse;width:100%;font-size:14px}
th{font-weight:500;color:var(--text2);text-align:right;padding:9px 12px;border-bottom:1px solid var(--rule-strong);white-space:nowrap}
th:first-child,td:first-child{text-align:left}
td{padding:9px 12px;border-bottom:1px solid var(--rule);text-align:right;font-family:var(--mono);font-size:13px;white-space:nowrap}
td:first-child{font-family:var(--sans);font-size:14px}
td.up{color:var(--pos)} td.down{color:var(--neg)}
.findings{margin-top:32px;border-top:1px solid var(--rule-strong)}
.finding{display:grid;grid-template-columns:220px minmax(0,1fr);gap:28px;padding:22px 0;border-bottom:1px solid var(--rule)}
.finding .fig{font-family:var(--mono);font-size:40px;line-height:1;color:var(--horizon-deep);letter-spacing:-.02em}
.finding .fig small{display:block;font-size:13px;color:var(--text2);letter-spacing:0;margin-top:8px;font-family:var(--sans)}
.finding h3{font-size:19px}
.finding p{color:var(--text2);max-width:72ch;margin-top:4px}
.finding .go{font:500 14px var(--sans);color:var(--horizon-deep);background:none;border:0;padding:0;margin-top:8px;cursor:pointer;text-decoration:underline;text-underline-offset:3px}
.watch{margin-top:40px;background:var(--surface);padding:24px 28px;border-radius:4px}
.watch h3{margin-bottom:10px}
.watch li{margin:6px 0 0 18px;color:var(--text2);max-width:90ch}
.watch li b{color:var(--text);font-weight:500}
.calc{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:36px;margin-top:40px;padding-top:28px;border-top:1px solid var(--rule)}
.calc-inputs{display:grid;gap:18px;margin-top:16px}
.calc-inputs label{display:grid;gap:6px;font-size:14px;color:var(--text2)}
.calc-inputs input[type=range]{width:100%;accent-color:var(--horizon)}
.calc-out{background:var(--mast);color:var(--mast-text);padding:28px;border-radius:4px;align-self:start}
.calc-out .big{font-family:var(--mono);font-size:44px;line-height:1.05;margin-top:6px}
.calc-out .row{display:flex;justify-content:space-between;gap:12px;border-top:1px solid #31313C;padding:10px 0;font-size:14px;color:var(--mast-sub)}
.calc-out .row span:last-child{font-family:var(--mono);color:var(--mast-text)}
.calc-out p{font-size:13px;color:var(--mast-sub);margin-top:12px}
.dyn{margin-top:14px;font-size:15px;color:var(--text);background:var(--accent-subtle);padding:12px 16px;border-radius:4px;max-width:900px}
.method p,.method li{color:var(--text2);max-width:78ch}
.method h3{margin-top:28px}
.method li{margin:6px 0 0 18px}
footer{border-top:1px solid var(--rule);padding:22px 0 40px;color:var(--text3);font-size:13px}
.themebtn{float:right;font:400 13px var(--sans);background:none;border:1px solid #55555E;color:var(--mast-sub);border-radius:999px;padding:4px 12px;cursor:pointer}
.hidden{display:none!important}
@media (max-width:920px){
  .mast-grid,.block,.calc,.twocol{grid-template-columns:minmax(0,1fr)}
  .finding{grid-template-columns:minmax(0,1fr);gap:8px}
  .wrap{padding:0 18px}
  aside.note{border-left:0;border-top:2px solid var(--horizon);padding:14px 0 0}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
@media print{nav.tabs,.controls,.themebtn{display:none}section.panel{display:block}}
`

const SCRIPT = String.raw`
(function(){
'use strict';
const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const css=v=>getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const HAS={U:!!U, usage:!!(U&&U.hasUsage), OPP:!!OPP, ST:!!ST, vel:!!(META&&META.hasVelocity)};
const MK=U?Object.keys(U.labels):[], LAB=U?U.labels:{}, MON=U?U.months:[], NM=MON.length;
const isMoney=k=>k.startsWith('pipeline');
const fmt=(v,k)=>{if(v==null||isNaN(v))return '–'; if(isMoney(k)){const a=Math.abs(v); if(a>=1e6)return '$'+(v/1e6).toFixed(2)+'M'; if(a>=1e3)return '$'+(v/1e3).toFixed(0)+'K'; return '$'+v.toFixed(0);} return v.toFixed(v<10?2:1);};
const pct=(a,b)=>(b?((a/b-1)*100):NaN);
const sp=v=>isNaN(v)?'–':(v>=0?'+':'')+v.toFixed(1)+'%';
const mlab=m=>{const [y,mm]=m.split('-');return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+mm-1]+' '+y.slice(2);};
const money=v=>(v==null||isNaN(v))?'–':'$'+(Math.abs(v)>=1e6?(v/1e6).toFixed(1)+'M':Math.abs(v)>=1e3?(v/1e3).toFixed(0)+'K':Math.round(v));
const n0=v=>(v==null||isNaN(v))?'–':Math.round(v).toLocaleString();

/* ---------- theme ---------- */
let themeMode='auto';
$('#themeBtn').onclick=()=>{themeMode=themeMode==='auto'?'light':themeMode==='light'?'dark':'auto';
  if(themeMode==='auto')document.documentElement.removeAttribute('data-theme');else document.documentElement.setAttribute('data-theme',themeMode);
  $('#themeBtn').textContent='Theme: '+themeMode; rerender();};
try{window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change',()=>{if(themeMode==='auto')rerender();});}catch(e){}

function base(extra){
  const t=css('--text'),t2=css('--text2'),r=css('--rule');
  const L={paper_bgcolor:'rgba(0,0,0,0)',plot_bgcolor:'rgba(0,0,0,0)',font:{family:css('--sans'),size:13,color:t2},
    margin:{l:56,r:20,t:14,b:48},hoverlabel:{font:{family:'Chivo Mono, monospace',size:12},bgcolor:css('--raised'),bordercolor:css('--rule-strong'),font_color:t},
    xaxis:{gridcolor:r,linecolor:css('--rule-strong'),zeroline:false,tickfont:{family:'Chivo Mono, monospace',size:11}},
    yaxis:{gridcolor:r,zeroline:false,tickfont:{family:'Chivo Mono, monospace',size:11},rangemode:'tozero'},
    legend:{orientation:'h',y:-0.18,x:0,font:{size:13,color:t2}},bargap:0.28};
  return Object.assign(L,extra||{});
}
const CFG={displayModeBar:false,responsive:true};
function plot(id,data,layout){const el=document.getElementById(id); if(!el||!window.Plotly)return; Plotly.react(el,data,layout,CFG);}

/* ---------- user-level math ---------- */
function popMask(p){return U.users.map(u=>p==='all'?true:(p==='User'||p==='Non-user')?u.f===p:u.t===p);}
function winAvg(mask,mi){
  const out={}; let n=0;
  for(const k of MK){let s=0,c=0; const M=U.m[k];
    for(let i=0;i<M.length;i++){if(!mask[i])continue; let rs=0,rc=0; for(const j of mi){const v=M[i][j]; if(v!=null){rs+=v;rc++;}} if(rc){s+=rs/rc;c++;}}
    out[k]=c?s/c:NaN; if(k==='meeting_count')n=c;}
  out.n=n; return out;}
function monthly(mask,k){const M=U.m[k],r=[];for(let j=0;j<NM;j++){let s=0,c=0;for(let i=0;i<M.length;i++){if(!mask[i])continue;const v=M[i][j];if(v!=null){s+=v;c++;}}r.push(c?s/c:null);}return r;}
const rng=(a,b)=>{const r=[];for(let i=Math.max(0,a);i<=b;i++)r.push(i);return r;};
const W=NM?{L6:rng(NM-6,NM-1),P6:rng(NM-12,NM-7),PY:rng(NM-18,NM-13),L12:rng(NM-12,NM-1),P12:rng(0,NM-13),L3:rng(NM-3,NM-1),P3:rng(NM-6,NM-4)}:{};
const wl=w=>w&&w.length?mlab(MON[w[0]])+' – '+mlab(MON[w[w.length-1]]):'–';
const DEAL_ALL=OPP?(OPP['All (excl. renewals)']?'All (excl. renewals)':Object.keys(OPP)[0]):null;

/* ---------- hero ---------- */
function renderHero(){
  if(!HAS.OPP){ if(HAS.U){ const s=monthly(popMask('all'),'dir_vp_exec'); const hz=css('--horizon');
    plot('heroStrip',[{type:'scatter',mode:'lines',x:MON.map(mlab),y:s,line:{color:hz,width:2.5},hovertemplate:'%{x}<br>%{y:.2f}<extra></extra>'}],
      base({margin:{l:4,r:4,t:12,b:26},font:{family:css('--sans'),color:'#BBBCBC'},xaxis:{showgrid:false,linecolor:'#55555E',nticks:6,tickfont:{family:'Chivo Mono, monospace',size:11,color:'#BBBCBC'}},yaxis:{visible:false}}));
    $('#heroCap').textContent='Director, VP and executive meetings per rep per month, all reps'; } return; }
  const d=OPP[DEAL_ALL].excl.deciles; const hz=css('--horizon');
  plot('heroStrip',[{type:'bar',x:d.map(r=>'D'+r.dec),y:d.map(r=>r.win_rate),marker:{color:d.map((r,i)=>i>=7?hz:'#55555E')},
    text:d.map(r=>(r.win_rate==null?'–':r.win_rate.toFixed(0)+'%')),textposition:'outside',textfont:{family:'Chivo Mono, monospace',size:12,color:'#FFFFFF'},cliponaxis:false,
    hovertemplate:'Decile %{x}<br>Win rate %{y:.1f}%<extra></extra>'}],
    base({margin:{l:4,r:4,t:22,b:26},font:{family:css('--sans'),color:'#BBBCBC'},xaxis:{showgrid:false,linecolor:'#55555E',tickfont:{family:'Chivo Mono, monospace',size:11,color:'#BBBCBC'}},yaxis:{visible:false,range:[0,Math.max(10,...d.map(r=>r.win_rate||0))*1.2]},bargap:.18}));
}

/* ---------- summary ---------- */
function renderSummary(){
  $('#findings').innerHTML=N.findings.map(f=>'<div class="finding"><div class="fig">'+esc(f.fig)+'<small>'+esc(f.cap)+'</small></div><div><h3>'+esc(f.h)+'</h3><p>'+md(f.p)+'</p>'+(TABS[f.tab]?'<button class="go" data-go="'+f.tab+'" type="button">See the detail</button>':'')+'</div></div>').join('');
  $$('.go').forEach(b=>b.onclick=()=>{showTab(b.dataset.go);window.scrollTo({top:$('nav.tabs').offsetTop,behavior:'smooth'});});
  $('#watch').innerHTML=N.watch.map(w=>'<li><b>'+esc(w.lead)+'</b> '+md(w.text)+'</li>').join('');
}
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const md=s=>esc(s).replace(/\*\*(.+?)\*\*/g,'<b class="num">$1</b>');

/* ---------- calculator ---------- */
function setupCalc(){
  if(!HAS.OPP||META.medWon==null){ $('#calc').classList.add('hidden'); return; }
  const types=Object.keys(OPP);
  $('#cType').innerHTML=types.map(t=>'<option>'+esc(t)+'</option>').join('');
  $('#cVal').value=Math.round(META.medWon);
  $('#cValNote').textContent='Default is the median won deal value ('+money(META.medWon)+'). The mean, capped at the 95th percentile, is '+money(META.meanWonCap)+'.';
  ['cPct','cType','cVal'].forEach(id=>document.getElementById(id).addEventListener('input',calc));
  calc();
}
function calc(){
  const p=+$('#cPct').value/100, t=$('#cType').value, v=+$('#cVal').value||0; $('#cPctL').textContent=Math.round(p*100)+'%';
  const lv=OPP[t].excl.levels; if(lv.length<2){return;} const yrs=Math.max(1,NM/12); const nYr=lv[0].n/yrs; const lift=nYr*p; const dw=((lv[1].win_rate||0)-(lv[0].win_rate||0))/100; const wins=lift*dw;
  $('#cN').textContent=n0(nYr); $('#cLift').textContent=n0(lift);
  $('#cWR').textContent=(lv[0].win_rate||0).toFixed(1)+'% → '+(lv[1].win_rate||0).toFixed(1)+'%'; $('#cWins').textContent=n0(wins);
  $('#cBig').textContent=money(wins*v);
}

/* ---------- leading indicators ---------- */
let leadMetric='dir_vp_exec', leadMode=PRESET==='last6_vs_year_ago'?'yoy':PRESET==='last12_vs_prior12'?'y12':PRESET==='last3_vs_prior3'?'q':'pp';
function setupLead(){
  $('#leadMetric').innerHTML=MK.map(k=>'<button type="button" data-k="'+k+'" aria-pressed="'+(k===leadMetric)+'">'+esc(LAB[k])+'</button>').join('');
  $$('#leadMetric button').forEach(b=>b.onclick=()=>{leadMetric=b.dataset.k;$$('#leadMetric button').forEach(x=>x.setAttribute('aria-pressed',x===b));renderLead();});
  const opts=MON.map((m,i)=>'<option value="'+i+'">'+mlab(m)+'</option>').join('');
  ['bS','bE','oS','oE'].forEach(id=>document.getElementById(id).innerHTML=opts);
  $('#bS').value=Math.max(0,NM-12);$('#bE').value=Math.max(0,NM-7);$('#oS').value=Math.max(0,NM-6);$('#oE').value=NM-1;
  if(!HAS.usage){ $('#leadPop').innerHTML='<option value="all">All reps</option>'; }
  $$('#leadMode button').forEach(b=>b.setAttribute('aria-pressed',b.dataset.v===leadMode));
  segBind('#leadMode',v=>{leadMode=v;$('#leadCustom').classList.toggle('on',v==='custom');renderLead();});
  ['bS','bE','oS','oE','leadPop'].forEach(id=>document.getElementById(id).addEventListener('change',renderLead));
}
function leadWindows(){
  if(leadMode==='pp')return [W.P6,W.L6,'Prior 6 months ('+wl(W.P6)+')','Last 6 months ('+wl(W.L6)+')'];
  if(leadMode==='yoy')return [W.PY,W.L6,'Same period last year ('+wl(W.PY)+')','Last 6 months ('+wl(W.L6)+')'];
  if(leadMode==='y12')return [W.P12,W.L12,'Prior 12 months ('+wl(W.P12)+')','Last 12 months ('+wl(W.L12)+')'];
  if(leadMode==='q')return [W.P3,W.L3,'Prior quarter ('+wl(W.P3)+')','Last quarter ('+wl(W.L3)+')'];
  let a=+$('#bS').value,b=+$('#bE').value,c=+$('#oS').value,d=+$('#oE').value; if(b<a)[a,b]=[b,a]; if(d<c)[c,d]=[d,c];
  return [rng(a,b),rng(c,d),'Baseline ('+mlab(MON[a])+' – '+mlab(MON[b])+')','Observation ('+mlab(MON[c])+' – '+mlab(MON[d])+')'];
}
function renderLead(){
  const pop=$('#leadPop').value, mask=popMask(pop), [bw,ow,bl,ol]=leadWindows();
  const B=winAvg(mask,bw), O=winAvg(mask,ow), k=leadMetric, series=monthly(mask,k);
  const hz=css('--horizon'), shapes=[];
  if(bw.length)shapes.push({type:'rect',xref:'x',yref:'paper',x0:bw[0]-.5,x1:bw[bw.length-1]+.5,y0:0,y1:1,fillcolor:css('--rule-strong'),opacity:.18,line:{width:0},layer:'below'},{type:'line',xref:'x',x0:bw[0]-.5,x1:bw[bw.length-1]+.5,y0:B[k],y1:B[k],line:{color:css('--text3'),width:2,dash:'dot'}});
  if(ow.length)shapes.push({type:'rect',xref:'x',yref:'paper',x0:ow[0]-.5,x1:ow[ow.length-1]+.5,y0:0,y1:1,fillcolor:hz,opacity:.16,line:{width:0},layer:'below'},{type:'line',xref:'x',x0:ow[0]-.5,x1:ow[ow.length-1]+.5,y0:O[k],y1:O[k],line:{color:css('--horizon-deep'),width:2,dash:'dot'}});
  $('#leadTitle').textContent=LAB[k]+', monthly average per rep';
  plot('leadTrend',[{type:'scatter',mode:'lines+markers',x:MON.map((m,i)=>i),y:series,line:{color:hz,width:2.5,shape:'spline',smoothing:.4},marker:{size:6,color:hz},
    customdata:MON.map(mlab),hovertemplate:'%{customdata}<br>'+(isMoney(k)?'$%{y:,.0f}':'%{y:.2f}')+'<extra></extra>',name:LAB[k]}],
    base({shapes,showlegend:false,xaxis:{tickmode:'array',tickvals:MON.map((m,i)=>i).filter(i=>i%3===0),ticktext:MON.filter((m,i)=>i%3===0).map(mlab),gridcolor:'rgba(0,0,0,0)',linecolor:css('--rule-strong'),tickfont:{family:'Chivo Mono, monospace',size:11}},
      yaxis:{gridcolor:css('--rule'),rangemode:'tozero',tickformat:isMoney(k)?'$.2s':'',tickfont:{family:'Chivo Mono, monospace',size:11}}}));
  const ch=pct(O[k],B[k]); const popName=$('#leadPop').selectedOptions[0].text.toLowerCase();
  $('#leadDyn').innerHTML='For '+esc(popName)+', <b>'+esc(LAB[k].toLowerCase())+'</b> averaged <b class="num">'+fmt(O[k],k)+'</b> per rep per month in the '+esc(ol.toLowerCase().replace(/ \(.*/,''))+' window vs <b class="num">'+fmt(B[k],k)+'</b> in the baseline, a change of <b class="num">'+sp(ch)+'</b>. '+O.n.toLocaleString()+' reps in the observation window, '+B.n.toLocaleString()+' in the baseline.';
  $('#leadTblSub').textContent=bl+' vs '+ol+'. Population: '+$('#leadPop').selectedOptions[0].text+'.';
  $('#leadTbl').innerHTML='<thead><tr><th>Metric</th><th>Baseline</th><th>Observation</th><th>Change</th></tr></thead><tbody>'+
    MK.map(m=>{const c=pct(O[m],B[m]);return '<tr><td>'+esc(LAB[m])+'</td><td>'+fmt(B[m],m)+'</td><td>'+fmt(O[m],m)+'</td><td class="'+(c>=0?'up':'down')+'">'+sp(c)+'</td></tr>';}).join('')+
    '<tr><td>Reps in window</td><td>'+B.n.toLocaleString()+'</td><td>'+O.n.toLocaleString()+'</td><td></td></tr></tbody>';
}

/* ---------- adoption tiers ---------- */
let adoptW='L6', usersW='L6';
function tiers(w){const o={};['High','Medium','Low'].forEach(t=>{o[t]=winAvg(popMask(t),W[w]);o[t+'_L6']=winAvg(popMask(t),W.L6);o[t+'_P6']=winAvg(popMask(t),W.P6);});return o;}
function renderAdopt(){
  const T=tiers(adoptW), cols={High:css('--d1'),Medium:css('--d2')};
  plot('adoptIndex',['High','Medium'].map(t=>({type:'bar',name:t+' adopters',x:MK.map(k=>LAB[k]),y:MK.map(k=>T[t][k]/T.Low[k]*100),marker:{color:cols[t]},
    customdata:MK.map(k=>[fmt(T[t][k],k),fmt(T.Low[k],k)]),hovertemplate:'%{x}<br>'+t+': %{customdata[0]} vs Low: %{customdata[1]}<br>Index %{y:.0f}<extra></extra>'})),
    base({barmode:'group',shapes:[{type:'line',xref:'paper',x0:0,x1:1,y0:100,y1:100,line:{color:css('--text3'),width:1.5,dash:'dash'}}],
      annotations:[{xref:'paper',x:1,y:100,text:'Low = 100',showarrow:false,xanchor:'right',yanchor:'bottom',font:{family:'Chivo Mono, monospace',size:11,color:css('--text3')}}],
      xaxis:{tickangle:0,automargin:true,gridcolor:'rgba(0,0,0,0)',tickfont:{size:11}},margin:{l:48,r:10,t:14,b:80}}));
  $('#adoptTblSub').textContent=adoptW==='L6'?'Change is measured against each tier\'s own prior six months ('+wl(W.P6)+').':'Change is measured against each tier\'s own prior twelve months ('+wl(W.P12)+').';
  $('#adoptTbl').innerHTML='<thead><tr><th>Metric</th>'+['High','Medium','Low'].map(t=>'<th>'+t+'</th><th>Last 6 vs prior 6</th>').join('')+'</tr></thead><tbody>'+
    MK.map(k=>'<tr><td>'+esc(LAB[k])+'</td>'+['High','Medium','Low'].map(t=>{const c=pct(T[t+'_L6'][k],T[t+'_P6'][k]);return '<td>'+fmt(T[t][k],k)+'</td><td class="'+(c>=0?'up':'down')+'">'+sp(c)+'</td>';}).join('')+'</tr>').join('')+
    '<tr><td>Reps</td>'+['High','Medium','Low'].map(t=>'<td>'+T[t].n+'</td><td></td>').join('')+'</tr></tbody>';
}
function renderUsers(){
  const w=W[usersW], Us=winAvg(popMask('User'),w), N_=winAvg(popMask('Non-user'),w);
  const lifts=MK.map(k=>pct(Us[k],N_[k]));
  plot('usersLift',[{type:'bar',orientation:'h',y:MK.map(k=>LAB[k]),x:lifts,marker:{color:lifts.map(v=>v>=0?css('--d1'):css('--neg'))},
    text:lifts.map(v=>sp(v)),textposition:'outside',cliponaxis:false,textfont:{family:'Chivo Mono, monospace',size:12,color:css('--text')},
    customdata:MK.map(k=>[fmt(Us[k],k),fmt(N_[k],k)]),hovertemplate:'%{y}<br>Users %{customdata[0]} vs non-users %{customdata[1]}<extra></extra>'}],
    base({margin:{l:200,r:60,t:10,b:36},yaxis:{autorange:'reversed',automargin:true,tickfont:{size:13}},xaxis:{ticksuffix:'%',zeroline:true,zerolinecolor:css('--rule-strong'),gridcolor:css('--rule'),tickfont:{family:'Chivo Mono, monospace',size:11}},showlegend:false}));
  const mu=monthly(popMask('User'),'dir_vp_exec'), mn=monthly(popMask('Non-user'),'dir_vp_exec');
  plot('usersTrend',[{type:'scatter',mode:'lines',name:'Backstory users',x:MON.map(mlab),y:mu,line:{color:css('--d1'),width:2.5}},
    {type:'scatter',mode:'lines',name:'Non-users',x:MON.map(mlab),y:mn,line:{color:css('--text3'),width:2,dash:'dot'}}],
    base({hovermode:'x unified',xaxis:{gridcolor:'rgba(0,0,0,0)',nticks:8,linecolor:css('--rule-strong'),tickfont:{family:'Chivo Mono, monospace',size:11}}}));
  $('#usersTbl').innerHTML='<thead><tr><th>Metric</th><th>Users</th><th>Non-users</th><th>Difference</th></tr></thead><tbody>'+
    MK.map((k,i)=>'<tr><td>'+esc(LAB[k])+'</td><td>'+fmt(Us[k],k)+'</td><td>'+fmt(N_[k],k)+'</td><td class="'+(lifts[i]>=0?'up':'down')+'">'+sp(lifts[i])+'</td></tr>').join('')+
    '<tr><td>Reps</td><td>'+Us.n+'</td><td>'+N_.n.toLocaleString()+'</td><td></td></tr></tbody>';
}

/* ---------- deal engagement ---------- */
let dealView='deciles';
function renderDeal(){
  const t=$('#dealType').value, f=$('#dealIncl').checked?'incl':'excl', D=OPP[t][f], rows=D[dealView];
  const x=dealView==='deciles'?rows.map(r=>'D'+r.dec):rows.map(r=>r.level);
  const cd=rows.map(r=>[r.n.toLocaleString(),r.lo.toFixed(0),r.hi.toFixed(0)]);
  const colr=dealView==='deciles'?rows.map((r,i)=>i>=rows.length-3?css('--d1'):css('--rule-strong')):[css('--rule-strong'),css('--d2'),css('--d1')];
  plot('dealWin',[{type:'bar',x,y:rows.map(r=>r.win_rate),marker:{color:colr},text:rows.map(r=>(r.win_rate==null?'–':r.win_rate.toFixed(1)+'%')),textposition:'outside',cliponaxis:false,
    textfont:{family:'Chivo Mono, monospace',size:12,color:css('--text')},customdata:cd,hovertemplate:'%{x}<br>Win rate %{y:.1f}%<br>%{customdata[0]} deals<br>Score %{customdata[1]}–%{customdata[2]}<extra></extra>'},
    {type:'scatter',mode:'lines',x,y:rows.map(()=>D.win_rate),line:{color:css('--text3'),dash:'dash',width:1.5},hoverinfo:'skip',name:'Overall'}],
    base({showlegend:false,yaxis:{ticksuffix:'%',gridcolor:css('--rule'),rangemode:'tozero',tickfont:{family:'Chivo Mono, monospace',size:11}},xaxis:{gridcolor:'rgba(0,0,0,0)',linecolor:css('--rule-strong')},
      annotations:[{xref:'paper',x:1,y:D.win_rate,text:'Overall '+D.win_rate+'%',showarrow:false,xanchor:'right',yanchor:'bottom',font:{family:'Chivo Mono, monospace',size:11,color:css('--text3')}}]}));
  if(HAS.vel){
    plot('dealVel',[{type:'bar',name:'Won deals',x,y:rows.map(r=>r.med_days_won),marker:{color:css('--d1')},hovertemplate:'%{x}<br>Won: %{y} days median<extra></extra>'},
      {type:'bar',name:'Lost deals',x,y:rows.map(r=>r.med_days_lost),marker:{color:css('--d3')},hovertemplate:'%{x}<br>Lost: %{y} days median<extra></extra>'}],
      base({barmode:'group',yaxis:{title:{text:'Median days',font:{size:12}},gridcolor:css('--rule'),tickfont:{family:'Chivo Mono, monospace',size:11}},xaxis:{gridcolor:'rgba(0,0,0,0)',linecolor:css('--rule-strong')}}));
  }
  const lv=D.levels, dc=D.deciles;
  const top=dc[dc.length-1], bot=dc[0];
  let s='<b>'+esc(t)+'</b>, '+D.n.toLocaleString()+' deals'+(f==='incl'?' including transactional':'')+'.';
  if(top&&bot&&bot.win_rate)s+=' Top decile wins <b class="num">'+top.win_rate.toFixed(1)+'%</b> vs <b class="num">'+bot.win_rate.toFixed(1)+'%</b> for the bottom (<b class="num">'+(top.win_rate/bot.win_rate).toFixed(1)+'×</b>'+(D.r_win!=null?', decile correlation r = '+D.r_win:'')+').';
  if(lv.length>=3&&lv[2].win_rate!=null&&lv[0].win_rate!=null)s+=' High-engagement deals win <b class="num">'+lv[2].win_rate.toFixed(1)+'%</b> vs <b class="num">'+lv[0].win_rate.toFixed(1)+'%</b> for low.';
  if(HAS.vel&&lv.length>=2&&lv[1].med_days_won!=null&&lv[0].med_days_won!=null)s+=' Won deals close in <b class="num">'+lv[1].med_days_won+'</b> days median at medium engagement vs <b class="num">'+lv[0].med_days_won+'</b> at low.';
  $('#dealDyn').innerHTML=s;
}

/* ---------- stage & persona ---------- */
const PERS=['Director','VP','Executive','Management/Admin','Legal/Procurement','Finance','IT','Engineering','Ops/Product/Supply chain'];
let stageView='share', persView='wr';
function renderStage(){
  const S=ST.stages, x=S.map(s=>s.stage);
  const post=S.map(s=>ST.postStages.indexOf(s.stage)>=0);
  let data, lay;
  if(stageView==='share'){
    data=[{type:'bar',name:'Share of all activity',x,y:S.map(s=>s.share),marker:{color:S.map((s,i)=>post[i]?css('--rule-strong'):css('--d1'))},text:S.map(s=>s.share.toFixed(1)+'%'),textposition:'outside',cliponaxis:false,textfont:{family:'Chivo Mono, monospace',size:11,color:css('--text')},
      customdata:S.map(s=>[s.acts.toLocaleString(),s.opps.toLocaleString()]),hovertemplate:'%{x}<br>%{y:.1f}% of activity<br>%{customdata[0]} activities on %{customdata[1]} deals<extra></extra>'},
      {type:'scatter',mode:'lines+markers',name:'Activities with Director or above',x,y:S.map(s=>s.dir_above_pct),yaxis:'y2',line:{color:css('--d2'),width:2.5},marker:{size:7},hovertemplate:'%{x}<br>%{y:.1f}% include Director+<extra></extra>'}];
    lay=base({yaxis:{ticksuffix:'%',gridcolor:css('--rule'),tickfont:{family:'Chivo Mono, monospace',size:11}},yaxis2:{overlaying:'y',side:'right',ticksuffix:'%',showgrid:false,rangemode:'tozero',tickfont:{family:'Chivo Mono, monospace',size:11}},xaxis:{gridcolor:'rgba(0,0,0,0)',tickfont:{size:11}},margin:{l:50,r:50,t:14,b:60}});
  } else if(stageView==='wl'){
    data=[{type:'bar',name:'Won deals',x,y:S.map(s=>s.won_acts),marker:{color:css('--d1')},customdata:S.map(s=>s.won_n),hovertemplate:'%{x}<br>Won: %{y} activities per deal (%{customdata} deals)<extra></extra>'},
      {type:'bar',name:'Lost deals',x,y:S.map(s=>s.lost_acts),marker:{color:css('--d3')},customdata:S.map(s=>s.lost_n),hovertemplate:'%{x}<br>Lost: %{y} activities per deal (%{customdata} deals)<extra></extra>'}];
    lay=base({barmode:'group',yaxis:{title:{text:'Avg activities per deal at stage',font:{size:12}},gridcolor:css('--rule'),tickfont:{family:'Chivo Mono, monospace',size:11}},xaxis:{gridcolor:'rgba(0,0,0,0)',tickfont:{size:11}},margin:{l:56,r:20,t:14,b:60}});
  } else {
    const types=[...new Set(S.flatMap(s=>Object.keys(s.type_pct||{})))].slice(0,5); const pal=[css('--d1'),css('--d2'),css('--d3'),css('--d4'),css('--d5')];
    data=types.map((tp,i)=>({type:'bar',name:tp[0].toUpperCase()+tp.slice(1),x,y:S.map(s=>(s.type_pct||{})[tp]||0),marker:{color:pal[i]},hovertemplate:'%{x}<br>'+tp+': %{y:.1f}%<extra></extra>'}));
    lay=base({barmode:'stack',yaxis:{ticksuffix:'%',range:[0,100],gridcolor:css('--rule'),tickfont:{family:'Chivo Mono, monospace',size:11}},xaxis:{gridcolor:'rgba(0,0,0,0)',tickfont:{size:11}},margin:{l:50,r:20,t:14,b:60}});
  }
  plot('stageProf',data,lay);
  const z=PERS.map(p=>S.map(s=>(s.persona_pct||{})[p]||0));
  plot('stageHeat',[{type:'heatmap',x,y:PERS,z,colorscale:[[0,css('--page')],[1,css('--horizon')]],text:z.map(r=>r.map(v=>v.toFixed(0)+'%')),texttemplate:'%{text}',
    textfont:{family:'Chivo Mono, monospace',size:11,color:css('--text')},hovertemplate:'%{y} at %{x}<br>%{z:.1f}% of activities<extra></extra>',showscale:false,xgap:2,ygap:2}],
    base({margin:{l:190,r:10,t:10,b:60},xaxis:{side:'bottom',tickfont:{size:11},gridcolor:'rgba(0,0,0,0)'},yaxis:{autorange:'reversed',tickfont:{size:12},gridcolor:'rgba(0,0,0,0)'}}));
  const sv=ST.surv.filter(s=>s.wr_early!=null&&s.wr_no_early!=null).slice().sort((a,b)=>a.lift-b.lift);
  const allv=sv.flatMap(s=>[s.wr_early,s.wr_no_early]); const lo=Math.max(0,Math.floor(Math.min(...allv)/5)*5-5), hi=Math.min(100,Math.ceil(Math.max(...allv)/5)*5+5);
  plot('stageSurv',[
    {type:'scatter',mode:'markers',name:'Not engaged early',y:sv.map(s=>s.persona),x:sv.map(s=>s.wr_no_early),marker:{size:11,color:css('--text3')},customdata:sv.map(s=>s.n_no),hovertemplate:'%{y}<br>Not engaged early: %{x:.1f}% (%{customdata} deals)<extra></extra>'},
    {type:'scatter',mode:'markers+text',name:'Engaged in '+ST.earlyStages.join(' / '),y:sv.map(s=>s.persona),x:sv.map(s=>s.wr_early),marker:{size:13,color:css('--d1')},text:sv.map(s=>(s.lift>=0?'+':'')+s.lift.toFixed(1)),textposition:'middle right',textfont:{family:'Chivo Mono, monospace',size:12,color:css('--text')},
      customdata:sv.map(s=>s.n_early),hovertemplate:'%{y}<br>Engaged early: %{x:.1f}% (%{customdata} deals)<extra></extra>'}],
    base({shapes:sv.map(s=>({type:'line',x0:s.wr_no_early,x1:s.wr_early,y0:s.persona,y1:s.persona,line:{color:css('--rule-strong'),width:3},layer:'below'})),
      margin:{l:190,r:40,t:10,b:60},xaxis:{ticksuffix:'%',range:[lo,hi],gridcolor:css('--rule'),title:{text:'Win rate of deals that reached late stage',font:{size:12}},tickfont:{family:'Chivo Mono, monospace',size:11}},yaxis:{tickfont:{size:12},gridcolor:'rgba(0,0,0,0)'}}));
  renderPers();
  const br=ST.breadth;
  const best=br.reduce((a,b)=>(b.win_rate||0)>(a.win_rate||0)?b:a,br[0]||{k:-1});
  plot('stageBreadth',[{type:'bar',x:br.map(b=>b.k===6?'6+':String(b.k)),y:br.map(b=>b.win_rate),marker:{color:br.map(b=>b.k===best.k?css('--d1'):css('--rule-strong'))},text:br.map(b=>(b.win_rate==null?'–':b.win_rate.toFixed(0)+'%')),textposition:'outside',cliponaxis:false,textfont:{family:'Chivo Mono, monospace',size:11,color:css('--text')},
    customdata:br.map(b=>[b.n.toLocaleString(),b.med_days_won==null?'–':b.med_days_won]),hovertemplate:'%{x} personas<br>Win rate %{y:.1f}%<br>%{customdata[0]} deals, %{customdata[1]} days median (won)<extra></extra>'}],
    base({showlegend:false,yaxis:{ticksuffix:'%',rangemode:'tozero',gridcolor:css('--rule'),tickfont:{family:'Chivo Mono, monospace',size:11}},xaxis:{title:{text:'Personas engaged',font:{size:12}},gridcolor:'rgba(0,0,0,0)'},margin:{l:44,r:10,t:14,b:48}}));
  const eq=ST.early_q;
  const bestq=eq.reduce((a,b)=>(b.win_rate||0)>(a.win_rate||0)?b:a,eq[0]||{q:''});
  plot('stageEarlyQ',[{type:'bar',x:eq.map(q=>q.q.replace(' lowest','').replace(' highest','')),y:eq.map(q=>q.win_rate),marker:{color:eq.map(q=>q.q===bestq.q?css('--d1'):css('--rule-strong'))},text:eq.map(q=>(q.win_rate==null?'–':q.win_rate.toFixed(0)+'%')),textposition:'outside',cliponaxis:false,textfont:{family:'Chivo Mono, monospace',size:11,color:css('--text')},
    customdata:eq.map(q=>[q.lo,q.hi,q.med_days_won==null?'–':q.med_days_won]),hovertemplate:'%{x}: %{customdata[0]}–%{customdata[1]} early activities<br>Win rate %{y:.1f}%<br>%{customdata[2]} days median (won)<extra></extra>'}],
    base({showlegend:false,yaxis:{ticksuffix:'%',rangemode:'tozero',gridcolor:css('--rule'),tickfont:{family:'Chivo Mono, monospace',size:11}},xaxis:{title:{text:'Early activity quintile (low to high)',font:{size:12}},gridcolor:'rgba(0,0,0,0)'},margin:{l:44,r:10,t:14,b:48}}));
}
function renderPers(){
  const P=ST.personas.filter(p=>p.wr_with!=null&&p.wr_without!=null).slice(); let data, xa={};
  if(persView==='wr'){ P.sort((a,b)=>a.lift_pts-b.lift_pts);
    data=[{type:'bar',orientation:'h',name:'Without persona',y:P.map(p=>p.persona),x:P.map(p=>p.wr_without),marker:{color:css('--rule-strong')},hovertemplate:'%{y}<br>Without: %{x:.1f}%<extra></extra>'},
      {type:'bar',orientation:'h',name:'With persona',y:P.map(p=>p.persona),x:P.map(p=>p.wr_with),marker:{color:css('--d1')},text:P.map(p=>(p.lift_pts>=0?'+':'')+p.lift_pts.toFixed(1)+' pts'),textposition:'outside',cliponaxis:false,textfont:{family:'Chivo Mono, monospace',size:11,color:css('--text')},customdata:P.map(p=>p.prevalence),hovertemplate:'%{y}<br>With: %{x:.1f}%<br>Present on %{customdata}% of deals<extra></extra>'}];
    xa={ticksuffix:'%',rangemode:'tozero'};
  } else if(persView==='share'){ P.sort((a,b)=>a.won_share-b.won_share);
    data=[{type:'bar',orientation:'h',name:'Share of won deals',y:P.map(p=>p.persona),x:P.map(p=>p.won_share),marker:{color:css('--d1')},text:P.map(p=>(p.won_share==null?'–':p.won_share.toFixed(0)+'%')),textposition:'outside',cliponaxis:false,textfont:{family:'Chivo Mono, monospace',size:11,color:css('--text')},hovertemplate:'%{y}<br>Engaged on %{x:.1f}% of won deals<extra></extra>'},
      {type:'bar',orientation:'h',name:'Share of all deals',y:P.map(p=>p.persona),x:P.map(p=>p.prevalence),marker:{color:css('--rule-strong')},hovertemplate:'%{y}<br>Engaged on %{x:.1f}% of all deals<extra></extra>'}];
    xa={ticksuffix:'%',rangemode:'tozero'};
  } else { P.sort((a,b)=>(a.days_with||0)-(b.days_with||0));
    data=[{type:'bar',orientation:'h',name:'Without persona',y:P.map(p=>p.persona),x:P.map(p=>p.days_without),marker:{color:css('--rule-strong')},hovertemplate:'%{y}<br>Without: %{x} days median<extra></extra>'},
      {type:'bar',orientation:'h',name:'With persona',y:P.map(p=>p.persona),x:P.map(p=>p.days_with),marker:{color:css('--d3')},customdata:P.map(p=>[money(p.amt_with),money(p.amt_without)]),hovertemplate:'%{y}<br>With: %{x} days median<br>Median deal %{customdata[0]} vs %{customdata[1]}<extra></extra>'}];
    xa={title:{text:'Median days to close, won deals',font:{size:12}}};
  }
  plot('stagePers',data,base({barmode:'group',margin:{l:190,r:60,t:10,b:70},xaxis:Object.assign({gridcolor:css('--rule'),tickfont:{family:'Chivo Mono, monospace',size:11}},xa),yaxis:{tickfont:{size:12},gridcolor:'rgba(0,0,0,0)'}}));
  const notes=N.notes.persona||{}; $('#persNote').innerHTML=md(notes[persView]||'');
}

/* ---------- plumbing ---------- */
function segBind(sel,cb){$$(sel+' button').forEach(b=>b.onclick=()=>{$$(sel+' button').forEach(x=>x.setAttribute('aria-pressed',x===b));cb(b.dataset.v);});}
const TABS={summary:true,lead:HAS.U,adopt:HAS.usage,users:HAS.usage,deal:HAS.OPP,stage:HAS.ST,method:true};
const R={summary:()=>{},lead:renderLead,adopt:renderAdopt,users:renderUsers,deal:renderDeal,stage:renderStage,method:()=>{}};
let current='summary';
function showTab(t){if(!TABS[t])t='summary';current=t;$$('nav.tabs button').forEach(b=>b.setAttribute('aria-selected',b.dataset.tab===t));$$('section.panel').forEach(s=>s.classList.toggle('active',s.id==='p-'+t));requestAnimationFrame(()=>R[t]());}
function rerender(){renderHero();R[current]();}
$$('nav.tabs button').forEach(b=>{if(!TABS[b.dataset.tab])b.classList.add('hidden');b.onclick=()=>showTab(b.dataset.tab);});
$$('section.panel').forEach(s=>{const t=s.id.slice(2);if(!TABS[t])s.classList.add('hidden');});

function init(){
  if(HAS.OPP){$('#dealType').innerHTML=Object.keys(OPP).map(t=>'<option>'+esc(t)+'</option>').join('');
    $('#dealType').onchange=renderDeal; $('#dealIncl').onchange=renderDeal; segBind('#dealView',v=>{dealView=v;renderDeal();});
    if(!HAS.vel){$('#dealInclWrap').classList.add('hidden');$('#dealVelBlock').classList.add('hidden');}}
  if(HAS.usage){segBind('#adoptWin',v=>{adoptW=v;renderAdopt();}); segBind('#usersWin',v=>{usersW=v;renderUsers();});
    const nT={High:0,Medium:0,Low:0}; U.users.forEach(u=>{if(u.t)nT[u.t]++;}); const nUser=U.users.filter(u=>u.f==='User').length;
    $('#adoptIntro').innerHTML=U.nUsage+' reps appear in both the activity extract and the usage file. They\'re split into equal thirds by usage score: high (more than '+U.tierCuts[1]+', '+nT.High+' reps), medium ('+(U.tierCuts[0]+1)+'–'+U.tierCuts[1]+', '+nT.Medium+') and low ('+U.tierCuts[0]+' or fewer, '+nT.Low+').';
    $('#usersIntro').innerHTML='Users are the '+nUser+' reps with usage above the bottom 5%. Non-users are the '+(U.users.length-U.nUsage).toLocaleString()+' reps in the activity extract with no usage, plus the '+U.nBottom+' lowest-usage reps ('+(U.users.length-nUser).toLocaleString()+' in total).';
    $('#methodUsage').innerHTML=['The usage file (last months of product usage) is left-joined to the activity extract on lower-cased email. '+U.nUsage+' of '+U.usageRecords+' usage records match an activity rep.',
      'Tiers are terciles of the usage score among matched reps (cut points '+U.tierCuts[0]+' and '+U.tierCuts[1]+').',
      'Very low usage: the bottom 5% by score ('+U.nBottom+' reps), ties broken by the oldest last-usage date. These reps are counted as non-users.',
      'Cohort metrics include only reps with activity in the chosen window.'].map(x=>'<li>'+x+'</li>').join('');}
  else {$('#methodUsage').innerHTML='<li>No usage cohort file was provided, so adoption tiers and users vs non-users were not computed.</li>';}
  if(HAS.ST){segBind('#stageView',v=>{stageView=v;renderStage();}); segBind('#persView',v=>{persView=v;renderPers();});
    $('#stageIntro').innerHTML=ST.base.n_opps.toLocaleString()+' closed opportunities, with each activity tagged by the stage the deal was in when it was matched. Win-rate analysis uses the '+ST.base.n_pre.toLocaleString()+' deals with pre-decision activity ('+(ST.base.wr_pre==null?'–':ST.base.wr_pre+'%')+' win rate).';
    $('#mOpps').textContent=ST.base.n_opps.toLocaleString(); $('#mPre').textContent=ST.base.n_pre.toLocaleString(); $('#mPreWR').textContent=(ST.base.wr_pre==null?'–':ST.base.wr_pre+'%'); $('#mLate').textContent=ST.n_late.toLocaleString();
    $('#mEarly').textContent=ST.earlyStages.join(' or '); $('#mLateStages').textContent=ST.lateStages.join(' or '); $('#mCycle').textContent=ST.cycleMatch==null?'no cycle times available':ST.cycleMatch+'% match';}
  if(HAS.U){$('#capP').textContent=money(META.capP); $('#capPO').textContent=money(META.capPO); setupLead();}
  setupCalc(); renderSummary(); renderHero();
}
if(window.Plotly)init(); else window.addEventListener('load',init);
})();
`

export function renderRoiDashboard(facts: RoiFacts, narrative: RoiNarrative, options: RoiDashboardOptions): string {
  const account = options.account
  const generated = options.generatedAt ? new Date(options.generatedAt) : new Date()
  const generatedLabel = Number.isNaN(generated.getTime()) ? '' : generated.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
  const U = facts.U
  const activityRange = U ? `Activity ${monthLabel(U.months[0])} – ${monthLabel(U.months[U.months.length - 1])}` : ''
  const dealCount = facts.OPP ? Object.values(facts.OPP)[0]?.incl.n : null
  const metaLine = [`ROI analysis for ${account}`, activityRange, dealCount ? `${Math.round(dealCount).toLocaleString()} closed deals` : '', generatedLabel ? `Generated ${generatedLabel}` : ''].filter(Boolean).join(' · ')
  const notes = narrative.notes
  const aside = (title: string, items: string[] | undefined) => `<aside class="note"><h4>${escapeHtml(title)}</h4>${paragraphs(items) || '<p>—</p>'}</aside>`
  const caveats = [...(narrative.caveats ?? []), ...(facts.notes ?? [])]

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Backstory ROI analysis · ${escapeHtml(account)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cardo:wght@400;700&family=Chivo+Mono:wght@400;500;700&family=Roboto:wght@300;400;500;700&display=swap" rel="stylesheet">
<script src="/vendor/plotly.min.js"></script>
<style>${CSS}</style>
</head>
<body>
<header class="mast">
  <div class="wrap">
    <button class="themebtn" id="themeBtn" type="button">Theme: auto</button>
    <div class="brand">
      <svg viewBox="0 0 22 18" aria-hidden="true"><rect x="0" y="2" width="4" height="16" fill="currentColor"/><rect x="6" y="0" width="4" height="18" fill="currentColor"/><rect x="12.5" y="3" width="4" height="15" transform="rotate(-12 14.5 10.5)" fill="currentColor"/></svg>
      Backstory
    </div>
    <div class="mast-meta">${escapeHtml(metaLine)}</div>
    <div class="mast-grid">
      <div>
        <h1>${escapeHtml(narrative.headline)}</h1>
        <p class="lede">${inline(narrative.lede)}</p>
      </div>
      <figure class="strip-wrap">
        <div id="heroStrip" role="img" aria-label="Headline chart"></div>
        <figcaption id="heroCap">Win rate by engagement decile, lowest to highest (non-transactional deals, excluding renewals)</figcaption>
      </figure>
    </div>
  </div>
</header>

<nav class="tabs" aria-label="Sections"><div class="wrap" role="tablist">
  <button role="tab" data-tab="summary" aria-selected="true">Summary</button>
  <button role="tab" data-tab="lead" aria-selected="false">Leading indicators</button>
  <button role="tab" data-tab="adopt" aria-selected="false">Adoption tiers</button>
  <button role="tab" data-tab="users" aria-selected="false">Users vs non-users</button>
  <button role="tab" data-tab="deal" aria-selected="false">Deal engagement</button>
  <button role="tab" data-tab="stage" aria-selected="false">Stage and persona</button>
  <button role="tab" data-tab="method" aria-selected="false">Method</button>
</div></nav>

<main>
<section class="panel active" id="p-summary"><div class="wrap">
  <h2>The ROI story in ${['two', 'three', 'four'][narrative.findings.length - 2] ?? 'four'} numbers</h2>
  <p class="intro">Each figure is traceable to a view in this dashboard. The chain runs from product usage, to rep behaviour, to deal engagement, to outcomes.</p>
  <div class="findings" id="findings"></div>
  <div class="watch">
    <h3>What to watch</h3>
    <ul id="watch"></ul>
  </div>
  <div class="calc" id="calc">
    <div>
      <h3>Model the upside</h3>
      <p class="sub">What happens if a share of today's low-engagement deals were engaged to the medium level? Uses observed win rates for this account; deal value is editable.</p>
      <div class="calc-inputs">
        <label>Low-engagement deals lifted to medium: <b class="num" id="cPctL">10%</b><input type="range" id="cPct" min="1" max="50" value="10"></label>
        <label>Deal type<select id="cType"></select></label>
        <label>Average won deal value<input type="number" id="cVal" min="0" step="500"></label>
        <p class="sub" id="cValNote"></p>
      </div>
    </div>
    <div class="calc-out" aria-live="polite">
      <div style="font-size:14px;color:var(--mast-sub)">Estimated incremental bookings per year</div>
      <div class="big" id="cBig">–</div>
      <div class="row" style="margin-top:16px"><span>Low-engagement deals per year</span><span id="cN">–</span></div>
      <div class="row"><span>Deals lifted</span><span id="cLift">–</span></div>
      <div class="row"><span>Win rate, low → medium</span><span id="cWR">–</span></div>
      <div class="row"><span>Incremental wins per year</span><span id="cWins">–</span></div>
      <p>A directional model, not a forecast. It assumes lifted deals take on the medium-engagement win rate observed in this data.</p>
    </div>
  </div>
</div></section>

<section class="panel" id="p-lead"><div class="wrap">
  <h2>Leading indicators, averaged per rep per month</h2>
  <p class="intro">Each rep's monthly value is averaged across the window, then averaged across reps. Pick a metric, a population and the baseline and observation windows.</p>
  <div class="controls"><div class="ctl"><span>Metric</span><div class="chips" id="leadMetric"></div></div></div>
  <div class="controls">
    <div class="ctl"><span>Population</span><select id="leadPop">
      <option value="all">All reps</option><option value="User">Backstory users</option><option value="Non-user">Non-users</option>
      <option value="High">High adopters</option><option value="Medium">Medium adopters</option><option value="Low">Low adopters</option></select></div>
    <div class="ctl"><span>Comparison</span><div class="seg" id="leadMode">
      <button aria-pressed="true" data-v="pp">Last 6 vs prior 6</button><button aria-pressed="false" data-v="yoy">Last 6 vs same 6 last year</button><button aria-pressed="false" data-v="y12">Last 12 vs prior 12</button><button aria-pressed="false" data-v="q">Last quarter vs prior</button><button aria-pressed="false" data-v="custom">Custom</button></div></div>
    <div class="custom" id="leadCustom">
      <div class="ctl"><span>Baseline from</span><select id="bS"></select></div>
      <div class="ctl"><span>to</span><select id="bE"></select></div>
      <div class="ctl"><span>Observation from</span><select id="oS"></select></div>
      <div class="ctl"><span>to</span><select id="oE"></select></div>
    </div>
  </div>
  <div class="dyn" id="leadDyn"></div>
  <div class="block">
    <div><h3 id="leadTitle">Monthly trend</h3><p class="sub">Shaded bands mark the baseline (grey) and observation (blue) windows.</p><div class="chart" id="leadTrend"></div></div>
    ${aside('What this shows', notes.lead)}
  </div>
  <div class="block full">
    <div><h3>Baseline vs observation, all metrics</h3><p class="sub" id="leadTblSub"></p>
    <div class="tbl-wrap"><table id="leadTbl"></table></div></div>
  </div>
</div></section>

<section class="panel" id="p-adopt"><div class="wrap">
  <h2>High, medium and low adopters</h2>
  <p class="intro" id="adoptIntro"></p>
  <div class="controls"><div class="ctl"><span>Window</span><div class="seg" id="adoptWin"><button aria-pressed="true" data-v="L6">Last 6 months</button><button aria-pressed="false" data-v="L12">Last 12 months</button></div></div></div>
  <div class="block">
    <div><h3>Engagement indexed to low adopters</h3><p class="sub">Low adopters = 100. Bars above 100 mean more activity per rep per month.</p><div class="chart" id="adoptIndex"></div></div>
    ${aside('What this shows', notes.adopt)}
  </div>
  <div class="block full">
    <div><h3>Per-rep monthly averages by tier</h3><p class="sub" id="adoptTblSub"></p>
    <div class="tbl-wrap"><table id="adoptTbl"></table></div></div>
  </div>
</div></section>

<section class="panel" id="p-users"><div class="wrap">
  <h2>Backstory users vs non-users</h2>
  <p class="intro" id="usersIntro"></p>
  <div class="controls"><div class="ctl"><span>Window</span><div class="seg" id="usersWin"><button aria-pressed="true" data-v="L6">Last 6 months</button><button aria-pressed="false" data-v="L12">Last 12 months</button></div></div></div>
  <div class="block">
    <div><h3>How much more users do, per rep per month</h3><p class="sub">Percent difference, users vs non-users.</p><div class="chart" id="usersLift"></div></div>
    ${aside('What this shows', notes.users)}
  </div>
  <div class="block">
    <div><h3>The senior-meeting gap over time</h3><p class="sub">Director, VP and executive meetings per rep per month. Users are defined by current usage, so a gap before the usage window shows these reps were already more senior-engaged.</p><div class="chart" id="usersTrend"></div></div>
    ${aside('Reading this fairly', notes.usersTrend)}
  </div>
  <div class="block full">
    <div><h3>Per-rep monthly averages</h3><div class="tbl-wrap"><table id="usersTbl"></table></div></div>
  </div>
</div></section>

<section class="panel" id="p-deal"><div class="wrap">
  <h2>Deal engagement vs win rate and velocity</h2>
  <p class="intro">Every closed deal with a Backstory engagement score. Deals that closed within seven days of creation are booked-on-creation orders that win almost every time; they are excluded by default so they don't mask the relationship.</p>
  <div class="controls">
    <div class="ctl"><span>Group by</span><div class="seg" id="dealView"><button aria-pressed="true" data-v="deciles">Engagement deciles</button><button aria-pressed="false" data-v="levels">Engagement levels</button></div></div>
    <div class="ctl"><span>Deal type</span><select id="dealType"></select></div>
    <label class="toggle" id="dealInclWrap"><input type="checkbox" id="dealIncl"> Include transactional deals (closed in 7 days or less)</label>
  </div>
  <div class="dyn" id="dealDyn"></div>
  <div class="block">
    <div><h3>Win rate</h3><p class="sub">Bars show win rate; hover for deal counts and score range.</p><div class="chart" id="dealWin"></div></div>
    ${aside('What this shows', notes.dealWin)}
  </div>
  <div class="block" id="dealVelBlock">
    <div><h3>Deal velocity</h3><p class="sub">Median days from creation to close, for won and lost deals.</p><div class="chart" id="dealVel"></div></div>
    ${aside('What this shows', notes.dealVel)}
  </div>
</div></section>

<section class="panel" id="p-stage"><div class="wrap">
  <h2>Where engagement happens, and who moves the deal</h2>
  <p class="intro" id="stageIntro"></p>
  <div class="block">
    <div><h3>Engagement by stage at time of activity</h3>
      <div class="controls" style="margin-top:10px"><div class="seg" id="stageView"><button aria-pressed="true" data-v="share">Share of activity</button><button aria-pressed="false" data-v="wl">Activity per deal, won vs lost</button><button aria-pressed="false" data-v="type">Channel mix</button></div></div>
      <div class="chart" id="stageProf"></div></div>
    ${aside('What this shows', notes.stageProf)}
  </div>
  <div class="block">
    <div><h3>Persona mix by stage</h3><p class="sub">Share of activities at each stage that include each persona. A single activity can include several.</p><div class="chart tall" id="stageHeat"></div></div>
    ${aside('What this shows', notes.stageHeat)}
  </div>
  <div class="block">
    <div><h3>Early engagement and win rate among deals that reached late stage</h3>
      <p class="sub">Only deals with activity in the late stages. Compares those that also had the persona engaged in the early stages with those that didn't.</p>
      <div class="chart tall" id="stageSurv"></div></div>
    ${aside('What this shows', notes.stageSurv)}
  </div>
  <div class="block">
    <div><h3>Persona involvement, all pre-decision activity</h3>
      <div class="controls" style="margin-top:10px"><div class="seg" id="persView"><button aria-pressed="true" data-v="wr">Win rate with vs without</button><button aria-pressed="false" data-v="share">Share of won deals</button><button aria-pressed="false" data-v="days">Days to close (won)</button></div></div>
      <div class="chart tall" id="stagePers"></div></div>
    <aside class="note"><h4>What this shows</h4><p id="persNote"></p></aside>
  </div>
  <div class="block">
    <div class="twocol">
      <div><h3>Buying-committee breadth</h3><p class="sub">Number of distinct personas engaged before a decision.</p><div class="chart short" id="stageBreadth"></div></div>
      <div><h3>Early activity intensity</h3><p class="sub">Quintiles of activity logged in the early stages.</p><div class="chart short" id="stageEarlyQ"></div></div>
    </div>
    ${aside('What this shows', notes.breadth)}
  </div>
</div></section>

<section class="panel" id="p-method"><div class="wrap method">
  <h2>Method and caveats</h2>
  <h3>Leading indicators</h3>
  <ul>
    <li>Source: the activity extract, one row per rep per month, up to 24 months. Windows are counted back from the newest month in the data.</li>
    <li>Metrics: meetings, emails sent, Director + VP + Executive meetings, VP meetings, Executive meetings, pipeline created (touched) and pipeline created (owned).</li>
    <li>Per-rep averaging: each rep's monthly values are averaged across the months they appear in the window; those rep averages are then averaged.</li>
    <li>Pipeline cleaning: reps whose pipeline is reported in another currency (median rep-month more than 25× the org's) are excluded from pipeline metrics only. Remaining rep-months are capped at the 95th percentile of non-zero values (<span class="num" id="capP"></span> touched, <span class="num" id="capPO"></span> owned).</li>
  </ul>
  <h3>Usage cohorts</h3>
  <ul id="methodUsage"></ul>
  <h3>Deal engagement</h3>
  <ul>
    <li>Source: closed deals with an engagement score. Framework deals excluded; the default view excludes renewals.</li>
    <li>Transactional deals (open 7 days or less) are excluded by default and can be toggled back in when cycle times are available.</li>
    <li>Levels: Low 0 – 30, Medium 31 – 70, High 71+. Deciles use equal-count bins of the engagement score. Velocity is the median days from creation to close.</li>
  </ul>
  <h3>Stage and persona</h3>
  <ul>
    <li>Source: closed deals by stage, <span class="num" id="mOpps"></span> closed non-renewal opportunities. Cycle time joined from the opportunity file on CRM id (<span id="mCycle"></span>).</li>
    <li>Win-rate analysis uses only activity logged in pre-decision stages and excludes transactional deals (<span class="num" id="mPre"></span> opportunities, <span class="num" id="mPreWR"></span> win rate).</li>
    <li>Survivorship control: comparing early vs late engagement across all deals is misleading because deals lost early never generate late activity. The early-engagement chart restricts to deals that reached <span id="mLateStages"></span> (<span class="num" id="mLate"></span> deals); "early" means <span id="mEarly"></span>.</li>
  </ul>
  <h3>Data notes for this run</h3>
  <ul>${caveats.length ? caveats.map((caveat) => `<li>${inline(caveat)}</li>`).join('') : '<li>No data issues were reported.</li>'}</ul>
  <h3>What this analysis doesn't claim</h3>
  <ul>
    <li>All relationships are correlations. Usage cohorts are self-selected, and any users-vs-non-users gap may predate the usage window.</li>
    <li>Pipeline and bookings aren't normalised for quota, territory or role mix.</li>
    <li>The upside model uses median won deal value by default because amounts are heavily skewed; the P95-capped mean is shown for comparison.</li>
  </ul>
</div></section>
</main>
<footer><div class="wrap">Prepared with Backstory activity and opportunity data for ${escapeHtml(account)}${generatedLabel ? ` · ${escapeHtml(generatedLabel)}` : ''} · computed by the ROI Analyst</div></footer>

<script>
const U = ${scriptJson(facts.U)};
const OPP = ${scriptJson(facts.OPP)};
const ST = ${scriptJson(facts.ST)};
const META = ${scriptJson(facts.META ?? {})};
const N = ${scriptJson(narrative)};
const PRESET = ${scriptJson(options.timeframePreset ?? 'last6_vs_prior6')};
</script>
<script>${SCRIPT}</script>
</body>
</html>`
}

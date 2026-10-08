/**
 * The ROI report's script (see dashboard.ts) — Backstory's value readout.
 * Plain ES2017 in a raw string:
 * no template literals, so nothing in it can interpolate or close the
 * embedding. It reads the globals the page declares — U, OPP, DEALS, ST,
 * ACC, META, A360, N, CFG, VIEW — and draws every tab with Plotly from
 * /vendor. The math mirrors facts.ts (window averages, the deal buckets) so
 * the narrative's numbers and the charts agree.
 */
export const REPORT_SCRIPT = String.raw`
(function(){
'use strict';
var $=function(s){return document.querySelector(s);}, $$=function(s){return Array.prototype.slice.call(document.querySelectorAll(s));};
var css=function(v){return getComputedStyle(document.documentElement).getPropertyValue(v).trim();};
var esc=function(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});};
var md=function(s){return esc(s).replace(/\*\*(.+?)\*\*/g,'<b class="num">$1</b>');};
var paras=function(list){return (list&&list.length)?list.map(function(p){return '<p>'+md(p)+'</p>';}).join(''):'';};
var MN=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
var mlab=function(m){return MN[+m.slice(5,7)-1]+' '+m.slice(2,4);};
var mlabL=function(m){return MN[+m.slice(5,7)-1]+' '+m.slice(0,4);};
var money=function(v){if(v==null||isNaN(v))return '–';var a=Math.abs(v),s=v<0?'-':'';if(a>=1e9)return s+'$'+(a/1e9).toFixed(2)+'B';if(a>=1e6)return s+'$'+(a/1e6).toFixed(1)+'M';if(a>=1e3)return s+'$'+(a/1e3).toFixed(0)+'K';return s+'$'+a.toFixed(0);};
var n0=function(v){return (v==null||isNaN(v))?'–':Math.round(v).toLocaleString();};
var sp=function(v){return (v==null||isNaN(v)||!isFinite(v))?'–':(v>=0?'+':'')+v.toFixed(1)+'%';};
var p1=function(v){return (v==null||isNaN(v))?'–':v.toFixed(1)+'%';};
var pct=function(a,b){return (b&&a!=null&&!isNaN(a))?((a/b-1)*100):NaN;};
var uniq=function(a){var o=[];a.forEach(function(x){if(o.indexOf(x)<0)o.push(x);});return o;};
var median=function(a){if(!a.length)return null;var s=a.slice().sort(function(x,y){return x-y;}),m=s.length>>1;return s.length%2?s[m]:(s[m-1]+s[m])/2;};
var r1=function(v){return (v==null||isNaN(v))?null:Math.round(v*10)/10;};
/* Long axis labels break onto two lines at the space nearest their middle. */
var wrapLab=function(s){s=String(s);if(s.length<=14)return s;var mid=s.length/2,best=-1;for(var i=0;i<s.length;i++){if(s.charAt(i)===' '&&(best<0||Math.abs(i-mid)<Math.abs(best-mid)))best=i;}return best<0?s:s.slice(0,best)+'<br>'+s.slice(best+1);};

/* ---------- data ---------- */
var dm=function(s){if(s==null)return null;if(typeof s!=='string')return s;if(!s)return [];return s.split(';').map(function(r){return r.split(',').map(function(v){return v===''?null:+v;});});};
var MAT={};
function mat(k){if(k in MAT)return MAT[k];var src=(U&&U.m&&U.m[k]!=null)?U.m[k]:((U&&U.mx&&U.mx[k]!=null)?U.mx[k]:null);MAT[k]=dm(src);return MAT[k];}
var D=null;
if(DEALS&&DEALS.w&&DEALS.w.length){
  var nD=DEALS.w.length;D={types:DEALS.types,months:DEALS.months,s:new Array(nD),w:new Array(nD),d:DEALS.d,t:new Array(nD),m:new Array(nD),x:new Array(nD)};
  for(var i=0;i<nD;i++){D.s[i]=parseInt(DEALS.s.substr(i*2,2),36)/10;D.w[i]=DEALS.w.charCodeAt(i)===49?1:0;D.t[i]=parseInt(DEALS.t.charAt(i),36);var mm=DEALS.m.substr(i*2,2);D.m[i]=mm==='zz'?-1:parseInt(mm,36);D.x[i]=DEALS.x.charCodeAt(i)===49?1:0;}
}
/* A value readout's aggregates (see readout-import.ts): group rows instead of reps, deal and stage tables instead of deals. */
var AG=(typeof AGG!=='undefined'&&AGG)?AGG:null, AG_ALL='All deal types';
var PERS_DEFAULT=['Director','VP','Executive','Management/Admin','Legal/Procurement','Finance','IT','Engineering','Ops/Product/Supply chain'];
var PK=(ST&&ST.personaKeys)||PERS_DEFAULT, NP=PK.length;
var HAS={U:!!U,usage:!!(U&&U.hasUsage),OPP:!!OPP,D:!!D,ST:!!ST||!!(AG&&AG.stages&&AG.stages.wr.length),cells:!!(ST&&ST.cells&&ST.cells.length),ACC:!!(ACC&&ACC.accounts&&ACC.accounts.length),A360:!!A360,vel:!!(META&&META.hasVelocity),roster:!!(U&&U.users.some(function(u){return u.n;}))||!!(AG&&AG.roster&&AG.roster.length)};
/* Rows stand for one rep each, or (readouts) for a group of reps: averages weight them. */
var WT=U?U.users.map(function(u){return u.w==null?1:u.w;}):[];
function cohortRow(u){return !AG||u.k==='cohort';}
function headcount(pred){var n=0;if(!U)return 0;U.users.forEach(function(u,i){if(cohortRow(u)&&(AG||roleOK(u))&&pred(u))n+=WT[i];});return n;}
var MK=U?Object.keys(U.labels):[], LAB=U?U.labels:{}, MON=U?U.months:[], NM=MON.length;
var isMoney=function(k){return k.indexOf('pipeline')===0||((U&&U.moneyKeys)||[]).indexOf(k)>=0;};
var fmt=function(v,k){if(v==null||isNaN(v))return '–';if(isMoney(k))return money(v);return v.toFixed(v<10?2:1);};

/* ---------- fiscal periods ---------- */
function fp(m){var y=+m.slice(0,4),mo=+m.slice(5,7),st=CFG.fyStart||1,off=(mo-st+12)%12,fy=st===1?y:(mo>=st?y+1:y);return {fy:'FY'+fy,fq:'Q'+(Math.floor(off/3)+1)};}

/* ---------- filters (side panel, or the ROI page's panel when hosted) ---------- */
var GF={fy:[],fq:[],role:[]};
function monthOK(m){if(!GF.fy.length&&!GF.fq.length)return true;if(!m)return false;var p=fp(m);return (!GF.fy.length||GF.fy.indexOf(p.fy)>=0)&&(!GF.fq.length||GF.fq.indexOf(p.fq)>=0);}
function roleOK(u){return !GF.role.length||GF.role.indexOf(u.r||'Other')>=0;}
var ROLE_ORDER=['Account executives','CS / PS','SDR / BDR','Solutions engineering','Leadership','Other'];
var OPTIONS={fy:[],fq:[],role:[]};
function chipGroup(id,values,key){var el=$(id);if(!el)return 0;el.innerHTML=values.map(function(v){return '<button type="button" aria-pressed="'+(GF[key].indexOf(v)>=0)+'" data-v="'+esc(v)+'">'+esc(v)+'</button>';}).join('');
  $$(id+' button').forEach(function(b){b.onclick=function(){var v=b.getAttribute('data-v'),a=GF[key],ix=a.indexOf(v);if(ix>=0)a.splice(ix,1);else a.push(v);b.setAttribute('aria-pressed',ix<0);gfChanged(true);};});return values.length;}
function aggOK(r){return (!GF.fy.length||GF.fy.indexOf(r.fy)>=0)&&(!GF.fq.length||!r.fq||GF.fq.indexOf(r.fq)>=0);}
function setupGF(){
  var months=D?D.months.slice():(HAS.cells?(ST.cellMonths||[]).slice():[]);
  OPTIONS.fy=AG?AG.fys.slice():uniq(months.map(function(m){return fp(m).fy;})).sort();
  OPTIONS.fq=OPTIONS.fy.length?['Q1','Q2','Q3','Q4']:[];
  OPTIONS.role=AG?ROLE_ORDER.filter(function(r){return AG.roster.some(function(u){return u.r===r;});}):U?ROLE_ORDER.filter(function(r){return U.users.some(function(u){return u.r&&(u.r||'Other')===r;});}):[];
  drawChips();
  $('#gfClear').onclick=function(){GF.fy=[];GF.fq=[];GF.role=[];drawChips();gfChanged(true);};
  var open=function(on){$('#filterPanel').hidden=!on;$('#filterScrim').hidden=!on;$('#filtersBtn').setAttribute('aria-expanded',on);if(on)$('#filtersClose').focus();else $('#filtersBtn').focus();};
  $('#filtersBtn').onclick=function(){open($('#filterPanel').hidden);};
  $('#filtersClose').onclick=function(){open(false);};
  $('#filterScrim').onclick=function(){open(false);};
  document.addEventListener('keydown',function(e){if(e.key==='Escape'&&!$('#filterPanel').hidden)open(false);});
  if(!OPTIONS.fy.length&&!OPTIONS.role.length)$('#filtersBtn').classList.add('hidden');
}
function drawChips(){
  if(!chipGroup('#gfFy',OPTIONS.fy,'fy'))$('#gfFyWrap').classList.add('hidden');
  if(!chipGroup('#gfFq',OPTIONS.fq,'fq'))$('#gfFqWrap').classList.add('hidden');
  if(!chipGroup('#gfRole',OPTIONS.role,'role'))$('#gfRoleWrap').classList.add('hidden');
}
function gfChanged(fromPanel){var parts=[].concat(GF.fy,GF.fq,GF.role);
  var b=$('#gfBadge');b.textContent=parts.length?'Filtered: '+parts.join(' · '):'';b.style.display=parts.length?'inline-block':'none';
  if(fromPanel&&HOSTED)post({type:'backstory:roi-filters-changed',filters:GF});
  rerender();}
/* The ROI page hosts this report: its own side panel holds the filters, and
   sends them here; this page's menu steps aside. Messages from anything but
   the parent are ignored, and filter values must be ones offered. */
var HOSTED=false;
function post(msg){try{if(window.parent&&window.parent!==window)window.parent.postMessage(msg,'*');}catch(e){}}
window.addEventListener('message',function(e){
  if(e.source!==window.parent||window.parent===window)return;var m=e.data||{};
  if(m.type==='backstory:roi-host'){HOSTED=true;document.body.classList.add('hosted');post({type:'backstory:roi-ready',options:OPTIONS,filters:GF});}
  if(m.type==='backstory:roi-filters'&&m.filters){var f=m.filters;['fy','fq','role'].forEach(function(k){GF[k]=Array.isArray(f[k])?f[k].filter(function(v){return OPTIONS[k].indexOf(v)>=0;}):[];});drawChips();gfChanged(false);}
  if(m.type==='backstory:roi-tab'&&typeof m.tab==='string')showTab(m.tab);
});

/* ---------- theme ---------- */
var themeMode='auto';
$('#themeBtn').onclick=function(){themeMode=themeMode==='auto'?'light':themeMode==='light'?'dark':'auto';
  if(themeMode==='auto')document.documentElement.removeAttribute('data-theme');else document.documentElement.setAttribute('data-theme',themeMode);
  $('#themeBtn').textContent='Theme: '+themeMode;renderHero();rerender();};
try{window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change',function(){if(themeMode==='auto'){renderHero();rerender();}});}catch(e){}

/* ---------- chart layer ----------
   One theme for every chart: thin rounded bars capped near 24px, hairline
   grid, a crosshair with one tooltip for every series on line charts, the
   hovered bar lifting, animated transitions between views (not under
   prefers-reduced-motion), a legend only when there are two or more series.
   Every chart gets a table view, an image download and an expanded view. */
var MONO='Chivo Mono, monospace';
var MOTION=(function(){try{return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;}catch(e){return true;}})();
function isObj(v){return !!v&&typeof v==='object'&&!Array.isArray(v);}
function merge(a,b){var out=Object.assign({},a);Object.keys(b||{}).forEach(function(k){out[k]=isObj(out[k])&&isObj(b[k])?merge(out[k],b[k]):b[k];});return out;}
function rgba(hex,a){var m=/^#?([0-9a-f]{6})$/i.exec(String(hex).trim());if(!m)return hex;var n=parseInt(m[1],16);return 'rgba('+(n>>16&255)+','+(n>>8&255)+','+(n&255)+','+a+')';}
function base(extra){
  var t=css('--text'),t2=css('--text2'),t3=css('--text3'),r=css('--rule'),rs=css('--rule-strong');
  var L={paper_bgcolor:'rgba(0,0,0,0)',plot_bgcolor:'rgba(0,0,0,0)',font:{family:css('--sans'),size:13,color:t2},
    margin:{l:56,r:20,t:14,b:48},
    hoverlabel:{font:{family:MONO,size:12,color:t},bgcolor:css('--raised'),bordercolor:rs,align:'left',namelength:-1},
    xaxis:{gridcolor:'rgba(0,0,0,0)',linecolor:rs,zeroline:false,tickfont:{family:MONO,size:11,color:t3},automargin:true,fixedrange:true},
    yaxis:{gridcolor:r,gridwidth:1,linecolor:'rgba(0,0,0,0)',zeroline:false,tickfont:{family:MONO,size:11,color:t3},rangemode:'tozero',automargin:true,fixedrange:true},
    legend:{orientation:'h',x:0,y:1.02,yanchor:'bottom',font:{size:12,color:t2},itemclick:'toggle',itemdoubleclick:'toggleothers',itemsizing:'constant',tracegroupgap:4}};
  return merge(L,extra||{});
}
var PCFG={displayModeBar:false,responsive:true};
var NO_TOOLS={heroStrip:true};
function plot(id,data,layout){
  var el=document.getElementById(id);if(!el||!window.Plotly)return null;
  layout=layout||base();
  el.classList.remove('empty');el.removeAttribute('data-empty');
  styleTraces(data,layout,el);
  if(!NO_TOOLS[id])chartTools(el);
  Plotly.react(el,data,layout,PCFG);
  el._roi={data:data,layout:layout};
  el.classList.add('drawn');
  bindLift(el);
  if(el._roiWrap&&el._roiWrap.classList.contains('table'))refreshTable(el);
  return el;
}
/* A chart with nothing to draw says so in place of the plot. */
function emptyChart(id,msg){var el=document.getElementById(id);if(!el)return;if(window.Plotly&&el._roi)Plotly.purge(el);el._roi=null;el.classList.remove('drawn');el.classList.add('empty');el.setAttribute('data-empty',msg||'Nothing to draw yet.');}
function styleTraces(data,layout,el){
  var surf=css('--raised'),bars=0,hbars=0,lines=0,others=0,maxCats=1;
  data.forEach(function(tr){
    if(tr.type==='bar'){bars++;if(tr.orientation==='h')hbars++;var cats=(tr.orientation==='h'?tr.y:tr.x)||[];if(cats.length>maxCats)maxCats=cats.length;
      tr.marker=tr.marker||{};if(tr.marker.cornerradius==null)tr.marker.cornerradius=4;
      if(layout.barmode==='stack')tr.marker.line=Object.assign({color:surf,width:2},tr.marker.line||{});
      if(tr.text&&!tr.textfont)tr.textfont={family:MONO,size:11,color:css('--text')};else if(tr.textfont&&!tr.textfont.family)tr.textfont.family=MONO;}
    else if(tr.type==='scatter'){var mode=tr.mode||'lines';
      if(/lines/.test(mode)){lines++;tr.line=Object.assign({width:tr.stackgroup?1.2:2},tr.line||{});}
      if(/markers/.test(mode)){tr.marker=tr.marker||{};if(tr.marker.size==null)tr.marker.size=8;if(!tr.marker.line)tr.marker.line={color:surf,width:2};}
      if(tr.fill&&!tr.fillcolor&&tr.line&&tr.line.color)tr.fillcolor=rgba(tr.line.color,.12);
      if(tr.stackgroup&&!tr.fillcolor&&tr.line&&tr.line.color)tr.fillcolor=rgba(tr.line.color,.3);
      if(!/lines/.test(mode))others++;}
    else if(tr.type==='pie'){tr.marker=tr.marker||{};tr.marker.line=Object.assign({color:surf,width:2},tr.marker.line||{});if(tr.hole==null)tr.hole=.62;if(!tr.textfont)tr.textfont={family:MONO,size:12};others++;}
    else if(tr.type==='heatmap'){if(tr.xgap==null)tr.xgap=3;if(tr.ygap==null)tr.ygap=3;others++;}
    else others++;
  });
  /* Bars stay thin: the gap grows with the slot so a bar is about 24px however many categories there are. */
  if(bars){var groups=layout.barmode==='group'?data.filter(function(t){return t.type==='bar';}).length:1,m=layout.margin||{};
    var span=hbars?el.clientHeight-(m.t||14)-(m.b||48):el.clientWidth-(m.l||56)-(m.r||20);
    if(layout.bargroupgap==null)layout.bargroupgap=0.12;
    if(layout.bargap==null){var gap=0.4;if(span>0){var slot=span/maxCats,want=(groups>1?22:26)*groups;gap=1-want/slot;}layout.bargap=Math.max(0.28,Math.min(0.82,gap));}}
  if(layout.hovermode==null)layout.hovermode=(lines&&!bars&&!others)?'x unified':'closest';
  if(layout.hovermode==='x unified')layout.xaxis=merge(layout.xaxis||{},{showspikes:true,spikemode:'across',spikesnap:'cursor',spikethickness:1,spikecolor:css('--rule-strong'),spikedash:'solid'});
  var named=data.filter(function(t){return t.showlegend!==false&&t.hoverinfo!=='skip'&&t.type!=='heatmap';}).length;
  if(layout.showlegend==null)layout.showlegend=named>1;
  if(layout.showlegend&&layout.legend&&layout.legend.y>1){layout.margin=layout.margin||{};var rows=named>4?2:1;if((layout.margin.t||0)<22+rows*22)layout.margin.t=22+rows*22;}
  if(MOTION&&!others&&data.length&&layout.transition==null)layout.transition={duration:300,easing:'cubic-in-out'};
}
/* The hovered bar lifts: the others in its series step back. */
function bindLift(el){
  if(el._roiLift||!el.on)return;el._roiLift=true;var dimmed=[];
  var restore=function(){dimmed.forEach(function(n){n.style.opacity='';});dimmed=[];};
  el.on('plotly_hover',function(e){restore();var p=e.points&&e.points[0];if(!p||!p.data||p.data.type!=='bar')return;if(el._roi&&el._roi.layout.barmode==='stack')return;
    var traces=el.querySelectorAll('.barlayer .trace'),tr=traces[p.curveNumber];if(!tr)return;var pts=tr.querySelectorAll('.point');
    for(var i=0;i<pts.length;i++){if(i!==p.pointNumber){pts[i].style.opacity='.45';dimmed.push(pts[i]);}}});
  el.on('plotly_unhover',restore);
}
var ICON={table:'<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 4v16"/></svg>',
  png:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11m0 0 4-4m-4 4-4-4M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2"/></svg>',
  expand:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M20 15v5h-5M20 4l-6 6M4 20l6-6"/></svg>',
  close:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>'};
function chartTitle(el){var box=el.parentNode;while(box&&box!==document.body&&!box.querySelector('h3,h4'))box=box.parentNode;var h=box&&box!==document.body?box.querySelector('h3,h4'):null;return h?h.textContent.trim():'Chart';}
function chartTools(el){
  if(el._roiWrap)return;
  var wrap=document.createElement('div');wrap.className='chart-wrap';el.parentNode.insertBefore(wrap,el);
  var head=document.createElement('div');head.className='chart-head';
  var title=document.createElement('span');title.className='chart-title';title.textContent=chartTitle(el);head.appendChild(title);
  var mk=function(kind,label,toggles){var b=document.createElement('button');b.type='button';b.className='ctool';b.innerHTML=ICON[kind]+'<span>'+label+'</span>';b.setAttribute('aria-label',label);if(toggles)b.setAttribute('aria-pressed','false');head.appendChild(b);return b;};
  var tb=mk('table','Table',true),pb=mk('png','Image',false),xb=mk('expand','Expand',true);
  wrap.appendChild(head);wrap.appendChild(el);
  var table=document.createElement('div');table.className='chart-table';wrap.appendChild(table);
  el._roiWrap=wrap;el._roiTable=table;wrap._roiExpandBtn=xb;
  tb.onclick=function(){var on=!wrap.classList.contains('table');wrap.classList.toggle('table',on);tb.setAttribute('aria-pressed',on);if(on)refreshTable(el);else if(window.Plotly&&el._roi)Plotly.Plots.resize(el);};
  pb.onclick=function(){downloadChart(el);};
  xb.onclick=function(){expandChart(el,!wrap.classList.contains('expanded'));};
}
var SCRIM=null,EXPANDED=null;
function expandChart(el,on){
  var wrap=el._roiWrap;if(!wrap)return;
  if(on&&EXPANDED&&EXPANDED!==el)expandChart(EXPANDED,false);
  wrap.classList.toggle('expanded',on);var xb=wrap._roiExpandBtn;xb.setAttribute('aria-pressed',on);xb.innerHTML=ICON[on?'close':'expand']+'<span>'+(on?'Close':'Expand')+'</span>';xb.setAttribute('aria-label',on?'Close the expanded chart':'Expand');
  if(!SCRIM){SCRIM=document.createElement('div');SCRIM.className='chart-scrim';SCRIM.hidden=true;document.body.appendChild(SCRIM);SCRIM.onclick=function(){if(EXPANDED)expandChart(EXPANDED,false);};document.addEventListener('keydown',function(e){if(e.key==='Escape'&&EXPANDED)expandChart(EXPANDED,false);});}
  SCRIM.hidden=!on;EXPANDED=on?el:null;document.body.style.overflow=on?'hidden':'';
  if(window.Plotly&&el._roi)requestAnimationFrame(function(){Plotly.Plots.resize(el);});
  xb.focus();
}
function fmtCell(v,axis){if(v==null||v==='')return '–';if(typeof v!=='number')return String(v).replace(/<br>/g,' ');if(!isFinite(v))return '–';axis=axis||{};
  if(/\$/.test(axis.tickformat||'')||/\$/.test(axis.tickprefix||''))return money(v);
  var abs=Math.abs(v),str=abs>=100?Math.round(v).toLocaleString():abs>=10?v.toFixed(1):String(Math.round(v*100)/100);return str+(axis.ticksuffix||'');}
function catLabel(t,key,i){var c=(t[key]||[])[i];if(typeof c==='number'&&t.customdata&&typeof t.customdata[i]==='string')return t.customdata[i];return String(c).replace(/<br>/g,' ');}
/* The chart's values as a table — the same numbers, reachable without hovering. */
function refreshTable(el){
  var box=el._roiTable,R=el._roi;if(!box)return;box.textContent='';if(!R||!R.data.length)return;
  var data=R.data,L=R.layout,tbl=document.createElement('table'),thead=document.createElement('thead'),tbody=document.createElement('tbody'),tr=document.createElement('tr');
  var th=function(t){var c=document.createElement('th');c.textContent=t;return c;},td=function(t,cls){var c=document.createElement('td');c.textContent=t;if(cls)c.className=cls;return c;};
  var first=data[0];
  if(first.type==='heatmap'){tr.appendChild(th(''));first.x.forEach(function(x){tr.appendChild(th(String(x).replace(/<br>/g,' ')));});thead.appendChild(tr);
    first.y.forEach(function(y,i){var row=document.createElement('tr');row.appendChild(td(String(y),'txt'));(first.z[i]||[]).forEach(function(v,j){row.appendChild(td(first.text&&first.text[i]&&first.text[i][j]!==''?first.text[i][j]:fmtCell(v)));});tbody.appendChild(row);});}
  else if(first.type==='pie'){['','Count','Share'].forEach(function(h){tr.appendChild(th(h));});thead.appendChild(tr);var tot=first.values.reduce(function(a,b){return a+(b||0);},0);
    first.labels.forEach(function(lab,i){var row=document.createElement('tr');row.appendChild(td(String(lab),'txt'));row.appendChild(td(fmtCell(first.values[i])));row.appendChild(td(tot?p1(first.values[i]/tot*100):'–'));tbody.appendChild(row);});}
  else{var horiz=first.type==='bar'&&first.orientation==='h',catKey=horiz?'y':'x',valKey=horiz?'x':'y',valAxis=horiz?L.xaxis:L.yaxis;
    var series=data.filter(function(t){return t.hoverinfo!=='skip'&&(t[valKey]||[]).length;}),cats=[];
    series.forEach(function(t){(t[catKey]||[]).forEach(function(c,i){var lab=catLabel(t,catKey,i);if(cats.indexOf(lab)<0)cats.push(lab);});});
    tr.appendChild(th(''));series.forEach(function(t,i){tr.appendChild(th(t.name||(series.length===1?chartTitle(el):'Series '+(i+1))));});thead.appendChild(tr);
    cats.forEach(function(c){var row=document.createElement('tr');row.appendChild(td(c,'txt'));series.forEach(function(t){var ix=-1;for(var i=0;i<(t[catKey]||[]).length;i++){if(catLabel(t,catKey,i)===c){ix=i;break;}}row.appendChild(td(fmtCell(ix>=0?t[valKey][ix]:null,valAxis)));});tbody.appendChild(row);});}
  tbl.appendChild(thead);tbl.appendChild(tbody);var cap=document.createElement('caption');cap.textContent='The values drawn in the chart.';tbl.appendChild(cap);box.appendChild(tbl);
}
function downloadChart(el){
  if(!window.Plotly||!el._roi)return;var bg=css('--page'),name=chartTitle(el).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')||'chart';
  var reset=function(){return Plotly.relayout(el,{paper_bgcolor:'rgba(0,0,0,0)'});};
  Plotly.relayout(el,{paper_bgcolor:bg}).then(function(){return Plotly.downloadImage(el,{format:'png',width:Math.max(960,el.clientWidth),height:Math.max(540,el.clientHeight),scale:2,filename:name});}).then(reset,reset);
}
/* Paired charts share a hover: the decile under the pointer lights up in both. */
var LINKING=false;
function linkHover(ids){
  var els=ids.map(function(id){return document.getElementById(id);}).filter(function(e){return e&&e.on&&e._roi;});if(els.length<2)return;
  els.forEach(function(a){if(a._roiLinked)return;a._roiLinked=true;
    a.on('plotly_hover',function(e){if(LINKING)return;var p=e.points&&e.points[0];if(!p)return;LINKING=true;
      els.forEach(function(b){if(b===a||!b._roi)return;var pts=[];b._roi.data.forEach(function(t,ci){if(t.hoverinfo==='skip'||t.type!=='bar')return;var cats=(t.orientation==='h'?t.y:t.x)||[];var ix=cats.indexOf(p.data.orientation==='h'?p.y:p.x);if(ix>=0)pts.push({curveNumber:ci,pointNumber:ix});});
        try{if(pts.length)Plotly.Fx.hover(b,pts);}catch(err){}});
      LINKING=false;});
    a.on('plotly_unhover',function(){if(LINKING)return;LINKING=true;els.forEach(function(b){if(b!==a){try{Plotly.Fx.unhover(b);}catch(err){}}});LINKING=false;});});
}
/* A 12-point trend in a tile: the whole series faintly, the window in the accent, the last point marked. */
function spark(series,hiIdx){
  var pts=series.map(function(v,i){return v==null||isNaN(v)?null:[i,v];}).filter(Boolean);if(pts.length<2)return '';
  var W=120,H=28,pad=3,n=series.length,lo=Infinity,hi=-Infinity;pts.forEach(function(p){if(p[1]<lo)lo=p[1];if(p[1]>hi)hi=p[1];});if(hi===lo)hi=lo+1;
  var X=function(i){return (pad+(W-2*pad)*(n>1?i/(n-1):0)).toFixed(1);},Y=function(v){return (H-pad-(H-2*pad)*((v-lo)/(hi-lo))).toFixed(1);};
  var seg=function(ps){return ps.map(function(p,k){return (k?'L':'M')+X(p[0])+' '+Y(p[1]);}).join('');};
  var hiPts=pts.filter(function(p){return hiIdx&&hiIdx.indexOf(p[0])>=0;}),last=pts[pts.length-1];
  var area=hiPts.length>1?'<path class="fill" d="'+seg(hiPts)+'L'+X(hiPts[hiPts.length-1][0])+' '+(H-pad)+'L'+X(hiPts[0][0])+' '+(H-pad)+'Z"/>':'';
  var dot='M'+X(last[0])+' '+Y(last[1])+'h0.01';
  return '<svg class="spark" viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none" aria-hidden="true">'+area+'<path class="base" d="'+seg(pts)+'"/>'+(hiPts.length>1?'<path class="hi" d="'+seg(hiPts)+'"/>':'')+'<path class="halo" d="'+dot+'"/><path class="dot" d="'+dot+'"/></svg>';
}
function donutCenter(value,word){return {text:'<b>'+esc(String(value))+'</b><br>'+esc(word),showarrow:false,x:.5,y:.5,xref:'paper',yref:'paper',font:{family:MONO,size:15,color:css('--text')},align:'center'};}
var palette=function(){return [css('--s1'),css('--s2'),css('--s3'),css('--s4'),css('--s5'),css('--s6')];};
function ypct(extra){return Object.assign({ticksuffix:'%',rangemode:'tozero'},extra||{});}
var xcat=function(extra){return Object.assign({},extra||{});};
function segBind(sel,cb){$$(sel+' button').forEach(function(b){b.onclick=function(){$$(sel+' button').forEach(function(x){x.setAttribute('aria-pressed',x===b);});cb(b.getAttribute('data-v'));};});}
function segSet(sel,v){$$(sel+' button').forEach(function(x){x.setAttribute('aria-pressed',x.getAttribute('data-v')===v);});}

/* ---------- rep math ---------- */
function popMask(p){
  /* Readouts: the team row, or its role rows when roles are chosen; cohorts by their own rows (the readout has no role split within a cohort). */
  if(AG){var mk=U.users.map(function(u){if(u.k==='role')return p==='all'&&GF.role.length>0&&GF.role.indexOf(u.r)>=0;if(u.k==='org')return p==='all'&&!GF.role.length;return p!=='all'&&((p==='User'||p==='Non-user')?u.f===p:u.t===p);});mk.pop=p;return mk;}
  return U.users.map(function(u){return (p==='all'?true:(p==='User'||p==='Non-user')?u.f===p:u.t===p)&&roleOK(u);});}
/* Readouts: a cohort over the readout's own last 6 or 12 months reads its per-rep totals (quiet months count), so the comparison matches the readout. */
function cohortWindow(mask,mi){
  if(!AG||!AG.cohortWindows||!mask.pop||mask.pop==='all')return null;
  var len=mi.length,last=NM-1,contiguous=len&&mi[len-1]===last&&mi[0]===NM-len;if(!contiguous||(len!==6&&len!==12))return null;
  var row=AG.cohortWindows[len===6?'l6':'l12'][mask.pop];if(!row)return null;
  var out={},n=0;MK.forEach(function(k){out[k]=row[k]==null?NaN:row[k]/len;});U.users.forEach(function(u,i){if(mask[i])n+=WT[i];});out.n=n;return out;}
function winAvg(mask,mi,keys,raw){
  var cw=raw?null:cohortWindow(mask,mi);if(cw)return cw;
  var out={},n=0;(keys||MK).forEach(function(k,ki){var M=mat(k);if(!M){out[k]=NaN;return;}var s=0,c=0;
    for(var i=0;i<M.length;i++){if(!mask[i])continue;var rs=0,rc=0;for(var j=0;j<mi.length;j++){var v=M[i][mi[j]];if(v!=null){rs+=v;rc++;}}if(rc&&WT[i]){s+=rs/rc*WT[i];c+=WT[i];}}
    out[k]=c?s/c:NaN;if(k==='meeting_count'||(ki===0&&!n))n=c;});
  out.n=n;return out;}
function monthly(mask,k){var M=mat(k),r=[];if(!M)return MON.map(function(){return null;});for(var j=0;j<NM;j++){var s=0,c=0;for(var i=0;i<M.length;i++){if(!mask[i]||!WT[i])continue;var v=M[i][j];if(v!=null){s+=v*WT[i];c+=WT[i];}}r.push(c?s/c:null);}return r;}
function userAvg(i,k,mi){var M=mat(k);if(!M)return null;var s=0,c=0;for(var j=0;j<mi.length;j++){var v=M[i][mi[j]];if(v!=null){s+=v;c++;}}return c?s/c:null;}
var rng=function(a,b){var r=[];for(var i=Math.max(0,a);i<=b;i++)r.push(i);return r;};
var WN=CFG.windowMonths||6;
var OBS=(CFG.obs&&CFG.obs.length)?CFG.obs:rng(NM-WN,NM-1), BASE=(CFG.base&&CFG.base.length)?CFG.base:rng(NM-2*WN,NM-WN-1);
var wl=function(w){return w&&w.length?mlab(MON[w[0]])+' – '+mlab(MON[w[w.length-1]]):'–';};
var shift12=function(w){return w.map(function(i){return i-12;}).filter(function(i){return i>=0;});};
var L12=rng(NM-12,NM-1), P12=rng(NM-24,NM-13);

/* ---------- deal math (mirrors facts.ts dealGroup) ---------- */
var LEVELS=['Low (0–30)','Medium (31–70)','High (71+)'];
var levelOf=function(s){return s<=30?0:s<=70?1:2;};
function bucket(ix){var won=0,lo=Infinity,hi=-Infinity,dw=[],dl=[];ix.forEach(function(i){won+=D.w[i];if(D.s[i]<lo)lo=D.s[i];if(D.s[i]>hi)hi=D.s[i];if(D.d[i]>=0)(D.w[i]?dw:dl).push(D.d[i]);});
  return {n:ix.length,won:won,win_rate:ix.length?r1(won/ix.length*100):null,med_days_won:r1(median(dw)),med_days_lost:r1(median(dl)),lo:isFinite(lo)?lo:0,hi:isFinite(hi)?hi:0};}
function corr(xs,ys){var n=xs.length,mx=0,my=0,i;for(i=0;i<n;i++){mx+=xs[i];my+=ys[i];}mx/=n;my/=n;var a=0,b=0,c=0;for(i=0;i<n;i++){a+=(xs[i]-mx)*(ys[i]-my);b+=(xs[i]-mx)*(xs[i]-mx);c+=(ys[i]-my)*(ys[i]-my);}return b&&c?a/Math.sqrt(b*c):0;}
function dealGroup(ix){if(ix.length<20)return null;var order=ix.slice().sort(function(a,b){return (D.s[a]-D.s[b])||(a-b);}),n=order.length,dec=[[],[],[],[],[],[],[],[],[],[]];
  order.forEach(function(di,pos){var rank=pos+1,bin=rank===1?0:Math.max(0,Math.ceil((rank-1)*10/(n-1))-1);dec[Math.min(9,bin)].push(di);});
  var lv=[[],[],[]];ix.forEach(function(i){lv[levelOf(D.s[i])].push(i);});
  var deciles=dec.map(function(b,k){var o=bucket(b);o.dec=k+1;return o;}).filter(function(r){return r.n>0;});
  var levels=lv.map(function(b,k){var o=bucket(b);o.level=LEVELS[k];return o;}).filter(function(r){return r.n>0;});
  var won=0;ix.forEach(function(i){won+=D.w[i];});
  return {deciles:deciles,levels:levels,n:n,win_rate:r1(won/n*100),r_win:deciles.length>2?Math.round(corr(deciles.map(function(r){return r.dec;}),deciles.map(function(r){return r.win_rate||0;}))*100)/100:null};}
var ALL_TYPES='All (excl. renewals)';
function dealType(){var el=$('#dealType');return el&&el.value?el.value:ALL_TYPES;}
function typeOK(t){var sel=dealType();return sel===ALL_TYPES?!/renewal/i.test(t):t===sel;}
function dealIdx(opts){opts=opts||{};var incl=opts.incl!=null?opts.incl:$('#dealIncl').checked,out=[];if(!D)return out;
  for(var i=0;i<D.w.length;i++){if(!incl&&D.x[i])continue;if(!typeOK(D.types[D.t[i]]))continue;if(!opts.ignoreMonth&&!monthOK(D.m[i]>=0?D.months[D.m[i]]:null))continue;if(opts.extra&&!opts.extra(i))continue;out.push(i);}return out;}
function legacyTable(incl){if(!OPP)return null;var t=OPP[dealType()]?dealType():(OPP[ALL_TYPES]?ALL_TYPES:Object.keys(OPP)[0]);return OPP[t][incl?'incl':'excl'];}
/* Readouts: the type's table, or (with fiscal-year or quarter filters) levels from the monthly aggregates and deciles from the fiscal-year ones. */
function aggBucket(list){var n=0,won=0,vs=0,vn=0,es=0,en=0;list.forEach(function(r){n+=r.n;won+=r.won;if(r.vel!=null){vs+=r.vel*r.n;vn+=r.n;}if(r.eng!=null){es+=r.eng*r.n;en+=r.n;}});return {n:n,won:won,win_rate:n?r1(won/n*100):null,avg_days:vn?Math.round(vs/vn):null,med_days_won:null,med_days_lost:null,eng:en?es/en:null};}
function aggType(r){var t=dealType();return t===AG_ALL||r.t===t;}
function aggDeals(){
  var t=dealType();if(!GF.fy.length&&!GF.fq.length)return OPP[t]?OPP[t].excl:null;
  var mrows=AG.deals.monthly.filter(function(r){return aggType(r)&&aggOK(r);});
  var levels=[0,1,2].map(function(l){var b=aggBucket(mrows.filter(function(r){return r.l===l;}));b.level=LEVELS[l];b.lo=[0,31,71][l];b.hi=[30,70,100][l];return b;}).filter(function(b){return b.n>0;});
  var drows=AG.deals.decileFy.filter(function(r){return aggType(r)&&(!GF.fy.length||GF.fy.indexOf(r.fy)>=0);});
  var deciles=[1,2,3,4,5,6,7,8,9,10].map(function(d){var b=aggBucket(drows.filter(function(r){return r.dec===d;}));b.dec=d;b.lo=b.hi=b.eng==null?0:Math.round(b.eng);return b;}).filter(function(b){return b.n>0;});
  var tot=aggBucket(mrows);if(tot.n<20)return null;
  return {deciles:deciles,levels:levels,n:tot.n,win_rate:tot.win_rate,r_win:deciles.length>2?Math.round(corr(deciles.map(function(r){return r.dec;}),deciles.map(function(r){return r.win_rate||0;}))*100)/100:null};}
function currentDeals(){if(D)return dealGroup(dealIdx());if(AG)return aggDeals();return legacyTable($('#dealIncl')&&$('#dealIncl').checked);}
function defaultDeals(){if(AG)return OPP[AG_ALL]?OPP[AG_ALL].excl:null;if(D){var renew=D.types.map(function(t){return /renewal/i.test(t);}),ix=[];for(var i=0;i<D.w.length;i++)if(!renew[D.t[i]]&&!D.x[i])ix.push(i);return dealGroup(ix);}return OPP?(OPP['All (excl. renewals)']||OPP[Object.keys(OPP)[0]]).excl:null;}
var lvl=function(g,prefix){return g?g.levels.filter(function(r){return r.level.indexOf(prefix)===0;})[0]:null;};

/* ---------- hero ---------- */
function topCohort(){return CFG.cohort==='users'?'User':'High';}
function renderHero(){
  var g=defaultDeals();
  if(!g||!g.deciles.length){ if(HAS.U){var s=monthly(U.users.map(function(){return true;}),'dir_vp_exec'),hz=css('--horizon');
    plot('heroStrip',[{type:'scatter',mode:'lines',x:MON.map(mlab),y:s,line:{color:hz,width:2.5},fill:'tozeroy',hovertemplate:'%{x}<br>%{y:.2f}<extra></extra>'}],
      base({margin:{l:4,r:4,t:12,b:26},font:{family:css('--sans'),color:'#BBBCBC'},xaxis:{showgrid:false,linecolor:'#55555E',nticks:6,tickfont:{family:MONO,size:11,color:'#BBBCBC'}},yaxis:{visible:false},hoverlabel:{bgcolor:'#31313C',bordercolor:'#55555E',font:{family:MONO,size:12,color:'#FFFFFF'}}}));
    $('#heroCap').textContent='Director, VP and executive meetings per rep per month, all reps';}
    else $('[data-section="hero"]').classList.add('hidden'); return; }
  if(AG)$('#heroCap').textContent='Win rate by engagement decile, lowest to highest (every closed deal in the readout)';
  var d=g.deciles,hz2=css('--horizon');
  plot('heroStrip',[{type:'bar',x:d.map(function(r){return 'D'+r.dec;}),y:d.map(function(r){return r.win_rate;}),marker:{color:d.map(function(r,i){return i>=d.length-3?hz2:'rgba(255,255,255,.26)';}),cornerradius:4},
    text:d.map(function(r){return r.win_rate==null?'–':r.win_rate.toFixed(0)+'%';}),textposition:'outside',textfont:{family:MONO,size:12,color:'#FFFFFF'},cliponaxis:false,customdata:d.map(function(r){return r.n;}),
    hovertemplate:'Decile %{x}<br>Win rate %{y:.1f}%<br>%{customdata} deals<extra></extra>'}],
    base({margin:{l:4,r:4,t:22,b:26},font:{family:css('--sans'),color:'#BBBCBC'},xaxis:{showgrid:false,linecolor:'#55555E',tickfont:{family:MONO,size:11,color:'#BBBCBC'}},yaxis:{visible:false,range:[0,Math.max.apply(null,[10].concat(d.map(function(r){return r.win_rate||0;})))*1.2]},bargap:.3,hoverlabel:{bgcolor:'#31313C',bordercolor:'#55555E',font:{family:MONO,size:12,color:'#FFFFFF'}}}));
}
function renderHeroStats(){
  var out=[];
  if(HAS.U&&MK.indexOf('pipeline_created')>=0){var who=HAS.usage?topCohort():'all',m=HAS.usage?U.users.map(function(u){return (who==='User'?u.f===who:u.t===who);}):U.users.map(function(){return true;});
    var o=winAvg(m,OBS,['pipeline_created']);out.push([money(o.pipeline_created),'Pipeline created per rep per month'+(HAS.usage?(who==='User'?', Backstory users':', high adopters'):'')]);}
  var g=defaultDeals(),hi=lvl(g,'High'),lo=lvl(g,'Low');
  if(hi&&hi.win_rate!=null)out.push([hi.win_rate.toFixed(1)+'%','Win rate, high-engagement deals']);
  if(hi&&lo&&lo.win_rate)out.push([(hi.win_rate/lo.win_rate).toFixed(1)+'×','Win rate lift, high vs low engagement']);
  if(HAS.U&&MK.indexOf('pipeline_created')>=0){var all=U.users.map(function(){return true;}),a=winAvg(all,OBS,['pipeline_created']),b=winAvg(all,BASE,['pipeline_created']);out.push([sp(pct(a.pipeline_created,b.pipeline_created)),'Pipeline created per rep, vs baseline']);}
  if(out.length<4&&HAS.A360){var agg=a360Agg(0,A360.B.months.length-1),pw=agg['Power Users'],nn=agg['No Engagement'];if(pw&&nn&&nn.avg_created)out.push([(pw.avg_created/nn.avg_created).toFixed(1)+'×','Pipeline per account, Account 360 power users vs no engagement']);}
  var el=$('#heroStats');if(!out.length){el.classList.add('hidden');return;}
  el.style.setProperty('--cols',String(Math.min(4,out.length)));
  el.innerHTML=out.slice(0,4).map(function(s){return '<div><div class="v">'+esc(s[0])+'</div><div class="l">'+esc(s[1])+'</div></div>';}).join('');
}

/* ---------- executive summary ---------- */
var TAB_TAG={activity:'Activity trends',adoption:'Adoption impact',deals:'Deal engagement',stage:'Stage and persona',accounts:'Account engagement'};
function renderSummary(){
  $('#findings').innerHTML=N.findings.map(function(f,i){var t=TABS[f.tab]?f.tab:null;
    return '<article class="fcard'+(t?' t-'+t:'')+'"><div class="ftag">'+esc(t?TAB_TAG[t]:'Finding '+(i+1))+'</div><div class="ffig">'+esc(f.fig)+'</div><div class="fcap">'+esc(f.cap)+'</div><h3>'+esc(f.h)+'</h3><p>'+md(f.p)+'</p>'+(t?'<button class="go" data-go="'+esc(t)+'" type="button">See the detail</button>':'')+'</article>';}).join('');
  $$('.go').forEach(function(b){b.onclick=function(){showTab(b.getAttribute('data-go'));window.scrollTo({top:$('nav.tabs').offsetTop,behavior:'smooth'});};});
  $('#watch').innerHTML=N.watch.map(function(w){return '<li><b>'+esc(w.lead)+'</b> '+md(w.text)+'</li>';}).join('');
}
/* The scorecard: the configured observation window against its baseline, all reps (the role filter applies). */
function renderScorecard(){
  if(!HAS.U){$('#scoreBlock').classList.add('hidden');return;}
  var keys=['meeting_count','sent_email_count','dir_vp_exec','vp_meeting_count','people_engaged','pipeline_created','executive_meeting_count'].filter(function(k){return MK.indexOf(k)>=0;});
  MK.forEach(function(k){if(keys.length<6&&keys.indexOf(k)<0)keys.push(k);});keys=keys.slice(0,6);
  var mask=popMask('all'),O=winAvg(mask,OBS,keys),B=winAvg(mask,BASE,keys);
  $('#scoreWin').textContent=wl(OBS)+' vs '+wl(BASE)+(GF.role.length?' · '+GF.role.join(', '):'');
  $('#scoreKpis').innerHTML=keys.map(function(k){var c=pct(O[k],B[k]);return '<div class="tile"><div class="k">'+esc(LAB[k])+' per rep</div><div class="v">'+fmt(O[k],k)+'</div><div class="d '+(isNaN(c)?'':c>=0?'up':'down')+'">'+sp(c)+' vs '+fmt(B[k],k)+'</div>'+spark(monthly(mask,k),OBS)+'</div>';}).join('');
}
/* The adoption overview: who is in each usage cohort, and the pipeline each creates. */
function renderOverview(){
  if(!HAS.usage){$('#overviewBlock').classList.add('hidden');return;}
  var P=[css('--d1'),css('--d2'),css('--d3')],groups=['High','Medium','Low','No usage'],counts=groups.map(function(g){return headcount(function(u){return g==='No usage'?!u.t:u.t===g;});}),total=counts.reduce(function(a,b){return a+b;},0),noneLabel=AG?'Non-users':'No usage data';
  $('#ovDonutSub').textContent=AG?total.toLocaleString()+' people with activity: high, medium and low adopters by Backstory usage, and non-users.':total.toLocaleString()+' reps: thirds of usage, and reps with no usage data.';
  plot('ovDonut',[{type:'pie',hole:.62,labels:groups.map(function(g){return g==='No usage'?noneLabel:cohortName(g);}),values:counts,marker:{colors:[css('--d1'),css('--d2'),css('--d3'),css('--rule-strong')]},textinfo:'value',textposition:'inside',insidetextorientation:'horizontal',hovertemplate:'%{label}: %{value} reps (%{percent})<extra></extra>',sort:false,direction:'clockwise',rotation:-90}],base({showlegend:true,legend:{orientation:'h',y:-0.08,yanchor:'top',x:0.5,xanchor:'center'},margin:{l:8,r:8,t:8,b:8},annotations:[donutCenter(total.toLocaleString(),'reps')]}));
  var card=$('#ovPipeline').closest('.card');
  if(MK.indexOf('pipeline_created')<0){card.classList.add('hidden');return;}
  var C=['High','Medium','Low','Non-user'],v=C.map(function(c){return winAvg(popMask(c),OBS,['pipeline_created']).pipeline_created;});
  $('#ovPipelineSub').textContent='Average per rep per month, '+wl(OBS)+'.';
  plot('ovPipeline',[{type:'bar',x:C.map(cohortName),y:v,marker:{color:[P[0],P[1],P[2],css('--rule-strong')]},text:v.map(money),textposition:'outside',cliponaxis:false,hovertemplate:'%{x}<br>%{y:$,.0f}<extra></extra>'}],
    base({showlegend:false,margin:{l:48,r:8,t:18,b:60},xaxis:xcat(),yaxis:{tickformat:'$.2s',rangemode:'tozero'}}));
}
function setupCalc(){
  if(!OPP||META.medWon==null){$('#calc').classList.add('hidden');return;}
  $('#cType').innerHTML=Object.keys(OPP).map(function(t){return '<option>'+esc(t)+'</option>';}).join('');
  $('#cVal').value=Math.round(META.medWon);
  $('#cValNote').textContent='Default is the median won deal value ('+money(META.medWon)+'). The mean, capped at the 95th percentile, is '+money(META.meanWonCap)+'.';
  ['cPct','cType','cVal'].forEach(function(id){document.getElementById(id).addEventListener('input',calc);});calc();
}
function calc(){
  var p=+$('#cPct').value/100,t=$('#cType').value,v=+$('#cVal').value||0;$('#cPctL').textContent=Math.round(p*100)+'%';
  var lv=OPP[t].excl.levels;if(lv.length<2)return;var yrs=Math.max(1,(NM||12)/12),nYr=lv[0].n/yrs,lift=nYr*p,dw=((lv[1].win_rate||0)-(lv[0].win_rate||0))/100,wins=lift*dw;
  $('#cN').textContent=n0(nYr);$('#cLift').textContent=n0(lift);$('#cWR').textContent=(lv[0].win_rate||0).toFixed(1)+'% → '+(lv[1].win_rate||0).toFixed(1)+'%';$('#cWins').textContent=n0(wins);$('#cBig').textContent=money(wins*v);
}

/* ---------- leading indicators ---------- */
var leadMetric=MK.indexOf('dir_vp_exec')>=0?'dir_vp_exec':MK[0], mixKind='meetings';
var W=NM?{L6:rng(NM-6,NM-1),P6:rng(NM-12,NM-7),PY:rng(NM-18,NM-13),L12:rng(NM-12,NM-1),P12:rng(0,NM-13),L3:rng(NM-3,NM-1),P3:rng(NM-6,NM-4)}:{};
/* The comparison the analysis was configured with, as one of the dashboard's own buttons (or Custom with its months). */
var leadMode=(function(){if(CFG.custom)return 'custom';var n=CFG.windowMonths||6,c=CFG.comparison||'prior';if(n===6&&c==='prior')return 'pp';if(n===6&&c==='year_ago')return 'yoy';if(n===12&&c==='prior')return 'y12';if(n===3&&c==='prior')return 'q';return 'custom';})();
function setupLead(){
  $('#leadMetric').innerHTML=MK.map(function(k){return '<button type="button" data-k="'+k+'" aria-pressed="'+(k===leadMetric)+'">'+esc(LAB[k])+'</button>';}).join('');
  $$('#leadMetric button').forEach(function(b){b.onclick=function(){leadMetric=b.getAttribute('data-k');$$('#leadMetric button').forEach(function(x){x.setAttribute('aria-pressed',x===b);});renderLead();};});
  var opts=MON.map(function(m,i){return '<option value="'+i+'">'+mlab(m)+'</option>';}).join('');
  ['bS','bE','oS','oE'].forEach(function(id){document.getElementById(id).innerHTML=opts;});
  $('#bS').value=BASE[0]!=null?BASE[0]:Math.max(0,NM-12);$('#bE').value=BASE.length?BASE[BASE.length-1]:Math.max(0,NM-7);$('#oS').value=OBS[0]!=null?OBS[0]:Math.max(0,NM-6);$('#oE').value=OBS.length?OBS[OBS.length-1]:NM-1;
  if(!HAS.usage)$('#leadPop').innerHTML='<option value="all">All reps</option>';
  segSet('#leadMode',leadMode);$('#leadCustom').classList.toggle('on',leadMode==='custom');
  segBind('#leadMode',function(v){leadMode=v;$('#leadCustom').classList.toggle('on',v==='custom');renderLead();});
  segBind('#mixKind',function(v){mixKind=v;renderMix();});
  ['bS','bE','oS','oE','leadPop'].forEach(function(id){document.getElementById(id).addEventListener('change',renderLead);});
  var hasMix=function(k){return AG?!!AG.org[k]:!!mat(k);};
  if(!hasMix('in_person_meeting_count')&&!hasMix('received_email_count'))$('#mixBlock').classList.add('hidden');
  else{if(!hasMix('in_person_meeting_count')&&!hasMix('conference_call_count')){mixKind='emails';segSet('#mixKind','emails');$('#mixKind button[data-v="meetings"]').classList.add('hidden');}
    if(!hasMix('received_email_count'))$('#mixKind button[data-v="emails"]').classList.add('hidden');}
  if(!mat('director_meeting_count')&&!mat('vp_meeting_count'))$('#seniorBlock').classList.add('hidden');
}
function leadWindows(){
  if(leadMode==='pp')return [W.P6,W.L6,'Prior 6 months ('+wl(W.P6)+')','Last 6 months ('+wl(W.L6)+')'];
  if(leadMode==='yoy')return [W.PY,W.L6,'Same period last year ('+wl(W.PY)+')','Last 6 months ('+wl(W.L6)+')'];
  if(leadMode==='y12')return [W.P12,W.L12,'Prior 12 months ('+wl(W.P12)+')','Last 12 months ('+wl(W.L12)+')'];
  if(leadMode==='q')return [W.P3,W.L3,'Prior quarter ('+wl(W.P3)+')','Last quarter ('+wl(W.L3)+')'];
  var a=+$('#bS').value,b=+$('#bE').value,c=+$('#oS').value,d=+$('#oE').value;if(b<a){var t=a;a=b;b=t;}if(d<c){var t2=c;c=d;d=t2;}
  return [rng(a,b),rng(c,d),'Baseline ('+mlab(MON[a])+' – '+mlab(MON[b])+')','Observation ('+mlab(MON[c])+' – '+mlab(MON[d])+')'];
}
function bands(bw,ow,B,O){var s=[],hz=css('--horizon');
  if(bw.length){s.push({type:'rect',xref:'x',yref:'paper',x0:bw[0]-.5,x1:bw[bw.length-1]+.5,y0:0,y1:1,fillcolor:css('--rule-strong'),opacity:.18,line:{width:0},layer:'below'});if(B!=null&&!isNaN(B))s.push({type:'line',xref:'x',x0:bw[0]-.5,x1:bw[bw.length-1]+.5,y0:B,y1:B,line:{color:css('--text3'),width:2,dash:'dot'}});}
  if(ow.length){s.push({type:'rect',xref:'x',yref:'paper',x0:ow[0]-.5,x1:ow[ow.length-1]+.5,y0:0,y1:1,fillcolor:hz,opacity:.16,line:{width:0},layer:'below'});if(O!=null&&!isNaN(O))s.push({type:'line',xref:'x',x0:ow[0]-.5,x1:ow[ow.length-1]+.5,y0:O,y1:O,line:{color:css('--horizon-deep'),width:2,dash:'dot'}});}
  return s;}
var monthAxis=function(extra){return Object.assign({tickmode:'array',tickvals:MON.map(function(m,i){return i;}).filter(function(i){return i%3===0;}),ticktext:MON.filter(function(m,i){return i%3===0;}).map(mlab),gridcolor:'rgba(0,0,0,0)',linecolor:css('--rule-strong'),tickfont:{family:MONO,size:11}},extra||{});};
function renderLead(){
  var pop=$('#leadPop').value,mask=popMask(pop),w=leadWindows(),bw=w[0],ow=w[1],bl=w[2],ol=w[3];
  var B=winAvg(mask,bw),O=winAvg(mask,ow),k=leadMetric,series=monthly(mask,k),hz=css('--horizon');
  $('#leadTitle').textContent=LAB[k]+', monthly average per rep';
  plot('leadTrend',[{type:'scatter',mode:'lines+markers',x:MON.map(function(m,i){return i;}),y:series,line:{color:hz,width:2.2,shape:'spline',smoothing:.4},marker:{color:hz},
    customdata:MON.map(mlab),hovertemplate:'%{customdata}<br>'+(isMoney(k)?'$%{y:,.0f}':'%{y:.2f}')+'<extra></extra>',name:LAB[k]}],
    base({shapes:bands(bw,ow,B[k],O[k]),showlegend:false,xaxis:monthAxis(),yaxis:{gridcolor:css('--rule'),rangemode:'tozero',tickformat:isMoney(k)?'$.2s':'',tickfont:{family:MONO,size:11}}}));
  var ch=pct(O[k],B[k]),popName=$('#leadPop').selectedOptions[0].text.toLowerCase()+(GF.role.length?' ('+GF.role.join(', ')+')':'');
  $('#leadDyn').innerHTML='For '+esc(popName)+', <b>'+esc(LAB[k].toLowerCase())+'</b> averaged <b class="num">'+fmt(O[k],k)+'</b> per rep per month in the '+esc(ol.toLowerCase().replace(/ \(.*/,''))+' window vs <b class="num">'+fmt(B[k],k)+'</b> in the baseline, a change of <b class="num">'+sp(ch)+'</b>. '+O.n.toLocaleString()+' reps in the observation window, '+B.n.toLocaleString()+' in the baseline.';
  $('#leadTblSub').textContent=bl+' vs '+ol+'. Population: '+$('#leadPop').selectedOptions[0].text+(GF.role.length?' · '+GF.role.join(', '):'')+'.';
  $('#leadTbl').innerHTML='<thead><tr><th>Metric</th><th>Baseline</th><th>Observation</th><th>Change</th></tr></thead><tbody>'+
    MK.map(function(m){var c=pct(O[m],B[m]);return '<tr><td>'+esc(LAB[m])+'</td><td>'+fmt(B[m],m)+'</td><td>'+fmt(O[m],m)+'</td><td class="'+(c>=0?'up':'down')+'">'+sp(c)+'</td></tr>';}).join('')+
    '<tr><td>Reps in window</td><td>'+B.n.toLocaleString()+'</td><td>'+O.n.toLocaleString()+'</td><td></td></tr></tbody>';
  renderPeriod(B,O,bl,ol);renderMix();renderSenior();
}
/* Period comparison: every metric's change against the baseline, in one unit (the table below holds the values). */
function renderPeriod(B,O,bl,ol){
  var keys=MK.filter(function(k){var c=pct(O[k],B[k]);return !isNaN(c)&&isFinite(c);});
  if(!keys.length){$('#periodBlock').classList.add('hidden');return;}
  $('#periodBlock').classList.remove('hidden');
  var ch=keys.map(function(k){return pct(O[k],B[k]);}),lo=Math.min.apply(null,ch.concat([0])),hi=Math.max.apply(null,ch.concat([0])),pad=(hi-lo)*0.2||5;
  $('#periodSub').textContent='Change per rep per month: '+ol+' against '+bl+'.';
  plot('periodChart',[{type:'bar',orientation:'h',y:keys.map(function(k){return LAB[k];}),x:ch,marker:{color:ch.map(function(v){return v>=0?css('--d1'):css('--neg');})},text:ch.map(sp),textposition:'outside',cliponaxis:false,textfont:{family:MONO,size:12,color:css('--text')},
    customdata:keys.map(function(k){return [fmt(B[k],k),fmt(O[k],k)];}),hovertemplate:'%{y}<br>%{customdata[0]} → %{customdata[1]} per rep per month<extra></extra>'}],
    base({margin:{l:200,r:64,t:10,b:36},yaxis:{autorange:'reversed',automargin:true,tickfont:{size:13}},xaxis:{ticksuffix:'%',range:[lo-pad,hi+pad],zeroline:true,zerolinecolor:css('--rule-strong'),gridcolor:css('--rule'),tickfont:{family:MONO,size:11}},showlegend:false}));
  var moves=keys.map(function(k,i){return [k,ch[i]];}).sort(function(a,b){return Math.abs(b[1])-Math.abs(a[1]);}).slice(0,3);
  $('#periodNote').innerHTML=moves.map(function(m){return '<b>'+esc(LAB[m[0]])+'</b> '+(m[1]>=0?'rose':'fell')+' <b class="num">'+sp(m[1])+'</b>';}).join('; ')+' per rep per month against the baseline.';
}
function renderMix(){
  if($('#mixBlock').classList.contains('hidden'))return;
  var mask=popMask($('#leadPop').value),w=leadWindows(),bw=w[0],ow=w[1],P=palette();
  var keys=mixKind==='meetings'?[['meeting_count','All meetings'],['in_person_meeting_count','In person'],['conference_call_count','Conference calls']]:[['sent_email_count','Sent'],['received_email_count','Received']];
  keys=keys.filter(function(p){return AG?!!AG.org[p[0]]:mat(p[0]);});
  var seriesOf=function(k){return AG?AG.org[k]:monthly(mask,k);};
  plot('mixChart',keys.map(function(p,i){return {type:'scatter',mode:'lines',name:p[1],x:MON.map(function(m,j){return j;}),y:seriesOf(p[0]),line:{color:P[i],width:i===0?2.6:2,dash:i===0?'solid':'dot'},customdata:MON.map(mlab),hovertemplate:'%{customdata}<br>'+esc(p[1])+': %{y:.2f}<extra></extra>'};}),
    base({shapes:bands(bw,ow),xaxis:monthAxis(),hovermode:'x unified'}));
  var avgOf=function(k,w){var s=AG?AG.org[k]:null;if(!s){var A=winAvg(mask,w,[k]);return A[k];}var t=0,c=0;w.forEach(function(j){if(s[j]!=null){t+=s[j];c++;}});return c?t/c:NaN;};
  var O={},B={};keys.forEach(function(p){O[p[0]]=avgOf(p[0],ow);B[p[0]]=avgOf(p[0],bw);});
  var note='';if(mixKind==='meetings'&&keys.length>1&&O.meeting_count){note=keys.slice(1).map(function(p){return esc(p[1])+' are <b class="num">'+p1(O[p[0]]/O.meeting_count*100)+'</b> of meetings in the observation window vs <b class="num">'+p1(B[p[0]]/B.meeting_count*100)+'</b> in the baseline.';}).join(' ');}
  else if(mixKind==='emails'&&O.sent_email_count&&O.received_email_count){note='Reps send <b class="num">'+fmt(O.sent_email_count,'x')+'</b> emails per month for every <b class="num">'+fmt(O.received_email_count,'x')+'</b> received in the observation window ('+(O.sent_email_count/O.received_email_count).toFixed(2)+' sent per received, vs '+(B.received_email_count?(B.sent_email_count/B.received_email_count).toFixed(2):'–')+' in the baseline).';}
  $('#mixNote').innerHTML=(note||'Monthly averages per rep for the same reps and windows as the tiles above.')+(AG?' The readout splits channels for the whole team only, so this chart does not follow the population.':'');
}
function renderSenior(){
  if($('#seniorBlock').classList.contains('hidden'))return;
  var mask=popMask($('#leadPop').value),w=leadWindows(),bw=w[0],ow=w[1],ly=shift12(ow);
  var keys=[['director_meeting_count','Director'],['vp_meeting_count','VP'],['executive_meeting_count','Executive']].filter(function(p){return mat(p[0]);});
  var periods=[];if(ly.length&&ly.join()!==bw.join())periods.push(['A year earlier ('+wl(ly)+')',ly,css('--rule-strong')]);periods.push(['Baseline ('+wl(bw)+')',bw,css('--d3')]);periods.push(['Observation ('+wl(ow)+')',ow,css('--d1')]);
  plot('seniorChart',periods.map(function(p){var a=winAvg(mask,p[1],keys.map(function(k){return k[0];}));return {type:'bar',name:p[0],x:keys.map(function(k){return k[1];}),y:keys.map(function(k){return a[k[0]];}),marker:{color:p[2]},hovertemplate:'%{x}: %{y:.2f} per rep per month<extra>'+esc(p[0])+'</extra>'};}),
    base({barmode:'group',xaxis:xcat()}));
}

/* ---------- adoption tiers / users vs non-users ---------- */
var adoptView=CFG.cohort==='users'?'users':'tiers', adoptWin='obs', rosterTier='All', rosterSort={k:'ev',dir:-1};
var WN_LABEL='Last '+(OBS.length||WN)+' months';
var cohortName=function(c){return c==='User'?'Backstory users':c==='Non-user'?'Non-users':c+' adopters';};
function winsFor(w){return w==='l12'?[L12,P12,'last 12 months','prior 12 months ('+wl(P12)+')']:[OBS,BASE,'observation window ('+wl(OBS)+')','baseline ('+wl(BASE)+')'];}
function setupCohorts(){
  $('#adoptWin button[data-v="obs"]').textContent=WN_LABEL;if((OBS.length||WN)===12)$('#adoptWin button[data-v="l12"]').classList.add('hidden');
  segSet('#adoptView',adoptView);
  segBind('#adoptView',function(v){adoptView=v;renderAdoption();});
  segBind('#adoptWin',function(v){adoptWin=v;renderAdoption();});
  var metricOpts=function(sel){return MK.map(function(k){return '<option value="'+k+'"'+(k===sel?' selected':'')+'>'+esc(LAB[k])+'</option>';}).join('');};
  var def=MK.indexOf('dir_vp_exec')>=0?'dir_vp_exec':MK[0];
  $('#adoptTrendMetric').innerHTML=metricOpts(def);$('#adoptTrendMetric').onchange=function(){cohortTrend('adoptTrend',['High','Medium','Low'],$('#adoptTrendMetric').value);};
  $('#usersTrendMetric').innerHTML=metricOpts(def);$('#usersTrendMetric').onchange=function(){var k=$('#usersTrendMetric').value;$('#usersTrendTitle').textContent=k==='dir_vp_exec'?'The senior-meeting gap over time':'The gap over time: '+LAB[k].toLowerCase();cohortTrend('usersTrend',['User','Non-user'],k);};
  $('#rosterQ').addEventListener('input',renderRoster);
  if(!HAS.roster)$('#rosterBlock').classList.add('hidden');
}
function cohortKpis(el,C,A,w){var top=C[0],bot=C[C.length-1],kk=['meeting_count','dir_vp_exec','people_engaged','pipeline_created'].filter(function(k){return MK.indexOf(k)>=0;}),mask=popMask(top);
  $(el).innerHTML=kk.map(function(k){var c=pct(A[top][k],A[bot][k]);return '<div class="tile"><div class="k">'+esc(LAB[k])+' · '+esc(cohortName(top).toLowerCase())+'</div><div class="v">'+fmt(A[top][k],k)+'</div><div class="d '+(isNaN(c)?'':c>=0?'up':'down')+'">'+sp(c)+' vs '+esc(cohortName(bot).toLowerCase())+' ('+fmt(A[bot][k],k)+')</div>'+spark(monthly(mask,k),w||OBS)+'</div>';}).join('');}
function cohortBars(senId,pipeId,C,w){var P=[css('--d1'),css('--d2'),css('--d3')];
  var sk=[['director_meeting_count','Director'],['vp_meeting_count','VP'],['executive_meeting_count','Executive']].filter(function(p){return mat(p[0]);});
  plot(senId,sk.map(function(p,i){return {type:'bar',name:p[1],x:C.map(cohortName),y:C.map(function(c){return winAvg(popMask(c),w,[p[0]])[p[0]];}),marker:{color:P[i]},hovertemplate:'%{x}<br>'+p[1]+': %{y:.2f}<extra></extra>'};}),base({barmode:'group',margin:{l:40,r:8,t:10,b:60},xaxis:xcat()}));
  if(MK.indexOf('pipeline_created')<0){$('#'+pipeId).closest('.card').classList.add('hidden');return;}
  var v=C.map(function(c){return winAvg(popMask(c),w,['pipeline_created']).pipeline_created;});
  plot(pipeId,[{type:'bar',x:C.map(cohortName),y:v,marker:{color:C.map(function(c,i){return P[i];})},text:v.map(money),textposition:'outside',cliponaxis:false,hovertemplate:'%{x}<br>%{y:$,.0f}<extra></extra>'}],base({showlegend:false,margin:{l:48,r:8,t:18,b:60},xaxis:xcat(),yaxis:{tickformat:'$.2s',rangemode:'tozero'}}));
  linkHover([senId,pipeId]);
}
function cohortTrend(id,C,k){var P=palette();
  plot(id,C.map(function(c,i){return {type:'scatter',mode:'lines',name:cohortName(c),x:MON.map(mlab),y:monthly(popMask(c),k),line:{color:i===C.length-1?css('--text3'):P[i],width:2.4,dash:i===C.length-1?'dot':'solid'}};}),
    base({hovermode:'x unified',xaxis:{gridcolor:'rgba(0,0,0,0)',nticks:8,linecolor:css('--rule-strong'),tickfont:{family:MONO,size:11}},yaxis:{gridcolor:css('--rule'),rangemode:'tozero',tickformat:isMoney(k)?'$.2s':'',tickfont:{family:MONO,size:11}}}));
}
/* Adoption impact: the tiers or users vs non-users view, then the roster. */
function renderAdoption(){
  $('#tiersView').classList.toggle('hidden',adoptView!=='tiers');
  $('#usersView').classList.toggle('hidden',adoptView!=='users');
  if(adoptView==='users'){renderUsers();renderRoster();}else renderAdopt();
}
function renderAdopt(){
  var C=['High','Medium','Low'],w=winsFor(adoptWin),A={},Ar={},Bs={};
  /* Change against each tier's own baseline compares like with like: monthly averages on both sides (a readout's totals cover only its last 6 and 12 months). */
  C.forEach(function(c){A[c]=winAvg(popMask(c),w[0]);Ar[c]=winAvg(popMask(c),w[0],undefined,true);Bs[c]=winAvg(popMask(c),w[1]);});
  var nT={High:headcount(function(u){return u.t==='High';}),Medium:headcount(function(u){return u.t==='Medium';}),Low:headcount(function(u){return u.t==='Low';})};
  if(AG)$('#adoptionIntro').innerHTML=(nT.High+nT.Medium+nT.Low)+' people use Backstory: '+nT.High+' high, '+nT.Medium+' medium and '+nT.Low+' low adopters by usage, against '+headcount(function(u){return u.f==='Non-user';})+' non-users. Averages are per rep per month; the readout has no role split within a cohort, so the role filter narrows the team views and the roster.';
  else $('#adoptionIntro').innerHTML=U.nUsage+' reps appear in both the activity extract and the usage file. They\'re split into equal thirds by usage score: high (more than '+U.tierCuts[1]+', '+nT.High+' reps), medium ('+(U.tierCuts[0]+1)+'–'+U.tierCuts[1]+', '+nT.Medium+') and low ('+U.tierCuts[0]+' or fewer, '+nT.Low+').'+(GF.role.length?' Role: '+esc(GF.role.join(', '))+'.':'');
  cohortKpis('#adoptKpis',C,A,w[0]);
  var cols={High:css('--d1'),Medium:css('--d2')};
  plot('adoptIndex',['High','Medium'].map(function(t){return {type:'bar',name:t+' adopters',x:MK.map(function(k){return wrapLab(LAB[k]);}),y:MK.map(function(k){return A[t][k]/A.Low[k]*100;}),marker:{color:cols[t]},
    customdata:MK.map(function(k){return [fmt(A[t][k],k),fmt(A.Low[k],k)];}),hovertemplate:'%{x}<br>'+t+': %{customdata[0]} vs Low: %{customdata[1]}<br>Index %{y:.0f}<extra></extra>'};}),
    base({barmode:'group',shapes:[{type:'line',xref:'paper',x0:0,x1:1,y0:100,y1:100,line:{color:css('--text3'),width:1.5,dash:'dash'}}],
      annotations:[{xref:'paper',x:1,y:100,text:'Low = 100',showarrow:false,xanchor:'right',yanchor:'bottom',font:{family:MONO,size:11,color:css('--text3')}}],
      xaxis:{tickangle:0,automargin:true,gridcolor:'rgba(0,0,0,0)',tickfont:{size:11}},margin:{l:48,r:10,t:14,b:80}}));
  cohortBars('adoptSenior','adoptPipeline',C,w[0]);
  var groups=['High','Medium','Low','No usage'],counts=groups.map(function(g){return headcount(function(u){return g==='No usage'?!u.t:u.t===g;});});
  var donutTotal=counts.reduce(function(a,b){return a+b;},0);
  var donut=plot('adoptDonut',[{type:'pie',hole:.62,labels:groups.map(function(g){return g==='No usage'?(AG?'Non-users':'No usage data'):cohortName(g);}),values:counts,customdata:groups,marker:{colors:[css('--d1'),css('--d2'),css('--d3'),css('--rule-strong')]},textinfo:'value',textposition:'inside',insidetextorientation:'horizontal',hovertemplate:'%{label}: %{value} reps (%{percent})<br>Select to filter the roster<extra></extra>',sort:false,direction:'clockwise',rotation:-90}],base({showlegend:true,legend:{orientation:'h',y:-0.08,yanchor:'top',x:0.5,xanchor:'center'},margin:{l:8,r:8,t:8,b:8},annotations:[donutCenter(donutTotal.toLocaleString(),'reps')]}));
  if(donut&&donut.on&&!donut._roiBound){donut._roiBound=true;donut.on('plotly_click',function(e){var g=e.points&&e.points[0]&&e.points[0].customdata;if(g==null)return;rosterTier=Array.isArray(g)?g[0]:g;renderRoster();var rb=$('#rosterBlock');if(rb)rb.scrollIntoView({behavior:'smooth',block:'start'});});}
  cohortTrend('adoptTrend',C,$('#adoptTrendMetric').value);
  $('#adoptTblSub').textContent='Averages per rep per month in the '+w[2]+'; change against each tier\'s own '+w[3]+'.';
  $('#adoptTbl').innerHTML='<thead><tr><th>Metric</th>'+C.map(function(t){return '<th>'+t+'</th><th>Change</th>';}).join('')+'</tr></thead><tbody>'+
    MK.map(function(k){return '<tr><td>'+esc(LAB[k])+'</td>'+C.map(function(t){var c=pct(Ar[t][k],Bs[t][k]);return '<td>'+fmt(A[t][k],k)+'</td><td class="'+(isNaN(c)?'':c>=0?'up':'down')+'">'+sp(c)+'</td>';}).join('')+'</tr>';}).join('')+
    '<tr><td>Reps</td>'+C.map(function(t){return '<td>'+A[t].n+'</td><td></td>';}).join('')+'</tr></tbody>';
  renderRoster();
}
function renderUsers(){
  var C=['User','Non-user'],w=winsFor(adoptWin),A={};C.forEach(function(c){A[c]=winAvg(popMask(c),w[0]);});
  var nUser=headcount(function(u){return u.f==='User';}),nAll=headcount(function(){return true;});
  if(AG)$('#adoptionIntro').innerHTML='Users are the '+nUser+' people with Backstory usage; non-users the '+(nAll-nUser)+' without. Averages are per rep per month.';
  else $('#adoptionIntro').innerHTML='Users are the '+nUser+' reps with usage above the bottom 5%. Non-users are the '+(nAll-nUser).toLocaleString()+' reps in the activity extract with no usage, plus the '+U.nBottom+' lowest-usage reps.'+(GF.role.length?' Role: '+esc(GF.role.join(', '))+'.':'');
  cohortKpis('#usersKpis',C,A,w[0]);
  var lifts=MK.map(function(k){return pct(A.User[k],A['Non-user'][k]);});
  plot('usersLift',[{type:'bar',orientation:'h',y:MK.map(function(k){return LAB[k];}),x:lifts,marker:{color:lifts.map(function(v){return v>=0?css('--d1'):css('--neg');})},
    text:lifts.map(sp),textposition:'outside',cliponaxis:false,textfont:{family:MONO,size:12,color:css('--text')},
    customdata:MK.map(function(k){return [fmt(A.User[k],k),fmt(A['Non-user'][k],k)];}),hovertemplate:'%{y}<br>Users %{customdata[0]} vs non-users %{customdata[1]}<extra></extra>'}],
    base({margin:{l:200,r:60,t:10,b:36},yaxis:{autorange:'reversed',automargin:true,tickfont:{size:13}},xaxis:{ticksuffix:'%',zeroline:true,zerolinecolor:css('--rule-strong'),gridcolor:css('--rule'),tickfont:{family:MONO,size:11}},showlegend:false}));
  cohortBars('usersSenior','usersPipeline',C,w[0]);
  cohortTrend('usersTrend',C,$('#usersTrendMetric').value);
  $('#usersTbl').innerHTML='<thead><tr><th>Metric</th><th>Users</th><th>Non-users</th><th>Difference</th></tr></thead><tbody>'+
    MK.map(function(k,i){return '<tr><td>'+esc(LAB[k])+'</td><td>'+fmt(A.User[k],k)+'</td><td>'+fmt(A['Non-user'][k],k)+'</td><td class="'+(lifts[i]>=0?'up':'down')+'">'+sp(lifts[i])+'</td></tr>';}).join('')+
    '<tr><td>Reps</td><td>'+A.User.n+'</td><td>'+A['Non-user'].n.toLocaleString()+'</td><td></td></tr></tbody>';
}
var ROSTER_COLS=[['n','Name'],['tier','Cohort'],['r','Role'],['ti','Team or title'],['ev','Usage score'],['a','Account views'],['o','Opportunity views'],['meeting_count','Meetings'],['vp_meeting_count','VP meetings'],['executive_meeting_count','Exec meetings'],['pipeline_created','Pipeline created'],['last','Last active']];
var rosterRows=null;
function buildRoster(){
  if(AG){rosterRows=AG.roster.map(function(u,i){return {i:i,n:u.n,r:u.r||'Other',ti:u.ti,t:u.t,f:u.f,ev:u.ev,a:u.a,o:u.o,last:u.last,meeting_count:u.meetings,vp_meeting_count:u.vp,executive_meeting_count:u.exec,pipeline_created:u.pipeline};});return;}
  rosterRows=U.users.map(function(u,i){var row={i:i,n:u.n||'',r:u.r||'Other',ti:u.ti||u.g||'',t:u.t,f:u.f,ev:u.u?u.u.ev:null,a:u.u?u.u.a:null,o:u.u?u.u.o:null,last:u.u?u.u.last:null};
  ['meeting_count','vp_meeting_count','executive_meeting_count','pipeline_created'].forEach(function(k){row[k]=userAvg(i,k,OBS);});return row;});}
function renderRoster(){
  if(!HAS.roster)return;if(!rosterRows)buildRoster();
  var tiers=AG?['All','High','Medium','Low','Non-user']:['All','High','Medium','Low','No usage','User','Non-user'];if(tiers.indexOf(rosterTier)<0)rosterTier='All';
  $('#rosterTier').innerHTML=tiers.map(function(t){return '<button type="button" aria-pressed="'+(t===rosterTier)+'" data-v="'+t+'">'+esc(t==='All'?'All':t==='No usage'?'No usage data':cohortName(t))+'</button>';}).join('');
  $$('#rosterTier button').forEach(function(b){b.onclick=function(){rosterTier=b.getAttribute('data-v');renderRoster();};});
  var q=($('#rosterQ').value||'').toLowerCase();
  var rows=rosterRows.filter(function(r){var u=AG?{r:r.r}:U.users[r.i];if(!roleOK(u))return false;
    if(rosterTier!=='All'){if(rosterTier==='No usage'){if(r.t)return false;}else if(rosterTier==='User'||rosterTier==='Non-user'){if(r.f!==rosterTier)return false;}else if(r.t!==rosterTier)return false;}
    return !q||(r.n+' '+r.ti+' '+r.r).toLowerCase().indexOf(q)>=0;});
  var k=rosterSort.k,dir=rosterSort.dir;rows.sort(function(a,b){var va=k==='tier'?(a.t||a.f||''):a[k],vb=k==='tier'?(b.t||b.f||''):b[k];if(va==null&&vb==null)return 0;if(va==null)return 1;if(vb==null)return -1;return (typeof va==='string'?va.localeCompare(vb):va-vb)*dir;});
  $('#rosterSub').textContent=AG?rosterRows.length.toLocaleString()+' people · activity columns are totals for the last six months, as the readout reports them':rosterRows.length.toLocaleString()+' reps · activity columns are per-month averages in the observation window ('+wl(OBS)+')';
  $('#rosterTbl').innerHTML='<thead><tr>'+ROSTER_COLS.map(function(c){return '<th><button type="button" data-k="'+c[0]+'">'+esc(c[1])+(rosterSort.k===c[0]?(rosterSort.dir<0?' ↓':' ↑'):'')+'</button></th>';}).join('')+'</tr></thead><tbody>'+
    rows.slice(0,250).map(function(r){return '<tr><td>'+esc(r.n||'—')+'</td><td class="txt"><span class="badge">'+esc(r.t||(r.f==='User'?'User':r.f?'Non-user':'—'))+'</span></td><td class="txt">'+esc(r.r)+'</td><td class="txt">'+esc(r.ti)+'</td><td>'+n0(r.ev)+'</td><td>'+n0(r.a)+'</td><td>'+n0(r.o)+'</td><td>'+(AG?n0(r.meeting_count):fmt(r.meeting_count,'x'))+'</td><td>'+(AG?n0(r.vp_meeting_count):fmt(r.vp_meeting_count,'x'))+'</td><td>'+(AG?n0(r.executive_meeting_count):fmt(r.executive_meeting_count,'x'))+'</td><td>'+money(r.pipeline_created)+'</td><td>'+esc(r.last||'—')+'</td></tr>';}).join('')+'</tbody>';
  $$('#rosterTbl th button').forEach(function(b){b.onclick=function(){var kk=b.getAttribute('data-k');rosterSort={k:kk,dir:rosterSort.k===kk?-rosterSort.dir:-1};renderRoster();};});
  $('#rosterCount').textContent='Showing '+Math.min(250,rows.length).toLocaleString()+' of '+rows.length.toLocaleString()+' reps';
}

/* ---------- deal engagement ---------- */
var dealView='deciles', dealMode='overall', heatMode='share', stageView='share', persView='wr';
function setupDeals(){
  var types=D?[ALL_TYPES].concat(D.types.filter(function(t){var n=0;for(var i=0;i<D.t.length;i++)if(D.types[D.t[i]]===t)n++;return n>=20&&!/framework/i.test(t);})):Object.keys(OPP||{});
  if(AG){$('#dealInclWrap').classList.add('hidden');$('#p-deals .intro').textContent='Every closed deal in the readout with an engagement score, all deal types by default. Levels: low 0–30, medium 31–70, high 71+. Fiscal year and quarter filters slice the levels and the monthly view; deciles follow the fiscal year.';}
  $('#dealType').innerHTML=types.map(function(t){return '<option>'+esc(t)+'</option>';}).join('');
  $('#dealType').onchange=renderDeal;
  segBind('#dealView',function(v){dealView=v;renderDeal();});
  segBind('#dealMode',function(v){dealMode=v;renderDeal();});
  $('#dealIncl').onchange=renderDeal;
  if(!HAS.vel){$('#dealInclWrap').classList.add('hidden');$('#dealVelBlock').classList.add('hidden');}
  if(!D&&!AG)$('#dealModeWrap').classList.add('hidden');
  if(!HAS.OPP&&!HAS.D)$$('#p-deals .controls,#dealDyn,#dealKpis,#dealYoy,#p-deals [data-section="dealWin"],#dealVelBlock,#dealVolBlock').forEach(function(e){e.classList.add('hidden');});
}
function renderDealsTab(){if(HAS.OPP||HAS.D)renderDeal();if(HAS.ACC){renderAccBubble();renderAccTable();}}
function setupStage(){
  if(AG){
    heatMode='won';segSet('#heatMode','won');$('#heatMode button[data-v="share"]').classList.add('hidden');
    stageView='pwl';segSet('#stageView','pwl');['share','type'].forEach(function(v){$('#stageView button[data-v="'+v+'"]').classList.add('hidden');});
    ['stageSurv','stagePersona','stageBreadth'].forEach(function(id){var el=$('[data-section="'+id+'"]');if(el)el.classList.add('hidden');});
  }
  segBind('#heatMode',function(v){heatMode=v;renderHeat();});
  segBind('#stageView',function(v){stageView=v;renderStageProf();});
  segBind('#persView',function(v){persView=v;renderPers();});
}
function renderDeal(){renderDealEng();}
function fyOfDeal(i){return D.m[i]>=0?fp(D.months[D.m[i]]).fy:null;}
function renderDealEng(){
  var g=currentDeals();var P=palette();
  if(!g){$('#dealDyn').innerHTML='<span>Fewer than 20 deals match these filters. Clear a filter to see the engagement views.</span>';$('#dealKpis').innerHTML='';['dealWin','dealVel','dealVol'].forEach(function(id){emptyChart(id,'Fewer than 20 deals match these filters.');});$('#dealYoy').innerHTML='';return;}
  var hi=lvl(g,'High'),lo=lvl(g,'Low'),mid=lvl(g,'Medium');
  var tiles=[];
  if(hi)tiles.push(['High-engagement win rate',p1(hi.win_rate),n0(hi.n)+' deals']);
  if(lo)tiles.push(['Low-engagement win rate',p1(lo.win_rate),n0(lo.n)+' deals']);
  if(hi&&lo&&lo.win_rate)tiles.push(['Win rate lift, high vs low',(hi.win_rate/lo.win_rate).toFixed(1)+'×',(hi.win_rate-lo.win_rate).toFixed(1)+' pts']);
  if(AG&&hi&&lo&&hi.avg_days!=null&&lo.avg_days!=null){var dd=lo.avg_days-hi.avg_days;tiles.push(['Days to close · high vs low',hi.avg_days+' vs '+lo.avg_days,Math.abs(dd)<1?'same average time':Math.abs(dd)+' days '+(dd>0?'faster':'slower')+' on average']);}
  if(HAS.vel&&hi&&lo&&hi.med_days_won!=null&&lo.med_days_won!=null)tiles.push(['Days to close, won · high vs low',hi.med_days_won+' vs '+lo.med_days_won,(function(d){var a=Math.abs(d),u=Math.round(a)===1?' day ':' days ';return a<0.5?'same median time':Math.round(a)+u+(d>=0?'faster':'slower');})(lo.med_days_won-hi.med_days_won)]);
  tiles.push(['Deals analysed',n0(g.n),'win rate '+p1(g.win_rate)+(g.r_win!=null?' · r = '+g.r_win:'')]);
  $('#dealKpis').innerHTML=tiles.map(function(t){return '<div class="tile"><div class="k">'+esc(t[0])+'</div><div class="v">'+esc(t[1])+'</div><div class="d">'+esc(t[2])+'</div></div>';}).join('');
  var dc=g.deciles,top=dc[dc.length-1],bot=dc[0],s='<b>'+esc(dealType())+'</b>, '+n0(g.n)+' deals'+($('#dealIncl').checked?' including transactional':'')+(GF.fy.length||GF.fq.length?' ('+esc([].concat(GF.fy,GF.fq).join(', '))+')':'')+'.';
  if(top&&bot&&bot.win_rate)s+=' Top decile wins <b class="num">'+top.win_rate.toFixed(1)+'%</b> vs <b class="num">'+bot.win_rate.toFixed(1)+'%</b> for the bottom (<b class="num">'+(top.win_rate/bot.win_rate).toFixed(1)+'×</b>'+(g.r_win!=null?', decile correlation r = '+g.r_win:'')+').';
  if(hi&&lo&&hi.win_rate!=null&&lo.win_rate!=null)s+=' High-engagement deals win <b class="num">'+hi.win_rate.toFixed(1)+'%</b> vs <b class="num">'+lo.win_rate.toFixed(1)+'%</b> for low.';
  $('#dealDyn').innerHTML=s;
  renderDealYoy();
  var mode=(D||AG)?dealMode:'overall';
  $('#dealWinNote').innerHTML=paras(mode==='overall'?N.notes.dealWin:(N.notes.dealTrend||N.notes.dealWin))||'<p class="muted">—</p>';
  $('#dealVolBlock').classList.toggle('hidden',mode==='overall');
  if(mode==='overall'){
    var rows=g[dealView],x=dealView==='deciles'?rows.map(function(r){return 'D'+r.dec;}):rows.map(function(r){return r.level;});
    var colr=dealView==='deciles'?rows.map(function(r,i){return i>=rows.length-3?css('--d1'):css('--rule-strong');}):rows.map(function(r){return r.level.indexOf('High')===0?css('--d1'):r.level.indexOf('Medium')===0?css('--d2'):css('--rule-strong');});
    $('#dealWinTitle').textContent='Win rate';$('#dealWinSub').textContent='Bars show win rate; hover for deal counts and score range.';
    plot('dealWin',[{type:'bar',x:x,y:rows.map(function(r){return r.win_rate;}),marker:{color:colr},text:rows.map(function(r){return r.win_rate==null?'–':r.win_rate.toFixed(1)+'%';}),textposition:'outside',cliponaxis:false,
      textfont:{family:MONO,size:12,color:css('--text')},customdata:rows.map(function(r){return [r.n.toLocaleString(),(+r.lo).toFixed(0),(+r.hi).toFixed(0)];}),hovertemplate:'%{x}<br>Win rate %{y:.1f}%<br>%{customdata[0]} deals<br>Score %{customdata[1]}–%{customdata[2]}<extra></extra>'}],
      base({showlegend:false,yaxis:ypct(),xaxis:xcat(),shapes:[{type:'line',xref:'paper',x0:0,x1:1,y0:g.win_rate,y1:g.win_rate,line:{color:css('--text3'),dash:'dot',width:1.5},layer:'below'}],
        annotations:[{xref:'paper',x:0,y:g.win_rate,text:'Overall '+g.win_rate+'%',showarrow:false,xanchor:'left',yanchor:'bottom',font:{family:MONO,size:11,color:css('--text2')},bgcolor:rgba(css('--page'),.85),borderpad:2}]}));
    if(AG){$('#dealVelTitle').textContent='Deal velocity';$('#dealVelSub').textContent='Average days from creation to close, every closed deal. Lower is faster.';
      plot('dealVel',[{type:'bar',name:'Average days to close',x:x,y:rows.map(function(r){return r.avg_days;}),marker:{color:colr},text:rows.map(function(r){return r.avg_days==null?'–':r.avg_days+'d';}),textposition:'outside',cliponaxis:false,hovertemplate:'%{x}<br>%{y} days on average<extra></extra>'}],
        base({showlegend:false,yaxis:{title:{text:'Average days',font:{size:12}},rangemode:'tozero'},xaxis:xcat()}));linkHover(['dealWin','dealVel']);return;}
    if(HAS.vel){$('#dealVelTitle').textContent='Deal velocity';$('#dealVelSub').textContent='Median days from creation to close, for won and lost deals.';
      plot('dealVel',[{type:'bar',name:'Won deals',x:x,y:rows.map(function(r){return r.med_days_won;}),marker:{color:css('--d1')},hovertemplate:'%{x}<br>Won: %{y} days median<extra></extra>'},
        {type:'bar',name:'Lost deals',x:x,y:rows.map(function(r){return r.med_days_lost;}),marker:{color:css('--d3')},hovertemplate:'%{x}<br>Lost: %{y} days median<extra></extra>'}],
        base({barmode:'group',yaxis:{title:{text:'Median days',font:{size:12}}},xaxis:xcat()}));linkHover(['dealWin','dealVel']);}
    return;
  }
  var lvColors=[css('--rule-strong'),css('--d2'),css('--d1')];
  if(AG){renderAggDealModes(mode,lvColors);return;}
  var ix=dealIdx();
  if(mode==='monthly'){
    var months=D.months.map(function(m,mi){return mi;}).filter(function(mi){return monthOK(D.months[mi]);});
    var cell=months.map(function(){return [[],[],[]];});var pos={};months.forEach(function(mi,k){pos[mi]=k;});
    ix.forEach(function(i){if(D.m[i]<0||pos[D.m[i]]==null)return;cell[pos[D.m[i]]][levelOf(D.s[i])].push(i);});
    var xm=months.map(function(mi){return mlab(D.months[mi]);});
    $('#dealWinTitle').textContent='Win rate by close month';$('#dealWinSub').textContent='Each line is an engagement level; months with fewer than five deals at a level are left blank.';
    plot('dealWin',LEVELS.map(function(L,li){return {type:'scatter',mode:'lines+markers',name:L,x:xm,y:cell.map(function(c){var b=c[li];if(b.length<5)return null;var w=0;b.forEach(function(i){w+=D.w[i];});return w/b.length*100;}),customdata:cell.map(function(c){return c[li].length;}),line:{color:lvColors[li],width:2.4},hovertemplate:'%{x}<br>'+L+': %{y:.1f}% (%{customdata} deals)<extra></extra>'};}),base({yaxis:ypct(),xaxis:xcat({nticks:12}),hovermode:'x unified'}));
    if(HAS.vel){$('#dealVelTitle').textContent='Days to close by close month';$('#dealVelSub').textContent='Median days from creation to close for won deals, by engagement level.';
      plot('dealVel',LEVELS.map(function(L,li){return {type:'scatter',mode:'lines',name:L,x:xm,y:cell.map(function(c){var d=c[li].filter(function(i){return D.w[i]&&D.d[i]>=0;}).map(function(i){return D.d[i];});return d.length>=5?median(d):null;}),line:{color:lvColors[li],width:2.2}};}),base({xaxis:xcat({nticks:12}),yaxis:{title:{text:'Median days (won)',font:{size:12}},gridcolor:css('--rule'),rangemode:'tozero',tickfont:{family:MONO,size:11}},hovermode:'x unified'}));}
    $('#dealVolSub').textContent='Closed deals per month, stacked by engagement level.';
    plot('dealVol',LEVELS.map(function(L,li){return {type:'bar',name:L,x:xm,y:cell.map(function(c){return c[li].length;}),marker:{color:lvColors[li]}};}),base({barmode:'stack',xaxis:xcat({nticks:12})}));
    return;
  }
  var fys=uniq(ix.map(fyOfDeal).filter(Boolean)).sort(),byFy={};fys.forEach(function(f){byFy[f]=[];});ix.forEach(function(i){var f=fyOfDeal(i);if(f)byFy[f].push(i);});
  var groups=fys.map(function(f){return dealGroup(byFy[f]);}),fyColors=[css('--rule-strong'),css('--d3'),css('--d2'),css('--d1'),css('--d6')].slice(-Math.max(1,fys.length));
  $('#dealWinTitle').textContent='Win rate by fiscal year';$('#dealWinSub').textContent=dealView==='levels'?'Each bar is a fiscal year.':'Each line is a fiscal year; deciles are recomputed within each year.';
  if(dealView==='levels')plot('dealWin',fys.map(function(f,k){var gg=groups[k];return {type:'bar',name:f,x:LEVELS,y:LEVELS.map(function(L){var r=gg&&gg.levels.filter(function(x){return x.level===L;})[0];return r?r.win_rate:null;}),marker:{color:fyColors[k%fyColors.length]},hovertemplate:'%{x}<br>'+f+': %{y:.1f}%<extra></extra>'};}),base({barmode:'group',yaxis:ypct(),xaxis:xcat()}));
  else plot('dealWin',fys.map(function(f,k){var gg=groups[k];return {type:'scatter',mode:'lines+markers',name:f,x:gg?gg.deciles.map(function(r){return 'D'+r.dec;}):[],y:gg?gg.deciles.map(function(r){return r.win_rate;}):[],line:{color:fyColors[k%fyColors.length],width:2.4}};}),base({yaxis:ypct(),xaxis:xcat()}));
  if(HAS.vel){$('#dealVelTitle').textContent='Days to close by fiscal year';$('#dealVelSub').textContent='Median days from creation to close for won deals, by engagement level.';
    plot('dealVel',fys.map(function(f,k){var gg=groups[k];return {type:'bar',name:f,x:LEVELS,y:LEVELS.map(function(L){var r=gg&&gg.levels.filter(function(x){return x.level===L;})[0];return r?r.med_days_won:null;}),marker:{color:fyColors[k%fyColors.length]}};}),base({barmode:'group',xaxis:xcat(),yaxis:{title:{text:'Median days (won)',font:{size:12}},gridcolor:css('--rule'),tickfont:{family:MONO,size:11}}}));}
  $('#dealVolSub').textContent='Closed deals per fiscal year, stacked by engagement level.';
  plot('dealVol',LEVELS.map(function(L,li){return {type:'bar',name:L,x:fys,y:fys.map(function(f){return byFy[f].filter(function(i){return levelOf(D.s[i])===li;}).length;}),marker:{color:lvColors[li]}};}),base({barmode:'stack',xaxis:xcat()}));
}
/* Readouts: the month and fiscal-year views read the deal aggregates directly. */
function renderAggDealModes(mode,lvColors){
  if(mode==='monthly'){
    var rowsM=AG.deals.monthly.filter(function(r){return aggType(r)&&aggOK(r);}),months=uniq(rowsM.map(function(r){return r.m;})).sort(),xm=months.map(mlab);
    var cell=months.map(function(m){return [0,1,2].map(function(l){return aggBucket(rowsM.filter(function(r){return r.m===m&&r.l===l;}));});});
    $('#dealWinTitle').textContent='Win rate by close month';$('#dealWinSub').textContent='Each line is an engagement level; months with fewer than five deals at a level are left blank.';
    plot('dealWin',LEVELS.map(function(L,li){return {type:'scatter',mode:'lines+markers',name:L,x:xm,y:cell.map(function(c){return c[li].n>=5?c[li].win_rate:null;}),customdata:cell.map(function(c){return c[li].n;}),line:{color:lvColors[li],width:2.4},hovertemplate:'%{x}<br>'+L+': %{y:.1f}% (%{customdata} deals)<extra></extra>'};}),base({yaxis:ypct(),xaxis:xcat({nticks:12}),hovermode:'x unified'}));
    $('#dealVelTitle').textContent='Days to close by close month';$('#dealVelSub').textContent='Average days from creation to close, by engagement level.';
    plot('dealVel',LEVELS.map(function(L,li){return {type:'scatter',mode:'lines',name:L,x:xm,y:cell.map(function(c){return c[li].n>=5?c[li].avg_days:null;}),line:{color:lvColors[li],width:2.2}};}),base({xaxis:xcat({nticks:12}),yaxis:{title:{text:'Average days',font:{size:12}},gridcolor:css('--rule'),rangemode:'tozero',tickfont:{family:MONO,size:11}},hovermode:'x unified'}));
    $('#dealVolSub').textContent='Closed deals per month, stacked by engagement level.';
    plot('dealVol',LEVELS.map(function(L,li){return {type:'bar',name:L,x:xm,y:cell.map(function(c){return c[li].n;}),marker:{color:lvColors[li]}};}),base({barmode:'stack',xaxis:xcat({nticks:12})}));
    return;
  }
  var rowsF=AG.deals.fy.filter(function(r){return aggType(r)&&(!GF.fy.length||GF.fy.indexOf(r.fy)>=0);}),fys=uniq(rowsF.map(function(r){return r.fy;})).sort();
  var fyColors=[css('--rule-strong'),css('--d3'),css('--d2'),css('--d1'),css('--d6')].slice(-Math.max(1,fys.length));
  var lv=function(f,l){return aggBucket(rowsF.filter(function(r){return r.fy===f&&r.l===l;}));};
  $('#dealWinTitle').textContent='Win rate by fiscal year';$('#dealWinSub').textContent=dealView==='levels'?'Each bar is a fiscal year.':'Each line is a fiscal year, by engagement decile.';
  if(dealView==='levels')plot('dealWin',fys.map(function(f,k){return {type:'bar',name:f,x:LEVELS,y:[0,1,2].map(function(l){return lv(f,l).win_rate;}),marker:{color:fyColors[k%fyColors.length]},hovertemplate:'%{x}<br>'+f+': %{y:.1f}%<extra></extra>'};}),base({barmode:'group',yaxis:ypct(),xaxis:xcat()}));
  else plot('dealWin',fys.map(function(f,k){var d=[1,2,3,4,5,6,7,8,9,10].map(function(dec){return aggBucket(AG.deals.decileFy.filter(function(r){return r.fy===f&&r.dec===dec&&aggType(r);}));});return {type:'scatter',mode:'lines+markers',name:f,x:d.map(function(b,i){return 'D'+(i+1);}),y:d.map(function(b){return b.n>=5?b.win_rate:null;}),line:{color:fyColors[k%fyColors.length],width:2.4}};}),base({yaxis:ypct(),xaxis:xcat()}));
  $('#dealVelTitle').textContent='Days to close by fiscal year';$('#dealVelSub').textContent='Average days from creation to close, by engagement level.';
  plot('dealVel',fys.map(function(f,k){return {type:'bar',name:f,x:LEVELS,y:[0,1,2].map(function(l){return lv(f,l).avg_days;}),marker:{color:fyColors[k%fyColors.length]}};}),base({barmode:'group',xaxis:xcat(),yaxis:{title:{text:'Average days',font:{size:12}},gridcolor:css('--rule'),tickfont:{family:MONO,size:11}}}));
  $('#dealVolSub').textContent='Closed deals per fiscal year, stacked by engagement level.';
  plot('dealVol',LEVELS.map(function(L,li){return {type:'bar',name:L,x:fys,y:fys.map(function(f){return lv(f,li).n;}),marker:{color:lvColors[li]}};}),base({barmode:'stack',xaxis:xcat()}));
}
function monthsInFy(f){if(AG)return uniq(AG.deals.monthly.filter(function(r){return r.fy===f;}).map(function(r){return r.m;})).length;if(!D)return 0;return D.months.filter(function(m){return fp(m).fy===f;}).length;}
function trendWord(vals){var a=vals.filter(function(v){return v!=null;});if(a.length<2)return 'steady';var d=a[a.length-1]-a[0];return Math.abs(d)<3?'steady':d>0?'rising':'falling';}
function aggFyGroups(){var rowsF=AG.deals.fy.filter(aggType),fys=uniq(rowsF.map(function(r){return r.fy;})).sort().filter(function(f){return aggBucket(rowsF.filter(function(r){return r.fy===f;})).n>=20;});
  return {fys:fys,G:fys.map(function(f){return {levels:[0,1,2].map(function(l){var bk=aggBucket(rowsF.filter(function(r){return r.fy===f&&r.l===l;}));bk.level=LEVELS[l];bk.med_days_won=bk.avg_days;return bk;}).filter(function(bk){return bk.n>0;})};})};}
function renderDealYoy(){
  var el=$('#dealYoy');if(!D&&!AG){el.innerHTML='';return;}
  var fys,G;
  if(AG){var ag=aggFyGroups();fys=ag.fys;G=ag.G;}
  else{var ix=dealIdx({ignoreMonth:true}),by={};ix.forEach(function(i){var f=fyOfDeal(i);if(!f)return;(by[f]=by[f]||[]).push(i);});
    fys=Object.keys(by).sort().filter(function(f){return by[f].length>=20;});G=fys.map(function(f){return dealGroup(by[f]);});}
  if(fys.length<2){el.innerHTML='';return;}
  var a=fys.length-2,b=fys.length-1,partial=monthsInFy(fys[b])<12?' (partial year)':'';
  var L=function(g,p){return g?g.levels.filter(function(r){return r.level.indexOf(p)===0;})[0]:null;};
  var cards=[];
  var ha=L(G[a],'High'),hb=L(G[b],'High');
  if(ha&&hb){var ma=monthsInFy(fys[a])||12,mb=monthsInFy(fys[b])||12,ra=ha.n/ma,rb=hb.n/mb,ch=pct(rb,ra);
    cards.push([ch>=0?'pos':'neg','High-engagement volume',partial?Math.round(ra)+' → '+Math.round(rb)+' a month':n0(ha.n)+' → '+n0(hb.n)+' deals',
      partial?n0(ha.n)+' high-engagement deals closed in '+fys[a]+' ('+Math.round(ra)+' a month) and '+n0(hb.n)+' so far in '+fys[b]+' over '+mb+' months ('+Math.round(rb)+' a month, '+sp(ch)+'), at '+p1(ha.win_rate)+' and '+p1(hb.win_rate)+' win rates.'
        :'High-engagement deals went from '+n0(ha.n)+' in '+fys[a]+' to '+n0(hb.n)+' in '+fys[b]+' ('+sp(ch)+'), at '+p1(ha.win_rate)+' and '+p1(hb.win_rate)+' win rates.']);}
  var mids=G.map(function(g){var r=L(g,'Medium');return r?r.win_rate:null;}),mw=trendWord(mids);cards.push([mw==='falling'?'neg':mw==='rising'?'pos':'','Medium-engagement win rate',mids.map(p1).join(' → '),mw==='steady'?'Steady across '+fys.join(', ')+': the middle band is a predictable outcome range year to year.':'Medium-engagement deals are '+mw+' across '+fys.join(', ')+'.']);
  var lows=G.map(function(g){var r=L(g,'Low');return r?r.win_rate:null;}),lw=trendWord(lows);cards.push([lw==='falling'?'neg':lw==='rising'?'pos':'','Low-engagement win rate',lows.map(p1).join(' → '),'Low-engagement deals are '+lw+' across '+fys.join(', ')+(lw==='falling'?' — the gap between engaged and disengaged deals is widening.':'.')]);
  if(HAS.vel&&ha&&hb&&ha.med_days_won!=null&&hb.med_days_won!=null){var dd=ha.med_days_won-hb.med_days_won,what=AG?'High-engagement deals':'Won high-engagement deals',how=AG?'average':'median';cards.push([Math.abs(dd)<1?'':dd>0?'pos':'neg','High-engagement velocity',ha.med_days_won+'d → '+hb.med_days_won+'d',Math.abs(dd)<1?what+' closed in the same '+how+' time in '+fys[b]+partial+' as in '+fys[a]+'.':what+' closed '+Math.abs(dd).toFixed(0)+' days '+(dd>0?'faster':'slower')+' ('+how+') in '+fys[b]+partial+' than in '+fys[a]+'.']);}
  el.innerHTML='<div class="yoy-title">Year over year · '+esc(fys[a])+' → '+esc(fys[b])+'</div>'+cards.map(function(c){return '<div class="'+c[0]+'"><h4>'+esc(c[1])+'</h4><div class="s">'+esc(c[2])+'</div><p>'+esc(c[3])+'</p></div>';}).join('');
}

/* ---------- stage and persona ---------- */
/* Readouts: the stage views read the readout's stage and persona tables; fiscal-year filters pick its per-year rows. */
var SA=AG?AG.stages:null;
var shortStage=function(st){return String(st).replace(/^\d+ - /,'');};
function aggStageWr(fyOnly){var src=fyOnly?SA.wrFy.filter(function(r){return r.fy===fyOnly;}):GF.fy.length?SA.wrFy.filter(function(r){return GF.fy.indexOf(r.fy)>=0;}):SA.wr;
  return SA.order.map(function(st){var n=0,w=0;src.forEach(function(r){if(r.stage===st){n+=r.n;w+=r.won;}});return {stage:st,n:n,won:w,wr:n?w/n*100:null};});}
function aggPersona(won){var src=GF.fy.length?SA.personaFy.filter(function(r){return GF.fy.indexOf(r.fy)>=0;}):SA.persona;
  return SA.order.map(function(st){var n=0,p=SA.personas.map(function(){return 0;});src.forEach(function(r){if(r.stage===st&&r.won===won){n+=r.n;r.p.forEach(function(v,k){p[k]+=v*r.n;});}});return {n:n,p:p.map(function(v){return n?v/n:null;})};});}
function renderAggStage(){
  var W=aggStageWr();
  $('#stageIntro').innerHTML='Win rate for deals with activity matched to each stage, and the personas engaged on won and lost deals. '+(GF.fy.length?'Fiscal years: '+esc(GF.fy.join(', '))+'.':'Every fiscal year in the readout.')+(GF.fq.length?' The readout splits stages by fiscal year only, so quarter filters do not apply here.':'');
  $('#stageKpis').innerHTML=W.slice(0,4).map(function(a){return '<div class="tile"><div class="k">Win rate · '+esc(shortStage(a.stage))+'</div><div class="v">'+p1(a.wr)+'</div><div class="d">'+n0(a.n)+' deals with activity here</div></div>';}).join('');
  var fys=uniq(SA.wrFy.map(function(r){return r.fy;})).sort(),cards=[];
  if(fys.length>=2){var fa=fys[fys.length-2],fb=fys[fys.length-1],A=aggStageWr(fa),Bw=aggStageWr(fb),partial=monthsInFy(fb)<12?' (partial year)':'';
    var deltas=A.map(function(a,i){var b=Bw[i];return a.n>=20&&b.n>=20?{st:a.stage,a:a.wr,b:b.wr}:null;}).filter(Boolean).sort(function(x,y){return (y.b-y.a)-(x.b-x.a);});
    if(deltas.length){var up=deltas[0],dn=deltas[deltas.length-1];
      if(up.b-up.a>0)cards.push(['pos','Biggest win-rate gain by stage',shortStage(up.st)+': '+p1(up.a)+' → '+p1(up.b),'Deals with '+shortStage(up.st)+' activity won '+(up.b-up.a).toFixed(1)+' points more often in '+fb+partial+' than in '+fa+'.']);
      if(dn!==up&&dn.b-dn.a<0)cards.push(['neg','Biggest win-rate drop by stage',shortStage(dn.st)+': '+p1(dn.a)+' → '+p1(dn.b),'Deals with '+shortStage(dn.st)+' activity won '+(dn.a-dn.b).toFixed(1)+' points less often in '+fb+partial+' than in '+fa+'.']);}}
  var best=null;SA.heat.wr.forEach(function(row,k){row.forEach(function(v,i){if(v!=null&&i<SA.order.length-1&&(!best||v>best.v))best={v:v,k:k,i:i};});});
  if(best)cards.push(['','Strongest persona signal',SA.personas[best.k]+' at '+shortStage(SA.order[best.i])+': '+p1(best.v),'Of the deals with '+SA.personas[best.k]+' engaged at '+shortStage(SA.order[best.i])+', '+p1(best.v)+' were won — the highest of any persona before the deal is decided.']);
  $('#stageYoy').innerHTML=cards.length?'<div class="yoy-title">Stage and persona'+(fys.length>=2?' · '+esc(fys[fys.length-2])+' → '+esc(fys[fys.length-1]):'')+'</div>'+cards.map(function(c){return '<div class="'+c[0]+'"><h4>'+esc(c[1])+'</h4><div class="s">'+esc(c[2])+'</div><p>'+esc(c[3])+'</p></div>';}).join(''):'';
  renderHeat();renderStageWin();renderStageProf();
}
var stageNames=function(){return ST.stages.map(function(s){return s.stage;});};
function cellsOK(ignoreMonth){return (ST.cells||[]).filter(function(c){var t=(ST.cellTypes||[])[c[2]]||'';if(/framework/i.test(t))return false;if(ignoreMonth)return true;return monthOK(c[3]>=0?(ST.cellMonths||[])[c[3]]:null);});}
function aggCells(cells){var S=stageNames().map(function(){return {won:0,lost:0,wa:new Array(NP).fill(0),la:new Array(NP).fill(0),ww:new Array(NP).fill(0),aw:new Array(NP).fill(0),acts:0};});
  cells.forEach(function(c){var a=S[c[0]];if(!a)return;var n=c[4];if(c[1])a.won+=n;else a.lost+=n;a.acts+=c[5];for(var k=0;k<NP;k++){if(c[1]){a.wa[k]+=c[6+k];a.ww[k]+=c[6+NP+k];}else a.la[k]+=c[6+k];a.aw[k]+=c[6+NP+k];}});return S;}
function cellFy(c){return c[3]>=0?fp((ST.cellMonths||[])[c[3]]).fy:null;}
function renderStage(){
  if(!HAS.ST)return;
  if(AG){renderAggStage();return;}
  $('#stageIntro').innerHTML=ST.base.n_opps.toLocaleString()+' closed non-renewal opportunities, with each activity tagged by the stage the deal was in when it was matched. Win-rate analysis of personas uses the '+ST.base.n_pre.toLocaleString()+' deals with pre-decision activity ('+(ST.base.wr_pre==null?'–':ST.base.wr_pre+'%')+' win rate).';
  var post=ST.postStages||[];
  if(HAS.cells&&!cellsOK().length){$('#stageIntro').innerHTML+='<div class="notice">No deals match these filters. Clear a filter to see the stage and persona views.</div>';}
  if(HAS.cells){
    var S=aggCells(cellsOK()),names=stageNames(),pre=names.map(function(n,i){return i;}).filter(function(i){return post.indexOf(names[i])<0;});
    $('#stageKpis').innerHTML=pre.slice(0,4).map(function(i){var a=S[i],n=a.won+a.lost;return '<div class="tile"><div class="k">Win rate · '+esc(names[i])+'</div><div class="v">'+(n?p1(a.won/n*100):'–')+'</div><div class="d">'+n0(n)+' deals with activity here</div></div>';}).join('');
    renderStageYoy(S,names,pre);
  } else {$('#stageKpis').innerHTML='';$('#stageYoy').innerHTML='';$('#stageWinBlock').classList.add('hidden');}
  renderHeat();renderStageWin();renderStageProf();renderSurv();renderPers();renderBreadth();
}
function renderStageYoy(S,names,pre){
  var el=$('#stageYoy'),cells=cellsOK(true),fys=uniq(cells.map(cellFy).filter(Boolean)).sort();var cards=[];
  if(fys.length>=2){var fa=fys[fys.length-2],fb=fys[fys.length-1],A=aggCells(cells.filter(function(c){return cellFy(c)===fa;})),B=aggCells(cells.filter(function(c){return cellFy(c)===fb;}));
    var deltas=pre.map(function(i){var na=A[i].won+A[i].lost,nb=B[i].won+B[i].lost;if(na<20||nb<20)return null;return {i:i,a:A[i].won/na*100,b:B[i].won/nb*100};}).filter(Boolean);
    if(deltas.length){deltas.sort(function(x,y){return (y.b-y.a)-(x.b-x.a);});var up=deltas[0],dn=deltas[deltas.length-1],partial=monthsInFy(fb)<12?' (partial year)':'';
      if(up.b-up.a>0)cards.push(['pos','Biggest win-rate gain by stage',names[up.i]+': '+p1(up.a)+' → '+p1(up.b),'Deals with '+names[up.i]+' activity won '+(up.b-up.a).toFixed(1)+' points more often in '+fb+partial+' than in '+fa+'.']);
      if(dn!==up&&dn.b-dn.a<0)cards.push(['neg','Biggest win-rate drop by stage',names[dn.i]+': '+p1(dn.a)+' → '+p1(dn.b),'Deals with '+names[dn.i]+' activity won '+(dn.a-dn.b).toFixed(1)+' points less often in '+fb+partial+' than in '+fa+'.']);}}
  var best=null;pre.forEach(function(i){for(var k=0;k<NP;k++){if(S[i].aw[k]>=20){var w=S[i].ww[k]/S[i].aw[k]*100;if(!best||w>best.w)best={i:i,k:k,w:w,n:S[i].aw[k]};}}});
  if(best)cards.push(['','Strongest persona signal',PK[best.k]+' at '+names[best.i]+': '+p1(best.w),'Of '+n0(best.n)+' deals with '+PK[best.k]+' engaged at '+names[best.i]+', '+p1(best.w)+' were won — the highest of any persona at a pre-decision stage.']);
  var any=(ST.surv||[]).filter(function(s){return s.persona==='Any activity';})[0];
  if(any&&any.lift!=null)cards.push([any.lift>=0?'pos':'neg','Early engagement',(any.lift>=0?'+':'')+any.lift.toFixed(1)+' pts','Among deals that reached '+ST.lateStages.join(' or ')+', those with activity in '+ST.earlyStages.join(' or ')+' won '+p1(any.wr_early)+' vs '+p1(any.wr_no_early)+'.']);
  el.innerHTML=cards.length?'<div class="yoy-title">Stage and persona'+(fys.length>=2?' · '+esc(fys[fys.length-2])+' → '+esc(fys[fys.length-1]):'')+'</div>'+cards.map(function(c){return '<div class="'+c[0]+'"><h4>'+esc(c[1])+'</h4><div class="s">'+esc(c[2])+'</div><p>'+esc(c[3])+'</p></div>';}).join(''):'';
}
function renderHeat(){
  if(AG){
    var mode=heatMode==='share'?'won':heatMode,Z=SA.heat[mode],sc=mode==='diff'?[[0,css('--neg')],[.5,css('--div-mid')],[1,css('--pos')]]:[[0,css('--seq-lo')],[1,css('--seq-hi')]];
    var subs={won:'Average activities with each persona per won deal at each stage. Darker means more engagement.',lost:'Average activities with each persona per lost deal at each stage.',diff:'Won-deal average minus lost-deal average. Green: winners had more of this persona at this stage.',wr:'Of the deals with each persona engaged at each stage, the share won.'};
    $('#heatTitle').textContent='Stage × persona';$('#heatSub').textContent=subs[mode]+' The readout\'s heatmap covers every fiscal year, so the filters do not apply here.';
    var tz=Z.map(function(r){return r.map(function(v){return v==null?'':mode==='wr'?v.toFixed(0)+'%':mode==='diff'?(v>=0?'+':'')+v.toFixed(1):v.toFixed(1);});});
    var ht={type:'heatmap',x:SA.order.map(shortStage),y:SA.personas,z:Z,colorscale:sc,text:tz,texttemplate:'%{text}',textfont:{family:MONO,size:11,color:css('--text')},hovertemplate:'%{y} at %{x}<br>%{text}<extra></extra>',showscale:false,xgap:2,ygap:2,hoverongaps:false};if(mode==='diff')ht.zmid=0;
    plot('stageHeat',[ht],base({margin:{l:110,r:10,t:10,b:70},xaxis:{side:'bottom',tickfont:{size:11},gridcolor:'rgba(0,0,0,0)'},yaxis:{autorange:'reversed',tickfont:{size:12},gridcolor:'rgba(0,0,0,0)'}}));
    return;
  }
  var names=stageNames(),z,txt,scale=[[0,css('--seq-lo')],[1,css('--seq-hi')]],zmid=null,hover,sub;
  if(heatMode==='share'||!HAS.cells){
    if(!HAS.cells){segSet('#heatMode','share');$$('#heatMode button').forEach(function(b){if(b.getAttribute('data-v')!=='share')b.classList.add('hidden');});}
    z=PK.map(function(p){return ST.stages.map(function(s){return (s.persona_pct||{})[p]||0;});});txt=z.map(function(r){return r.map(function(v){return v.toFixed(0)+'%';});});hover='%{y} at %{x}<br>%{z:.1f}% of activities<extra></extra>';sub='Share of activities at each stage that include each persona (a single activity can include several). All closed non-renewal deals; the filters do not apply to this view.';$('#heatTitle').textContent='Persona mix by stage';
  } else {
    var S=aggCells(cellsOK());$('#heatTitle').textContent='Stage × persona';
    if(heatMode==='won'||heatMode==='lost'){var won=heatMode==='won';z=PK.map(function(p,k){return S.map(function(a){var n=won?a.won:a.lost;return n?(won?a.wa[k]:a.la[k])/n:null;});});hover='%{y} at %{x}<br>%{z:.2f} activities per '+(won?'won':'lost')+' deal<extra></extra>';sub='Average activities with each persona per '+(won?'won':'lost')+' deal at each stage. Darker means more engagement.';}
    else if(heatMode==='diff'){z=PK.map(function(p,k){return S.map(function(a){return (a.won&&a.lost)?a.wa[k]/a.won-a.la[k]/a.lost:null;});});scale=[[0,css('--neg')],[.5,css('--div-mid')],[1,css('--pos')]];zmid=0;hover='%{y} at %{x}<br>%{z:+.2f} activities per deal, won minus lost<extra></extra>';sub='Won-deal average minus lost-deal average. Green: winners had more of this persona at this stage.';}
    else {z=PK.map(function(p,k){return S.map(function(a){return a.aw[k]>=5?a.ww[k]/a.aw[k]*100:null;});});hover='%{y} at %{x}<br>%{z:.1f}% of deals with this persona here were won<extra></extra>';sub='Of the deals with each persona engaged at each stage, the share won (blank under five deals). Post-decision stages are shown for completeness: activity there follows the outcome.';}
    txt=z.map(function(r){return r.map(function(v){return v==null?'':heatMode==='wr'?v.toFixed(0)+'%':heatMode==='diff'?(v>=0?'+':'')+v.toFixed(1):v.toFixed(1);});});
  }
  $('#heatSub').textContent=sub;
  var tr={type:'heatmap',x:names,y:PK,z:z,colorscale:scale,text:txt,texttemplate:'%{text}',textfont:{family:MONO,size:11,color:css('--text')},hovertemplate:hover,showscale:false,xgap:2,ygap:2,hoverongaps:false};if(zmid!=null)tr.zmid=zmid;
  plot('stageHeat',[tr],base({margin:{l:190,r:10,t:10,b:70},xaxis:{side:'bottom',tickfont:{size:11},gridcolor:'rgba(0,0,0,0)'},yaxis:{autorange:'reversed',tickfont:{size:12},gridcolor:'rgba(0,0,0,0)'}}));
}
function renderStageWin(){
  if(AG){
    var W=aggStageWr(),xs=SA.order.map(shortStage),dat=[{type:'bar',name:GF.fy.length?esc(GF.fy.join(', ')):'All fiscal years',x:xs,y:W.map(function(a){return a.wr;}),customdata:W.map(function(a){return a.n;}),marker:{color:css('--rule-strong')},hovertemplate:'%{x}<br>Win rate %{y:.1f}% (%{customdata} deals)<extra></extra>'}];
    var fyl=uniq(SA.wrFy.map(function(r){return r.fy;})).sort();
    if(fyl.length>=2&&!GF.fy.length)fyl.forEach(function(f,k){var A=aggStageWr(f);dat.push({type:'scatter',mode:'lines+markers',name:f,x:xs,y:A.map(function(a){return a.n>=10?a.wr:null;}),line:{color:[css('--d3'),css('--d2'),css('--d1'),css('--d6')][k%4],width:2.2}});});
    plot('stageWin',dat,base({yaxis:ypct(),xaxis:xcat()}));
    var f0=W[0],fl=W[W.length-1];
    if(f0&&fl)$('#stageWinNote').innerHTML='Deals with activity at <b>'+esc(shortStage(f0.stage))+'</b> win <b class="num">'+p1(f0.wr)+'</b>; those with activity at <b>'+esc(shortStage(fl.stage))+'</b> win <b class="num">'+p1(fl.wr)+'</b>. Later stages hold only the deals that survived to them, so part of the rise is survivorship.';
    return;
  }
  if(!HAS.cells)return;var names=stageNames(),S=aggCells(cellsOK()),P=palette();
  var data=[{type:'bar',name:'All selected deals',x:names,y:S.map(function(a){var n=a.won+a.lost;return n?a.won/n*100:null;}),customdata:S.map(function(a){return a.won+a.lost;}),marker:{color:css('--rule-strong')},hovertemplate:'%{x}<br>Win rate %{y:.1f}% (%{customdata} deals)<extra></extra>'}];
  var cells=cellsOK(),fys=uniq(cells.map(cellFy).filter(Boolean)).sort();
  if(fys.length>=2)fys.forEach(function(f,k){var A=aggCells(cells.filter(function(c){return cellFy(c)===f;}));data.push({type:'scatter',mode:'lines+markers',name:f,x:names,y:A.map(function(a){var n=a.won+a.lost;return n>=10?a.won/n*100:null;}),line:{color:[css('--d3'),css('--d2'),css('--d1'),css('--d6')][k%4],width:2.2}});});
  plot('stageWin',data,base({yaxis:ypct(),xaxis:xcat()}));
  var post=ST.postStages||[],pre=names.map(function(n,i){return i;}).filter(function(i){return post.indexOf(names[i])<0;});
  if(pre.length>=2){var f=S[pre[0]],l=S[pre[pre.length-1]],wf=(f.won+f.lost)?f.won/(f.won+f.lost)*100:null,wl2=(l.won+l.lost)?l.won/(l.won+l.lost)*100:null;
    $('#stageWinNote').innerHTML='Deals with activity at <b>'+esc(names[pre[0]])+'</b> win <b class="num">'+p1(wf)+'</b>; those still active at <b>'+esc(names[pre[pre.length-1]])+'</b> win <b class="num">'+p1(wl2)+'</b>. Later stages hold only the deals that survived to them, so the rise is partly survivorship — the early-engagement chart below controls for it.';}
}
function renderStageProf(){
  if(AG){
    var xa=SA.order.map(shortStage),won=aggPersona(true),lost=aggPersona(false),Pc=palette(),dt,ly,sb;
    var total=function(r){return r.n?r.p.reduce(function(a,b){return a+(b||0);},0):null;};
    if(stageView==='wl'){dt=[{type:'bar',name:'Won deals',x:xa,y:won.map(total),marker:{color:css('--d1')},customdata:won.map(function(r){return r.n;}),hovertemplate:'%{x}<br>Won: %{y:.1f} activities per deal (%{customdata} deals)<extra></extra>'},
        {type:'bar',name:'Lost deals',x:xa,y:lost.map(total),marker:{color:css('--d3')},customdata:lost.map(function(r){return r.n;}),hovertemplate:'%{x}<br>Lost: %{y:.1f} activities per deal (%{customdata} deals)<extra></extra>'}];
      ly=base({barmode:'group',yaxis:{title:{text:'Avg activities per deal, these personas',font:{size:12}},gridcolor:css('--rule'),tickfont:{family:MONO,size:11}},xaxis:xcat(),margin:{l:56,r:20,t:14,b:60}});sb='Activities per deal with the six personas the readout tracks, won and lost.';}
    else if(stageView==='mixwon'){dt=SA.personas.map(function(p,k){return {type:'scatter',mode:'lines',stackgroup:'one',name:p,x:xa,y:won.map(function(r){return r.p[k]||0;}),line:{color:Pc[k%Pc.length],width:1}};});
      ly=base({xaxis:xcat(),yaxis:{title:{text:'Avg activities per won deal',font:{size:12}},gridcolor:css('--rule'),tickfont:{family:MONO,size:11}},margin:{l:56,r:20,t:14,b:80}});sb='Who is engaged at each stage of the deals that were won, stacked.';}
    else {dt=[];SA.personas.forEach(function(p,k){dt.push({type:'scatter',mode:'lines',name:p+', won',x:xa,y:won.map(function(r){return r.p[k];}),line:{color:Pc[k%Pc.length],width:2.4},legendgroup:p});dt.push({type:'scatter',mode:'lines',name:p+', lost',x:xa,y:lost.map(function(r){return r.p[k];}),line:{color:Pc[k%Pc.length],width:1.6,dash:'dash'},legendgroup:p,showlegend:false});});
      ly=base({xaxis:xcat(),yaxis:{title:{text:'Avg activities per deal',font:{size:12}},gridcolor:css('--rule'),rangemode:'tozero',tickfont:{family:MONO,size:11}},margin:{l:56,r:20,t:14,b:80}});sb='Solid lines are won deals, dashed lost. Fiscal-year filters apply.';}
    $('#stageProfSub').textContent=sb;plot('stageProf',dt,ly);return;
  }
  var S=ST.stages,x=S.map(function(s){return s.stage;}),post=S.map(function(s){return (ST.postStages||[]).indexOf(s.stage)>=0;}),data,lay,P=palette(),sub='';
  if(stageView==='share'){
    data=[{type:'bar',name:'Share of all activity',x:x,y:S.map(function(s){return s.share;}),marker:{color:S.map(function(s,i){return post[i]?css('--rule-strong'):css('--d1');})},text:S.map(function(s){return s.share.toFixed(1)+'%';}),textposition:'outside',cliponaxis:false,textfont:{family:MONO,size:11,color:css('--text')},
      customdata:S.map(function(s){return [s.acts.toLocaleString(),s.opps.toLocaleString()];}),hovertemplate:'%{x}<br>%{y:.1f}% of activity<br>%{customdata[0]} activities on %{customdata[1]} deals<extra></extra>'},
      {type:'scatter',mode:'lines+markers',name:'Activities with Director or above',x:x,y:S.map(function(s){return s.dir_above_pct;}),line:{color:css('--d2'),width:2},hovertemplate:'%{x}<br>%{y:.1f}% include Director+<extra></extra>'}];
    lay=base({yaxis:ypct(),xaxis:xcat(),margin:{l:50,r:20,t:14,b:60}});sub='All closed non-renewal deals; post-decision stages in grey. Both series are percentages on one scale.';
  } else if(stageView==='wl'){
    data=[{type:'bar',name:'Won deals',x:x,y:S.map(function(s){return s.won_acts;}),marker:{color:css('--d1')},customdata:S.map(function(s){return s.won_n;}),hovertemplate:'%{x}<br>Won: %{y} activities per deal (%{customdata} deals)<extra></extra>'},
      {type:'bar',name:'Lost deals',x:x,y:S.map(function(s){return s.lost_acts;}),marker:{color:css('--d3')},customdata:S.map(function(s){return s.lost_n;}),hovertemplate:'%{x}<br>Lost: %{y} activities per deal (%{customdata} deals)<extra></extra>'}];
    lay=base({barmode:'group',yaxis:{title:{text:'Avg activities per deal at stage',font:{size:12}},gridcolor:css('--rule'),tickfont:{family:MONO,size:11}},xaxis:xcat(),margin:{l:56,r:20,t:14,b:60}});sub='All closed non-renewal deals.';
  } else if((stageView==='pwl'||stageView==='mixwon')&&HAS.cells){
    var A=aggCells(cellsOK()),show=['Executive','VP','Director','Finance','IT','Engineering'].map(function(p){return PK.indexOf(p);}).filter(function(k){return k>=0;});
    if(stageView==='pwl'){data=[];show.forEach(function(k,j){data.push({type:'scatter',mode:'lines',name:PK[k]+', won',x:x,y:A.map(function(a){return a.won?a.wa[k]/a.won:null;}),line:{color:P[j%P.length],width:2.4},legendgroup:PK[k]});data.push({type:'scatter',mode:'lines',name:PK[k]+', lost',x:x,y:A.map(function(a){return a.lost?a.la[k]/a.lost:null;}),line:{color:P[j%P.length],width:1.6,dash:'dash'},legendgroup:PK[k],showlegend:false});});
      lay=base({xaxis:xcat(),yaxis:{title:{text:'Avg activities per deal',font:{size:12}},gridcolor:css('--rule'),rangemode:'tozero',tickfont:{family:MONO,size:11}},margin:{l:56,r:20,t:14,b:80}});sub='Solid lines are won deals, dashed lost. The filters above apply.';}
    else {data=show.map(function(k,j){return {type:'scatter',mode:'lines',stackgroup:'one',name:PK[k],x:x,y:A.map(function(a){return a.won?a.wa[k]/a.won:0;}),line:{color:P[j%P.length],width:1}};});
      lay=base({xaxis:xcat(),yaxis:{title:{text:'Avg activities per won deal',font:{size:12}},gridcolor:css('--rule'),tickfont:{family:MONO,size:11}},margin:{l:56,r:20,t:14,b:80}});sub='Who is engaged at each stage of the deals that were won, stacked. The filters above apply.';}
  } else {
    var types=uniq([].concat.apply([],S.map(function(s){return Object.keys(s.type_pct||{});}))).slice(0,5);
    data=types.map(function(tp,i){return {type:'bar',name:tp.charAt(0).toUpperCase()+tp.slice(1),x:x,y:S.map(function(s){return (s.type_pct||{})[tp]||0;}),marker:{color:P[i]},hovertemplate:'%{x}<br>'+esc(tp)+': %{y:.1f}%<extra></extra>'};});
    lay=base({barmode:'stack',yaxis:ypct({range:[0,100]}),xaxis:xcat(),margin:{l:50,r:20,t:14,b:60}});sub='All closed non-renewal deals.';
  }
  if(!HAS.cells)$$('#stageView button').forEach(function(b){var v=b.getAttribute('data-v');if(v==='pwl'||v==='mixwon')b.classList.add('hidden');});
  $('#stageProfSub').textContent=sub;plot('stageProf',data,lay);
}
function renderSurv(){
  var sv=(ST.surv||[]).filter(function(s){return s.wr_early!=null&&s.wr_no_early!=null;}).slice().sort(function(a,b){return a.lift-b.lift;});if(!sv.length)return;
  var allv=[].concat.apply([],sv.map(function(s){return [s.wr_early,s.wr_no_early];})),lo=Math.max(0,Math.floor(Math.min.apply(null,allv)/5)*5-5),hi=Math.min(100,Math.ceil(Math.max.apply(null,allv)/5)*5+5);
  plot('stageSurv',[
    {type:'scatter',mode:'markers',name:'Not engaged early',y:sv.map(function(s){return s.persona;}),x:sv.map(function(s){return s.wr_no_early;}),marker:{size:11,color:css('--text3')},customdata:sv.map(function(s){return s.n_no;}),hovertemplate:'%{y}<br>Not engaged early: %{x:.1f}% (%{customdata} deals)<extra></extra>'},
    {type:'scatter',mode:'markers+text',name:'Engaged in '+ST.earlyStages.join(' / '),y:sv.map(function(s){return s.persona;}),x:sv.map(function(s){return s.wr_early;}),marker:{size:13,color:css('--d1')},text:sv.map(function(s){return (s.lift>=0?'+':'')+s.lift.toFixed(1);}),textposition:'middle right',textfont:{family:MONO,size:12,color:css('--text')},
      customdata:sv.map(function(s){return s.n_early;}),hovertemplate:'%{y}<br>Engaged early: %{x:.1f}% (%{customdata} deals)<extra></extra>'}],
    base({shapes:sv.map(function(s){return {type:'line',x0:s.wr_no_early,x1:s.wr_early,y0:s.persona,y1:s.persona,line:{color:css('--rule-strong'),width:3},layer:'below'};}),
      margin:{l:190,r:40,t:10,b:60},xaxis:{ticksuffix:'%',range:[lo,hi],gridcolor:css('--rule'),title:{text:'Win rate of deals that reached late stage',font:{size:12}},tickfont:{family:MONO,size:11}},yaxis:{tickfont:{size:12},gridcolor:'rgba(0,0,0,0)'}}));
}
function renderPers(){
  var Pp=(ST.personas||[]).filter(function(p){return p.wr_with!=null&&p.wr_without!=null;}).slice(),data,xa={};
  if(persView==='wr'){Pp.sort(function(a,b){return a.lift_pts-b.lift_pts;});
    data=[{type:'bar',orientation:'h',name:'Without persona',y:Pp.map(function(p){return p.persona;}),x:Pp.map(function(p){return p.wr_without;}),marker:{color:css('--rule-strong')},hovertemplate:'%{y}<br>Without: %{x:.1f}%<extra></extra>'},
      {type:'bar',orientation:'h',name:'With persona',y:Pp.map(function(p){return p.persona;}),x:Pp.map(function(p){return p.wr_with;}),marker:{color:css('--d1')},text:Pp.map(function(p){return (p.lift_pts>=0?'+':'')+p.lift_pts.toFixed(1)+' pts';}),textposition:'outside',cliponaxis:false,textfont:{family:MONO,size:11,color:css('--text')},customdata:Pp.map(function(p){return p.prevalence;}),hovertemplate:'%{y}<br>With: %{x:.1f}%<br>Present on %{customdata}% of deals<extra></extra>'}];
    xa={ticksuffix:'%',rangemode:'tozero'};
  } else if(persView==='share'){Pp.sort(function(a,b){return a.won_share-b.won_share;});
    data=[{type:'bar',orientation:'h',name:'Share of won deals',y:Pp.map(function(p){return p.persona;}),x:Pp.map(function(p){return p.won_share;}),marker:{color:css('--d1')},text:Pp.map(function(p){return p.won_share==null?'–':p.won_share.toFixed(0)+'%';}),textposition:'outside',cliponaxis:false,textfont:{family:MONO,size:11,color:css('--text')},hovertemplate:'%{y}<br>Engaged on %{x:.1f}% of won deals<extra></extra>'},
      {type:'bar',orientation:'h',name:'Share of all deals',y:Pp.map(function(p){return p.persona;}),x:Pp.map(function(p){return p.prevalence;}),marker:{color:css('--rule-strong')},hovertemplate:'%{y}<br>Engaged on %{x:.1f}% of all deals<extra></extra>'}];
    xa={ticksuffix:'%',rangemode:'tozero'};
  } else {Pp.sort(function(a,b){return (a.days_with||0)-(b.days_with||0);});
    data=[{type:'bar',orientation:'h',name:'Without persona',y:Pp.map(function(p){return p.persona;}),x:Pp.map(function(p){return p.days_without;}),marker:{color:css('--rule-strong')},hovertemplate:'%{y}<br>Without: %{x} days median<extra></extra>'},
      {type:'bar',orientation:'h',name:'With persona',y:Pp.map(function(p){return p.persona;}),x:Pp.map(function(p){return p.days_with;}),marker:{color:css('--d3')},customdata:Pp.map(function(p){return [money(p.amt_with),money(p.amt_without)];}),hovertemplate:'%{y}<br>With: %{x} days median<br>Median deal %{customdata[0]} vs %{customdata[1]}<extra></extra>'}];
    xa={title:{text:'Median days to close, won deals',font:{size:12}}};
  }
  plot('stagePers',data,base({barmode:'group',margin:{l:190,r:60,t:10,b:70},xaxis:Object.assign({gridcolor:css('--rule'),tickfont:{family:MONO,size:11}},xa),yaxis:{tickfont:{size:12},gridcolor:'rgba(0,0,0,0)'}}));
  var notes=N.notes.persona||{};$('#persNote').innerHTML=md(notes[persView]||'');
}
function renderBreadth(){
  var br=ST.breadth||[];if(br.length){var best=br.reduce(function(a,b){return (b.win_rate||0)>(a.win_rate||0)?b:a;},br[0]);
  plot('stageBreadth',[{type:'bar',x:br.map(function(b){return b.k===6?'6+':String(b.k);}),y:br.map(function(b){return b.win_rate;}),marker:{color:br.map(function(b){return b.k===best.k?css('--d1'):css('--rule-strong');})},text:br.map(function(b){return b.win_rate==null?'–':b.win_rate.toFixed(0)+'%';}),textposition:'outside',cliponaxis:false,textfont:{family:MONO,size:11,color:css('--text')},
    customdata:br.map(function(b){return [b.n.toLocaleString(),b.med_days_won==null?'–':b.med_days_won];}),hovertemplate:'%{x} personas<br>Win rate %{y:.1f}%<br>%{customdata[0]} deals, %{customdata[1]} days median (won)<extra></extra>'}],
    base({showlegend:false,yaxis:ypct(),xaxis:{type:'category',title:{text:'Personas engaged',font:{size:12}},gridcolor:'rgba(0,0,0,0)'},margin:{l:44,r:10,t:14,b:48}}));}
  var eq=ST.early_q||[];if(eq.length){var bq=eq.reduce(function(a,b){return (b.win_rate||0)>(a.win_rate||0)?b:a;},eq[0]);
  plot('stageEarlyQ',[{type:'bar',x:eq.map(function(q){return q.q.replace(' lowest','').replace(' highest','');}),y:eq.map(function(q){return q.win_rate;}),marker:{color:eq.map(function(q){return q.q===bq.q?css('--d1'):css('--rule-strong');})},text:eq.map(function(q){return q.win_rate==null?'–':q.win_rate.toFixed(0)+'%';}),textposition:'outside',cliponaxis:false,textfont:{family:MONO,size:11,color:css('--text')},
    customdata:eq.map(function(q){return [q.lo,q.hi,q.med_days_won==null?'–':q.med_days_won];}),hovertemplate:'%{x}: %{customdata[0]}–%{customdata[1]} early activities<br>Win rate %{y:.1f}%<br>%{customdata[2]} days median (won)<extra></extra>'}],
    base({showlegend:false,yaxis:ypct(),xaxis:{title:{text:'Early activity quintile (low to high)',font:{size:12}},gridcolor:'rgba(0,0,0,0)'},margin:{l:44,r:10,t:14,b:48}}));}
}

/* ---------- account engagement ---------- */
var CO=['Power Users','Frequent Browsers','Focused Diggers','Light Touch','No Engagement'];
var coColor=function(c){return css({'Power Users':'--c-power','Frequent Browsers':'--c-browser','Focused Diggers':'--c-digger','Light Touch':'--c-light','No Engagement':'--c-none'}[c]);};
var a360Lo=0,a360Hi=0,a360Sort={k:'created',dir:-1},a360TrendView='total',accSort={k:'opps',dir:-1};
function a360Accounts(lo,hi){return A360.B.accounts.map(function(a){var c=0,w=0;for(var i=lo;i<=hi;i++){c+=a.created_by_month[i]||0;w+=a.closed_won_by_month[i]||0;}return {account:a.account,cohort:a.cohort,sessions:a.unique_sessions,deep:a.deep_action_ratio,users:a.unique_users,created:c,won:w};});}
function a360Agg(lo,hi){var rows=a360Accounts(lo,hi),o={};CO.forEach(function(c){var r=rows.filter(function(a){return a.cohort===c;}),n=r.length,tc=0,tw=0;r.forEach(function(a){tc+=a.created;tw+=a.won;});o[c]={n:n,total_created:tc,total_won:tw,avg_created:n?tc/n:0,avg_won:n?tw/n:0};});return o;}
function setupA360(){
  var M=A360.B.months,n=M.length;a360Hi=n-1;a360Lo=Math.max(0,n-WN);
  $('#a360Range').innerHTML='<button type="button" aria-pressed="true" data-v="cfg">Last '+WN+' months</button><button type="button" aria-pressed="false" data-v="all">All '+n+' months</button>';
  segBind('#a360Range',function(v){a360Lo=v==='all'?0:Math.max(0,n-WN);renderA360();});
  segBind('#a360TrendView',function(v){a360TrendView=v;renderA360Trend();});
  $('#a360Cohort').innerHTML='<option value="">All cohorts</option>'+CO.map(function(c){return '<option>'+c+'</option>';}).join('');
  $('#a360Cohort').onchange=renderA360Table;$('#a360Q').addEventListener('input',renderA360Table);
  var B=A360.B,Mt=A360.M;
  $('#a360Intro').innerHTML='How the team uses Account 360 on '+Mt.accounts.toLocaleString()+' parent accounts ('+Mt.engaged.toLocaleString()+' engaged, '+Mt.noEngagement.toLocaleString()+' with no Account 360 activity), click-stream '+esc(Mt.clickStart)+' to '+esc(Mt.clickEnd)+'. Accounts are cohorted on the medians of sessions ('+B.session_median+') and of the share of deep actions ('+(B.depth_ratio_median*100).toFixed(0)+'%).'+(Mt.excludedUsers&&Mt.excludedUsers.length?' '+Mt.excludedUsers.length+' users who browse broadly (or were named) are excluded.':'');
  var Q=[['Power Users','Many sessions and deep actions — opportunities, metrics, activities.'],['Frequent Browsers','Many sessions, mostly page views.'],['Focused Diggers','Few sessions, but deep when they come.'],['Light Touch','Few sessions, little depth.'],['No Engagement','No Account 360 activity in the window.']];
  $('#a360Quads').innerHTML=Q.map(function(q){return '<div style="--c:'+coColor(q[0])+'"><h4>'+q[0]+'</h4><p>'+q[1]+'</p></div>';}).join('');
}
function setupAccDeals(){
  $('#accQ').addEventListener('input',renderAccTable);
  var rows=ACC.accounts.filter(function(a){return a.eng!=null;}),r=rows.length>5?corr(rows.map(function(a){return a.eng;}),rows.map(function(a){return a.win_rate;})):null;
  $('#accIntro').innerHTML=ACC.nShown.toLocaleString()+' accounts with two or more closed non-renewal deals'+(ACC.nAccounts>ACC.nShown?' (the largest of '+ACC.nAccounts.toLocaleString()+')':'')+'.'+(r!=null?' Across them, average engagement and win rate correlate at <b class="num">r = '+r.toFixed(2)+'</b>.':'');
}
function renderA360(){
  var M=A360.B.months,agg=a360Agg(a360Lo,a360Hi),pw=agg['Power Users'],br=agg['Frequent Browsers'],dg=agg['Focused Diggers'],lt=agg['Light Touch'],nn=agg['No Engagement'];
  $('#a360RangeLabel').textContent=mlabL(M[a360Lo])+' – '+mlabL(M[a360Hi]);
  var tc=0,tw=0,ta=0;CO.forEach(function(c){tc+=agg[c].total_created;tw+=agg[c].total_won;ta+=agg[c].n;});
  var x=function(a,b){return b?(a/b).toFixed(1)+'×':'–';},lift=function(a,b){return b?sp((a/b-1)*100):'–';};
  var T=[['Pipeline created',money(tc),'across '+ta.toLocaleString()+' parent accounts'],['Power user accounts, avg created',money(pw.avg_created),x(pw.avg_created,nn.avg_created)+' the '+money(nn.avg_created)+' of no-engagement accounts'],
    ['Pipeline closed-won',money(tw),money(pw.total_won)+' of it on power user accounts'],['Power user accounts, avg closed-won',money(pw.avg_won),x(pw.avg_won,nn.avg_won)+' the '+money(nn.avg_won)+' of no-engagement accounts'],
    ['Depth at the same frequency',lift(pw.avg_created,br.avg_created),'power users vs frequent browsers, pipeline created'],['Depth among infrequent visitors',lift(dg.avg_created,lt.avg_created),'focused diggers vs light touch, pipeline created']];
  $('#a360Kpis').innerHTML=T.map(function(t){return '<div class="tile"><div class="k">'+esc(t[0])+'</div><div class="v">'+esc(t[1])+'</div><div class="d">'+esc(t[2])+'</div></div>';}).join('');
  plot('a360Cohorts',[{type:'bar',name:'Created',x:CO,y:CO.map(function(c){return agg[c].avg_created;}),marker:{color:CO.map(coColor)},text:CO.map(function(c){return money(agg[c].avg_created);}),textposition:'outside',cliponaxis:false,textfont:{family:MONO,size:11,color:css('--text')},customdata:CO.map(function(c){return agg[c].n;}),hovertemplate:'%{x}<br>Created %{y:$,.0f} per account (%{customdata} accounts)<extra></extra>'},
    {type:'bar',name:'Closed-won',x:CO,y:CO.map(function(c){return agg[c].avg_won;}),marker:{color:CO.map(coColor),opacity:.45},hovertemplate:'%{x}<br>Closed-won %{y:$,.0f} per account<extra></extra>'}],
    base({barmode:'group',xaxis:xcat(),yaxis:{tickformat:'$.2s',gridcolor:css('--rule'),rangemode:'tozero',tickfont:{family:MONO,size:11}}}));
  $('#a360Nuance').innerHTML=(pw.avg_created&&br.avg_created?'At the same visit frequency, accounts worked in depth carry <b class="num">'+lift(pw.avg_created,br.avg_created)+'</b> more created pipeline than those only browsed; among infrequent visitors the gap is <b class="num">'+lift(dg.avg_created,lt.avg_created)+'</b>. ':'')+'Solid bars are created pipeline, faint bars closed-won.';
  var rows=a360Accounts(a360Lo,a360Hi),B=A360.B;
  plot('a360Scatter',CO.map(function(c){var r=rows.filter(function(a){return a.cohort===c;});return {type:'scatter',mode:'markers',name:c,x:r.map(function(a){return Math.max(a.sessions,0.8);}),y:r.map(function(a){return Math.max(a.created+a.won,1000);}),text:r.map(function(a){return a.account;}),marker:{color:coColor(c),size:9,opacity:.8,line:{width:0}},hovertemplate:'%{text}<br>%{x} sessions<br>%{y:$,.0f} pipeline<extra>'+c+'</extra>'};}),
    base({xaxis:{type:'log',title:{text:'Sessions (log)',font:{size:12}},gridcolor:css('--rule'),tickfont:{family:MONO,size:11}},yaxis:{type:'log',tickformat:'$.2s',title:{text:'Pipeline created + closed-won (log)',font:{size:12}},gridcolor:css('--rule'),tickfont:{family:MONO,size:11}},
      shapes:[{type:'line',xref:'x',yref:'paper',x0:Math.max(B.session_median,1),x1:Math.max(B.session_median,1),y0:0,y1:1,line:{color:css('--text3'),dash:'dash',width:1}}]}));
  renderA360Trend();
  var watch=rows.filter(function(a){return (B.whale_names.indexOf(a.account)>=0||B.dark_names.indexOf(a.account)>=0)&&(a.created+a.won>0);}).sort(function(a,b){return (b.created+b.won)-(a.created+a.won);}).slice(0,15);
  $('#a360Watch').innerHTML='<thead><tr><th>Account</th><th>Cohort</th><th>Sessions</th><th>Created</th><th>Closed-won</th></tr></thead><tbody>'+(watch.length?watch.map(function(a){return '<tr><td>'+esc(a.account)+'</td><td class="txt"><span class="badge">'+esc(a.cohort)+'</span></td><td>'+n0(a.sessions)+'</td><td>'+money(a.created)+'</td><td>'+money(a.won)+'</td></tr>';}).join(''):'<tr><td colspan="5" class="muted">No pipeline on low-engagement accounts in these months.</td></tr>')+'</tbody>';
  var us=(B.top_users||[]).slice(0,8);
  $('#a360UsersSub').textContent='The most active Account 360 users after exclusions'+(A360.M.excludedUsers&&A360.M.excludedUsers.length?' ('+A360.M.excludedUsers.length+' excluded)':'')+'.';
  $('#a360Users').innerHTML='<thead><tr><th>User</th><th>Accounts</th><th>Events</th><th>Sessions</th></tr></thead><tbody>'+us.map(function(u){return '<tr><td>'+esc(u.user)+'</td><td>'+n0(u.unique_accounts)+'</td><td>'+n0(u.total_events)+'</td><td>'+n0(u.unique_sessions)+'</td></tr>';}).join('')+'</tbody>';
  renderA360Table();
}
function renderA360Trend(){
  var M=A360.B.months,idx=rng(a360Lo,a360Hi),x=idx.map(function(i){return mlab(M[i]);}),acc=A360.B.accounts,data;
  var tot=function(key,filter){return idx.map(function(i){var s=0;acc.forEach(function(a){if(!filter||filter(a))s+=a[key][i]||0;});return s;});};
  if(a360TrendView==='total')data=[{type:'scatter',mode:'lines+markers',name:'Created',x:x,y:tot('created_by_month'),line:{color:css('--d1'),width:2.4},fill:'tozeroy'},{type:'scatter',mode:'lines+markers',name:'Closed-won',x:x,y:tot('closed_won_by_month'),line:{color:css('--d2'),width:2.6}}];
  else data=CO.map(function(c){return {type:'scatter',mode:'lines',name:c,x:x,y:tot('created_by_month',function(a){return a.cohort===c;}),line:{color:coColor(c),width:2.2}};});
  plot('a360Trend',data,base({xaxis:xcat(),yaxis:{tickformat:'$.2s',gridcolor:css('--rule'),rangemode:'tozero',tickfont:{family:MONO,size:11}},hovermode:'x unified'}));
  var c=tot('created_by_month'),peak=c.indexOf(Math.max.apply(null,c)),sum=c.reduce(function(a,b){return a+b;},0),ch=c.length>1&&c[0]?((c[c.length-1]-c[0])/c[0]*100):null;
  $('#a360TrendSub').textContent=money(sum)+' created in these months; the peak was '+(x[peak]||'–')+' ('+money(c[peak])+')'+(ch!=null?'; the last month is '+sp(ch)+' against the first.':'.')+(A360.M.lastMonthPartial?' The last month is partial.':'');
}
function sortRows(rows,s){var k=s.k,d=s.dir;return rows.sort(function(a,b){var va=a[k],vb=b[k];if(va==null&&vb==null)return 0;if(va==null)return 1;if(vb==null)return -1;return (typeof va==='string'?va.localeCompare(vb):va-vb)*d;});}
function sortHead(id,cols,s,cb){return '<thead><tr>'+cols.map(function(c){return '<th><button type="button" data-k="'+c[0]+'">'+esc(c[1])+(s.k===c[0]?(s.dir<0?' ↓':' ↑'):'')+'</button></th>';}).join('')+'</tr></thead>';}
function bindSort(id,s,cb){$$(id+' th button').forEach(function(b){b.onclick=function(){var k=b.getAttribute('data-k');s.dir=s.k===k?-s.dir:-1;s.k=k;cb();};});}
function renderA360Table(){
  var c=$('#a360Cohort').value,q=($('#a360Q').value||'').toLowerCase(),rows=a360Accounts(a360Lo,a360Hi).filter(function(a){return (!c||a.cohort===c)&&(!q||a.account.toLowerCase().indexOf(q)>=0);});
  sortRows(rows,a360Sort);var cols=[['account','Account'],['cohort','Cohort'],['sessions','Sessions'],['deep','Deep actions'],['users','Users'],['created','Created'],['won','Closed-won']];
  $('#a360Tbl').innerHTML=sortHead('#a360Tbl',cols,a360Sort)+'<tbody>'+rows.slice(0,200).map(function(a){return '<tr><td>'+esc(a.account)+'</td><td class="txt"><span class="badge">'+esc(a.cohort)+'</span></td><td>'+n0(a.sessions)+'</td><td>'+p1(a.deep*100)+'</td><td>'+n0(a.users)+'</td><td>'+money(a.created)+'</td><td>'+money(a.won)+'</td></tr>';}).join('')+'</tbody>';
  bindSort('#a360Tbl',a360Sort,renderA360Table);
}
function renderAccBubble(){
  var rows=ACC.accounts.filter(function(a){return a.eng!=null;}),cols=[css('--rule-strong'),css('--d2'),css('--d1')],mx=Math.max.apply(null,rows.map(function(a){return a.opps;}).concat([1]));
  plot('accBubble',LEVELS.map(function(L,li){var r=rows.filter(function(a){return levelOf(a.eng)===li;});return {type:'scatter',mode:'markers',name:L,x:r.map(function(a){return a.eng;}),y:r.map(function(a){return a.win_rate;}),text:r.map(function(a){return a.account;}),customdata:r.map(function(a){return [a.opps,a.won];}),
    marker:{size:r.map(function(a){return 6+Math.sqrt(a.opps/mx)*34;}),color:cols[li],opacity:.7,line:{width:1,color:css('--page')}},hovertemplate:'%{text}<br>Engagement %{x:.1f}<br>Win rate %{y:.1f}% (%{customdata[1]} of %{customdata[0]} deals)<extra></extra>'};}),
    base({xaxis:{title:{text:'Average engagement score',font:{size:12}},range:[0,100],gridcolor:css('--rule'),tickfont:{family:MONO,size:11}},yaxis:ypct({range:[0,105]})}));
}
function renderAccTable(){
  var q=($('#accQ').value||'').toLowerCase(),rows=ACC.accounts.filter(function(a){return !q||a.account.toLowerCase().indexOf(q)>=0;}).slice();sortRows(rows,accSort);
  var cols=[['account','Account'],['opps','Deals'],['won','Won'],['win_rate','Win rate'],['eng','Engagement'],['days','Days to close'],['depth','Depth'],['breadth','Breadth'],['exec','Exec activity'],['vp','VP activity'],['dir','Director activity']];
  $('#accTbl').innerHTML=sortHead('#accTbl',cols,accSort)+'<tbody>'+rows.slice(0,200).map(function(a){return '<tr><td>'+esc(a.account)+'</td><td>'+n0(a.opps)+'</td><td>'+n0(a.won)+'</td><td>'+p1(a.win_rate)+'</td><td>'+(a.eng==null?'–':a.eng.toFixed(1))+'</td><td>'+(a.days==null?'–':n0(a.days))+'</td><td>'+(a.depth==null?'–':a.depth.toFixed(1))+'</td><td>'+a.breadth+'</td><td>'+n0(a.exec)+'</td><td>'+n0(a.vp)+'</td><td>'+n0(a.dir)+'</td></tr>';}).join('')+'</tbody>';
  bindSort('#accTbl',accSort,renderAccTable);
}

/* ---------- method ---------- */
function fillMethod(){
  if(AG)return;
  if(HAS.U){$('#capP').textContent=money(META.capP);$('#capPO').textContent=money(META.capPO);}
  if(HAS.usage)$('#methodUsage').innerHTML=['The usage file is left-joined to the activity extract on lower-cased email. '+U.nUsage+' of '+U.usageRecords+' usage records match an activity rep.',
      'Tiers are terciles of the usage score among matched reps (cut points '+U.tierCuts[0]+' and '+U.tierCuts[1]+').',
      'Very low usage: the bottom 5% by score ('+U.nBottom+' reps), ties broken by the oldest last-usage date. These reps are counted as non-users.',
      'Cohort metrics include only reps with activity in the chosen window.'].map(function(x){return '<li>'+esc(x)+'</li>';}).join('');
  else $('#methodUsage').innerHTML='<li>No usage cohort file was provided, so adoption cohorts were not computed.</li>';
  if(HAS.ST){$('#mOpps').textContent=ST.base.n_opps.toLocaleString();$('#mPre').textContent=ST.base.n_pre.toLocaleString();$('#mPreWR').textContent=ST.base.wr_pre==null?'–':ST.base.wr_pre+'%';$('#mLate').textContent=ST.n_late.toLocaleString();
    $('#mEarly').textContent=ST.earlyStages.join(' or ');$('#mLateStages').textContent=ST.lateStages.join(' or ');$('#mCycle').textContent=ST.cycleMatch==null?'no cycle times available':ST.cycleMatch+'% match';}
  var am=[];
  if(HAS.A360)am=['Source: the Account 360 click-stream, the parent accounts in scope and the opportunity pull.','Users who touched '+A360.M.breadthCutoff+' or more accounts are excluded (enablement and admins browse everywhere)'+(A360.M.excludedUsers.length?', as are any the requester named — '+A360.M.excludedUsers.length+' in all':'')+'.','Each event belongs to the account its session was on; deep actions are opportunity, metric and activity actions.','Cohorts split engaged accounts on the medians of sessions and of the deep-action share. Pipeline is by month: created by created date, closed-won by close date on a won stage.'];
  if(HAS.ACC)am.push('Deal engagement by account uses closed non-renewal deals from the stage extract, accounts with two or more deals, the '+ACC.nShown+' largest by deal count.');
  if(!am.length)am=['No Account 360 or account-level extracts were loaded for this run.'];
  $('#methodA360').innerHTML=am.map(function(x){return '<li>'+esc(x)+'</li>';}).join('');
}

/* ---------- plumbing ---------- */
var TABS={summary:true,activity:HAS.U,adoption:HAS.usage,deals:HAS.OPP||HAS.D||HAS.ACC,stage:HAS.ST,accounts:HAS.A360,method:true};
/* Tab ids from earlier layouts: hiding maps onto today's tabs ("users" is a view now, so hides nothing); navigating opens the view. */
var HIDE_AS={lead:'activity',adopt:'adoption',deal:'deals'}, OPEN_AS={lead:'activity',adopt:'adoption',users:'adoption',deal:'deals'};
(VIEW.hiddenTabs||[]).forEach(function(t){t=HIDE_AS[t]||t;if(t!=='summary'&&t in TABS)TABS[t]=false;});
var R={summary:function(){renderScorecard();renderOverview();},activity:renderLead,adoption:renderAdoption,deals:renderDealsTab,stage:renderStage,accounts:function(){if(HAS.A360)renderA360();},method:function(){}};
var current='summary';
function showTab(t){if(t==='users'&&HAS.usage){adoptView='users';segSet('#adoptView','users');}t=OPEN_AS[t]||t;if(!TABS[t])t='summary';current=t;$$('nav.tabs button[role=tab]').forEach(function(b){b.setAttribute('aria-selected',b.getAttribute('data-tab')===t);});$$('section.panel').forEach(function(s){s.classList.toggle('active',s.id==='p-'+t);});if(HOSTED)post({type:'backstory:roi-tab-shown',tab:t});requestAnimationFrame(function(){R[t]();});}
function rerender(){R[current]();}
$$('nav.tabs button[role=tab]').forEach(function(b){if(!TABS[b.getAttribute('data-tab')])b.classList.add('hidden');b.onclick=function(){showTab(b.getAttribute('data-tab'));};});
$$('section.panel').forEach(function(s){var t=s.id.slice(2);if(!TABS[t])s.classList.add('hidden');});
/* The platform's startup validator opens every saved version in an isolated
   browser and runs these steps. The readout's primary workflow is opening a
   view and seeing its numbers drawn, so the steps open the first view this
   account's data has and wait for its figures. */
window.__artifactTests=(function(){
  var deals=HAS.OPP||HAS.D;
  var plan=[['activity','#leadDyn','per rep per month'],['deals',deals?'#dealDyn':'#accTbl',deals?'deals':'Account'],['adoption','#adoptionIntro','reps'],['stage','#stageIntro','opportunities'],['accounts','#a360Kpis','Pipeline created']];
  var pick=plan.filter(function(p){return TABS[p[0]];})[0];
  return pick?[{action:'click',selector:'nav.tabs button[data-tab="'+pick[0]+'"]'},{action:'expectText',selector:pick[1],value:pick[2]}]
    :[{action:'click',selector:'#themeBtn'},{action:'expectText',selector:'#themeBtn',value:'Theme: light'}];
})();

function init(){
  setupGF();
  if(HAS.U)setupLead();
  if(HAS.usage)setupCohorts();
  if(TABS.deals)setupDeals();
  if(HAS.ST)setupStage();
  if(HAS.ACC)setupAccDeals();else $('#accDealsWrap').classList.add('hidden');
  if(HAS.A360)setupA360();
  setupCalc();renderSummary();renderHero();renderHeroStats();fillMethod();R.summary();
  post({type:'backstory:roi-loaded'});
}
if(window.Plotly)init();else window.addEventListener('load',init);
})();
`

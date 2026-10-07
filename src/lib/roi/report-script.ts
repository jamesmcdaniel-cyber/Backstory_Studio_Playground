/**
 * The ROI report's script (see dashboard.ts). Plain ES2017 in a raw string:
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

/* ---------- data ---------- */
var dm=function(s){if(s==null)return null;if(typeof s!=='string')return s;if(!s)return [];return s.split(';').map(function(r){return r.split(',').map(function(v){return v===''?null:+v;});});};
var MAT={};
function mat(k){if(k in MAT)return MAT[k];var src=(U&&U.m&&U.m[k]!=null)?U.m[k]:((U&&U.mx&&U.mx[k]!=null)?U.mx[k]:null);MAT[k]=dm(src);return MAT[k];}
var D=null;
if(DEALS&&DEALS.w&&DEALS.w.length){
  var nD=DEALS.w.length;D={types:DEALS.types,months:DEALS.months,s:new Array(nD),w:new Array(nD),d:DEALS.d,t:new Array(nD),m:new Array(nD),x:new Array(nD)};
  for(var i=0;i<nD;i++){D.s[i]=parseInt(DEALS.s.substr(i*2,2),36)/10;D.w[i]=DEALS.w.charCodeAt(i)===49?1:0;D.t[i]=parseInt(DEALS.t.charAt(i),36);var mm=DEALS.m.substr(i*2,2);D.m[i]=mm==='zz'?-1:parseInt(mm,36);D.x[i]=DEALS.x.charCodeAt(i)===49?1:0;}
}
var PERS_DEFAULT=['Director','VP','Executive','Management/Admin','Legal/Procurement','Finance','IT','Engineering','Ops/Product/Supply chain'];
var PK=(ST&&ST.personaKeys)||PERS_DEFAULT, NP=PK.length;
var HAS={U:!!U,usage:!!(U&&U.hasUsage),OPP:!!OPP,D:!!D,ST:!!ST,cells:!!(ST&&ST.cells&&ST.cells.length),ACC:!!(ACC&&ACC.accounts&&ACC.accounts.length),A360:!!A360,vel:!!(META&&META.hasVelocity),roster:!!(U&&U.users.some(function(u){return u.n;}))};
var MK=U?Object.keys(U.labels):[], LAB=U?U.labels:{}, MON=U?U.months:[], NM=MON.length;
var isMoney=function(k){return k.indexOf('pipeline')===0||((U&&U.moneyKeys)||[]).indexOf(k)>=0;};
var fmt=function(v,k){if(v==null||isNaN(v))return '–';if(isMoney(k))return money(v);return v.toFixed(v<10?2:1);};

/* ---------- fiscal periods ---------- */
function fp(m){var y=+m.slice(0,4),mo=+m.slice(5,7),st=CFG.fyStart||1,off=(mo-st+12)%12,fy=st===1?y:(mo>=st?y+1:y);return {fy:'FY'+fy,fq:'Q'+(Math.floor(off/3)+1)};}

/* ---------- global filters ---------- */
var GF={fy:[],fq:[],type:[],role:[]};
function monthOK(m){if(!GF.fy.length&&!GF.fq.length)return true;if(!m)return false;var p=fp(m);return (!GF.fy.length||GF.fy.indexOf(p.fy)>=0)&&(!GF.fq.length||GF.fq.indexOf(p.fq)>=0);}
function typeOK(t){return GF.type.length?GF.type.indexOf(t)>=0:!/renewal/i.test(t);}
function roleOK(u){return !GF.role.length||GF.role.indexOf(u.r||'Other')>=0;}
var ROLE_ORDER=['Account executives','CS / PS','SDR / BDR','Solutions engineering','Leadership','Other'];
function chipGroup(id,values,key,label){var el=$(id);if(!el)return 0;el.innerHTML=values.map(function(v){return '<button type="button" aria-pressed="false" data-v="'+esc(v)+'">'+esc(label?label(v):v)+'</button>';}).join('');
  $$(id+' button').forEach(function(b){b.onclick=function(){var v=b.getAttribute('data-v'),a=GF[key],ix=a.indexOf(v);if(ix>=0)a.splice(ix,1);else a.push(v);b.setAttribute('aria-pressed',ix<0);gfChanged();};});return values.length;}
function setupGF(){
  var months=D?D.months.slice():(HAS.cells?(ST.cellMonths||[]).slice():[]);
  var fys=uniq(months.map(function(m){return fp(m).fy;})).sort();
  var types=[];if(D)types=types.concat(D.types);if(HAS.cells)types=types.concat(ST.cellTypes||[]);if(!D&&OPP)types=types.concat(Object.keys(OPP).filter(function(t){return t!=='All (excl. renewals)';}));
  types=uniq(types).filter(function(t){return t&&!/framework/i.test(t);});
  var roles=U?ROLE_ORDER.filter(function(r){return U.users.some(function(u){return (u.r||'Other')===r&&u.r;});}):[];
  if(!chipGroup('#gfFy',fys,'fy'))$('#gfFyWrap').classList.add('hidden');
  if(!fys.length)$('#gfFqWrap').classList.add('hidden');else chipGroup('#gfFq',['Q1','Q2','Q3','Q4'],'fq');
  if(!chipGroup('#gfType',types,'type'))$('#gfTypeWrap').classList.add('hidden');
  if(!chipGroup('#gfRole',roles,'role'))$('#gfRoleWrap').classList.add('hidden');
  $('#gfClear').onclick=function(){GF.fy=[];GF.fq=[];GF.type=[];GF.role=[];$$('.gfbar .chips button').forEach(function(b){b.setAttribute('aria-pressed','false');});gfChanged();};
}
function gfChanged(){var parts=[];if(GF.fy.length)parts.push(GF.fy.join(', '));if(GF.fq.length)parts.push(GF.fq.join(', '));if(GF.type.length)parts.push(GF.type.join(', '));if(GF.role.length)parts.push(GF.role.join(', '));
  var b=$('#gfBadge');b.textContent=parts.length?'Filtered: '+parts.join(' · '):'';b.style.display=parts.length?'inline-block':'none';
  rerender();}
function gfForTab(t){var dealish=t==='deals',people=t==='activity'||t==='adoption';
  $('#gfbar').classList.toggle('hidden',!(dealish||people));
  ['#gfFyWrap','#gfFqWrap','#gfTypeWrap'].forEach(function(s){$(s).style.display=dealish?'':'none';});
  $('#gfRoleWrap').style.display=people?'':'none';
  $('#gfHint').textContent=dealish?'Fiscal year, quarter and deal type slice every deal and stage view. With no deal type chosen, renewals are left out.':'Role narrows the reps behind every number on this tab.';}

/* ---------- theme ---------- */
var themeMode='auto';
$('#themeBtn').onclick=function(){themeMode=themeMode==='auto'?'light':themeMode==='light'?'dark':'auto';
  if(themeMode==='auto')document.documentElement.removeAttribute('data-theme');else document.documentElement.setAttribute('data-theme',themeMode);
  $('#themeBtn').textContent='Theme: '+themeMode;renderHero();rerender();};
try{window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change',function(){if(themeMode==='auto'){renderHero();rerender();}});}catch(e){}

function base(extra){
  var t=css('--text'),t2=css('--text2'),r=css('--rule');
  var L={paper_bgcolor:'rgba(0,0,0,0)',plot_bgcolor:'rgba(0,0,0,0)',font:{family:css('--sans'),size:13,color:t2},
    margin:{l:56,r:20,t:14,b:48},hoverlabel:{font:{family:'Chivo Mono, monospace',size:12,color:t},bgcolor:css('--raised'),bordercolor:css('--rule-strong')},
    xaxis:{gridcolor:r,linecolor:css('--rule-strong'),zeroline:false,tickfont:{family:'Chivo Mono, monospace',size:11}},
    yaxis:{gridcolor:r,zeroline:false,tickfont:{family:'Chivo Mono, monospace',size:11},rangemode:'tozero'},
    legend:{orientation:'h',y:-0.2,x:0,font:{size:13,color:t2}},bargap:0.28};
  return Object.assign(L,extra||{});
}
var PCFG={displayModeBar:false,responsive:true};
function plot(id,data,layout){var el=document.getElementById(id);if(!el||!window.Plotly)return null;Plotly.react(el,data,layout,PCFG);return el;}
var palette=function(){return [css('--d1'),css('--d2'),css('--d3'),css('--d5'),css('--d6'),css('--neg'),css('--d4'),css('--text3'),css('--pos')];};
function ypct(extra){return Object.assign({ticksuffix:'%',rangemode:'tozero',gridcolor:css('--rule'),tickfont:{family:'Chivo Mono, monospace',size:11}},extra||{});}
var xcat=function(extra){return Object.assign({gridcolor:'rgba(0,0,0,0)',linecolor:css('--rule-strong'),tickfont:{size:11}},extra||{});};
function segBind(sel,cb){$$(sel+' button').forEach(function(b){b.onclick=function(){$$(sel+' button').forEach(function(x){x.setAttribute('aria-pressed',x===b);});cb(b.getAttribute('data-v'));};});}
function segSet(sel,v){$$(sel+' button').forEach(function(x){x.setAttribute('aria-pressed',x.getAttribute('data-v')===v);});}

/* ---------- rep math ---------- */
function popMask(p){return U.users.map(function(u){return (p==='all'?true:(p==='User'||p==='Non-user')?u.f===p:u.t===p)&&roleOK(u);});}
function winAvg(mask,mi,keys){
  var out={},n=0;(keys||MK).forEach(function(k,ki){var M=mat(k);if(!M){out[k]=NaN;return;}var s=0,c=0;
    for(var i=0;i<M.length;i++){if(!mask[i])continue;var rs=0,rc=0;for(var j=0;j<mi.length;j++){var v=M[i][mi[j]];if(v!=null){rs+=v;rc++;}}if(rc){s+=rs/rc;c++;}}
    out[k]=c?s/c:NaN;if(k==='meeting_count'||(ki===0&&!n))n=c;});
  out.n=n;return out;}
function monthly(mask,k){var M=mat(k),r=[];if(!M)return MON.map(function(){return null;});for(var j=0;j<NM;j++){var s=0,c=0;for(var i=0;i<M.length;i++){if(!mask[i])continue;var v=M[i][j];if(v!=null){s+=v;c++;}}r.push(c?s/c:null);}return r;}
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
function dealIdx(opts){opts=opts||{};var incl=opts.incl!=null?opts.incl:$('#dealIncl').checked,out=[];if(!D)return out;
  for(var i=0;i<D.w.length;i++){if(!incl&&D.x[i])continue;if(!typeOK(D.types[D.t[i]]))continue;if(!opts.ignoreMonth&&!monthOK(D.m[i]>=0?D.months[D.m[i]]:null))continue;if(opts.extra&&!opts.extra(i))continue;out.push(i);}return out;}
function legacyTable(incl){if(!OPP)return null;var t=(GF.type.length===1&&OPP[GF.type[0]])?GF.type[0]:(OPP['All (excl. renewals)']?'All (excl. renewals)':Object.keys(OPP)[0]);return OPP[t][incl?'incl':'excl'];}
function currentDeals(){if(D)return dealGroup(dealIdx());return legacyTable($('#dealIncl')&&$('#dealIncl').checked);}
function defaultDeals(){if(D){var renew=D.types.map(function(t){return /renewal/i.test(t);}),ix=[];for(var i=0;i<D.w.length;i++)if(!renew[D.t[i]]&&!D.x[i])ix.push(i);return dealGroup(ix);}return OPP?(OPP['All (excl. renewals)']||OPP[Object.keys(OPP)[0]]).excl:null;}
var lvl=function(g,prefix){return g?g.levels.filter(function(r){return r.level.indexOf(prefix)===0;})[0]:null;};

/* ---------- hero ---------- */
function topCohort(){return CFG.cohort==='users'?'User':'High';}
function renderHero(){
  var g=defaultDeals();
  if(!g||!g.deciles.length){ if(HAS.U){var s=monthly(U.users.map(function(){return true;}),'dir_vp_exec'),hz=css('--horizon');
    plot('heroStrip',[{type:'scatter',mode:'lines',x:MON.map(mlab),y:s,line:{color:hz,width:2.5},hovertemplate:'%{x}<br>%{y:.2f}<extra></extra>'}],
      base({margin:{l:4,r:4,t:12,b:26},font:{family:css('--sans'),color:'#BBBCBC'},xaxis:{showgrid:false,linecolor:'#55555E',nticks:6,tickfont:{family:'Chivo Mono, monospace',size:11,color:'#BBBCBC'}},yaxis:{visible:false}}));
    $('#heroCap').textContent='Director, VP and executive meetings per rep per month, all reps';}
    else $('[data-section="hero"]').classList.add('hidden'); return; }
  var d=g.deciles,hz2=css('--horizon');
  plot('heroStrip',[{type:'bar',x:d.map(function(r){return 'D'+r.dec;}),y:d.map(function(r){return r.win_rate;}),marker:{color:d.map(function(r,i){return i>=d.length-3?hz2:'#55555E';})},
    text:d.map(function(r){return r.win_rate==null?'–':r.win_rate.toFixed(0)+'%';}),textposition:'outside',textfont:{family:'Chivo Mono, monospace',size:12,color:'#FFFFFF'},cliponaxis:false,
    hovertemplate:'Decile %{x}<br>Win rate %{y:.1f}%<extra></extra>'}],
    base({margin:{l:4,r:4,t:22,b:26},font:{family:css('--sans'),color:'#BBBCBC'},xaxis:{showgrid:false,linecolor:'#55555E',tickfont:{family:'Chivo Mono, monospace',size:11,color:'#BBBCBC'}},yaxis:{visible:false,range:[0,Math.max.apply(null,[10].concat(d.map(function(r){return r.win_rate||0;})))*1.2]},bargap:.18}));
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
  el.style.gridTemplateColumns='repeat('+Math.min(4,out.length)+',minmax(0,1fr))';
  el.innerHTML=out.slice(0,4).map(function(s){return '<div><div class="v">'+esc(s[0])+'</div><div class="l">'+esc(s[1])+'</div></div>';}).join('');
}

/* ---------- key findings ---------- */
function renderSummary(){
  $('#findings').innerHTML=N.findings.map(function(f){return '<div class="finding"><div class="fig">'+esc(f.fig)+'<small>'+esc(f.cap)+'</small></div><div><h3>'+esc(f.h)+'</h3><p>'+md(f.p)+'</p>'+(TABS[f.tab]?'<button class="go" data-go="'+esc(f.tab)+'" type="button">See the detail</button>':'')+'</div></div>';}).join('');
  $$('.go').forEach(function(b){b.onclick=function(){showTab(b.getAttribute('data-go'));window.scrollTo({top:$('nav.tabs').offsetTop,behavior:'smooth'});};});
  $('#watch').innerHTML=N.watch.map(function(w){return '<li><b>'+esc(w.lead)+'</b> '+md(w.text)+'</li>';}).join('');
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

/* ---------- activity trends ---------- */
var leadMetric=MK.indexOf('dir_vp_exec')>=0?'dir_vp_exec':MK[0], leadMode='cfg', mixKind='meetings';
function setupActivity(){
  var opts=MON.map(function(m,i){return '<option value="'+i+'">'+mlab(m)+'</option>';}).join('');
  ['bS','bE','oS','oE'].forEach(function(id){document.getElementById(id).innerHTML=opts;});
  $('#bS').value=BASE[0]!=null?BASE[0]:0;$('#bE').value=BASE.length?BASE[BASE.length-1]:0;$('#oS').value=OBS[0]!=null?OBS[0]:0;$('#oE').value=OBS.length?OBS[OBS.length-1]:NM-1;
  if(!HAS.usage)$('#leadPop').innerHTML='<option value="all">All reps</option>';
  $('#leadMode button[data-v="cfg"]').textContent='As configured ('+(CFG.obsLabel||wl(OBS))+' vs '+(CFG.baseLabel||wl(BASE))+')';
  $('#leadMode button[data-v="pp"]').textContent='Last '+WN+' months vs the '+WN+' before';
  $('#leadMode button[data-v="yoy"]').textContent='Last '+WN+' months vs a year earlier';
  segBind('#leadMode',function(v){leadMode=v;$('#leadCustom').classList.toggle('on',v==='custom');renderActivity();});
  segBind('#mixKind',function(v){mixKind=v;renderMix();});
  ['bS','bE','oS','oE','leadPop'].forEach(function(id){document.getElementById(id).addEventListener('change',renderActivity);});
  if(!mat('in_person_meeting_count')&&!mat('received_email_count'))$('#mixBlock').classList.add('hidden');
  else{if(!mat('in_person_meeting_count')&&!mat('conference_call_count')){mixKind='emails';segSet('#mixKind','emails');$('#mixKind button[data-v="meetings"]').classList.add('hidden');}
    if(!mat('received_email_count'))$('#mixKind button[data-v="emails"]').classList.add('hidden');}
  if(!mat('director_meeting_count')&&!mat('vp_meeting_count'))$('#seniorBlock').classList.add('hidden');
}
function leadWindows(){
  var last=rng(NM-WN,NM-1);
  if(leadMode==='cfg')return [BASE,OBS,'Baseline ('+wl(BASE)+')','Observation ('+wl(OBS)+')'];
  if(leadMode==='pp'){var pr=rng(NM-2*WN,NM-WN-1);return [pr,last,'Prior '+WN+' months ('+wl(pr)+')','Last '+WN+' months ('+wl(last)+')'];}
  if(leadMode==='yoy'){var py=shift12(last);return [py,last,'Same months last year ('+wl(py)+')','Last '+WN+' months ('+wl(last)+')'];}
  var a=+$('#bS').value,b=+$('#bE').value,c=+$('#oS').value,d=+$('#oE').value;if(b<a){var t=a;a=b;b=t;}if(d<c){var t2=c;c=d;d=t2;}
  return [rng(a,b),rng(c,d),'Baseline ('+mlab(MON[a])+' – '+mlab(MON[b])+')','Observation ('+mlab(MON[c])+' – '+mlab(MON[d])+')'];
}
function bands(bw,ow,B,O){var s=[],hz=css('--horizon');
  if(bw.length){s.push({type:'rect',xref:'x',yref:'paper',x0:bw[0]-.5,x1:bw[bw.length-1]+.5,y0:0,y1:1,fillcolor:css('--rule-strong'),opacity:.18,line:{width:0},layer:'below'});if(B!=null&&!isNaN(B))s.push({type:'line',xref:'x',x0:bw[0]-.5,x1:bw[bw.length-1]+.5,y0:B,y1:B,line:{color:css('--text3'),width:2,dash:'dot'}});}
  if(ow.length){s.push({type:'rect',xref:'x',yref:'paper',x0:ow[0]-.5,x1:ow[ow.length-1]+.5,y0:0,y1:1,fillcolor:hz,opacity:.16,line:{width:0},layer:'below'});if(O!=null&&!isNaN(O))s.push({type:'line',xref:'x',x0:ow[0]-.5,x1:ow[ow.length-1]+.5,y0:O,y1:O,line:{color:css('--horizon-deep'),width:2,dash:'dot'}});}
  return s;}
var monthAxis=function(extra){return Object.assign({tickmode:'array',tickvals:MON.map(function(m,i){return i;}).filter(function(i){return i%3===0;}),ticktext:MON.filter(function(m,i){return i%3===0;}).map(mlab),gridcolor:'rgba(0,0,0,0)',linecolor:css('--rule-strong'),tickfont:{family:'Chivo Mono, monospace',size:11}},extra||{});};
function renderActivity(){
  var pop=$('#leadPop').value,mask=popMask(pop),w=leadWindows(),bw=w[0],ow=w[1],bl=w[2],ol=w[3];
  var B=winAvg(mask,bw),O=winAvg(mask,ow),k=leadMetric,series=monthly(mask,k),hz=css('--horizon');
  $('#leadTiles').innerHTML=MK.map(function(m){var c=pct(O[m],B[m]);return '<button type="button" class="tile" aria-pressed="'+(m===k)+'" data-k="'+m+'"><div class="k">'+esc(LAB[m])+'</div><div class="v">'+fmt(O[m],m)+'</div><div class="d '+(isNaN(c)?'':c>=0?'up':'down')+'">'+sp(c)+' vs '+fmt(B[m],m)+'</div></button>';}).join('');
  $$('#leadTiles .tile').forEach(function(b){b.onclick=function(){leadMetric=b.getAttribute('data-k');renderActivity();};});
  $('#leadTitle').textContent=LAB[k]+', monthly average per rep';
  plot('leadTrend',[{type:'scatter',mode:'lines+markers',x:MON.map(function(m,i){return i;}),y:series,line:{color:hz,width:2.5,shape:'spline',smoothing:.4},marker:{size:6,color:hz},
    customdata:MON.map(mlab),hovertemplate:'%{customdata}<br>'+(isMoney(k)?'$%{y:,.0f}':'%{y:.2f}')+'<extra></extra>',name:LAB[k]}],
    base({shapes:bands(bw,ow,B[k],O[k]),showlegend:false,xaxis:monthAxis(),yaxis:{gridcolor:css('--rule'),rangemode:'tozero',tickformat:isMoney(k)?'$.2s':'',tickfont:{family:'Chivo Mono, monospace',size:11}}}));
  var ch=pct(O[k],B[k]),popName=$('#leadPop').selectedOptions[0].text.toLowerCase()+(GF.role.length?' ('+GF.role.join(', ')+')':'');
  $('#leadDyn').innerHTML='For '+esc(popName)+', <b>'+esc(LAB[k].toLowerCase())+'</b> averaged <b class="num">'+fmt(O[k],k)+'</b> per rep per month in the observation window ('+esc(ol.replace(/^[^(]*\(|\)$/g,''))+') vs <b class="num">'+fmt(B[k],k)+'</b> in the baseline ('+esc(bl.replace(/^[^(]*\(|\)$/g,''))+'), a change of <b class="num">'+sp(ch)+'</b>. '+O.n.toLocaleString()+' reps in the observation window, '+B.n.toLocaleString()+' in the baseline.';
  renderMix();renderSenior();
}
function renderMix(){
  if($('#mixBlock').classList.contains('hidden'))return;
  var mask=popMask($('#leadPop').value),w=leadWindows(),bw=w[0],ow=w[1],P=palette();
  var keys=mixKind==='meetings'?[['meeting_count','All meetings'],['in_person_meeting_count','In person'],['conference_call_count','Conference calls']]:[['sent_email_count','Sent'],['received_email_count','Received']];
  keys=keys.filter(function(p){return mat(p[0]);});
  plot('mixChart',keys.map(function(p,i){return {type:'scatter',mode:'lines',name:p[1],x:MON.map(function(m,j){return j;}),y:monthly(mask,p[0]),line:{color:P[i],width:i===0?2.6:2,dash:i===0?'solid':'dot'},customdata:MON.map(mlab),hovertemplate:'%{customdata}<br>'+esc(p[1])+': %{y:.2f}<extra></extra>'};}),
    base({shapes:bands(bw,ow),xaxis:monthAxis(),hovermode:'x unified'}));
  var O=winAvg(mask,ow,keys.map(function(p){return p[0];})),B=winAvg(mask,bw,keys.map(function(p){return p[0];}));
  var note='';if(mixKind==='meetings'&&keys.length>1&&O.meeting_count){note=keys.slice(1).map(function(p){return esc(p[1])+' are <b class="num">'+p1(O[p[0]]/O.meeting_count*100)+'</b> of meetings in the observation window vs <b class="num">'+p1(B[p[0]]/B.meeting_count*100)+'</b> in the baseline.';}).join(' ');}
  else if(mixKind==='emails'&&O.sent_email_count&&O.received_email_count){note='Reps send <b class="num">'+fmt(O.sent_email_count,'x')+'</b> emails per month for every <b class="num">'+fmt(O.received_email_count,'x')+'</b> received in the observation window ('+(O.sent_email_count/O.received_email_count).toFixed(2)+' sent per received, vs '+(B.received_email_count?(B.sent_email_count/B.received_email_count).toFixed(2):'–')+' in the baseline).';}
  $('#mixNote').innerHTML=note||'Monthly averages per rep for the same reps and windows as the tiles above.';
}
function renderSenior(){
  if($('#seniorBlock').classList.contains('hidden'))return;
  var mask=popMask($('#leadPop').value),w=leadWindows(),bw=w[0],ow=w[1],ly=shift12(ow);
  var keys=[['director_meeting_count','Director'],['vp_meeting_count','VP'],['executive_meeting_count','Executive']].filter(function(p){return mat(p[0]);});
  var periods=[];if(ly.length&&ly.join()!==bw.join())periods.push(['A year earlier ('+wl(ly)+')',ly,css('--rule-strong')]);periods.push(['Baseline ('+wl(bw)+')',bw,css('--d3')]);periods.push(['Observation ('+wl(ow)+')',ow,css('--d1')]);
  plot('seniorChart',periods.map(function(p){var a=winAvg(mask,p[1],keys.map(function(k){return k[0];}));return {type:'bar',name:p[0],x:keys.map(function(k){return k[1];}),y:keys.map(function(k){return a[k[0]];}),marker:{color:p[2]},hovertemplate:'%{x}: %{y:.2f} per rep per month<extra>'+esc(p[0])+'</extra>'};}),
    base({barmode:'group',xaxis:xcat()}));
}

/* ---------- adoption impact ---------- */
var cohortView=CFG.cohort==='users'?'users':'tiers', cohortWin='obs', rosterTier='All', rosterSort={k:'ev',dir:-1}, trendMetric=MK.indexOf('dir_vp_exec')>=0?'dir_vp_exec':MK[0];
var cohortsOf=function(v){return v==='users'?['User','Non-user']:['High','Medium','Low'];};
var cohortName=function(c){return c==='User'?'Backstory users':c==='Non-user'?'Non-users':c+' adopters';};
function cohortWindows(){return cohortWin==='l12'?[L12,P12,'last 12 months']:[OBS,BASE,'observation window'];}
function setupAdoption(){
  segSet('#cohortView',cohortView);
  segBind('#cohortView',function(v){cohortView=v;rosterTier='All';renderAdoption();});
  segBind('#cohortWin',function(v){cohortWin=v;renderAdoption();});
  $('#trendMetric').innerHTML=MK.map(function(k){return '<option value="'+k+'"'+(k===trendMetric?' selected':'')+'>'+esc(LAB[k])+'</option>';}).join('');
  $('#trendMetric').onchange=function(){trendMetric=$('#trendMetric').value;renderCohortTrend();};
  $('#rosterQ').addEventListener('input',renderRoster);
  if(!HAS.roster)$('#rosterBlock').classList.add('hidden');
}
function renderAdoption(){
  var C=cohortsOf(cohortView),cw=cohortWindows(),A={},Bs={},P=palette();
  C.forEach(function(c){A[c]=winAvg(popMask(c),cw[0]);Bs[c]=winAvg(popMask(c),cw[1]);});
  var nT={High:0,Medium:0,Low:0};U.users.forEach(function(u){if(u.t&&roleOK(u))nT[u.t]++;});var nUser=U.users.filter(function(u){return u.f==='User'&&roleOK(u);}).length,nAll=U.users.filter(roleOK).length;
  $('#adoptIntro').innerHTML=cohortView==='tiers'
    ?U.nUsage+' reps appear in both the activity extract and the usage file. They are split into equal thirds by usage score: high (more than '+U.tierCuts[1]+', '+nT.High+' reps), medium ('+(U.tierCuts[0]+1)+'–'+U.tierCuts[1]+', '+nT.Medium+') and low ('+U.tierCuts[0]+' or fewer, '+nT.Low+').'
    :'Users are the '+nUser+' reps with usage above the bottom 5%. Non-users are the '+(nAll-nUser).toLocaleString()+' other reps in the activity extract: no usage at all, or the '+U.nBottom+' lowest-usage reps.';
  var top=C[0],bot=C[C.length-1],kk=['meeting_count','dir_vp_exec','people_engaged','pipeline_created'].filter(function(k){return MK.indexOf(k)>=0;});
  $('#cohortKpis').innerHTML=kk.map(function(k){var c=pct(A[top][k],A[bot][k]);return '<div class="tile"><div class="k">'+esc(LAB[k])+' · '+esc(cohortName(top).toLowerCase())+'</div><div class="v">'+fmt(A[top][k],k)+'</div><div class="d '+(isNaN(c)?'':c>=0?'up':'down')+'">'+sp(c)+' vs '+esc(cohortName(bot).toLowerCase())+' ('+fmt(A[bot][k],k)+')</div></div>';}).join('');
  if(cohortView==='tiers'){
    $('#adoptIndexTitle').textContent='Activity indexed to low adopters';$('#adoptIndexSub').textContent='Low adopters = 100. Bars above 100 mean more activity per rep per month, '+cw[2]+'.';
    plot('adoptIndex',['High','Medium'].map(function(t,i){return {type:'bar',name:t+' adopters',x:MK.map(function(k){return LAB[k];}),y:MK.map(function(k){return A[t][k]/A.Low[k]*100;}),marker:{color:i?css('--d2'):css('--d1')},
      customdata:MK.map(function(k){return [fmt(A[t][k],k),fmt(A.Low[k],k)];}),hovertemplate:'%{x}<br>'+t+': %{customdata[0]} vs Low: %{customdata[1]}<br>Index %{y:.0f}<extra></extra>'};}),
      base({barmode:'group',shapes:[{type:'line',xref:'paper',x0:0,x1:1,y0:100,y1:100,line:{color:css('--text3'),width:1.5,dash:'dash'}}],
        annotations:[{xref:'paper',x:1,y:100,text:'Low = 100',showarrow:false,xanchor:'right',yanchor:'bottom',font:{family:'Chivo Mono, monospace',size:11,color:css('--text3')}}],
        xaxis:{tickangle:0,automargin:true,gridcolor:'rgba(0,0,0,0)',tickfont:{size:11}},margin:{l:48,r:10,t:14,b:80}}));
    $('#adoptNote').innerHTML=paras(N.notes.adopt)||'<p class="muted">—</p>';
  } else {
    var lifts=MK.map(function(k){return pct(A.User[k],A['Non-user'][k]);});
    $('#adoptIndexTitle').textContent='How much more users do, per rep per month';$('#adoptIndexSub').textContent='Percent difference, users vs non-users, '+cw[2]+'.';
    plot('adoptIndex',[{type:'bar',orientation:'h',y:MK.map(function(k){return LAB[k];}),x:lifts,marker:{color:lifts.map(function(v){return v>=0?css('--d1'):css('--neg');})},
      text:lifts.map(sp),textposition:'outside',cliponaxis:false,textfont:{family:'Chivo Mono, monospace',size:12,color:css('--text')},
      customdata:MK.map(function(k){return [fmt(A.User[k],k),fmt(A['Non-user'][k],k)];}),hovertemplate:'%{y}<br>Users %{customdata[0]} vs non-users %{customdata[1]}<extra></extra>'}],
      base({margin:{l:200,r:60,t:10,b:36},yaxis:{autorange:'reversed',automargin:true,tickfont:{size:13}},xaxis:{ticksuffix:'%',zeroline:true,zerolinecolor:css('--rule-strong'),gridcolor:css('--rule'),tickfont:{family:'Chivo Mono, monospace',size:11}},showlegend:false}));
    $('#adoptNote').innerHTML=paras(N.notes.users)||'<p class="muted">—</p>';
  }
  var sk=[['director_meeting_count','Director'],['vp_meeting_count','VP'],['executive_meeting_count','Executive']].filter(function(p){return mat(p[0]);});
  plot('cohortSenior',sk.map(function(p,i){return {type:'bar',name:p[1],x:C.map(cohortName),y:C.map(function(c){return winAvg(popMask(c),cw[0],[p[0]])[p[0]];}),marker:{color:P[i]},hovertemplate:'%{x}<br>'+p[1]+': %{y:.2f}<extra></extra>'};}),base({barmode:'group',margin:{l:40,r:8,t:10,b:60},xaxis:xcat()}));
  if(MK.indexOf('pipeline_created')>=0)plot('cohortPipeline',[{type:'bar',x:C.map(cohortName),y:C.map(function(c){return A[c].pipeline_created;}),marker:{color:C.map(function(c,i){return P[i];})},text:C.map(function(c){return money(A[c].pipeline_created);}),textposition:'outside',cliponaxis:false,textfont:{family:'Chivo Mono, monospace',size:11,color:css('--text')},hovertemplate:'%{x}<br>%{y:$,.0f}<extra></extra>'}],base({showlegend:false,margin:{l:48,r:8,t:18,b:60},xaxis:xcat(),yaxis:{tickformat:'$.2s',gridcolor:css('--rule'),rangemode:'tozero',tickfont:{family:'Chivo Mono, monospace',size:11}}}));
  else $('[data-section="cohortPipeline"]').classList.add('hidden');
  var groups=cohortView==='tiers'?['High','Medium','Low','No usage']:['User','Non-user'];
  var counts=groups.map(function(g){return U.users.filter(function(u){if(!roleOK(u))return false;if(g==='No usage')return !u.t;if(g==='User'||g==='Non-user')return u.f===g;return u.t===g;}).length;});
  var donut=plot('cohortDonut',[{type:'pie',hole:.58,labels:groups.map(function(g){return g==='No usage'?'No usage data':cohortName(g);}),values:counts,customdata:groups,marker:{colors:[P[0],P[1],P[2],css('--rule-strong')]},textinfo:'value',textfont:{family:'Chivo Mono, monospace',size:12},hovertemplate:'%{label}: %{value} reps (%{percent})<extra></extra>',sort:false}],base({showlegend:true,legend:{orientation:'h',y:-0.1,font:{size:12,color:css('--text2')}},margin:{l:8,r:8,t:8,b:8}}));
  if(donut&&donut.on&&!donut._roiBound){donut._roiBound=true;donut.on('plotly_click',function(e){var g=e.points&&e.points[0]&&e.points[0].customdata;if(g==null)return;rosterTier=Array.isArray(g)?g[0]:g;renderRoster();var rb=$('#rosterBlock');if(rb)rb.scrollIntoView({behavior:'smooth',block:'start'});});}
  renderCohortTrend();
  $('#cohortTblSub').textContent='Averages per rep per month in the '+cw[2]+'; change against each cohort\'s own '+(cohortWin==='l12'?'prior 12 months ('+wl(P12)+')':'baseline ('+wl(BASE)+')')+'.';
  $('#cohortTbl').innerHTML='<thead><tr><th>Metric</th>'+C.map(function(c){return '<th>'+esc(cohortName(c))+'</th><th>Change</th>';}).join('')+'</tr></thead><tbody>'+
    MK.map(function(k){return '<tr><td>'+esc(LAB[k])+'</td>'+C.map(function(c){var ch=pct(A[c][k],Bs[c][k]);return '<td>'+fmt(A[c][k],k)+'</td><td class="'+(isNaN(ch)?'':ch>=0?'up':'down')+'">'+sp(ch)+'</td>';}).join('')+'</tr>';}).join('')+
    '<tr><td>Reps</td>'+C.map(function(c){return '<td>'+A[c].n.toLocaleString()+'</td><td></td>';}).join('')+'</tr></tbody>';
  renderRoster();
}
function renderCohortTrend(){
  var C=cohortsOf(cohortView),P=palette(),k=trendMetric;
  plot('usersTrend',C.map(function(c,i){return {type:'scatter',mode:'lines',name:cohortName(c),x:MON.map(mlab),y:monthly(popMask(c),k),line:{color:i===C.length-1?css('--text3'):P[i],width:2.4,dash:i===C.length-1?'dot':'solid'}};}),
    base({hovermode:'x unified',xaxis:{gridcolor:'rgba(0,0,0,0)',nticks:8,linecolor:css('--rule-strong'),tickfont:{family:'Chivo Mono, monospace',size:11}},yaxis:{gridcolor:css('--rule'),rangemode:'tozero',tickformat:isMoney(k)?'$.2s':'',tickfont:{family:'Chivo Mono, monospace',size:11}}}));
}
var ROSTER_COLS=[['n','Name'],['tier','Cohort'],['r','Role'],['ti','Team or title'],['ev','Usage score'],['a','Account views'],['o','Opportunity views'],['meeting_count','Meetings'],['vp_meeting_count','VP meetings'],['executive_meeting_count','Exec meetings'],['pipeline_created','Pipeline created'],['last','Last active']];
var rosterRows=null;
function buildRoster(){rosterRows=U.users.map(function(u,i){var row={i:i,n:u.n||'',r:u.r||'Other',ti:u.ti||u.g||'',t:u.t,f:u.f,ev:u.u?u.u.ev:null,a:u.u?u.u.a:null,o:u.u?u.u.o:null,last:u.u?u.u.last:null};
  ['meeting_count','vp_meeting_count','executive_meeting_count','pipeline_created'].forEach(function(k){row[k]=userAvg(i,k,OBS);});return row;});}
function renderRoster(){
  if(!HAS.roster)return;if(!rosterRows)buildRoster();
  var tiers=cohortView==='users'?['All','User','Non-user']:['All','High','Medium','Low','No usage'];if(tiers.indexOf(rosterTier)<0)rosterTier='All';
  $('#rosterTier').innerHTML=tiers.map(function(t){return '<button type="button" aria-pressed="'+(t===rosterTier)+'" data-v="'+t+'">'+esc(t==='All'?'All':t==='No usage'?'No usage data':cohortName(t))+'</button>';}).join('');
  $$('#rosterTier button').forEach(function(b){b.onclick=function(){rosterTier=b.getAttribute('data-v');renderRoster();};});
  var q=($('#rosterQ').value||'').toLowerCase();
  var rows=rosterRows.filter(function(r){var u=U.users[r.i];if(!roleOK(u))return false;
    if(rosterTier!=='All'){if(rosterTier==='No usage'){if(r.t)return false;}else if(rosterTier==='User'||rosterTier==='Non-user'){if(r.f!==rosterTier)return false;}else if(r.t!==rosterTier)return false;}
    return !q||(r.n+' '+r.ti+' '+r.r).toLowerCase().indexOf(q)>=0;});
  var k=rosterSort.k,dir=rosterSort.dir;rows.sort(function(a,b){var va=k==='tier'?(a.t||a.f||''):a[k],vb=k==='tier'?(b.t||b.f||''):b[k];if(va==null&&vb==null)return 0;if(va==null)return 1;if(vb==null)return -1;return (typeof va==='string'?va.localeCompare(vb):va-vb)*dir;});
  $('#rosterSub').textContent=rosterRows.length.toLocaleString()+' reps · activity columns are per-month averages in the observation window ('+wl(OBS)+')';
  $('#rosterTbl').innerHTML='<thead><tr>'+ROSTER_COLS.map(function(c){return '<th><button type="button" data-k="'+c[0]+'">'+esc(c[1])+(rosterSort.k===c[0]?(rosterSort.dir<0?' ↓':' ↑'):'')+'</button></th>';}).join('')+'</tr></thead><tbody>'+
    rows.slice(0,250).map(function(r){return '<tr><td>'+esc(r.n||'—')+'</td><td class="txt"><span class="badge">'+esc(r.t||(r.f==='User'?'User':r.f?'Non-user':'—'))+'</span></td><td class="txt">'+esc(r.r)+'</td><td class="txt">'+esc(r.ti)+'</td><td>'+n0(r.ev)+'</td><td>'+n0(r.a)+'</td><td>'+n0(r.o)+'</td><td>'+fmt(r.meeting_count,'x')+'</td><td>'+fmt(r.vp_meeting_count,'x')+'</td><td>'+fmt(r.executive_meeting_count,'x')+'</td><td>'+money(r.pipeline_created)+'</td><td>'+esc(r.last||'—')+'</td></tr>';}).join('')+'</tbody>';
  $$('#rosterTbl th button').forEach(function(b){b.onclick=function(){var kk=b.getAttribute('data-k');rosterSort={k:kk,dir:rosterSort.k===kk?-rosterSort.dir:-1};renderRoster();};});
  $('#rosterCount').textContent='Showing '+Math.min(250,rows.length).toLocaleString()+' of '+rows.length.toLocaleString()+' reps';
}

/* ---------- deal intelligence ---------- */
var dealView='levels', dealMode='overall', dealSub='eng', heatMode='won', stageView='share', persView='wr';
function setupDeals(){
  segBind('#dealSub',function(v){dealSub=v;$('#dealEng').classList.toggle('hidden',v!=='eng');$('#dealStage').classList.toggle('hidden',v!=='stage');renderDeals();});
  segBind('#dealView',function(v){dealView=v;renderDeals();});
  segBind('#dealMode',function(v){dealMode=v;renderDeals();});
  $('#dealIncl').onchange=renderDeals;
  if(!HAS.vel){$('#dealInclWrap').classList.add('hidden');$('#dealVelBlock').classList.add('hidden');}
  if(!D)$('#dealModeWrap').classList.add('hidden');
  if(!HAS.OPP&&!HAS.D){$('#dealSub').classList.add('hidden');dealSub='stage';$('#dealEng').classList.add('hidden');$('#dealStage').classList.remove('hidden');}
  if(!HAS.ST)$('#dealSub').classList.add('hidden');
  segBind('#heatMode',function(v){heatMode=v;renderHeat();});
  segBind('#stageView',function(v){stageView=v;renderStageProf();});
  segBind('#persView',function(v){persView=v;renderPers();});
}
function renderDeals(){if(dealSub==='eng')renderDealEng();else renderStage();}
function fyOfDeal(i){return D.m[i]>=0?fp(D.months[D.m[i]]).fy:null;}
function renderDealEng(){
  var g=currentDeals();var P=palette();
  if(!g){$('#dealDyn').innerHTML='<span>Fewer than 20 deals match these filters. Clear a filter to see the engagement views.</span>';$('#dealKpis').innerHTML='';['dealWin','dealVel','dealVol'].forEach(function(id){var el=document.getElementById(id);if(el&&window.Plotly)Plotly.purge(el);});$('#dealYoy').innerHTML='';return;}
  var hi=lvl(g,'High'),lo=lvl(g,'Low'),mid=lvl(g,'Medium');
  var tiles=[];
  if(hi)tiles.push(['High-engagement win rate',p1(hi.win_rate),n0(hi.n)+' deals']);
  if(lo)tiles.push(['Low-engagement win rate',p1(lo.win_rate),n0(lo.n)+' deals']);
  if(hi&&lo&&lo.win_rate)tiles.push(['Win rate lift, high vs low',(hi.win_rate/lo.win_rate).toFixed(1)+'×',(hi.win_rate-lo.win_rate).toFixed(1)+' pts']);
  if(HAS.vel&&hi&&lo&&hi.med_days_won!=null&&lo.med_days_won!=null)tiles.push(['Days to close, won · high vs low',hi.med_days_won+' vs '+lo.med_days_won,(lo.med_days_won-hi.med_days_won>=0?(lo.med_days_won-hi.med_days_won).toFixed(0)+' days faster':(hi.med_days_won-lo.med_days_won).toFixed(0)+' days slower')]);
  tiles.push(['Deals analysed',n0(g.n),'win rate '+p1(g.win_rate)+(g.r_win!=null?' · r = '+g.r_win:'')]);
  $('#dealKpis').innerHTML=tiles.map(function(t){return '<div class="tile"><div class="k">'+esc(t[0])+'</div><div class="v">'+esc(t[1])+'</div><div class="d">'+esc(t[2])+'</div></div>';}).join('');
  var dc=g.deciles,top=dc[dc.length-1],bot=dc[0],s='<b>'+n0(g.n)+'</b> deals'+($('#dealIncl').checked?' including transactional':'')+'.';
  if(top&&bot&&bot.win_rate)s+=' Top decile wins <b class="num">'+top.win_rate.toFixed(1)+'%</b> vs <b class="num">'+bot.win_rate.toFixed(1)+'%</b> for the bottom (<b class="num">'+(top.win_rate/bot.win_rate).toFixed(1)+'×</b>'+(g.r_win!=null?', decile correlation r = '+g.r_win:'')+').';
  if(hi&&lo&&hi.win_rate!=null&&lo.win_rate!=null)s+=' High-engagement deals win <b class="num">'+hi.win_rate.toFixed(1)+'%</b> vs <b class="num">'+lo.win_rate.toFixed(1)+'%</b> for low.';
  $('#dealDyn').innerHTML=s;
  renderDealYoy();
  var mode=D?dealMode:'overall';
  $('#dealWinNote').innerHTML=paras(mode==='overall'?N.notes.dealWin:(N.notes.dealTrend||N.notes.dealWin))||'<p class="muted">—</p>';
  $('#dealVolBlock').classList.toggle('hidden',mode==='overall');
  if(mode==='overall'){
    var rows=g[dealView],x=dealView==='deciles'?rows.map(function(r){return 'D'+r.dec;}):rows.map(function(r){return r.level;});
    var colr=dealView==='deciles'?rows.map(function(r,i){return i>=rows.length-3?css('--d1'):css('--rule-strong');}):rows.map(function(r){return r.level.indexOf('High')===0?css('--d1'):r.level.indexOf('Medium')===0?css('--d2'):css('--rule-strong');});
    $('#dealWinTitle').textContent='Win rate';$('#dealWinSub').textContent='Bars show win rate; hover for deal counts and score range.';
    plot('dealWin',[{type:'bar',x:x,y:rows.map(function(r){return r.win_rate;}),marker:{color:colr},text:rows.map(function(r){return r.win_rate==null?'–':r.win_rate.toFixed(1)+'%';}),textposition:'outside',cliponaxis:false,
      textfont:{family:'Chivo Mono, monospace',size:12,color:css('--text')},customdata:rows.map(function(r){return [r.n.toLocaleString(),(+r.lo).toFixed(0),(+r.hi).toFixed(0)];}),hovertemplate:'%{x}<br>Win rate %{y:.1f}%<br>%{customdata[0]} deals<br>Score %{customdata[1]}–%{customdata[2]}<extra></extra>'},
      {type:'scatter',mode:'lines',x:x,y:rows.map(function(){return g.win_rate;}),line:{color:css('--text3'),dash:'dash',width:1.5},hoverinfo:'skip'}],
      base({showlegend:false,yaxis:ypct(),xaxis:xcat(),annotations:[{xref:'paper',x:1,y:g.win_rate,text:'Overall '+g.win_rate+'%',showarrow:false,xanchor:'right',yanchor:'bottom',font:{family:'Chivo Mono, monospace',size:11,color:css('--text3')}}]}));
    if(HAS.vel){$('#dealVelTitle').textContent='Deal velocity';$('#dealVelSub').textContent='Median days from creation to close, for won and lost deals.';
      plot('dealVel',[{type:'bar',name:'Won deals',x:x,y:rows.map(function(r){return r.med_days_won;}),marker:{color:css('--d1')},hovertemplate:'%{x}<br>Won: %{y} days median<extra></extra>'},
        {type:'bar',name:'Lost deals',x:x,y:rows.map(function(r){return r.med_days_lost;}),marker:{color:css('--d3')},hovertemplate:'%{x}<br>Lost: %{y} days median<extra></extra>'}],
        base({barmode:'group',yaxis:{title:{text:'Median days',font:{size:12}},gridcolor:css('--rule'),tickfont:{family:'Chivo Mono, monospace',size:11}},xaxis:xcat()}));}
    return;
  }
  var ix=dealIdx(),lvColors=[css('--rule-strong'),css('--d2'),css('--d1')];
  if(mode==='monthly'){
    var months=D.months.map(function(m,mi){return mi;}).filter(function(mi){return monthOK(D.months[mi]);});
    var cell=months.map(function(){return [[],[],[]];});var pos={};months.forEach(function(mi,k){pos[mi]=k;});
    ix.forEach(function(i){if(D.m[i]<0||pos[D.m[i]]==null)return;cell[pos[D.m[i]]][levelOf(D.s[i])].push(i);});
    var xm=months.map(function(mi){return mlab(D.months[mi]);});
    $('#dealWinTitle').textContent='Win rate by close month';$('#dealWinSub').textContent='Each line is an engagement level; months with fewer than five deals at a level are left blank.';
    plot('dealWin',LEVELS.map(function(L,li){return {type:'scatter',mode:'lines+markers',name:L,x:xm,y:cell.map(function(c){var b=c[li];if(b.length<5)return null;var w=0;b.forEach(function(i){w+=D.w[i];});return w/b.length*100;}),customdata:cell.map(function(c){return c[li].length;}),line:{color:lvColors[li],width:2.4},hovertemplate:'%{x}<br>'+L+': %{y:.1f}% (%{customdata} deals)<extra></extra>'};}),base({yaxis:ypct(),xaxis:xcat({nticks:12}),hovermode:'x unified'}));
    if(HAS.vel){$('#dealVelTitle').textContent='Days to close by close month';$('#dealVelSub').textContent='Median days from creation to close for won deals, by engagement level.';
      plot('dealVel',LEVELS.map(function(L,li){return {type:'scatter',mode:'lines',name:L,x:xm,y:cell.map(function(c){var d=c[li].filter(function(i){return D.w[i]&&D.d[i]>=0;}).map(function(i){return D.d[i];});return d.length>=5?median(d):null;}),line:{color:lvColors[li],width:2.2}};}),base({xaxis:xcat({nticks:12}),yaxis:{title:{text:'Median days (won)',font:{size:12}},gridcolor:css('--rule'),rangemode:'tozero',tickfont:{family:'Chivo Mono, monospace',size:11}},hovermode:'x unified'}));}
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
    plot('dealVel',fys.map(function(f,k){var gg=groups[k];return {type:'bar',name:f,x:LEVELS,y:LEVELS.map(function(L){var r=gg&&gg.levels.filter(function(x){return x.level===L;})[0];return r?r.med_days_won:null;}),marker:{color:fyColors[k%fyColors.length]}};}),base({barmode:'group',xaxis:xcat(),yaxis:{title:{text:'Median days (won)',font:{size:12}},gridcolor:css('--rule'),tickfont:{family:'Chivo Mono, monospace',size:11}}}));}
  $('#dealVolSub').textContent='Closed deals per fiscal year, stacked by engagement level.';
  plot('dealVol',LEVELS.map(function(L,li){return {type:'bar',name:L,x:fys,y:fys.map(function(f){return byFy[f].filter(function(i){return levelOf(D.s[i])===li;}).length;}),marker:{color:lvColors[li]}};}),base({barmode:'stack',xaxis:xcat()}));
}
function monthsInFy(f){if(!D)return 0;return D.months.filter(function(m){return fp(m).fy===f;}).length;}
function trendWord(vals){var a=vals.filter(function(v){return v!=null;});if(a.length<2)return 'steady';var d=a[a.length-1]-a[0];return Math.abs(d)<3?'steady':d>0?'rising':'falling';}
function renderDealYoy(){
  var el=$('#dealYoy');if(!D){el.innerHTML='';return;}
  var ix=dealIdx({ignoreMonth:true}),by={};ix.forEach(function(i){var f=fyOfDeal(i);if(!f)return;(by[f]=by[f]||[]).push(i);});
  var fys=Object.keys(by).sort().filter(function(f){return by[f].length>=20;});if(fys.length<2){el.innerHTML='';return;}
  var G=fys.map(function(f){return dealGroup(by[f]);}),a=fys.length-2,b=fys.length-1,partial=monthsInFy(fys[b])<12?' (partial year)':'';
  var L=function(g,p){return g?g.levels.filter(function(r){return r.level.indexOf(p)===0;})[0]:null;};
  var cards=[];
  var ha=L(G[a],'High'),hb=L(G[b],'High');
  if(ha&&hb){var ma=monthsInFy(fys[a])||12,mb=monthsInFy(fys[b])||12,ra=ha.n/ma,rb=hb.n/mb,ch=pct(rb,ra);
    cards.push([ch>=0?'pos':'neg','High-engagement volume',partial?Math.round(ra)+' → '+Math.round(rb)+' a month':n0(ha.n)+' → '+n0(hb.n)+' deals',
      partial?n0(ha.n)+' high-engagement deals closed in '+fys[a]+' ('+Math.round(ra)+' a month) and '+n0(hb.n)+' so far in '+fys[b]+' over '+mb+' months ('+Math.round(rb)+' a month, '+sp(ch)+'), at '+p1(ha.win_rate)+' and '+p1(hb.win_rate)+' win rates.'
        :'High-engagement deals went from '+n0(ha.n)+' in '+fys[a]+' to '+n0(hb.n)+' in '+fys[b]+' ('+sp(ch)+'), at '+p1(ha.win_rate)+' and '+p1(hb.win_rate)+' win rates.']);}
  var mids=G.map(function(g){var r=L(g,'Medium');return r?r.win_rate:null;}),mw=trendWord(mids);cards.push([mw==='falling'?'neg':mw==='rising'?'pos':'','Medium-engagement win rate',mids.map(p1).join(' → '),mw==='steady'?'Steady across '+fys.join(', ')+': the middle band is a predictable outcome range year to year.':'Medium-engagement deals are '+mw+' across '+fys.join(', ')+'.']);
  var lows=G.map(function(g){var r=L(g,'Low');return r?r.win_rate:null;}),lw=trendWord(lows);cards.push([lw==='falling'?'neg':lw==='rising'?'pos':'','Low-engagement win rate',lows.map(p1).join(' → '),'Low-engagement deals are '+lw+' across '+fys.join(', ')+(lw==='falling'?' — the gap between engaged and disengaged deals is widening.':'.')]);
  if(HAS.vel&&ha&&hb&&ha.med_days_won!=null&&hb.med_days_won!=null){var dd=ha.med_days_won-hb.med_days_won;cards.push([Math.abs(dd)<1?'':dd>0?'pos':'neg','High-engagement velocity',ha.med_days_won+'d → '+hb.med_days_won+'d',Math.abs(dd)<1?'Won high-engagement deals closed in the same median time in '+fys[b]+partial+' as in '+fys[a]+'.':'Won high-engagement deals closed '+Math.abs(dd).toFixed(0)+' days '+(dd>0?'faster':'slower')+' (median) in '+fys[b]+partial+' than in '+fys[a]+'.']);}
  el.innerHTML='<div class="yoy-title">Year over year · '+esc(fys[a])+' → '+esc(fys[b])+'</div>'+cards.map(function(c){return '<div class="'+c[0]+'"><h4>'+esc(c[1])+'</h4><div class="s">'+esc(c[2])+'</div><p>'+esc(c[3])+'</p></div>';}).join('');
}

/* ---------- stage and persona ---------- */
var stageNames=function(){return ST.stages.map(function(s){return s.stage;});};
function cellsOK(ignoreMonth){return (ST.cells||[]).filter(function(c){var t=(ST.cellTypes||[])[c[2]]||'';if(!typeOK(t))return false;if(ignoreMonth)return true;return monthOK(c[3]>=0?(ST.cellMonths||[])[c[3]]:null);});}
function aggCells(cells){var S=stageNames().map(function(){return {won:0,lost:0,wa:new Array(NP).fill(0),la:new Array(NP).fill(0),ww:new Array(NP).fill(0),aw:new Array(NP).fill(0),acts:0};});
  cells.forEach(function(c){var a=S[c[0]];if(!a)return;var n=c[4];if(c[1])a.won+=n;else a.lost+=n;a.acts+=c[5];for(var k=0;k<NP;k++){if(c[1]){a.wa[k]+=c[6+k];a.ww[k]+=c[6+NP+k];}else a.la[k]+=c[6+k];a.aw[k]+=c[6+NP+k];}});return S;}
function cellFy(c){return c[3]>=0?fp((ST.cellMonths||[])[c[3]]).fy:null;}
function renderStage(){
  if(!HAS.ST)return;
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
  var names=stageNames(),z,txt,scale=[[0,css('--page')],[1,css('--horizon')]],zmid=null,hover,sub;
  if(heatMode==='share'||!HAS.cells){
    if(!HAS.cells){segSet('#heatMode','share');$$('#heatMode button').forEach(function(b){if(b.getAttribute('data-v')!=='share')b.classList.add('hidden');});}
    z=PK.map(function(p){return ST.stages.map(function(s){return (s.persona_pct||{})[p]||0;});});txt=z.map(function(r){return r.map(function(v){return v.toFixed(0)+'%';});});hover='%{y} at %{x}<br>%{z:.1f}% of activities<extra></extra>';sub='Share of activities at each stage that include each persona (a single activity can include several). All closed non-renewal deals; the filters do not apply to this view.';$('#heatTitle').textContent='Persona mix by stage';
  } else {
    var S=aggCells(cellsOK());$('#heatTitle').textContent='Stage × persona';
    if(heatMode==='won'||heatMode==='lost'){var won=heatMode==='won';z=PK.map(function(p,k){return S.map(function(a){var n=won?a.won:a.lost;return n?(won?a.wa[k]:a.la[k])/n:null;});});hover='%{y} at %{x}<br>%{z:.2f} activities per '+(won?'won':'lost')+' deal<extra></extra>';sub='Average activities with each persona per '+(won?'won':'lost')+' deal at each stage. Darker means more engagement.';}
    else if(heatMode==='diff'){z=PK.map(function(p,k){return S.map(function(a){return (a.won&&a.lost)?a.wa[k]/a.won-a.la[k]/a.lost:null;});});scale=[[0,css('--neg')],[.5,css('--page')],[1,css('--pos')]];zmid=0;hover='%{y} at %{x}<br>%{z:+.2f} activities per deal, won minus lost<extra></extra>';sub='Won-deal average minus lost-deal average. Green: winners had more of this persona at this stage.';}
    else {z=PK.map(function(p,k){return S.map(function(a){return a.aw[k]>=5?a.ww[k]/a.aw[k]*100:null;});});hover='%{y} at %{x}<br>%{z:.1f}% of deals with this persona here were won<extra></extra>';sub='Of the deals with each persona engaged at each stage, the share won (blank under five deals). Post-decision stages are shown for completeness: activity there follows the outcome.';}
    txt=z.map(function(r){return r.map(function(v){return v==null?'':heatMode==='wr'?v.toFixed(0)+'%':heatMode==='diff'?(v>=0?'+':'')+v.toFixed(1):v.toFixed(1);});});
  }
  $('#heatSub').textContent=sub;
  var tr={type:'heatmap',x:names,y:PK,z:z,colorscale:scale,text:txt,texttemplate:'%{text}',textfont:{family:'Chivo Mono, monospace',size:11,color:css('--text')},hovertemplate:hover,showscale:false,xgap:2,ygap:2,hoverongaps:false};if(zmid!=null)tr.zmid=zmid;
  plot('stageHeat',[tr],base({margin:{l:190,r:10,t:10,b:70},xaxis:{side:'bottom',tickfont:{size:11},gridcolor:'rgba(0,0,0,0)'},yaxis:{autorange:'reversed',tickfont:{size:12},gridcolor:'rgba(0,0,0,0)'}}));
}
function renderStageWin(){
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
  var S=ST.stages,x=S.map(function(s){return s.stage;}),post=S.map(function(s){return (ST.postStages||[]).indexOf(s.stage)>=0;}),data,lay,P=palette(),sub='';
  if(stageView==='share'){
    data=[{type:'bar',name:'Share of all activity',x:x,y:S.map(function(s){return s.share;}),marker:{color:S.map(function(s,i){return post[i]?css('--rule-strong'):css('--d1');})},text:S.map(function(s){return s.share.toFixed(1)+'%';}),textposition:'outside',cliponaxis:false,textfont:{family:'Chivo Mono, monospace',size:11,color:css('--text')},
      customdata:S.map(function(s){return [s.acts.toLocaleString(),s.opps.toLocaleString()];}),hovertemplate:'%{x}<br>%{y:.1f}% of activity<br>%{customdata[0]} activities on %{customdata[1]} deals<extra></extra>'},
      {type:'scatter',mode:'lines+markers',name:'Activities with Director or above',x:x,y:S.map(function(s){return s.dir_above_pct;}),yaxis:'y2',line:{color:css('--d2'),width:2.5},marker:{size:7},hovertemplate:'%{x}<br>%{y:.1f}% include Director+<extra></extra>'}];
    lay=base({yaxis:ypct({rangemode:'normal'}),yaxis2:{overlaying:'y',side:'right',ticksuffix:'%',showgrid:false,rangemode:'tozero',tickfont:{family:'Chivo Mono, monospace',size:11}},xaxis:xcat(),margin:{l:50,r:50,t:14,b:60}});sub='All closed non-renewal deals; post-decision stages in grey.';
  } else if(stageView==='wl'){
    data=[{type:'bar',name:'Won deals',x:x,y:S.map(function(s){return s.won_acts;}),marker:{color:css('--d1')},customdata:S.map(function(s){return s.won_n;}),hovertemplate:'%{x}<br>Won: %{y} activities per deal (%{customdata} deals)<extra></extra>'},
      {type:'bar',name:'Lost deals',x:x,y:S.map(function(s){return s.lost_acts;}),marker:{color:css('--d3')},customdata:S.map(function(s){return s.lost_n;}),hovertemplate:'%{x}<br>Lost: %{y} activities per deal (%{customdata} deals)<extra></extra>'}];
    lay=base({barmode:'group',yaxis:{title:{text:'Avg activities per deal at stage',font:{size:12}},gridcolor:css('--rule'),tickfont:{family:'Chivo Mono, monospace',size:11}},xaxis:xcat(),margin:{l:56,r:20,t:14,b:60}});sub='All closed non-renewal deals.';
  } else if((stageView==='pwl'||stageView==='mixwon')&&HAS.cells){
    var A=aggCells(cellsOK()),show=['Executive','VP','Director','Finance','IT','Engineering'].map(function(p){return PK.indexOf(p);}).filter(function(k){return k>=0;});
    if(stageView==='pwl'){data=[];show.forEach(function(k,j){data.push({type:'scatter',mode:'lines',name:PK[k]+', won',x:x,y:A.map(function(a){return a.won?a.wa[k]/a.won:null;}),line:{color:P[j%P.length],width:2.4},legendgroup:PK[k]});data.push({type:'scatter',mode:'lines',name:PK[k]+', lost',x:x,y:A.map(function(a){return a.lost?a.la[k]/a.lost:null;}),line:{color:P[j%P.length],width:1.6,dash:'dash'},legendgroup:PK[k],showlegend:false});});
      lay=base({xaxis:xcat(),yaxis:{title:{text:'Avg activities per deal',font:{size:12}},gridcolor:css('--rule'),rangemode:'tozero',tickfont:{family:'Chivo Mono, monospace',size:11}},margin:{l:56,r:20,t:14,b:80}});sub='Solid lines are won deals, dashed lost. The filters above apply.';}
    else {data=show.map(function(k,j){return {type:'scatter',mode:'lines',stackgroup:'one',name:PK[k],x:x,y:A.map(function(a){return a.won?a.wa[k]/a.won:0;}),line:{color:P[j%P.length],width:1}};});
      lay=base({xaxis:xcat(),yaxis:{title:{text:'Avg activities per won deal',font:{size:12}},gridcolor:css('--rule'),tickfont:{family:'Chivo Mono, monospace',size:11}},margin:{l:56,r:20,t:14,b:80}});sub='Who is engaged at each stage of the deals that were won, stacked. The filters above apply.';}
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
    {type:'scatter',mode:'markers+text',name:'Engaged in '+ST.earlyStages.join(' / '),y:sv.map(function(s){return s.persona;}),x:sv.map(function(s){return s.wr_early;}),marker:{size:13,color:css('--d1')},text:sv.map(function(s){return (s.lift>=0?'+':'')+s.lift.toFixed(1);}),textposition:'middle right',textfont:{family:'Chivo Mono, monospace',size:12,color:css('--text')},
      customdata:sv.map(function(s){return s.n_early;}),hovertemplate:'%{y}<br>Engaged early: %{x:.1f}% (%{customdata} deals)<extra></extra>'}],
    base({shapes:sv.map(function(s){return {type:'line',x0:s.wr_no_early,x1:s.wr_early,y0:s.persona,y1:s.persona,line:{color:css('--rule-strong'),width:3},layer:'below'};}),
      margin:{l:190,r:40,t:10,b:60},xaxis:{ticksuffix:'%',range:[lo,hi],gridcolor:css('--rule'),title:{text:'Win rate of deals that reached late stage',font:{size:12}},tickfont:{family:'Chivo Mono, monospace',size:11}},yaxis:{tickfont:{size:12},gridcolor:'rgba(0,0,0,0)'}}));
}
function renderPers(){
  var Pp=(ST.personas||[]).filter(function(p){return p.wr_with!=null&&p.wr_without!=null;}).slice(),data,xa={};
  if(persView==='wr'){Pp.sort(function(a,b){return a.lift_pts-b.lift_pts;});
    data=[{type:'bar',orientation:'h',name:'Without persona',y:Pp.map(function(p){return p.persona;}),x:Pp.map(function(p){return p.wr_without;}),marker:{color:css('--rule-strong')},hovertemplate:'%{y}<br>Without: %{x:.1f}%<extra></extra>'},
      {type:'bar',orientation:'h',name:'With persona',y:Pp.map(function(p){return p.persona;}),x:Pp.map(function(p){return p.wr_with;}),marker:{color:css('--d1')},text:Pp.map(function(p){return (p.lift_pts>=0?'+':'')+p.lift_pts.toFixed(1)+' pts';}),textposition:'outside',cliponaxis:false,textfont:{family:'Chivo Mono, monospace',size:11,color:css('--text')},customdata:Pp.map(function(p){return p.prevalence;}),hovertemplate:'%{y}<br>With: %{x:.1f}%<br>Present on %{customdata}% of deals<extra></extra>'}];
    xa={ticksuffix:'%',rangemode:'tozero'};
  } else if(persView==='share'){Pp.sort(function(a,b){return a.won_share-b.won_share;});
    data=[{type:'bar',orientation:'h',name:'Share of won deals',y:Pp.map(function(p){return p.persona;}),x:Pp.map(function(p){return p.won_share;}),marker:{color:css('--d1')},text:Pp.map(function(p){return p.won_share==null?'–':p.won_share.toFixed(0)+'%';}),textposition:'outside',cliponaxis:false,textfont:{family:'Chivo Mono, monospace',size:11,color:css('--text')},hovertemplate:'%{y}<br>Engaged on %{x:.1f}% of won deals<extra></extra>'},
      {type:'bar',orientation:'h',name:'Share of all deals',y:Pp.map(function(p){return p.persona;}),x:Pp.map(function(p){return p.prevalence;}),marker:{color:css('--rule-strong')},hovertemplate:'%{y}<br>Engaged on %{x:.1f}% of all deals<extra></extra>'}];
    xa={ticksuffix:'%',rangemode:'tozero'};
  } else {Pp.sort(function(a,b){return (a.days_with||0)-(b.days_with||0);});
    data=[{type:'bar',orientation:'h',name:'Without persona',y:Pp.map(function(p){return p.persona;}),x:Pp.map(function(p){return p.days_without;}),marker:{color:css('--rule-strong')},hovertemplate:'%{y}<br>Without: %{x} days median<extra></extra>'},
      {type:'bar',orientation:'h',name:'With persona',y:Pp.map(function(p){return p.persona;}),x:Pp.map(function(p){return p.days_with;}),marker:{color:css('--d3')},customdata:Pp.map(function(p){return [money(p.amt_with),money(p.amt_without)];}),hovertemplate:'%{y}<br>With: %{x} days median<br>Median deal %{customdata[0]} vs %{customdata[1]}<extra></extra>'}];
    xa={title:{text:'Median days to close, won deals',font:{size:12}}};
  }
  plot('stagePers',data,base({barmode:'group',margin:{l:190,r:60,t:10,b:70},xaxis:Object.assign({gridcolor:css('--rule'),tickfont:{family:'Chivo Mono, monospace',size:11}},xa),yaxis:{tickfont:{size:12},gridcolor:'rgba(0,0,0,0)'}}));
  var notes=N.notes.persona||{};$('#persNote').innerHTML=md(notes[persView]||'');
}
function renderBreadth(){
  var br=ST.breadth||[];if(br.length){var best=br.reduce(function(a,b){return (b.win_rate||0)>(a.win_rate||0)?b:a;},br[0]);
  plot('stageBreadth',[{type:'bar',x:br.map(function(b){return b.k===6?'6+':String(b.k);}),y:br.map(function(b){return b.win_rate;}),marker:{color:br.map(function(b){return b.k===best.k?css('--d1'):css('--rule-strong');})},text:br.map(function(b){return b.win_rate==null?'–':b.win_rate.toFixed(0)+'%';}),textposition:'outside',cliponaxis:false,textfont:{family:'Chivo Mono, monospace',size:11,color:css('--text')},
    customdata:br.map(function(b){return [b.n.toLocaleString(),b.med_days_won==null?'–':b.med_days_won];}),hovertemplate:'%{x} personas<br>Win rate %{y:.1f}%<br>%{customdata[0]} deals, %{customdata[1]} days median (won)<extra></extra>'}],
    base({showlegend:false,yaxis:ypct(),xaxis:{title:{text:'Personas engaged',font:{size:12}},gridcolor:'rgba(0,0,0,0)'},margin:{l:44,r:10,t:14,b:48}}));}
  var eq=ST.early_q||[];if(eq.length){var bq=eq.reduce(function(a,b){return (b.win_rate||0)>(a.win_rate||0)?b:a;},eq[0]);
  plot('stageEarlyQ',[{type:'bar',x:eq.map(function(q){return q.q.replace(' lowest','').replace(' highest','');}),y:eq.map(function(q){return q.win_rate;}),marker:{color:eq.map(function(q){return q.q===bq.q?css('--d1'):css('--rule-strong');})},text:eq.map(function(q){return q.win_rate==null?'–':q.win_rate.toFixed(0)+'%';}),textposition:'outside',cliponaxis:false,textfont:{family:'Chivo Mono, monospace',size:11,color:css('--text')},
    customdata:eq.map(function(q){return [q.lo,q.hi,q.med_days_won==null?'–':q.med_days_won];}),hovertemplate:'%{x}: %{customdata[0]}–%{customdata[1]} early activities<br>Win rate %{y:.1f}%<br>%{customdata[2]} days median (won)<extra></extra>'}],
    base({showlegend:false,yaxis:ypct(),xaxis:{title:{text:'Early activity quintile (low to high)',font:{size:12}},gridcolor:'rgba(0,0,0,0)'},margin:{l:44,r:10,t:14,b:48}}));}
}

/* ---------- account engagement ---------- */
var CO=['Power Users','Frequent Browsers','Focused Diggers','Light Touch','No Engagement'];
var coColor=function(c){return css({'Power Users':'--c-power','Frequent Browsers':'--c-browser','Focused Diggers':'--c-digger','Light Touch':'--c-light','No Engagement':'--c-none'}[c]);};
var a360Lo=0,a360Hi=0,a360Sort={k:'created',dir:-1},a360TrendView='total',accSort={k:'opps',dir:-1};
function a360Accounts(lo,hi){return A360.B.accounts.map(function(a){var c=0,w=0;for(var i=lo;i<=hi;i++){c+=a.created_by_month[i]||0;w+=a.closed_won_by_month[i]||0;}return {account:a.account,cohort:a.cohort,sessions:a.unique_sessions,deep:a.deep_action_ratio,users:a.unique_users,created:c,won:w};});}
function a360Agg(lo,hi){var rows=a360Accounts(lo,hi),o={};CO.forEach(function(c){var r=rows.filter(function(a){return a.cohort===c;}),n=r.length,tc=0,tw=0;r.forEach(function(a){tc+=a.created;tw+=a.won;});o[c]={n:n,total_created:tc,total_won:tw,avg_created:n?tc/n:0,avg_won:n?tw/n:0};});return o;}
function setupAccounts(){
  if(HAS.A360){var M=A360.B.months,n=M.length;a360Hi=n-1;a360Lo=Math.max(0,n-WN);
    $('#a360Range').innerHTML='<button type="button" aria-pressed="true" data-v="cfg">Last '+WN+' months</button><button type="button" aria-pressed="false" data-v="all">All '+n+' months</button>';
    segBind('#a360Range',function(v){a360Lo=v==='all'?0:Math.max(0,n-WN);renderAccounts();});
    segBind('#a360TrendView',function(v){a360TrendView=v;renderA360Trend();});
    $('#a360Cohort').innerHTML='<option value="">All cohorts</option>'+CO.map(function(c){return '<option>'+c+'</option>';}).join('');
    $('#a360Cohort').onchange=renderA360Table;$('#a360Q').addEventListener('input',renderA360Table);
    var B=A360.B,Mt=A360.M;
    $('#a360Intro').innerHTML='How the team uses Account 360 on '+Mt.accounts.toLocaleString()+' parent accounts ('+Mt.engaged.toLocaleString()+' engaged, '+Mt.noEngagement.toLocaleString()+' with no Account 360 activity), click-stream '+esc(Mt.clickStart)+' to '+esc(Mt.clickEnd)+'. Accounts are cohorted on the medians of sessions ('+B.session_median+') and of the share of deep actions ('+(B.depth_ratio_median*100).toFixed(0)+'%).'+(Mt.excludedUsers&&Mt.excludedUsers.length?' '+Mt.excludedUsers.length+' users who browse broadly (or were named) are excluded.':'');
    var Q=[['Power Users','Many sessions and deep actions — opportunities, metrics, activities.'],['Frequent Browsers','Many sessions, mostly page views.'],['Focused Diggers','Few sessions, but deep when they come.'],['Light Touch','Few sessions, little depth.'],['No Engagement','No Account 360 activity in the window.']];
    $('#a360Quads').innerHTML=Q.map(function(q){return '<div style="--c:'+coColor(q[0])+'"><h4>'+q[0]+'</h4><p>'+q[1]+'</p></div>';}).join('');
  } else $('#a360Wrap').classList.add('hidden');
  if(HAS.ACC){$('#accQ').addEventListener('input',renderAccTable);
    var rows=ACC.accounts.filter(function(a){return a.eng!=null;}),r=rows.length>5?corr(rows.map(function(a){return a.eng;}),rows.map(function(a){return a.win_rate;})):null;
    $('#accIntro').innerHTML=ACC.nShown.toLocaleString()+' accounts with two or more closed non-renewal deals'+(ACC.nAccounts>ACC.nShown?' (the largest of '+ACC.nAccounts.toLocaleString()+')':'')+'.'+(r!=null?' Across them, average engagement and win rate correlate at <b class="num">r = '+r.toFixed(2)+'</b>.':'');
  } else $('#accDealsWrap').classList.add('hidden');
  if(!HAS.A360&&HAS.ACC)$('#accDealsWrap .section-h').classList.add('hidden');
}
function renderAccounts(){if(HAS.A360)renderA360();if(HAS.ACC){renderAccBubble();renderAccTable();}}
function renderA360(){
  var M=A360.B.months,agg=a360Agg(a360Lo,a360Hi),pw=agg['Power Users'],br=agg['Frequent Browsers'],dg=agg['Focused Diggers'],lt=agg['Light Touch'],nn=agg['No Engagement'];
  $('#a360RangeLabel').textContent=mlabL(M[a360Lo])+' – '+mlabL(M[a360Hi]);
  var tc=0,tw=0,ta=0;CO.forEach(function(c){tc+=agg[c].total_created;tw+=agg[c].total_won;ta+=agg[c].n;});
  var x=function(a,b){return b?(a/b).toFixed(1)+'×':'–';},lift=function(a,b){return b?sp((a/b-1)*100):'–';};
  var T=[['Pipeline created',money(tc),'across '+ta.toLocaleString()+' parent accounts'],['Power user accounts, avg created',money(pw.avg_created),x(pw.avg_created,nn.avg_created)+' the '+money(nn.avg_created)+' of no-engagement accounts'],
    ['Pipeline closed-won',money(tw),money(pw.total_won)+' of it on power user accounts'],['Power user accounts, avg closed-won',money(pw.avg_won),x(pw.avg_won,nn.avg_won)+' the '+money(nn.avg_won)+' of no-engagement accounts'],
    ['Depth at the same frequency',lift(pw.avg_created,br.avg_created),'power users vs frequent browsers, pipeline created'],['Depth among infrequent visitors',lift(dg.avg_created,lt.avg_created),'focused diggers vs light touch, pipeline created']];
  $('#a360Kpis').innerHTML=T.map(function(t){return '<div class="tile"><div class="k">'+esc(t[0])+'</div><div class="v">'+esc(t[1])+'</div><div class="d">'+esc(t[2])+'</div></div>';}).join('');
  plot('a360Cohorts',[{type:'bar',name:'Created',x:CO,y:CO.map(function(c){return agg[c].avg_created;}),marker:{color:CO.map(coColor)},text:CO.map(function(c){return money(agg[c].avg_created);}),textposition:'outside',cliponaxis:false,textfont:{family:'Chivo Mono, monospace',size:11,color:css('--text')},customdata:CO.map(function(c){return agg[c].n;}),hovertemplate:'%{x}<br>Created %{y:$,.0f} per account (%{customdata} accounts)<extra></extra>'},
    {type:'bar',name:'Closed-won',x:CO,y:CO.map(function(c){return agg[c].avg_won;}),marker:{color:CO.map(coColor),opacity:.45},hovertemplate:'%{x}<br>Closed-won %{y:$,.0f} per account<extra></extra>'}],
    base({barmode:'group',xaxis:xcat(),yaxis:{tickformat:'$.2s',gridcolor:css('--rule'),rangemode:'tozero',tickfont:{family:'Chivo Mono, monospace',size:11}}}));
  $('#a360Nuance').innerHTML=(pw.avg_created&&br.avg_created?'At the same visit frequency, accounts worked in depth carry <b class="num">'+lift(pw.avg_created,br.avg_created)+'</b> more created pipeline than those only browsed; among infrequent visitors the gap is <b class="num">'+lift(dg.avg_created,lt.avg_created)+'</b>. ':'')+'Solid bars are created pipeline, faint bars closed-won.';
  var rows=a360Accounts(a360Lo,a360Hi),B=A360.B;
  plot('a360Scatter',CO.map(function(c){var r=rows.filter(function(a){return a.cohort===c;});return {type:'scatter',mode:'markers',name:c,x:r.map(function(a){return Math.max(a.sessions,0.8);}),y:r.map(function(a){return Math.max(a.created+a.won,1000);}),text:r.map(function(a){return a.account;}),marker:{color:coColor(c),size:9,opacity:.8,line:{width:0}},hovertemplate:'%{text}<br>%{x} sessions<br>%{y:$,.0f} pipeline<extra>'+c+'</extra>'};}),
    base({xaxis:{type:'log',title:{text:'Sessions (log)',font:{size:12}},gridcolor:css('--rule'),tickfont:{family:'Chivo Mono, monospace',size:11}},yaxis:{type:'log',tickformat:'$.2s',title:{text:'Pipeline created + closed-won (log)',font:{size:12}},gridcolor:css('--rule'),tickfont:{family:'Chivo Mono, monospace',size:11}},
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
  if(a360TrendView==='total')data=[{type:'scatter',mode:'lines+markers',name:'Created',x:x,y:tot('created_by_month'),line:{color:css('--d1'),width:2.6},fill:'tozeroy',fillcolor:'rgba(98,150,173,.12)'},{type:'scatter',mode:'lines+markers',name:'Closed-won',x:x,y:tot('closed_won_by_month'),line:{color:css('--d2'),width:2.6}}];
  else data=CO.map(function(c){return {type:'scatter',mode:'lines',name:c,x:x,y:tot('created_by_month',function(a){return a.cohort===c;}),line:{color:coColor(c),width:2.2}};});
  plot('a360Trend',data,base({xaxis:xcat(),yaxis:{tickformat:'$.2s',gridcolor:css('--rule'),rangemode:'tozero',tickfont:{family:'Chivo Mono, monospace',size:11}},hovermode:'x unified'}));
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
    base({xaxis:{title:{text:'Average engagement score',font:{size:12}},range:[0,100],gridcolor:css('--rule'),tickfont:{family:'Chivo Mono, monospace',size:11}},yaxis:ypct({range:[0,105]})}));
}
function renderAccTable(){
  var q=($('#accQ').value||'').toLowerCase(),rows=ACC.accounts.filter(function(a){return !q||a.account.toLowerCase().indexOf(q)>=0;}).slice();sortRows(rows,accSort);
  var cols=[['account','Account'],['opps','Deals'],['won','Won'],['win_rate','Win rate'],['eng','Engagement'],['days','Days to close'],['depth','Depth'],['breadth','Breadth'],['exec','Exec activity'],['vp','VP activity'],['dir','Director activity']];
  $('#accTbl').innerHTML=sortHead('#accTbl',cols,accSort)+'<tbody>'+rows.slice(0,200).map(function(a){return '<tr><td>'+esc(a.account)+'</td><td>'+n0(a.opps)+'</td><td>'+n0(a.won)+'</td><td>'+p1(a.win_rate)+'</td><td>'+(a.eng==null?'–':a.eng.toFixed(1))+'</td><td>'+(a.days==null?'–':n0(a.days))+'</td><td>'+(a.depth==null?'–':a.depth.toFixed(1))+'</td><td>'+a.breadth+'</td><td>'+n0(a.exec)+'</td><td>'+n0(a.vp)+'</td><td>'+n0(a.dir)+'</td></tr>';}).join('')+'</tbody>';
  bindSort('#accTbl',accSort,renderAccTable);
}

/* ---------- method ---------- */
function fillMethod(){
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
var TABS={summary:true,activity:HAS.U,adoption:HAS.usage,deals:HAS.OPP||HAS.D||HAS.ST,accounts:HAS.A360||HAS.ACC,method:true};
(VIEW.hiddenTabs||[]).forEach(function(t){TABS[t]=false;});
var R={summary:function(){},activity:renderActivity,adoption:renderAdoption,deals:renderDeals,accounts:renderAccounts,method:function(){}};
var current='summary';
function showTab(t){if(!TABS[t])t='summary';current=t;$$('nav.tabs button[role=tab]').forEach(function(b){b.setAttribute('aria-selected',b.getAttribute('data-tab')===t);});$$('section.panel').forEach(function(s){s.classList.toggle('active',s.id==='p-'+t);});gfForTab(t);requestAnimationFrame(function(){R[t]();});}
function rerender(){R[current]();}
$$('nav.tabs button[role=tab]').forEach(function(b){if(!TABS[b.getAttribute('data-tab')])b.classList.add('hidden');b.onclick=function(){showTab(b.getAttribute('data-tab'));};});
$$('section.panel').forEach(function(s){var t=s.id.slice(2);if(!TABS[t])s.classList.add('hidden');});

function init(){
  setupGF();gfForTab('summary');
  if(HAS.U)setupActivity();
  if(HAS.usage)setupAdoption();
  if(TABS.deals)setupDeals();
  if(TABS.accounts)setupAccounts();
  setupCalc();renderSummary();renderHero();renderHeroStats();fillMethod();
}
if(window.Plotly)init();else window.addEventListener('load',init);
})();
`

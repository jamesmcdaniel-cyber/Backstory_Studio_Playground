/**
 * The ROI report's stylesheet — Backstory's value readout in the Iron
 * Mountain dashboard's UI: the brand tokens (Graphite masthead, Horizon
 * accents, Cardo / Roboto / Chivo Mono, the brand's data hues), light and
 * dark, print-friendly. See dashboard.ts.
 */
export const REPORT_CSS = String.raw`
:root{
  --page:#FFFFFF; --surface:#F5F5F5; --raised:#FFFFFF; --text:#171721; --text2:#55555E; --text3:#7F7F85;
  --rule:#E3E3E5; --rule-strong:#BBBCBC; --mast:#171721; --mast-text:#FFFFFF; --mast-sub:#BBBCBC;
  --horizon:#6296AD; --horizon-deep:#447C93; --accent-subtle:#DBEBF2;
  --d1:#6296AD; --d2:#5BA779; --d3:#B08FA2; --d4:#9FDFFF; --d5:#CEB375; --d6:#275198; --neg:#C05527; --pos:#3F7F58;
  --c-power:#275198; --c-browser:#5BA779; --c-digger:#C05527; --c-light:#B08FA2; --c-none:#BBBCBC;
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
    --d1:#7DACC0; --d2:#8FCDA8; --d3:#E8DDE3; --d4:#21B5FF; --d5:#CEB375; --d6:#7FA6E8; --neg:#E07B4F; --pos:#8FCDA8;
    --c-power:#7FA6E8; --c-browser:#8FCDA8; --c-digger:#E07B4F; --c-light:#E8DDE3; --c-none:#55555E;
  }
}
:root[data-theme="dark"]{
  --page:#171721; --surface:#22222C; --raised:#31313C; --text:#F5F5F5; --text2:#ABABAD; --text3:#8C8C92;
  --rule:#31313C; --rule-strong:#55555E; --mast:#000000; --mast-text:#FFFFFF; --mast-sub:#ABABAD;
  --horizon:#7DACC0; --horizon-deep:#99C1D1; --accent-subtle:#0A2F3F;
  --d1:#7DACC0; --d2:#8FCDA8; --d3:#E8DDE3; --d4:#21B5FF; --d5:#CEB375; --d6:#7FA6E8; --neg:#E07B4F; --pos:#8FCDA8;
  --c-power:#7FA6E8; --c-browser:#8FCDA8; --c-digger:#E07B4F; --c-light:#E8DDE3; --c-none:#55555E;
}
*,*::before,*::after{box-sizing:inherit;margin:0;padding:0}
html{-webkit-text-size-adjust:100%}
body{background:var(--page);color:var(--text);font-family:var(--sans);font-size:16px;line-height:1.5}
a{color:var(--horizon-deep)}
:focus-visible{outline:2px solid var(--horizon);outline-offset:2px}
.wrap{max-width:1240px;margin:0 auto;padding:0 28px}
.num{font-family:var(--mono);font-variant-numeric:tabular-nums}
.muted{color:var(--text3)}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.mast{background:var(--mast);color:var(--mast-text);padding:20px 0 0}
.topbar{display:flex;flex-wrap:wrap;align-items:center;gap:10px 18px;padding-bottom:16px;border-bottom:1px solid #31313C}
.brand{display:flex;align-items:center;gap:10px;font-weight:500;font-size:15px;letter-spacing:.01em}
.brand svg{width:22px;height:18px}
.brand-sub{font:500 11px var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--mast-sub);border-left:1px solid #55555E;padding-left:10px}
.mast-meta{color:var(--mast-sub);font-size:13px;margin-left:auto}
.mast-meta b{color:var(--mast-text);font-weight:500}
.mast .eyebrow{font:500 12px var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--horizon);margin-bottom:14px}
.mast-grid{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);gap:48px;align-items:end;margin-top:34px}
.mast h1{font-family:var(--serif);font-weight:400;font-size:clamp(34px,4.6vw,56px);line-height:1.06;letter-spacing:-.02em;max-width:17ch}
.mast .lede{color:var(--mast-sub);font-size:17px;margin-top:18px;max-width:52ch}
.mast .lede b{color:var(--mast-text)}
.strip-wrap figcaption{color:var(--mast-sub);font-size:13px;margin-top:6px}
#heroStrip{height:230px}
.hero-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1px;background:#31313C;margin:30px 0 32px;border:1px solid #31313C;border-radius:6px;overflow:hidden}
.hero-stats>div{background:var(--mast);padding:16px 18px}
.hero-stats .v{font-family:var(--mono);font-size:30px;line-height:1.1;color:var(--mast-text)}
.hero-stats .l{font-size:13px;color:var(--mast-sub);margin-top:6px}
.stripe{display:flex;height:4px}
.stripe span{flex:1}
.stripe span:nth-child(1){background:var(--d1)} .stripe span:nth-child(2){background:var(--d2)} .stripe span:nth-child(3){background:var(--d3)} .stripe span:nth-child(4){background:var(--neg)}
nav.tabs{position:sticky;top:0;z-index:20;background:var(--page);border-bottom:1px solid var(--rule);box-shadow:0 1px 0 rgba(0,0,0,.02),0 6px 16px -14px rgba(23,23,33,.35)}
.navrow{display:flex;align-items:center;gap:8px}
.tablist{display:flex;gap:4px;overflow-x:auto;scrollbar-width:none;min-width:0;flex:1}
nav.tabs button[role=tab]{font:500 14px var(--sans);color:var(--text2);background:none;border:0;padding:16px 14px 14px;border-bottom:2px solid transparent;cursor:pointer;white-space:nowrap}
nav.tabs button[role=tab][aria-selected="true"]{color:var(--text);border-bottom-color:var(--horizon);font-weight:500}
nav.tabs button[role=tab]:hover{color:var(--text)}
.hamburger{flex:none;display:inline-flex;flex-direction:column;justify-content:center;gap:4px;width:36px;height:36px;padding:0 9px;background:none;border:1px solid var(--rule-strong);border-radius:6px;cursor:pointer}
.hamburger span{display:block;height:2px;border-radius:1px;background:var(--text)}
.hamburger[aria-expanded="true"]{background:var(--surface)}
body.hosted .hamburger,body.hosted .gf-badge{display:none!important}
.gf-badge{flex:none;font-size:12px;color:var(--horizon-deep);background:var(--accent-subtle);border-radius:999px;padding:2px 10px;display:none;white-space:nowrap}
.scrim{position:fixed;inset:0;background:rgba(23,23,33,.35);z-index:40}
.scrim[hidden]{display:none}
.filter-panel{position:fixed;top:0;left:0;bottom:0;width:min(340px,88vw);background:var(--page);border-right:1px solid var(--rule);z-index:50;padding:22px 22px 28px;overflow-y:auto;box-shadow:8px 0 24px rgba(0,0,0,.12)}
.filter-panel[hidden]{display:none}
.fp-head{display:flex;align-items:center;justify-content:space-between}
.fp-head h2{font-family:var(--serif);font-weight:400;font-size:26px}
.fp-close{font:400 24px var(--sans);line-height:1;background:none;border:0;color:var(--text2);cursor:pointer;padding:4px 8px}
.fp-hint{font-size:13px;color:var(--text2);margin-top:6px}
.fp-group{margin-top:22px}
.fp-group h3{font-size:13px;font-weight:500;color:var(--text2);margin-bottom:8px}
.gf-clear{margin-top:26px;font:400 13px var(--sans);background:var(--raised);color:var(--text2);border:1px solid var(--rule-strong);border-radius:6px;padding:6px 12px;cursor:pointer}
section.panel{display:none;padding:40px 0 72px}
section.panel.active{display:block}
.panel h2{font-family:var(--serif);font-weight:400;font-size:clamp(28px,3vw,40px);line-height:1.1;letter-spacing:-.01em;max-width:28ch}
.panel .intro{color:var(--text2);font-size:17px;max-width:70ch;margin-top:10px}
.panel h3{font-size:18px;font-weight:500;margin-bottom:4px}
.section-h{font-family:var(--serif);font-weight:400;font-size:28px!important;margin-top:56px;padding-top:28px;border-top:1px solid var(--rule-strong)}
.section-lbl{display:flex;align-items:center;gap:12px;font:500 12px var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--text3);margin:48px 0 14px}
.section-lbl::after{content:'';flex:1;height:1px;background:var(--rule)}
.panel .wrap>.section-lbl:first-child,.panel .ctx+.section-lbl{margin-top:0}
.sub{color:var(--text2);font-size:14px;max-width:68ch}
.sub.right{text-align:right;max-width:none;margin-top:8px}
.block{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:36px;margin-top:40px;padding-top:28px;border-top:1px solid var(--rule)}
.block.full{grid-template-columns:minmax(0,1fr)}
.chart{height:380px;margin-top:14px}
.chart.tall{height:460px}
.chart.short{height:280px}
aside.note{font-size:15px;color:var(--text2);border-left:2px solid var(--horizon);padding:2px 0 2px 18px;align-self:start}
aside.note h4{font-size:14px;font-weight:500;color:var(--text);margin-bottom:8px}
aside.note p+p{margin-top:10px}
aside.note b{color:var(--text);font-weight:500}
.twocol{display:grid;grid-template-columns:1fr 1fr;gap:28px}
.cards3,.cards2{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px;margin-top:40px;padding-top:28px;border-top:1px solid var(--rule)}
.cards2{grid-template-columns:repeat(2,minmax(0,1fr))}
.cards2.flush{margin-top:0;padding-top:0;border-top:0}
.card{background:var(--raised);border:1px solid var(--rule);border-radius:8px;padding:18px 18px 8px;box-shadow:0 1px 2px rgba(23,23,33,.04)}
.card h3{font-size:16px!important}
.controls{display:flex;flex-wrap:wrap;gap:18px 28px;align-items:flex-end;margin-top:24px}
.controls.tight{margin-top:0;gap:10px;align-items:center}
.ctl{display:flex;flex-direction:column;gap:6px}
.ctl>span{font-size:13px;color:var(--text2)}
.seg{display:inline-flex;flex-wrap:wrap;border:1px solid var(--rule-strong);border-radius:6px;overflow:hidden}
.seg button{font:400 14px var(--sans);background:var(--raised);color:var(--text2);border:0;padding:7px 12px;cursor:pointer;border-right:1px solid var(--rule-strong)}
.seg button:last-child{border-right:0}
.seg button[aria-pressed="true"]{background:var(--text);color:var(--page)}
.subnav{margin-top:28px}
.subnav button{font-size:15px;padding:9px 16px}
select,input[type=number],input[type=search]{font:400 14px var(--sans);color:var(--text);background:var(--raised);border:1px solid var(--rule-strong);border-radius:6px;padding:7px 10px}
input[type=search]{min-width:220px}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chips button{font:400 13px var(--sans);background:transparent;color:var(--text2);border:1px solid var(--rule-strong);border-radius:999px;padding:4px 11px;cursor:pointer}
.chips button[aria-pressed="true"]{background:var(--horizon);border-color:var(--horizon);color:#000}
.custom{display:none;gap:18px;flex-wrap:wrap}
.custom.on{display:flex}
.toggle{display:flex;align-items:center;gap:8px;font-size:14px;color:var(--text2);cursor:pointer}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;margin-top:24px}
.tile{display:block;text-align:left;font:inherit;color:inherit;background:var(--raised);border:1px solid var(--rule);border-radius:8px;padding:14px 16px;cursor:pointer;box-shadow:0 1px 2px rgba(23,23,33,.04)}
.tiles.static .tile{cursor:default}
.tiles.score{grid-template-columns:repeat(auto-fit,minmax(160px,1fr))}
.tile[aria-pressed="true"]{border-color:var(--horizon);box-shadow:inset 0 0 0 1px var(--horizon);background:var(--accent-subtle)}
.tile .k{font-size:13px;color:var(--text2)}
.tile .v{font-family:var(--mono);font-size:24px;line-height:1.15;margin-top:6px}
.tile .d{font-family:var(--mono);font-size:13px;margin-top:4px;color:var(--text3)}
.tile .d.up{color:var(--pos)} .tile .d.down{color:var(--neg)}
.tbl-head{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:flex-end;gap:12px}
.tbl-wrap{overflow:auto;margin-top:14px}
.tbl-wrap.tall{max-height:520px}
table{border-collapse:collapse;width:100%;font-size:14px}
th{font-weight:500;color:var(--text2);text-align:right;padding:9px 12px;border-bottom:1px solid var(--rule-strong);white-space:nowrap;background:var(--page);position:sticky;top:0}
th button{font:inherit;color:inherit;background:none;border:0;cursor:pointer;padding:0}
th:first-child,td:first-child{text-align:left}
td{padding:9px 12px;border-bottom:1px solid var(--rule);text-align:right;font-family:var(--mono);font-size:13px;white-space:nowrap}
td:first-child,td.txt{font-family:var(--sans);font-size:14px;text-align:left}
td.up{color:var(--pos)} td.down{color:var(--neg)}
.badge{display:inline-block;font:500 12px var(--sans);border-radius:999px;padding:2px 9px;background:var(--surface);color:var(--text2)}
.fgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:16px;margin-top:26px}
.fcard{display:flex;flex-direction:column;background:var(--raised);border:1px solid var(--rule);border-top:3px solid var(--horizon);border-radius:8px;padding:18px 20px 16px;box-shadow:0 1px 2px rgba(23,23,33,.04)}
.fcard.t-activity{border-top-color:var(--d1)} .fcard.t-adoption{border-top-color:var(--d2)} .fcard.t-deals{border-top-color:var(--d6)} .fcard.t-stage{border-top-color:var(--d3)} .fcard.t-accounts{border-top-color:var(--d5)}
.ftag{font:500 11px var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--text3)}
.ffig{font-family:var(--mono);font-size:36px;line-height:1.05;color:var(--horizon-deep);letter-spacing:-.02em;margin-top:12px}
.fcap{font-size:13px;color:var(--text2);margin-top:4px}
.fcard h3{font-size:17px!important;margin:14px 0 0}
.fcard p{color:var(--text2);font-size:15px;margin-top:4px}
.go{align-self:flex-start;font:500 14px var(--sans);color:var(--horizon-deep);background:none;border:0;padding:12px 0 0;margin-top:auto;cursor:pointer;text-decoration:underline;text-underline-offset:3px}
.ctx{margin-bottom:36px;border:1px solid var(--rule);border-left:3px solid var(--horizon);border-radius:4px;padding:18px 22px;background:var(--surface)}
.ctx .eyebrow{font:500 12px var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--horizon-deep)}
.ctx p{margin-top:6px;max-width:80ch}
.ctx dl{display:flex;flex-wrap:wrap;gap:12px 32px;margin-top:12px}
.ctx dt{font-size:13px;color:var(--text2)}
.ctx dd{font-family:var(--mono);font-size:15px}
.ctx dd small{display:block;font-family:var(--sans);font-size:12px;color:var(--text3)}
.watch{margin-top:40px;background:var(--surface);padding:24px 28px;border-radius:4px}
.watch h3{margin-bottom:10px}
.watch li{margin:6px 0 0 18px;color:var(--text2);max-width:90ch}
.watch li b{color:var(--text);font-weight:500}
.yoy{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px;margin-top:24px}
.yoy:empty{display:none}
.yoy>div{border:1px solid var(--rule);border-top:3px solid var(--horizon);border-radius:4px;padding:14px 16px;background:var(--raised)}
.yoy>div.neg{border-top-color:var(--neg)} .yoy>div.pos{border-top-color:var(--pos)}
.yoy h4{font-size:14px;font-weight:500}
.yoy .s{font-family:var(--mono);font-size:18px;margin-top:6px}
.yoy p{font-size:13px;color:var(--text2);margin-top:6px}
.yoy>.yoy-title{grid-column:1/-1;font:500 12px var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--text3);border:0;padding:0;background:none}
.notice{margin-top:20px;padding:14px 18px;border:1px dashed var(--rule-strong);border-radius:4px;color:var(--text2);font-size:15px}
.quads{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;margin-top:22px}
.quads>div{border:1px solid var(--rule);border-left:4px solid var(--c);border-radius:4px;padding:10px 14px;background:var(--raised)}
.quads h4{font-size:14px;font-weight:500}
.quads p{font-size:13px;color:var(--text2)}
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
.callout{border-left:3px solid var(--horizon);border-radius:0 6px 6px 0;margin-top:20px}
.dyn:empty{display:none}
.method p,.method li{color:var(--text2);max-width:78ch}
.method h3{margin-top:28px}
.method li{margin:6px 0 0 18px}
footer{border-top:1px solid var(--rule);padding:22px 0 40px;color:var(--text3);font-size:13px}
.themebtn{font:400 13px var(--sans);background:none;border:1px solid #55555E;color:var(--mast-sub);border-radius:999px;padding:4px 12px;cursor:pointer}
.hidden{display:none!important}
@media (max-width:920px){
  .mast-grid,.block,.calc,.twocol,.cards3,.cards2{grid-template-columns:minmax(0,1fr)}
  .hero-stats{grid-template-columns:repeat(2,minmax(0,1fr))}
  .mast-meta{margin-left:0;flex-basis:100%;order:3}
  .wrap{padding:0 16px}
  aside.note{border-left:0;border-top:2px solid var(--horizon);padding:14px 0 0}
  input[type=search]{min-width:0;width:100%}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
@media print{nav.tabs,.controls,.themebtn,.filter-panel,.scrim{display:none}section.panel{display:block}}
`

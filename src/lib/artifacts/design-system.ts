/** Opt-in, offline UI foundation. No global selectors: old versions keep their design. */
export const ARTIFACT_DESIGN_CSS = String.raw`
[data-artifact-ui="studio"]{--bs-bg:#f4f5f7;--bs-surface:#fff;--bs-ink:#17202b;--bs-muted:#526173;--bs-line:#dce2e8;--bs-accent:#17634f;--bs-soft:#e7f2ed;--bs-radius:16px;color:var(--bs-ink);background:var(--bs-bg);font:14px/1.55 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-height:100vh;isolation:isolate;color-scheme:light}
[data-artifact-ui="studio"]:where([data-theme="night"]){--bs-bg:#101720;--bs-surface:#19232f;--bs-ink:#f2f5f8;--bs-muted:#b1bfcc;--bs-line:#354352;--bs-accent:#85dcc0;--bs-soft:#223d37;color-scheme:dark}
[data-artifact-ui="studio"] :where(*),[data-artifact-ui="studio"]{box-sizing:border-box}
[data-artifact-ui="studio"] :where(h1,h2,h3,p){margin:0}
[data-artifact-ui="studio"] :where(h1){font-size:clamp(26px,3.5vw,42px);font-weight:650;letter-spacing:-.04em;line-height:1.12}
[data-artifact-ui="studio"] :where(h2){font-size:20px;font-weight:650;letter-spacing:-.025em;line-height:1.3}
[data-artifact-ui="studio"] :where(h3){font-size:15px;font-weight:650;line-height:1.4}
[data-artifact-ui="studio"] :where(button,input,select,textarea){font:inherit;max-width:100%}
[data-artifact-ui="studio"] :where(button){cursor:pointer;min-height:44px;padding:9px 14px;border:1px solid var(--bs-line);border-radius:10px;background:var(--bs-surface);color:var(--bs-ink);font-weight:600;transition:background .15s,border-color .15s,box-shadow .15s}
[data-artifact-ui="studio"] :where(button:hover:not(:disabled)){border-color:var(--bs-accent);background:var(--bs-soft)}
[data-artifact-ui="studio"] :where(button:disabled){cursor:not-allowed;opacity:.5}
[data-artifact-ui="studio"] :where(input,select,textarea){min-height:44px;border:1px solid var(--bs-line);border-radius:10px;padding:10px 12px;background:var(--bs-surface);color:var(--bs-ink)}
[data-artifact-ui="studio"] :where(input[type="checkbox"],input[type="radio"]){min-height:20px;width:20px;accent-color:var(--bs-accent)}
[data-artifact-ui="studio"] :where(input[type="range"]){padding:0;accent-color:var(--bs-accent)}
[data-artifact-ui="studio"] :where(label){display:grid;gap:6px;font-size:12px;font-weight:600;color:var(--bs-muted)}
[data-artifact-ui="studio"] :where(:focus-visible){outline:3px solid var(--bs-accent);outline-offset:3px}
[data-artifact-ui="studio"] :where(a){color:var(--bs-accent);text-underline-offset:3px}
[data-artifact-ui="studio"] :where(svg,img,canvas){max-width:100%}
[data-artifact-ui="studio"] .bs-shell{display:grid;grid-template-columns:220px minmax(0,1fr);min-height:100vh}
[data-artifact-ui="studio"] .bs-nav{background:#17242a;color:#f4f7f8;padding:28px 18px;display:flex;flex-direction:column;gap:10px}
[data-artifact-ui="studio"] .bs-nav button{background:transparent;color:#d8e4e8;border-color:transparent;text-align:left}
[data-artifact-ui="studio"] .bs-nav button[aria-current="page"]{background:#31464b;color:#fff;border-color:#557178}
[data-artifact-ui="studio"] .bs-main{min-width:0;padding:clamp(20px,3vw,44px);display:grid;align-content:start;gap:28px}
[data-artifact-ui="studio"] .bs-header{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;flex-wrap:wrap}
[data-artifact-ui="studio"] .bs-eyebrow{text-transform:uppercase;font-size:10px;letter-spacing:.16em;font-weight:750;color:var(--bs-muted);margin-bottom:10px}
[data-artifact-ui="studio"] .bs-muted{color:var(--bs-muted)}
[data-artifact-ui="studio"] .bs-primary{background:var(--bs-accent);border-color:var(--bs-accent);color:var(--bs-surface)}
[data-artifact-ui="studio"] .bs-primary:hover:not(:disabled){background:var(--bs-accent);filter:brightness(.94);color:var(--bs-surface)}
[data-artifact-ui="studio"] .bs-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
[data-artifact-ui="studio"] .bs-metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,160px),1fr));gap:14px}
[data-artifact-ui="studio"] .bs-card{min-width:0;padding:24px;border:1px solid var(--bs-line);border-radius:var(--bs-radius);background:var(--bs-surface);box-shadow:0 3px 12px #17202b04}
[data-artifact-ui="studio"] .bs-value{font-size:clamp(26px,3vw,36px);line-height:1.15;letter-spacing:-.04em;font-weight:650;font-variant-numeric:tabular-nums;margin:10px 0}
[data-artifact-ui="studio"] .bs-split{display:grid;grid-template-columns:minmax(0,1.65fr) minmax(260px,1fr);gap:20px;align-items:start}
[data-artifact-ui="studio"] .bs-stack{display:grid;gap:16px}
[data-artifact-ui="studio"] .bs-badge{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:4px 9px;font-size:11px;font-weight:650;background:var(--bs-soft);color:var(--bs-accent)}
[data-artifact-ui="studio"] .bs-table{overflow:auto;border:1px solid var(--bs-line);border-radius:var(--bs-radius);background:var(--bs-surface)}
[data-artifact-ui="studio"] :where(table){width:100%;border-collapse:collapse;text-align:left;font-variant-numeric:tabular-nums}
[data-artifact-ui="studio"] :where(th){font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--bs-muted);background:var(--bs-bg)}
[data-artifact-ui="studio"] :where(td,th){padding:14px 18px;border-bottom:1px solid var(--bs-line);vertical-align:middle;white-space:nowrap}
[data-artifact-ui="studio"] :where(tbody tr:hover){background:var(--bs-soft)}
[data-artifact-ui="studio"] .bs-empty{padding:48px 24px;text-align:center;display:grid;justify-items:center;gap:12px;color:var(--bs-muted)}
[data-artifact-ui="studio"] .bs-alert{padding:14px 16px;border-left:3px solid var(--bs-accent);background:var(--bs-soft);border-radius:0 10px 10px 0}
[data-artifact-ui="studio"] .bs-error{color:#a32738;background:#fff0f2;border-color:#a32738}
[data-artifact-ui="studio"] .bs-chart{min-width:0;min-height:240px}
[data-artifact-ui="studio"] .bs-detail{border-top:3px solid var(--bs-accent)}
@media(max-width:900px){[data-artifact-ui="studio"] .bs-shell{grid-template-columns:minmax(0,1fr)}[data-artifact-ui="studio"] .bs-nav{flex-direction:row;flex-wrap:wrap;padding:14px 20px;gap:6px}[data-artifact-ui="studio"] .bs-split{grid-template-columns:minmax(0,1fr)}}
@media(max-width:480px){[data-artifact-ui="studio"] .bs-main{padding:18px 14px;gap:20px}[data-artifact-ui="studio"] .bs-card{padding:18px}[data-artifact-ui="studio"] .bs-toolbar>*{flex:1 1 auto;min-width:0}[data-artifact-ui="studio"] .bs-header{gap:14px}[data-artifact-ui="studio"] :where(h1,h2,h3,p){overflow-wrap:anywhere}}
@media(prefers-reduced-motion:reduce){[data-artifact-ui="studio"] *,[data-artifact-ui="studio"] *::before,[data-artifact-ui="studio"] *::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
`

export const ARTIFACT_DESIGN_GUIDANCE = `ARTIFACT PRODUCT DESIGN
More languages do not make a better UI. Deliver a task-specific application with a deliberate visual identity, not a generic HTML report, technology demo, dark banner plus identical KPI cards, or a wall of tabs. Never label sections "HTML", "JavaScript" or "Python" unless the user requested a runtime demo.
Before coding, choose the user's primary job, one dominant working surface, and 2–3 meaningful interactions. Match the layout to the task: an editable table with detail inspector for an operational workspace; a chart-led canvas with scenario controls for analysis; a board/list with item editor for a tracker; editorial typography and restrained navigation for a brief. Do not add a sidebar, chart, or tab unless it earns its space. Favor a strong page title, compact context, one clear primary action, deliberate contrast, aligned spacing, readable tables and a distinctive visualization over more decoration. Preserve user branding; no default purple gradients, emoji icons, fake logos, invented trends or decorative metrics.
OFFLINE UI KIT: opt in on your outermost element with data-artifact-ui="studio" (React uses the same attribute). The runtime supplies scoped CSS for HTML and React, no imports or CDN needed. Set body margin:0 for a full-page HTML app. Available classes: bs-shell (optional sidebar/content grid), bs-nav (real navigation buttons with aria-current="page"), bs-main, bs-header, bs-eyebrow, bs-muted, bs-toolbar, bs-primary, bs-metrics, bs-card, bs-value, bs-split (main + inspector), bs-stack, bs-badge, bs-table (scrolling table wrapper), bs-empty, bs-alert, bs-error, bs-chart, bs-detail. Native buttons/inputs/labels/tables are styled inside the root. Override --bs-accent, --bs-soft, --bs-bg, --bs-radius on the root for a coherent task-specific identity; data-theme="night" is optional. Use the kit as a foundation, not an identical mandatory template. Charts need explicit height, labelled units, tooltips where supported and a textual/table alternative; use vendored Recharts in React or real inline SVG in HTML.
FUNCTIONAL FINISH: every visible action must perform its named operation. Derive chart/KPI/table values from the same filtered records. Search, sort, select, edit, drill down, scenario comparison and export must agree. For data editing use the durable SDK and show loading/saving/error states. Never simulate saved state, Python results, refreshes, integrations or notifications. Python should power a useful calculation with inputs, Run/Cancel, result and failure feedback; keep normal UI interactions in JS/TS and responsive while it computes. Include useful empty states, validation at the field, keyboard-visible focus, labels, aria-pressed/current for selected controls and Escape/focus handling if you implement a modal. Prefer an inline inspector over a fragile modal. Touch targets at least 44px; work at 360px without page-level horizontal overflow (wide tables may scroll inside their wrapper); respect reduced motion.
SELF-REVIEW before saving: does this look like the requested product rather than the previous report template? Can the user complete the primary job end to end? Are the prominent interactions real? Are loading/error/empty states legible? Did source edits preserve storage keys and existing data? Do not claim browser testing unless a browser test actually ran. On a requested redesign, change layout/composition and interaction design substantially, not only colors or fonts. On a small edit, preserve the existing design.`

import { transform } from 'sucrase'

/**
 * The artifact runtime: what makes an agent's page work like a Claude
 * artifact — a React component with Tailwind, Recharts, lucide icons and the
 * shadcn/ui basics, or an HTML page that uses them — inside our sandbox, where
 * nothing can load from the internet.
 *
 * JSX is compiled here, when the page is served (sucrase: TypeScript + JSX →
 * CommonJS), never in the browser. Each compiled block gets a `require` that
 * resolves the libraries a page may import to the platform's own copies in
 * /public/vendor, loaded ahead of it. Stored content stays the source, so the
 * assistant edits the component, not compiled output.
 */

type ModuleDef = { global: string; scripts: string[] }

const REACT = '/vendor/react.production.min.js'
const REACT_DOM = '/vendor/react-dom.production.min.js'
const PROP_TYPES = '/vendor/prop-types.min.js'

/** Module specifiers a page may import, and the vendored scripts that provide them. */
export const ARTIFACT_MODULES: Record<string, ModuleDef> = {
  react: { global: 'React', scripts: [REACT] },
  'react-dom': { global: 'ReactDOM', scripts: [REACT, REACT_DOM] },
  'react-dom/client': { global: 'ReactDOM', scripts: [REACT, REACT_DOM] },
  recharts: { global: 'Recharts', scripts: [REACT, REACT_DOM, PROP_TYPES, '/vendor/recharts.min.js'] },
  'lucide-react': { global: 'LucideReact', scripts: [REACT, '/vendor/lucide-react.min.js'] },
  d3: { global: 'd3', scripts: ['/vendor/d3.min.js'] },
  lodash: { global: '_', scripts: ['/vendor/lodash.min.js'] },
  'chart.js': { global: 'Chart', scripts: ['/vendor/chart.umd.js'] },
  'chart.js/auto': { global: 'Chart', scripts: ['/vendor/chart.umd.js'] },
  'plotly.js-dist-min': { global: 'Plotly', scripts: ['/vendor/plotly.min.js'] },
  'plotly.js': { global: 'Plotly', scripts: ['/vendor/plotly.min.js'] },
  three: { global: 'THREE', scripts: ['/vendor/three.min.js'] },
  mermaid: { global: 'mermaid', scripts: ['/vendor/mermaid.min.js'] },
  xlsx: { global: 'XLSX', scripts: ['/vendor/xlsx.full.min.js'] },
  papaparse: { global: 'Papa', scripts: ['/vendor/papaparse.min.js'] },
  mathjs: { global: 'math', scripts: ['/vendor/math.min.js'] },
  marked: { global: 'marked', scripts: ['/vendor/marked.min.js'] },
}

export const TAILWIND_SCRIPT = '/vendor/tailwind.browser.js'

/** The shadcn/ui components a page may import from `@/components/ui/*`. */
export const ARTIFACT_UI_COMPONENTS = ['card', 'button', 'badge', 'tabs', 'alert', 'input', 'label', 'textarea', 'progress', 'separator', 'table', 'select', 'switch', 'skeleton'] as const

const JSX_SCRIPT = /<script\b([^>]*)\btype\s*=\s*["']text\/(?:babel|jsx|tsx)["']([^>]*)>([\s\S]*?)<\/script>/gi
const BABEL_STANDALONE = /<script\b[^>]*\bsrc\s*=\s*["'][^"']*babel[^"']*standalone[^"']*["'][^>]*>\s*<\/script>/gi

/** Whether HTML carries JSX the server must compile. */
export function hasJsxScript(html: string): boolean {
  JSX_SCRIPT.lastIndex = 0
  return JSX_SCRIPT.test(html)
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * The page's runtime, inlined once ahead of the compiled code: `require`, the
 * mount (a default-exported component renders into #root), an error panel in
 * place of a blank page, and the shadcn/ui basics as Tailwind components.
 */
const PRELUDE = String.raw`
(function(){
  var MODULES = __MODULES__;
  function panel(title, detail){
    var el = document.getElementById('__artifact_error') || document.createElement('div');
    el.id = '__artifact_error';
    el.setAttribute('style','position:fixed;left:16px;right:16px;bottom:16px;z-index:2147483647;background:#fff1f2;border:1px solid #fecdd3;color:#9f1239;border-radius:12px;padding:12px 14px;font:13px/1.5 ui-sans-serif,system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.12);white-space:pre-wrap;max-height:40vh;overflow:auto');
    el.textContent = title + (detail ? '\n' + detail : '');
    (document.body || document.documentElement).appendChild(el);
  }
  window.__artifactError = function(error){ panel('This page hit an error: ' + (error && error.message ? error.message : String(error)), error && error.stack ? String(error.stack).split('\n').slice(0, 4).join('\n') : ''); };
  window.addEventListener('error', function(e){ window.__artifactError(e.error || e.message); });
  window.addEventListener('unhandledrejection', function(e){ window.__artifactError(e.reason); });
  var ui = null;
  window.__artifactRequire = function(name){
    if (MODULES[name]) {
      var value = window[MODULES[name]];
      if (value === undefined) throw new Error('The library "' + name + '" did not load.');
      return value;
    }
    var m = /^@\/components\/ui\/([a-z-]+)$/.exec(name);
    if (m) { ui = ui || buildUi(); if (ui[m[1]]) return ui[m[1]]; }
    throw new Error('This page imports "' + name + '", which artifacts cannot load. Available: ' + Object.keys(MODULES).join(', ') + ', and @/components/ui/{' + __UI__ + '}.');
  };
  window.__artifactMount = function(exp){
    var C = exp && (exp.default || exp.App);
    if (!C || !window.React || !window.ReactDOM) return;
    var R = window.React;
    var host = document.getElementById('root');
    if (!host) { host = document.createElement('div'); host.id = 'root'; document.body.appendChild(host); }
    function Boundary(props){ R.Component.call(this, props); this.state = { error: null }; }
    Boundary.prototype = Object.create(R.Component.prototype);
    Boundary.prototype.constructor = Boundary;
    Boundary.getDerivedStateFromError = function(error){ return { error: error }; };
    Boundary.prototype.componentDidCatch = function(error){ window.__artifactError(error); };
    Boundary.prototype.render = function(){ return this.state.error ? null : this.props.children; };
    var el = R.createElement(Boundary, null, R.createElement(C));
    if (window.ReactDOM.createRoot) window.ReactDOM.createRoot(host).render(el); else window.ReactDOM.render(el, host);
  };
  function cx(){ var out = []; for (var i = 0; i < arguments.length; i++) { var a = arguments[i]; if (a) out.push(a); } return out.join(' '); }
  function buildUi(){
    var R = window.React, h = R.createElement;
    function part(tag, base){
      return R.forwardRef(function(props, ref){
        var p = Object.assign({}, props, { ref: ref, className: cx(base, props.className) });
        return h(tag, p);
      });
    }
    var buttonVariants = { default: 'bg-slate-900 text-white hover:bg-slate-800', secondary: 'bg-slate-100 text-slate-900 hover:bg-slate-200', outline: 'border border-slate-200 bg-white hover:bg-slate-50', ghost: 'hover:bg-slate-100', destructive: 'bg-red-600 text-white hover:bg-red-500', link: 'text-slate-900 underline-offset-4 hover:underline' };
    var buttonSizes = { default: 'h-9 px-4 py-2', sm: 'h-8 px-3 text-xs', lg: 'h-10 px-6', icon: 'h-9 w-9' };
    var Button = R.forwardRef(function(props, ref){
      var p = Object.assign({}, props); var v = p.variant || 'default', s = p.size || 'default'; delete p.variant; delete p.size;
      p.ref = ref; p.className = cx('inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none', buttonVariants[v] || buttonVariants['default'], buttonSizes[s] || buttonSizes['default'], props.className);
      return h('button', p);
    });
    var badgeVariants = { default: 'bg-slate-900 text-white', secondary: 'bg-slate-100 text-slate-900', outline: 'border border-slate-200 text-slate-900', destructive: 'bg-red-600 text-white' };
    var Badge = function(props){ var p = Object.assign({}, props); var v = p.variant || 'default'; delete p.variant; p.className = cx('inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold', badgeVariants[v] || badgeVariants['default'], props.className); return h('div', p); };
    var alertVariants = { default: 'bg-white text-slate-900 border-slate-200', destructive: 'border-red-200 bg-red-50 text-red-900' };
    var Alert = function(props){ var p = Object.assign({}, props); var v = p.variant || 'default'; delete p.variant; p.role = 'alert'; p.className = cx('relative w-full rounded-lg border p-4 text-sm', alertVariants[v] || alertVariants['default'], props.className); return h('div', p); };
    var TabsCtx = R.createContext(null);
    var Tabs = function(props){
      var st = R.useState(props.defaultValue); var value = props.value !== undefined ? props.value : st[0];
      var set = function(v){ if (props.value === undefined) st[1](v); if (props.onValueChange) props.onValueChange(v); };
      var p = Object.assign({}, props); delete p.defaultValue; delete p.value; delete p.onValueChange; p.className = cx('w-full', props.className);
      return h(TabsCtx.Provider, { value: { value: value, set: set } }, h('div', p));
    };
    var TabsList = part('div', 'inline-flex h-9 items-center justify-center rounded-lg bg-slate-100 p-1 text-slate-500');
    var TabsTrigger = function(props){
      var ctx = R.useContext(TabsCtx) || {}; var active = ctx.value === props.value;
      var p = Object.assign({}, props); delete p.value; p.type = 'button'; p.role = 'tab'; p['aria-selected'] = active;
      p.onClick = function(e){ if (ctx.set) ctx.set(props.value); if (props.onClick) props.onClick(e); };
      p.className = cx('inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium transition-all', active ? 'bg-white text-slate-900 shadow' : 'hover:text-slate-900', props.className);
      return h('button', p);
    };
    var TabsContent = function(props){
      var ctx = R.useContext(TabsCtx) || {}; if (ctx.value !== props.value) return null;
      var p = Object.assign({}, props); delete p.value; p.role = 'tabpanel'; p.className = cx('mt-2', props.className); return h('div', p);
    };
    var Progress = function(props){
      var v = Math.max(0, Math.min(100, Number(props.value) || 0)); var p = Object.assign({}, props); delete p.value;
      p.className = cx('relative h-2 w-full overflow-hidden rounded-full bg-slate-100', props.className);
      return h('div', p, h('div', { className: 'h-full bg-slate-900 transition-all', style: { width: v + '%' } }));
    };
    var Switch = function(props){
      var st = R.useState(!!props.defaultChecked); var on = props.checked !== undefined ? props.checked : st[0];
      return h('button', { type: 'button', role: 'switch', 'aria-checked': on, onClick: function(){ var n = !on; if (props.checked === undefined) st[1](n); if (props.onCheckedChange) props.onCheckedChange(n); }, className: cx('inline-flex h-5 w-9 items-center rounded-full transition-colors', on ? 'bg-slate-900' : 'bg-slate-200', props.className) },
        h('span', { className: cx('block h-4 w-4 rounded-full bg-white shadow transition-transform', on ? 'translate-x-4' : 'translate-x-0.5') }));
    };
    // A native select behind the shadcn names: SelectItem children become options.
    var SelectCtx = R.createContext(null);
    var Select = function(props){
      var items = []; (function walk(children){ R.Children.forEach(children, function(c){ if (!c || !c.props) return; if (c.type === SelectItem) items.push(c); else walk(c.props.children); }); })(props.children);
      var st = R.useState(props.defaultValue || ''); var value = props.value !== undefined ? props.value : st[0];
      return h('select', { value: value, className: cx('h-9 rounded-md border border-slate-200 bg-white px-3 text-sm', props.className), onChange: function(e){ if (props.value === undefined) st[1](e.target.value); if (props.onValueChange) props.onValueChange(e.target.value); } },
        items.map(function(item){ return h('option', { key: item.props.value, value: item.props.value }, item.props.children); }));
    };
    var SelectItem = function(){ return null; };
    var passthrough = function(props){ return props.children || null; };
    return {
      card: { Card: part('div', 'rounded-xl border border-slate-200 bg-white text-slate-900 shadow-sm'), CardHeader: part('div', 'flex flex-col space-y-1.5 p-6'), CardTitle: part('h3', 'font-semibold leading-none tracking-tight'), CardDescription: part('p', 'text-sm text-slate-500'), CardContent: part('div', 'p-6 pt-0'), CardFooter: part('div', 'flex items-center p-6 pt-0') },
      button: { Button: Button },
      badge: { Badge: Badge },
      tabs: { Tabs: Tabs, TabsList: TabsList, TabsTrigger: TabsTrigger, TabsContent: TabsContent },
      alert: { Alert: Alert, AlertTitle: part('h5', 'mb-1 font-medium leading-none tracking-tight'), AlertDescription: part('div', 'text-sm opacity-90') },
      input: { Input: part('input', 'flex h-9 w-full rounded-md border border-slate-200 bg-white px-3 py-1 text-sm placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-300') },
      label: { Label: part('label', 'text-sm font-medium leading-none') },
      textarea: { Textarea: part('textarea', 'flex min-h-[60px] w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm') },
      progress: { Progress: Progress },
      separator: { Separator: part('div', 'h-px w-full bg-slate-200') },
      table: { Table: part('table', 'w-full caption-bottom text-sm'), TableHeader: part('thead', '[&_tr]:border-b'), TableBody: part('tbody', '[&_tr:last-child]:border-0'), TableFooter: part('tfoot', 'border-t bg-slate-50 font-medium'), TableRow: part('tr', 'border-b border-slate-100 transition-colors hover:bg-slate-50'), TableHead: part('th', 'h-10 px-2 text-left align-middle font-medium text-slate-500'), TableCell: part('td', 'p-2 align-middle'), TableCaption: part('caption', 'mt-4 text-sm text-slate-500') },
      select: { Select: Select, SelectItem: SelectItem, SelectTrigger: passthrough, SelectValue: function(){ return null; }, SelectContent: passthrough, SelectGroup: passthrough, SelectLabel: function(){ return null; } },
      switch: { Switch: Switch },
      skeleton: { Skeleton: part('div', 'animate-pulse rounded-md bg-slate-100') },
    };
  }
})();
`

function prelude(): string {
  const globals = Object.fromEntries(Object.entries(ARTIFACT_MODULES).map(([name, def]) => [name, def.global]))
  return PRELUDE.replace('__MODULES__', JSON.stringify(globals)).replace('__UI__', JSON.stringify(ARTIFACT_UI_COMPONENTS.join(',')))
}

/** The module specifiers compiled code requires. */
function requiredModules(code: string): string[] {
  return [...new Set([...code.matchAll(/require\((['"])([^'"]+)\1\)/g)].map((m) => m[2]))]
}

/** The vendored scripts a set of modules needs, in load order, minus any the page already loads. */
function scriptsFor(modules: string[], html: string): string[] {
  const needed: string[] = []
  const add = (src: string) => { if (!needed.includes(src) && !html.includes(`src="${src}"`) && !html.includes(`src='${src}'`)) needed.push(src) }
  // JSX compiles to React.createElement, so React is needed even when no import names it.
  add(REACT)
  add(REACT_DOM)
  for (const name of modules) {
    if (/^@\/components\/ui\//.test(name)) continue
    for (const src of ARTIFACT_MODULES[name]?.scripts ?? []) add(src)
  }
  return needed
}

function compileError(message: string): string {
  const text = JSON.stringify(`This page's code could not be compiled: ${message}`).replace(/</g, '\\u003c')
  return `<script>window.__artifactError(new Error(${text}))</script>`
}

/**
 * Compile a page's JSX blocks for serving. Pages without any are returned
 * as they are. A block that fails to compile becomes an error panel naming
 * the problem — never a blank page.
 */
export function compileArtifactPage(html: string): string {
  if (!hasJsxScript(html)) return html
  const modules = new Set<string>()
  const compiled = html.replace(BABEL_STANDALONE, '').replace(JSX_SCRIPT, (_match, _before: string, _after: string, source: string) => {
    try {
      const { code } = transform(source, { transforms: ['typescript', 'jsx', 'imports'], production: true })
      for (const name of requiredModules(code)) modules.add(name)
      // A closing tag inside the code would end the script element early.
      const safe = code.replace(/<\/script/gi, '<\\/script')
      return `<script>(function(){var exports={},module={exports:exports},require=window.__artifactRequire;try{${safe}\n}catch(error){window.__artifactError(error);return}window.__artifactMount(module.exports);})();</script>`
    } catch (error) {
      return compileError(error instanceof Error ? error.message : String(error))
    }
  })
  // lucide's bundle looks for React under a lowercase global.
  const tags = scriptsFor([...modules], compiled).map((src) => `<script src="${src}"></script>${src === REACT ? '<script>window.react=window.React</script>' : ''}`)
  const head = `<script>${prelude()}</script>${tags.join('')}`
  // The runtime and libraries load before the first compiled block runs.
  const firstScript = compiled.search(/<script\b/i)
  return firstScript >= 0 ? `${compiled.slice(0, firstScript)}${head}${compiled.slice(firstScript)}` : `${head}${compiled}`
}

const FENCE = /^\s*```(?:jsx|tsx|javascript|js|typescript|ts|react)?\s*\n([\s\S]*?)\n```\s*$/i

/**
 * A React component answer — the shape of a Claude React artifact: a module
 * with a default-exported component, raw or in one fenced block.
 */
export function reactComponentOf(text: string): string | null {
  const trimmed = text.trim()
  const source = (FENCE.exec(trimmed)?.[1] ?? trimmed).trim()
  if (/^<!doctype|^<html/i.test(source)) return null
  if (!/\bexport\s+default\b/.test(source)) return null
  if (!/<[A-Za-z][\w.]*[\s>/]/.test(source)) return null
  if (!/^(?:import\b|export\b|const\b|function\b|\/\/|\/\*|'use client'|"use client"|type\b|interface\b)/.test(source)) return null
  return source
}

/** The heading a component renders first — its name as an artifact. */
export function reactTitleOf(source: string): string | null {
  const heading = /<h1[^>]*>([^<{]{3,160})</.exec(source)?.[1] ?? /<h2[^>]*>([^<{]{3,160})</.exec(source)?.[1]
  const title = heading?.replace(/\s+/g, ' ').trim()
  return title || null
}

/**
 * The page a React component is served as: Tailwind, a root, and the
 * component as a JSX block that the content route compiles.
 */
export function reactArtifactDocument(source: string, title?: string | null): string {
  const name = title ?? reactTitleOf(source) ?? 'Artifact'
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(name)}</title>
<script src="${TAILWIND_SCRIPT}"></script>
<style>html,body{margin:0}body{font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;color:#0f172a;background:#fff}</style>
</head>
<body>
<div id="root"></div>
<script type="text/jsx" data-artifact="react">
${source.replace(/<\/script/gi, '<\\/script')}
</script>
</body>
</html>`
}

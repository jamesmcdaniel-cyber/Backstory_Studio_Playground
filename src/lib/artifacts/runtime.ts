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

// JSX, TypeScript, and inline module scripts that import a library by name.
const JSX_SCRIPT = /<script\b([^>]*)\btype\s*=\s*["'](text\/(?:babel|jsx|tsx|typescript|ts)|module)["']([^>]*)>([\s\S]*?)<\/script>/gi
const BARE_IMPORT = /(?:^|[\n;])\s*import\s+(?:[\w*{}\s,]+\s+from\s+)?["'](?![./]|https?:)[^"']+["']/
// Python: <script type="text/python"> (or py/mpy) and PyScript's <py-script>.
const PY_SCRIPT = /<script\b([^>]*)\btype\s*=\s*["'](?:text\/(?:x-)?python|py|mpy)["']([^>]*)>([\s\S]*?)<\/script>|<py-script\b([^>]*)>([\s\S]*?)<\/py-script>/gi
// A code file shown as an artifact: its source, once (see codeArtifactDocument).
const SOURCE_BLOCK = /<script\b[^>]*\btype\s*=\s*["']text\/x-artifact-source["']([^>]*)>([\s\S]*?)<\/script>/i
const BABEL_STANDALONE = /<script\b[^>]*\bsrc\s*=\s*["'][^"']*babel[^"']*standalone[^"']*["'][^>]*>\s*<\/script>/gi

/** Whether HTML carries JSX or TypeScript the server must compile (a module script counts only when it imports a library). */
export function hasJsxScript(html: string): boolean {
  for (const match of html.matchAll(JSX_SCRIPT)) {
    if (match[2] !== 'module') return true
    if (!/\bsrc\s*=/.test(`${match[1]} ${match[3]}`) && BARE_IMPORT.test(match[4])) return true
  }
  return false
}

/** Whether a page runs Python in the browser (its policy then allows WebAssembly and the Python runtime's files). */
export function hasPythonScript(html: string): boolean {
  PY_SCRIPT.lastIndex = 0
  return PY_SCRIPT.test(html) || /data-lang\s*=\s*["']python["']/.test(SOURCE_BLOCK.exec(html)?.[1] ?? '')
}

function needsRuntime(html: string): boolean {
  return hasJsxScript(html) || hasPythonScript(html) || SOURCE_BLOCK.test(html)
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

function compileBlock(source: string, modules: Set<string>, before = ''): string {
  try {
    const { code } = transform(source, { transforms: ['typescript', 'jsx', 'imports'], production: true })
    for (const name of requiredModules(code)) modules.add(name)
    // A closing tag inside the code would end the script element early.
    const safe = code.replace(/<\/script/gi, '<\\/script')
    // Async, so a module's top-level await works; it runs synchronously up to
    // the first await, like the script it replaces.
    return `<script>(async function(){var exports={},module={exports:exports},require=window.__artifactRequire;${before}try{${safe}\n}catch(error){window.__artifactError(error);return}window.__artifactMount(module.exports);})();</script>`
  } catch (error) {
    return compileError(error instanceof Error ? error.message : String(error))
  }
}

function decodeText(value: string): string {
  return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
}

/** Runs each Python block in order with Pyodide; print() output lands under the block, or in the element its data-output names. */
const PYTHON_RUNNER = String.raw`
(async function(){
  var blocks = Array.prototype.slice.call(document.querySelectorAll('script[type="text/x-artifact-python"]'));
  if (!blocks.length) return;
  var badge = document.createElement('div');
  badge.setAttribute('style','position:fixed;right:12px;bottom:12px;z-index:2147483646;background:#0f172a;color:#fff;border-radius:999px;padding:6px 12px;font:12px ui-sans-serif,system-ui,sans-serif;opacity:.9');
  badge.textContent = 'Starting Python…';
  document.body.appendChild(badge);
  try {
    var py = await window.loadPyodide({ indexURL: '/vendor/pyodide/' });
    window.pyodide = py;
    for (var i = 0; i < blocks.length; i++) {
      var block = blocks[i];
      var named = block.getAttribute('data-output');
      var target = named ? document.getElementById(named) : null;
      if (!target) {
        target = document.createElement('pre');
        target.setAttribute('style','background:#0f172a;color:#e2e8f0;border-radius:10px;padding:12px 14px;font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;margin:8px 0');
        block.parentNode.insertBefore(target, block.nextSibling);
      }
      (function(t){ var w = function(line){ t.appendChild(document.createTextNode(line + '\n')); }; py.setStdout({ batched: w }); py.setStderr({ batched: w }); })(target);
      var code = block.textContent;
      badge.textContent = 'Running Python…';
      await py.loadPackagesFromImports(code, { messageCallback: function(){} });
      var result = await py.runPythonAsync(code);
      if (result !== undefined && result !== null && !target.textContent) target.textContent = String(result);
      if (!named && !target.textContent) target.remove();
    }
  } catch (error) {
    window.__artifactError(error);
  } finally {
    badge.remove();
  }
})();
`

const CONSOLE_CAPTURE = "var __out=document.getElementById('__console');var __orig=window.console;var __w=function(kind){return function(){var text=Array.prototype.map.call(arguments,function(a){if(typeof a==='string')return a;try{return JSON.stringify(a,null,2)}catch(e){return String(a)}}).join(' ');if(__out){var line=document.createElement('div');line.className='line '+kind;line.textContent=text;__out.appendChild(line)}if(__orig[kind])__orig[kind].apply(__orig,arguments)}};var console=Object.assign({},__orig,{log:__w('log'),info:__w('info'),warn:__w('warn'),error:__w('error'),table:__w('log')});window.console=console;window.addEventListener('error',function(e){console.error(String(e.error||e.message))});"

const SPECIMEN = '<div class="specimen"><h1>Heading one</h1><h2>Heading two</h2><h3>Heading three</h3><p>Body text with <a href="#">a link</a>, <strong>strong</strong> and <em>emphasis</em>.</p><p><button>Button</button> <button class="primary btn btn-primary">Primary</button> <input placeholder="Input"> <select><option>Select</option></select></p><ul><li>List item</li><li>List item</li></ul><blockquote>A quotation.</blockquote><table><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody><tr><td>Alpha</td><td>1</td></tr><tr><td>Beta</td><td>2</td></tr></tbody></table><div class="card"><h3>Card</h3><p>Content inside a .card.</p></div><code>inline code</code></div>'

/** A code file's source block, expanded: highlighted source, then what the code does. */
function expandSource(html: string, modules: Set<string>): string {
  const match = SOURCE_BLOCK.exec(html)
  if (!match) return html
  const lang = /data-lang\s*=\s*["']([a-z]+)["']/.exec(match[1])?.[1] ?? 'javascript'
  const source = match[2].replace(/<\\\/script/gi, '</script')
  const show = `<script type="text/plain" id="__artifact_source">${match[2]}</script><script>(function(){var v=document.getElementById('__source_view');if(v){v.textContent=document.getElementById('__artifact_source').textContent.replace(/^\\n/,'');if(window.hljs)window.hljs.highlightElement(v);}})();</script>`
  let run = ''
  if (lang === 'python') run = `<script type="text/x-artifact-python" data-output="__console">${match[2]}</script>`
  else if (lang === 'css') {
    const css = JSON.stringify(source.replace(/(^|[\s,}])(html|body|:root)(?=[\s,{.:#[])/g, '$1.specimen')).replace(/</g, '\\u003c')
    run = `<script>(function(){var host=document.getElementById('__specimen');if(!host)return;var root=host.attachShadow({mode:'open'});root.innerHTML='<style>'+${css}+'</style>'+${JSON.stringify(SPECIMEN)};})();</script>`
  } else run = compileBlock(source, modules, CONSOLE_CAPTURE)
  return html.replace(match[0], `${show}${run}`)
}

/**
 * Compile a page for serving: JSX, TypeScript and library-importing module
 * scripts become plain script; Python blocks get the in-browser runtime; a
 * code file's source becomes its view and its output. Pages with none of
 * these are returned as they are. A block that fails to compile becomes an
 * error panel naming the problem — never a blank page.
 */
export function compileArtifactPage(html: string): string {
  if (!needsRuntime(html)) return html
  const modules = new Set<string>()
  const python = hasPythonScript(html)
  const isCodeFile = SOURCE_BLOCK.test(html)
  let compiled = html.replace(BABEL_STANDALONE, '')
  compiled = expandSource(compiled, modules)
  compiled = compiled.replace(JSX_SCRIPT, (whole: string, before: string, type: string, after: string, source: string) => {
    // A module that loads from a URL, or imports nothing by name, runs as written.
    if (type === 'module' && (/\bsrc\s*=/.test(`${before} ${after}`) || !BARE_IMPORT.test(source))) return whole
    return compileBlock(source, modules)
  })
  compiled = compiled.replace(PY_SCRIPT, (_whole: string, before?: string, after?: string, source?: string, pyAttrs?: string, pySource?: string) => {
    const attrs = `${before ?? ''} ${after ?? ''} ${pyAttrs ?? ''}`.replace(/\btype\s*=\s*["'][^"']*["']/, '').trim()
    const code = source ?? decodeText(pySource ?? '')
    return `<script type="text/x-artifact-python" ${attrs}>${code.replace(/<\/script/gi, '<\\/script')}</script>`
  })
  // lucide's bundle looks for React under a lowercase global.
  const jsx = modules.size > 0 || hasJsxScript(html)
  const tags = (jsx ? scriptsFor([...modules], compiled) : [...modules].flatMap((name) => ARTIFACT_MODULES[name]?.scripts ?? []))
    .filter((src, index, all) => all.indexOf(src) === index)
    .map((src) => `<script src="${src}"></script>${src === REACT ? '<script>window.react=window.React</script>' : ''}`)
  if (isCodeFile) tags.push('<script src="/vendor/highlight.min.js"></script>')
  if (python) tags.push('<script src="/vendor/pyodide/pyodide.js"></script>')
  const head = `<script>${prelude()}</script>${tags.join('')}`
  // The runtime and libraries load before the first page script runs.
  const firstScript = compiled.search(/<script\b/i)
  const withHead = firstScript >= 0 ? `${compiled.slice(0, firstScript)}${head}${compiled.slice(firstScript)}` : `${head}${compiled}`
  return python ? withHead.replace(/<\/body>(?![\s\S]*<\/body>)/i, `<script>${PYTHON_RUNNER}</script></body>`) : withHead
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

export type CodeLanguage = 'typescript' | 'javascript' | 'python' | 'css'

const LANGUAGE_LABEL: Record<CodeLanguage, string> = { typescript: 'TypeScript', javascript: 'JavaScript', python: 'Python', css: 'CSS' }

/** The language a code file's name says it is. */
export function codeLanguageOf(filename: string): CodeLanguage | null {
  const ext = /\.([a-z0-9]+)$/i.exec(filename)?.[1]?.toLowerCase()
  if (ext === 'py') return 'python'
  if (ext === 'ts' || ext === 'tsx' || ext === 'mts' || ext === 'cts') return 'typescript'
  if (ext === 'js' || ext === 'jsx' || ext === 'mjs' || ext === 'cjs') return 'javascript'
  if (ext === 'css') return 'css'
  return null
}

const HLJS_THEME = ".hljs{color:#24292e;background:#fff}.hljs-doctag,.hljs-keyword,.hljs-meta .hljs-keyword,.hljs-template-tag,.hljs-template-variable,.hljs-type,.hljs-variable.language_{color:#d73a49}.hljs-title,.hljs-title.class_,.hljs-title.class_.inherited__,.hljs-title.function_{color:#6f42c1}.hljs-attr,.hljs-attribute,.hljs-literal,.hljs-meta,.hljs-number,.hljs-operator,.hljs-selector-attr,.hljs-selector-class,.hljs-selector-id,.hljs-variable{color:#005cc5}.hljs-meta .hljs-string,.hljs-regexp,.hljs-string{color:#032f62}.hljs-built_in,.hljs-symbol{color:#e36209}.hljs-code,.hljs-comment,.hljs-formula{color:#6a737d}.hljs-name,.hljs-quote,.hljs-selector-pseudo,.hljs-selector-tag{color:#22863a}.hljs-section{color:#005cc5;font-weight:700}.hljs-addition{color:#22863a;background-color:#f0fff4}.hljs-deletion{color:#b31d28;background-color:#ffeef0}"

/**
 * A code file as an artifact, like a Claude code artifact that also runs:
 * the highlighted source beside what it does — the console for TypeScript and
 * JavaScript, printed output for Python, a styled specimen for CSS. The
 * source is stored once (the assistant edits it there); the content route
 * expands it when the page is served.
 */
export function codeArtifactDocument(source: string, language: CodeLanguage, filename: string): string {
  const output = language === 'css'
    ? '<h2>Preview</h2><div id="__specimen"></div>'
    : `<h2>${language === 'python' ? 'Output' : 'Console'}</h2><div id="__console" class="console"></div>`
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(filename)}</title>
<style>
html,body{margin:0}body{font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;color:#0f172a;background:#f8fafc}
header{display:flex;align-items:center;gap:10px;padding:14px 20px;border-bottom:1px solid #e2e8f0;background:#fff}
header b{font-size:15px}header span{font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#475569;background:#f1f5f9;border-radius:999px;padding:3px 9px}
main{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,1fr);gap:16px;padding:16px 20px}
@media(max-width:900px){main{grid-template-columns:1fr}}
section{background:#fff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;min-height:200px}
h2{margin:0;padding:10px 14px;font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#64748b;border-bottom:1px solid #e2e8f0;background:#f8fafc}
pre{margin:0}pre code{display:block;padding:14px;font:12.5px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;overflow:auto;max-height:calc(100vh - 140px)}
.console{padding:10px 14px;font:12.5px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;background:#0f172a;color:#e2e8f0;min-height:160px;margin:0}
.console .line{padding:1px 0}.console .warn{color:#fcd34d}.console .error{color:#fca5a5}
#__specimen{padding:16px}
${HLJS_THEME}
</style>
</head>
<body>
<header><b>${escapeHtml(filename)}</b><span>${LANGUAGE_LABEL[language]}</span></header>
<main>
<section><h2>Source</h2><pre><code id="__source_view" class="language-${language}"></code></pre></section>
<section>${output}</section>
</main>
<script type="text/x-artifact-source" data-lang="${language}" data-filename="${escapeHtml(filename)}">
${source.replace(/<\/script/gi, '<\\/script')}
</script>
</body>
</html>`
}

/**
 * What an uploaded file becomes: an HTML page as it is; a React component
 * (a .jsx/.tsx — or .js/.ts — with a default-exported component) as a React
 * page; any other TypeScript, JavaScript, Python or CSS file as a code page.
 */
export function artifactDocumentForUpload(content: string, filename: string): { content: string; kind: 'page' | 'report' } | null {
  if (/\.html?$/i.test(filename) || /^\s*<(?:!doctype|html)\b/i.test(content)) {
    return { content, kind: /<script[\s>]/i.test(content) ? 'page' : 'report' }
  }
  const language = codeLanguageOf(filename)
  if (!language) return null
  if (language === 'typescript' || language === 'javascript') {
    const component = reactComponentOf(content)
    if (component) return { content: reactArtifactDocument(component), kind: 'page' }
  }
  return { content: codeArtifactDocument(content, language, filename), kind: 'page' }
}

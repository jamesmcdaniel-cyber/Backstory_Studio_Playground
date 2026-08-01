/**
 * Minimal jsdom environment for React component tests run under `tsx --test`.
 * Import this FIRST (before react-dom) so the DOM globals exist at module load.
 */
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
const win = dom.window as unknown as Record<string, unknown>
const g = globalThis as unknown as Record<string, unknown>

// Copy DOM constructors/globals React and Testing Library expect. Some globals
// (navigator) are read-only on Node 22 — define them non-fatally.
// NodeFilter/TreeWalker are what Radix's focus scope walks a dialog with, so
// they belong here rather than in each dialog test.
// localStorage is here so client-cache tests can assert on it as a bare global,
// the way a browser exposes it — the modules under test read window.localStorage
// and both point at the same jsdom Storage instance.
// Element/ShadowRoot/DOMRect are what Radix's popover positioning (floating-ui)
// reaches for as bare globals — same rationale as NodeFilter above.
const keys = ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Element', 'ShadowRoot', 'DOMRect', 'Node', 'NodeFilter', 'TreeWalker', 'Event', 'CustomEvent', 'KeyboardEvent', 'InputEvent', 'MouseEvent', 'PointerEvent', 'FocusEvent', 'getComputedStyle', 'DocumentFragment', 'Range', 'Text', 'MutationObserver', 'requestAnimationFrame', 'cancelAnimationFrame', 'localStorage']
g.window = dom.window
for (const key of keys) {
  if (key === 'window') continue
  try { g[key] = win[key] } catch { /* read-only global, skip */ }
}
try {
  Object.defineProperty(g, 'navigator', { value: win.navigator, configurable: true })
} catch { /* leave Node's navigator */ }
// jsdom ships no ResizeObserver; floating-ui constructs one to track anchors.
// A no-op is enough — tests assert on content, not on measured position.
if (!g.ResizeObserver) {
  g.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}

// React 18 act() environment flag.
g.IS_REACT_ACT_ENVIRONMENT = true

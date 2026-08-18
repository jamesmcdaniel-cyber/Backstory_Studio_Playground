/**
 * WCAG AA contrast guard for the design-token layer.
 *
 * This test does NOT compare token values against a list of expected strings —
 * it parses the real token declarations out of `backstory-design.css`,
 * `globals.css` and `tailwind.config.js`, resolves `var(--…)` chains, converts
 * hex / `H S% L%` triples to sRGB and computes the WCAG relative-luminance
 * contrast ratio. Change a token to a non-compliant value and this fails,
 * whatever the value happens to be.
 *
 * Thresholds (WCAG 2.1):
 *   - 4.5:1 for normal-size body text (1.4.3)
 *   - 3:1   for large text and non-text UI components (1.4.3 / 1.4.11)
 *
 * Background on the ruling this encodes: `graphite-400` (#ABABAD) is 2.29:1 on
 * white and stays that way on purpose — it is a locked brand scale stop used
 * for borders, dividers and decorative marks, where contrast minima do not
 * apply. Muted *text* uses `--fg-muted` instead.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

const ROOT = path.resolve(__dirname, '../../..')
const DESIGN_CSS = path.join(ROOT, 'src/app/backstory-design.css')
const GLOBALS_CSS = path.join(ROOT, 'src/app/globals.css')
const TAILWIND_CONFIG = path.join(ROOT, 'tailwind.config.js')

const AA_TEXT = 4.5
const AA_LARGE = 3

/* ------------------------------------------------------------------ parsing */

/** Pull the declarations inside the first `selector { … }` block of a file. */
function readBlock(file: string, selector: string): Record<string, string> {
  const css = readFileSync(file, 'utf8')
  const start = css.indexOf(selector)
  assert.notEqual(start, -1, `${path.basename(file)} has no \`${selector}\` block`)
  const open = css.indexOf('{', start)
  const close = css.indexOf('\n}', open)
  assert.ok(open !== -1 && close !== -1, `unterminated \`${selector}\` block in ${file}`)
  const body = css.slice(open + 1, close).replace(/\/\*[\s\S]*?\*\//g, '')

  const out: Record<string, string> = {}
  for (const decl of body.split(';')) {
    const m = /^\s*(--[\w-]+)\s*:\s*([^;]+?)\s*$/.exec(decl)
    if (m) out[m[1]] = m[2]
  }
  return out
}

/** Brand scales live in the Tailwind config as plain JS objects. */
function readScale(name: string): Record<string, string> {
  const js = readFileSync(TAILWIND_CONFIG, 'utf8')
  const m = new RegExp(`const ${name} = \\{([\\s\\S]*?)\\}`).exec(js)
  assert.ok(m, `tailwind.config.js has no \`${name}\` scale`)
  const out: Record<string, string> = {}
  for (const [, stop, hex] of m[1].matchAll(/(\d+):\s*'(#[0-9A-Fa-f]{6})'/g)) out[stop] = hex.toUpperCase()
  assert.ok(Object.keys(out).length > 0, `no stops parsed from \`${name}\``)
  return out
}

/* ------------------------------------------------------------------- colour */

type RGB = [number, number, number]

function hexToRgb(hex: string): RGB {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as RGB
}

/** `240 18% 11%` — the shadcn token shape, consumed as `hsl(var(--x))`. */
function hslTripleToRgb(triple: string): RGB {
  const m = /^([\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/.exec(triple.trim())
  assert.ok(m, `not an \`H S% L%\` triple: "${triple}"`)
  const h = Number(m[1])
  const s = Number(m[2]) / 100
  const l = Number(m[3]) / 100
  const k = (n: number) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return [f(0), f(8), f(4)].map((v) => Math.round(255 * v)) as RGB
}

function relativeLuminance([r, g, b]: RGB): number {
  const [R, G, B] = [r, g, b].map((channel) => {
    const c = channel / 255
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * R + 0.7152 * G + 0.0722 * B
}

function contrast(a: RGB, b: RGB): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/* ---------------------------------------------------------------- resolution */

/** Follow `var(--x)` chains through a token map down to a literal colour. */
function makeResolver(tokens: Record<string, string>, hslTokens: Record<string, string> = {}) {
  return function resolve(name: string, seen = new Set<string>()): RGB {
    assert.ok(!seen.has(name), `circular token reference at ${name}`)
    seen.add(name)

    // shadcn tokens are bare `H S% L%` triples (consumed as `hsl(var(--x))`).
    // The same block may also carry ordinary hex tokens, which fall through.
    const triple = hslTokens[name]
    if (triple !== undefined && /^[\d.]+\s+[\d.]+%\s+[\d.]+%$/.test(triple.trim())) {
      return hslTripleToRgb(triple)
    }

    const raw = tokens[name]
    assert.ok(raw !== undefined, `undefined design token: ${name}`)
    const ref = /^var\(\s*(--[\w-]+)\s*\)$/.exec(raw)
    if (ref) return resolve(ref[1], seen)
    assert.match(raw, /^#[0-9A-Fa-f]{3,6}$/, `token ${name} is not a hex colour: "${raw}"`)
    return hexToRgb(raw)
  }
}

/* -------------------------------------------------------------------- suites */

const design = readBlock(DESIGN_CSS, ':root')
const lightShadcn = readBlock(GLOBALS_CSS, ':root')
const darkShadcn = readBlock(GLOBALS_CSS, '.dark')
const darkDesign = readBlock(GLOBALS_CSS, '.dark')
const graphite = readScale('graphite')

const light = makeResolver(design, lightShadcn)
// Dark overrides sit in `.dark`; anything it does not redeclare falls through
// to the `:root` design tokens.
const dark = makeResolver({ ...design, ...darkDesign }, darkShadcn)

type Pair = [fg: string, bg: string, min?: number]

/** Semantic foreground/background pairs on the light ground. */
const LIGHT_PAIRS: Pair[] = [
  ['--fg-1', '--bg-page'],
  ['--fg-1', '--bg-muted'],
  ['--fg-2', '--bg-page'],
  ['--fg-2', '--bg-muted'],
  ['--fg-3', '--bg-page'],
  ['--fg-3', '--bg-muted'],
  ['--fg-4', '--bg-page'],
  ['--fg-4', '--bg-muted'],
  ['--fg-muted', '--bg-page'],
  ['--fg-muted', '--bg-surface'],
  ['--fg-muted', '--bg-muted'],
  ['--fg-link', '--bg-page'],
  ['--fg-accent', '--bg-page'],
  ['--fg-on-blue', '--horizon-500'],
  ['--fg-on-blue', '--horizon-700'],
  ['--status-good-fg', '--status-good-bg'],
  ['--status-warn-fg', '--status-warn-bg'],
  ['--status-risk-fg', '--status-risk-bg'],
  ['--status-info-fg', '--status-info-bg'],
  ['--cinder-40', '--bg-page'],
  ['--white', '--cinder-30'],
  // Non-text UI: the focus ring only has to clear 3:1 against the page.
  ['--border-strong', '--bg-page', AA_LARGE],
]

/** shadcn token pairs — these back every UI primitive, in both themes. */
const SHADCN_PAIRS: Pair[] = [
  ['--foreground', '--background'],
  ['--card-foreground', '--card'],
  ['--popover-foreground', '--popover'],
  ['--muted-foreground', '--background'],
  ['--muted-foreground', '--card'],
  ['--muted-foreground', '--muted'],
  ['--primary-foreground', '--primary'],
  ['--secondary-foreground', '--secondary'],
  ['--accent-foreground', '--accent'],
  ['--destructive-foreground', '--destructive'],
  // `text-destructive` is used as plain text on the page, not just as a fill.
  ['--destructive', '--background'],
  ['--destructive', '--card'],
  // Focus ring / input border are UI components, not text.
  ['--ring', '--background', AA_LARGE],
]

function check(resolve: ReturnType<typeof makeResolver>, [fg, bg, min = AA_TEXT]: Pair) {
  const ratio = contrast(resolve(fg), resolve(bg))
  assert.ok(
    ratio >= min,
    `${fg} on ${bg} is ${ratio.toFixed(2)}:1 — below the ${min}:1 WCAG AA floor`,
  )
}

describe('palette contrast (WCAG AA)', () => {
  it('computes the reference ratios correctly', () => {
    // Sanity-check the formula itself against known values before trusting it.
    assert.equal(contrast(hexToRgb('#000000'), hexToRgb('#FFFFFF')).toFixed(0), '21')
    assert.equal(contrast(hexToRgb('#FFFFFF'), hexToRgb('#FFFFFF')).toFixed(0), '1')
    assert.equal(contrast(hexToRgb('#767676'), hexToRgb('#FFFFFF')).toFixed(1), '4.5')
  })

  for (const pair of LIGHT_PAIRS) {
    it(`light: ${pair[0]} on ${pair[1]}`, () => check(light, pair))
  }

  for (const pair of SHADCN_PAIRS) {
    it(`shadcn light: ${pair[0]} on ${pair[1]}`, () => check(light, pair))
    it(`shadcn dark: ${pair[0]} on ${pair[1]}`, () => check(dark, pair))
  }

  it('dark: --fg-muted clears AA on the dark surfaces', () => {
    for (const bg of ['--background', '--card', '--muted']) {
      const ratio = contrast(dark('--fg-muted'), dark(bg))
      assert.ok(ratio >= AA_TEXT, `--fg-muted on ${bg} is ${ratio.toFixed(2)}:1 in dark mode`)
    }
  })

  it('the muted text token never resolves back onto a failing graphite stop', () => {
    // The specific regression this guards: --fg-muted / --fg-3 / --fg-4 being
    // pointed back at graphite-400 or -500, which cannot pass on white.
    const failing = ['400', '500'].map((stop) => hexToRgb(graphite[stop]).join(','))
    for (const token of ['--fg-muted', '--fg-3', '--fg-4']) {
      assert.ok(
        !failing.includes(light(token).join(',')),
        `${token} resolves to a graphite stop that fails AA on white`,
      )
    }
  })

  it('graphite-400 is still below AA — it is decoration only, never text', () => {
    // If someone "fixes" the brand stop instead of the text token, the fix
    // belongs in the design system, not silently here.
    const ratio = contrast(hexToRgb(graphite['400']), hexToRgb('#FFFFFF'))
    assert.ok(ratio < AA_TEXT, 'graphite-400 changed — revisit the muted-text ruling')
  })
})

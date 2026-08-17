import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  REPORT_CSS,
  REPORT_HTML_INSTRUCTION,
  REPORT_THEMES,
  emailSafeReportHtml,
  reportDocument,
  themeForKind,
} from '../report-format.js'

describe('report themes', () => {
  it('gives every artifact family its own palette, with revenue as the default', () => {
    for (const theme of ['revenue', 'account', 'brief', 'cockpit', 'overview', 'coaching'] as const) {
      assert.ok(REPORT_THEMES[theme], `missing palette for ${theme}`)
      if (theme !== 'revenue') {
        assert.ok(REPORT_CSS.includes(`.theme-${theme}{`), `stylesheet missing .theme-${theme}`)
        assert.notDeepEqual(REPORT_THEMES[theme], REPORT_THEMES.revenue, `${theme} must not reuse the revenue palette`)
      }
    }
  })

  it('drives all accent styling through theme variables, not hardcoded emerald', () => {
    for (const selector of ['.eyebrow', '.summary', '.prio-high', '.pill', '.dot', '.hero']) {
      const rule = REPORT_CSS.split('\n').find((l) => l.startsWith(selector))
      assert.ok(rule && /var\(--/.test(rule), `${selector} should use a theme variable`)
    }
  })

  it('classifies report kinds into the family the prompt advertises', () => {
    assert.equal(themeForKind('Account plan'), 'account')
    assert.equal(themeForKind('Renewal prep brief'), 'brief')
    assert.equal(themeForKind('Executive daily brief'), 'brief')
    assert.equal(themeForKind('Regression monitor report'), 'cockpit')
    assert.equal(themeForKind('Implementation gap audit'), 'overview')
    assert.equal(themeForKind('Coaching intelligence report'), 'coaching')
    assert.equal(themeForKind('Account readiness scorecard'), 'coaching')
    assert.equal(themeForKind('Upsell intelligence report'), 'revenue')
  })

  it('stamps the theme class on the document wrapper', () => {
    assert.ok(reportDocument('body', 'account').includes('<div class="report theme-account">'))
    assert.ok(reportDocument('body').includes('<div class="report">'), 'no theme keeps the plain wrapper')
    assert.ok(reportDocument('body', 'revenue').includes('<div class="report">'), 'revenue IS the default wrapper')
  })
})

describe('emailSafeReportHtml', () => {
  it('resolves every theme var() to the literal palette color for the detected theme', () => {
    const doc = reportDocument('<p class="eyebrow">Brief</p>', 'account')
    const out = emailSafeReportHtml(doc)
    assert.ok(!/var\(--/.test(out), 'no var() may survive — Gmail strips custom properties')
    const [tint, , accent, strong] = REPORT_THEMES.account
    assert.ok(out.includes(`linear-gradient(135deg,${tint}`), 'hero gradient must carry the account tint')
    assert.ok(out.includes(`color:${strong}`), 'eyebrow must carry the account strong color')
    assert.ok(out.includes(`background:${accent}`), 'dot/bar must carry the account accent')
  })

  it('defaults to the revenue palette for the plain wrapper', () => {
    const out = emailSafeReportHtml(reportDocument('<p>x</p>'))
    assert.ok(!/var\(--/.test(out))
    assert.ok(out.includes(`color:${REPORT_THEMES.revenue[3]}`))
  })

  it('leaves non-report HTML untouched', () => {
    const plain = '<div style="max-width:600px"><h1>Hi</h1><p>var(--tint) as text</p></div>'
    assert.equal(emailSafeReportHtml(plain), plain)
  })
})

describe('REPORT_HTML_INSTRUCTION', () => {
  it('gates the HTML artifact behind a report-vs-conversation decision', () => {
    assert.ok(REPORT_HTML_INSTRUCTION.includes('REPORT DELIVERABLES vs CONVERSATION'))
    assert.ok(/draft-and-approve/.test(REPORT_HTML_INSTRUCTION), 'draft loops must stay conversational')
    assert.ok(/advice|answering questions/i.test(REPORT_HTML_INSTRUCTION), 'advice and Q&A must stay Markdown')
    assert.ok(/When in doubt, answer in Markdown/.test(REPORT_HTML_INSTRUCTION), 'Markdown is the tie-breaker')
  })

  it('teaches the per-family theme rule and the dynamic modules', () => {
    assert.ok(REPORT_HTML_INSTRUCTION.includes('REPORT THEME'))
    for (const theme of ['theme-brief', 'theme-account', 'theme-cockpit', 'theme-overview', 'theme-coaching']) {
      assert.ok(REPORT_HTML_INSTRUCTION.includes(theme), `instruction missing ${theme}`)
    }
    assert.ok(REPORT_HTML_INSTRUCTION.includes('DYNAMIC ELEMENTS'))
    for (const snippet of ['class="bar"', 'class="delta up"', 'class="tag"', 'class="tl"']) {
      assert.ok(REPORT_HTML_INSTRUCTION.includes(snippet), `instruction missing module ${snippet}`)
    }
    assert.ok(/Never invent numbers to feed a module/.test(REPORT_HTML_INSTRUCTION))
  })
})

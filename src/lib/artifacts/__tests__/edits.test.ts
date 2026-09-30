import test from 'node:test'
import assert from 'node:assert/strict'
import { applyTextEdits } from '../tools'
import { unsupportedScripts, vendorScripts } from '../vendor-scripts'

const page = '<html><body><h1>Cockpit</h1><script>const data = [12, 19, 7]; const label = "Q3"</script><p>Q3 pipeline</p></body></html>'

test('exact edits apply in order and leave everything else untouched', () => {
  const result = applyTextEdits(page, [{ find: '[12, 19, 7]', replace: '[14, 21, 9]' }, { find: '<h1>Cockpit</h1>', replace: '<h1>Rep cockpit</h1>' }])
  assert.ok('content' in result)
  assert.equal((result as { content: string }).content, page.replace('[12, 19, 7]', '[14, 21, 9]').replace('<h1>Cockpit</h1>', '<h1>Rep cockpit</h1>'))
})

test('a missing or ambiguous find rejects the whole set, with a reason', () => {
  assert.match((applyTextEdits(page, [{ find: '<h1>Cockpit</h1>', replace: 'x' }, { find: 'not there', replace: 'y' }]) as { error: string }).error, /Edit 2: .*not found/)
  assert.match((applyTextEdits(page, [{ find: 'Q3', replace: 'Q4' }]) as { error: string }).error, /more than once/)
  const all = applyTextEdits(page, [{ find: 'Q3', replace: 'Q4', all: true }]) as { content: string }
  assert.equal(all.content.includes('Q3'), false)
  assert.match((applyTextEdits(page, [{ find: 'Q3', replace: 'Q3', all: true }]) as { error: string }).error, /no change/)
})

test('CDN chart libraries are served from our own copies; anything else is reported', () => {
  const html = '<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script><script src="https://cdn.plot.ly/plotly-2.35.2.min.js"></script><script src="https://example.com/widget.js"></script>'
  const out = vendorScripts(html)
  assert.match(out, /src="\/vendor\/chart\.umd\.js"/)
  assert.match(out, /src="\/vendor\/plotly\.min\.js"/)
  assert.deepEqual(unsupportedScripts(html), ['https://example.com/widget.js'])
})

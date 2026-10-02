import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

test('artifact run feeds stay inside the copilot, never above the preview workspace', () => {
  const source = readFileSync('src/components/artifacts/artifact-viewer.tsx', 'utf8')
  const file = ts.createSourceFile('artifact-viewer.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let feeds = 0
  const visit = (node: ts.Node) => {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(file) === 'RunFeed') {
      feeds++
      let parent = node.parent
      while (parent && !(ts.isJsxElement(parent) && parent.openingElement.tagName.getText(file) === 'aside')) parent = parent.parent
      assert.ok(parent, 'run activity must be a descendant of the copilot aside')
      assert.ok(node.attributes.properties.some(p => ts.isJsxAttribute(p) && p.name.getText(file) === 'compact'))
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  assert.equal(feeds, 2, 'chat and initial-build execution feeds are both available')
  assert.doesNotMatch(source, /artifact\.versions\.length > 0 &&/, 'initial builds with no saved version still show the copilot')
  assert.match(source, /onStatusChange=\{refresh\}/, 'stable refresh callback avoids re-subscribing on every parent render')
})

test('idle artifact viewers poll for external publication and keep stable iframe identity', () => {
  const source = readFileSync('src/components/artifacts/artifact-viewer.tsx', 'utf8')
  assert.match(source, /useEffect\(\(\) => startVisibleInterval\(/)
  assert.doesNotMatch(source, /busy \? startVisibleInterval/)
  // The viewer follows the current version — once the assistant has finished,
  // so a run that saves several times reloads the page a single time.
  assert.match(source, /\[artifact\?\.currentVersionId, assistantWorking\]/)
})

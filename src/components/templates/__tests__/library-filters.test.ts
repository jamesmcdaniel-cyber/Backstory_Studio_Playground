import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The three library grids — agent templates, skills, and the flow-template
 * gallery on the Flows page — filter from ONE bar: a plain search box plus a
 * Category and a Role dropdown. These pin that, because each grid drifted into
 * its own control before (an AI prompt box on one, a two-line row of category
 * pills on another, search-only on the third).
 */

const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

const read = (rel: string) => stripComments(readFileSync(join(process.cwd(), rel), 'utf8'))

const bar = read('src/components/templates/library-filter-bar.tsx')
const templates = read('src/components/templates/templates-view.tsx')
const gallery = read('src/components/flows/flow-template-gallery.tsx')

test('every library grid filters from the shared bar', () => {
  for (const [name, source] of [['templates + skills', templates], ['flow gallery', gallery]] as const) {
    assert.match(source, /<LibraryFilterBar/, `${name} must use the shared filter bar`)
    assert.match(source, /onCategoryChange=/, `${name} must wire the category dropdown`)
    assert.match(source, /onRoleChange=/, `${name} must wire the role dropdown`)
    assert.match(source, /hasRole\(/, `${name} must actually apply the role filter`)
  }
})

test('the bar is a plain search box — no AI finder', () => {
  // The Templates library led with a prompt box whose Enter key called a model
  // and answered in a SEPARATE suggestions panel, leaving the grid you were
  // looking at unfiltered. Searching a library should filter the library.
  for (const [name, source] of [['bar', bar], ['templates + skills', templates]] as const) {
    assert.doesNotMatch(source, /Ask AI|ai-search|aiResults/, `${name} must not carry the AI finder`)
  }
  assert.match(bar, /placeholder=\{searchPlaceholder\}/, 'the bar must render a plain search input')
})

test('categories are a dropdown, not a row of pills', () => {
  // Ten-plus categories wrapped to two lines of chips and pushed the cards
  // below the fold on both surfaces.
  assert.match(bar, /<Select value=\{value\} onValueChange=\{onChange\}>/, 'the filters must be Select dropdowns')
  for (const [name, source] of [['templates + skills', templates], ['flow gallery', gallery]] as const) {
    assert.doesNotMatch(source, /activeCategories\.map|categories\.map/, `${name} must not render category chips itself`)
  }
})

test('the category dropdown is derived from what the grid actually holds', () => {
  for (const [name, source] of [['templates + skills', templates], ['flow gallery', gallery]] as const) {
    assert.match(source, /new Set\(/, `${name} must dedupe real categories rather than hardcode a list`)
  }
})

test('changing a filter returns the grid to page one', () => {
  // A narrower result set otherwise leaves the reader on a page that no longer
  // exists, which reads as an empty library.
  assert.match(templates, /const onRole = \(value: string\) => \{ setRole\(value\); resetPages\(\) \}/)
  assert.match(gallery, /const onRole = \(value: string\) => \{ setRole\(value\); setPage\(1\) \}/)
})

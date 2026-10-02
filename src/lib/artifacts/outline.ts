/**
 * A map of a large page for its assistant: where the headings, identified
 * elements, script and style blocks and top-level data live, by character
 * offset. A page too large to paste into the prompt used to be explored one
 * search at a time; with the map the assistant goes straight to the part a
 * request touches (read_artifact at an offset) instead of hunting for it.
 */

type Entry = { offset: number; label: string; weight: number }

const strip = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()

export function artifactOutline(content: string, max = 70): string {
  const entries: Entry[] = []
  const push = (offset: number, label: string, weight: number) => { entries.push({ offset, label: label.slice(0, 110), weight }) }

  // Script and style blocks, with their size: data and behaviour live here.
  for (const match of content.matchAll(/<(script|style)\b([^>]*)>/gi)) {
    const close = content.indexOf(`</${match[1].toLowerCase()}`, match.index)
    const size = close < 0 ? 0 : close - match.index
    const id = /\b(?:id|type|src)="([^"]{1,60})"/i.exec(match[2])?.[1]
    push(match.index, `<${match[1].toLowerCase()}${id ? ` ${id}` : ''}> ${size.toLocaleString()} chars`, 0)
  }
  // Headings, with their text.
  for (const match of content.matchAll(/<h([1-4])\b[^>]*>([\s\S]{0,200}?)<\/h\1>/gi)) {
    const text = strip(match[2])
    if (text) push(match.index, `h${match[1]} "${text}"`, 1)
  }
  // Elements someone gave an id to: sections, views, containers charts render into.
  for (const match of content.matchAll(/<([a-z][a-z0-9-]*)\b[^>]*\bid="([^"]{1,60})"/gi)) {
    if (!/^(script|style)$/i.test(match[1])) push(match.index, `<${match[1].toLowerCase()} #${match[2]}>`, 2)
  }
  // Top-level declarations: the data and the functions a change usually edits.
  for (const match of content.matchAll(/^[ \t]{0,4}(?:const|let|var|function|class|async function)\s+([A-Za-z_$][\w$]{2,})/gm)) {
    push(match.index, `js ${match[1]}`, /^[A-Z_]+$/.test(match[1]) ? 1 : 3)
  }

  if (!entries.length) return ''
  // Over budget: keep the most structural entries, then present in page order.
  const kept = entries.length > max ? [...entries].sort((a, b) => a.weight - b.weight || a.offset - b.offset).slice(0, max) : entries
  return kept.sort((a, b) => a.offset - b.offset).map((entry) => `@${entry.offset} ${entry.label}`).join('\n')
}

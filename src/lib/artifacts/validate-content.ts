import { Script } from 'node:vm'
import { transform } from 'sucrase'
import { ARTIFACT_MODULES, ARTIFACT_UI_COMPONENTS, reactComponentOf } from './runtime'

export const MAX_ARTIFACT_CHARS = 2_000_000

/**
 * ROI dashboards are rendered by the platform from computed data, not
 * written by a model, and carry that data (every rep × month, every closed
 * deal) so the page can slice it: a large account's report is a few MB.
 */
export const MAX_ROI_DASHBOARD_CHARS = 8_000_000

export function maxArtifactCharsFor(kind: string | null | undefined): number {
  return kind === 'roi_dashboard' ? MAX_ROI_DASHBOARD_CHARS : MAX_ARTIFACT_CHARS
}

/** Parse only, never execute generated JavaScript in the application process. */
export function validateArtifactContent(content: string, maxChars: number = MAX_ARTIFACT_CHARS): void {
  if (!content.trim()) throw new Error('Artifact content is empty.')
  if (content.length > maxChars) throw new Error(`Artifact exceeds ${maxChars} characters; split it into smaller artifacts. Nothing was saved.`)
  const component = reactComponentOf(content)
  const blocks = component ? [{ source: component, typed: true }] : [...content.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].flatMap((m) => {
    if (/\bsrc\s*=/.test(m[1])) return []
    const type = /\btype\s*=\s*["']([^"']+)["']/i.exec(m[1])?.[1] ?? 'text/javascript'
    if (type === 'text/x-artifact-source' && !/data-lang=["'](?:python|css)["']/.test(m[1])) return [{ source: m[2].replace(/<\\\/script/gi, '</script'), typed: true }]
    if (!['text/javascript', 'application/javascript', 'module', 'text/jsx', 'text/tsx', 'text/typescript', 'text/ts', 'text/babel'].includes(type)) return []
    return [{ source: m[2].replace(/<\\\/script/gi, '</script'), typed: type !== 'text/javascript' && type !== 'application/javascript' }]
  })
  for (const [index, block] of blocks.entries()) {
    try {
      if (block.typed) {
        const { code } = transform(block.source, { transforms: ['typescript', 'jsx', 'imports'], production: true })
        for (const match of code.matchAll(/require\((['"])([^'"]+)\1\)/g)) {
          const name = match[2]
          const ui = name.startsWith('@/components/ui/') && (ARTIFACT_UI_COMPONENTS as readonly string[]).includes(name.slice('@/components/ui/'.length))
          if (!(name in ARTIFACT_MODULES) && name !== '@backstory/artifact' && !ui) throw new Error(`Unsupported artifact import: ${name}. Available: ${Object.keys(ARTIFACT_MODULES).join(', ')}, @backstory/artifact, @/components/ui/*.`)
        }
        new Script(`(async function(){${code}\n})`)
      } else new Script(block.source)
    } catch (error) {
      throw new Error(`Artifact script ${index + 1} failed validation: ${error instanceof Error ? error.message : String(error)}. The current version was not changed.`)
    }
  }
}

/** Inline Python is parsed too. Dynamic Python strings still report runtime errors. */
export async function validateArtifactPython(content: string): Promise<void> {
  const blocks = [...content.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>|<py-script\b[^>]*>([\s\S]*?)<\/py-script>/gi)].flatMap(m => {
    if (m[3] !== undefined) return [m[3]]
    if (/type\s*=\s*["'](?:text\/(?:x-)?python|py|mpy)["']/i.test(m[1]) || (/text\/x-artifact-source/.test(m[1]) && /data-lang=["']python["']/.test(m[1]))) return [m[2].replace(/<\\\/script/gi, '</script')]
    return []
  })
  if (!blocks.length) return
  const { validatePythonSyntax } = await import('@/features/flows/code-runner')
  for (const source of blocks) {
    try { await validatePythonSyntax(source) }
    catch (e) { throw new Error(`Artifact Python failed validation: ${e instanceof Error ? e.message : String(e)}. The current version was not changed.`) }
  }
}

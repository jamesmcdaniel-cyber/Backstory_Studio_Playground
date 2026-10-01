/** Structural JSON Schema checks for the editor. Template values are deferred
 * to the provider at runtime; unsupported keywords are never guessed. */
export function toolArgumentIssues(value: unknown, schema: unknown, path = 'arguments', depth = 0): string[] {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) || depth > 20) return []
  if (typeof value === 'string' && /\{\{[\s\S]*?\}\}/.test(value)) return []
  const s = schema as Record<string, unknown>
  const issues: string[] = []
  const matches = (type: unknown) => {
    if (type === 'null') return value === null
    if (type === 'array') return Array.isArray(value)
    if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value)
    if (type === 'integer') return typeof value === 'number' && Number.isInteger(value)
    if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
    return !['string', 'boolean'].includes(String(type)) || typeof value === type
  }
  const types = Array.isArray(s.type) ? s.type : s.type ? [s.type] : []
  if (types.length && !types.some(matches)) return [`${path} must be ${types.join(' or ')}.`]
  if (Array.isArray(s.enum) && !s.enum.some(v => JSON.stringify(v) === JSON.stringify(value))) issues.push(`${path} must be one of ${s.enum.map(v => JSON.stringify(v)).join(', ')}.`)
  if (Array.isArray(value) && s.items) {
    value.slice(0, 1000).forEach((item, i) => issues.push(...toolArgumentIssues(item, s.items, `${path}[${i}]`, depth + 1)))
  } else if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>
    const properties = s.properties && typeof s.properties === 'object' ? s.properties as Record<string, unknown> : {}
    if (Array.isArray(s.required)) for (const key of s.required) {
      if (typeof key === 'string' && object[key] === undefined) issues.push(`${path}.${key} is required.`)
    }
    for (const [key, item] of Object.entries(object)) {
      if (Object.hasOwn(properties, key)) issues.push(...toolArgumentIssues(item, properties[key], `${path}.${key}`, depth + 1))
      else if (s.additionalProperties === false) issues.push(`${path}.${key} is not an allowed field.`)
    }
  }
  return issues.slice(0, 30)
}

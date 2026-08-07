/**
 * Provider identity behind a model id, for logo rendering — the slug feeds
 * IntegrationLogo (local asset or Simple Icons CDN). Matching is by substring
 * so custom/fine-tuned ids ("claude-sonnet-5", "qwen-3.7-instruct") still
 * resolve; null keeps the caller's generic icon.
 */
export function modelProviderBrand(model: string | undefined): { slug: string; name: string } | null {
  if (!model) return null
  const id = model.toLowerCase()
  if (id.includes('claude') || id.includes('anthropic')) return { slug: 'anthropic', name: 'Claude' }
  if (id.includes('qwen')) return { slug: 'qwen', name: 'Qwen' }
  if (id.includes('gpt') || id.includes('openai') || /^o\d/.test(id)) return { slug: 'openai', name: 'OpenAI' }
  if (id.includes('gemini')) return { slug: 'googlegemini', name: 'Gemini' }
  if (id.includes('llama')) return { slug: 'meta', name: 'Llama' }
  if (id.includes('mistral') || id.includes('mixtral')) return { slug: 'mistralai', name: 'Mistral' }
  if (id.includes('deepseek')) return { slug: 'deepseek', name: 'DeepSeek' }
  return null
}

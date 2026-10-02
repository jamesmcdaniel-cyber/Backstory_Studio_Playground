import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { ApiError } from '@/lib/server/api-handler'
import { rateLimit } from '@/lib/ratelimit'
import { clientIp } from '@/lib/security/events'
import { ARTIFACT_QUESTION_MAX_CHARS } from '@/lib/artifacts/service'
import { askGuestCopy, changeGuestCopyMcp, clearGuestCopyChat, testGuestCopyMcp, loadGuestCopy, openGuestCopy, replyGuestCopy, restoreGuestCopy } from '@/lib/artifacts/templates'
import { copilotMcpInputSchema } from '@/lib/artifacts/copilot-mcp'
import { GUEST_COOKIE } from '@/lib/artifacts/types'
import { readRequestJsonLimited } from '@/lib/server/request-body'

export const runtime = 'nodejs'

// /api/share/artifacts/:token/copilot — a public template's copilot for
// someone with no account. The link's token says which template (and only
// while its sender offers it); the visitor's own cookie token says which copy.
// Nothing else of the workspace is reachable: the copy is a locked template
// copy, and every limit is per client, per visitor and per link.

const tokenOf = (request: NextRequest) => request.nextUrl.pathname.split('/').at(-2) ?? ''

function failure(error: unknown) {
  if (error instanceof ApiError) return NextResponse.json({ success: false, error: error.message, code: error.code }, { status: error.status })
  console.error('guest copilot', error)
  return NextResponse.json({ success: false, error: 'The copilot is unavailable right now. Please try again.' }, { status: 500 })
}

async function limited(request: NextRequest, bucket: string, limit: number, windowMs: number) {
  const result = await rateLimit(`artifact-guest-${bucket}:${clientIp(request)}`, { limit, windowMs })
  return result.ok ? null : NextResponse.json({ success: false, error: 'Too many requests. Give it a minute.', code: 'RATE_LIMITED' }, { status: 429 })
}

// GET — the visitor's copy and conversation, when their cookie has one.
export async function GET(request: NextRequest) {
  const blocked = await limited(request, 'read', 120, 60_000)
  if (blocked) return blocked
  try {
    return NextResponse.json({ success: true, copilot: await loadGuestCopy(tokenOf(request), request.cookies.get(GUEST_COOKIE)?.value) }, { headers: { 'cache-control': 'private, no-store' } })
  } catch (error) {
    return failure(error)
  }
}

const Body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('open') }),
  z.object({ action: z.literal('ask'), message: z.string().trim().min(1).max(ARTIFACT_QUESTION_MAX_CHARS) }),
  z.object({ action: z.literal('reply'), message: z.string().trim().min(1).max(ARTIFACT_QUESTION_MAX_CHARS) }),
  z.object({ action: z.literal('restore'), versionId: z.string().min(1).max(64) }),
  z.object({ action: z.literal('new_chat') }),
  z.object({ action: z.literal('mcp_add'), server: copilotMcpInputSchema }),
  z.object({ action: z.literal('mcp_test'), server: copilotMcpInputSchema }),
  z.object({ action: z.literal('mcp_remove'), serverId: z.string().min(1).max(64) }),
])

// POST — open the copilot (the copy is made on first use), send it a message,
// answer the question it paused on, or restore an earlier version of the copy.
export async function POST(request: NextRequest) {
  // Anonymous ingress: the body is read against a byte ceiling, never whole.
  const parsed = Body.safeParse(await readRequestJsonLimited(request, 16_384).catch(() => null))
  if (!parsed.success) return NextResponse.json({ success: false, error: 'That request was not understood. Check what you entered and try again.', code: 'INVALID_BODY' }, { status: 400 })
  const guestToken = request.cookies.get(GUEST_COOKIE)?.value
  try {
    if (parsed.data.action === 'ask') {
      const blocked = await limited(request, 'ask', 6, 60_000)
      if (blocked) return blocked
      return NextResponse.json({ success: true, copilot: await askGuestCopy(tokenOf(request), guestToken, parsed.data.message) })
    }
    if (parsed.data.action === 'reply') {
      // An answer to the copilot's own question: it resumes a run, not starts one.
      const blocked = await limited(request, 'reply', 12, 60_000)
      if (blocked) return blocked
      return NextResponse.json({ success: true, copilot: await replyGuestCopy(tokenOf(request), guestToken, parsed.data.message) })
    }
    if (parsed.data.action === 'restore') {
      const blocked = await limited(request, 'restore', 12, 60_000)
      if (blocked) return blocked
      return NextResponse.json({ success: true, copilot: await restoreGuestCopy(tokenOf(request), guestToken, parsed.data.versionId) })
    }
    if (parsed.data.action === 'new_chat') {
      const blocked = await limited(request, 'reply', 12, 60_000)
      if (blocked) return blocked
      return NextResponse.json({ success: true, copilot: await clearGuestCopyChat(tokenOf(request), guestToken) })
    }
    if (parsed.data.action === 'mcp_test') {
      const blocked = await limited(request, 'mcp', 6, 60_000)
      if (blocked) return blocked
      return NextResponse.json({ success: true, test: await testGuestCopyMcp(tokenOf(request), guestToken, parsed.data.server) })
    }
    if (parsed.data.action === 'mcp_add' || parsed.data.action === 'mcp_remove') {
      // Connecting calls out to the visitor's server to verify it: kept slow.
      const blocked = await limited(request, 'mcp', 6, 60_000)
      if (blocked) return blocked
      return NextResponse.json({ success: true, copilot: await changeGuestCopyMcp(tokenOf(request), guestToken, parsed.data.action === 'mcp_add' ? { add: parsed.data.server } : { remove: parsed.data.serverId }) })
    }
    const blocked = await limited(request, 'open', 20, 10 * 60_000)
    if (blocked) return blocked
    const opened = await openGuestCopy(tokenOf(request), guestToken)
    const response = NextResponse.json({ success: true, copilot: opened.view })
    // httpOnly: page script (and the sandboxed artifact) never sees the token.
    response.cookies.set(GUEST_COOKIE, opened.guestToken, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: 60 * 60 * 24 * 180 })
    return response
  } catch (error) {
    return failure(error)
  }
}

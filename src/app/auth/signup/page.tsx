import { redirect } from 'next/navigation'
import { validatedReturnPath } from '@/lib/auth/return-path'

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ return_to?: string | string[] }>
}) {
  const params = await searchParams
  const raw = Array.isArray(params.return_to) ? params.return_to[0] : params.return_to
  const safeReturnTo = validatedReturnPath(raw)
  redirect(safeReturnTo ? `/auth/login?return_to=${encodeURIComponent(safeReturnTo)}` : '/auth/login')
}

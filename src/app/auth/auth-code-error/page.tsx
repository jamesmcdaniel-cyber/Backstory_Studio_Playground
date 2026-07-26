import Link from 'next/link'
import { AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

export default async function AuthCodeErrorPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string | string[] }>
}) {
  const params = await searchParams
  const reason = Array.isArray(params.reason) ? params.reason[0] : params.reason
  const domainRejected = reason === 'domain'

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 py-12 px-4 sm:px-6 lg:px-8">
      <Card className="max-w-md w-full">
        <CardHeader className="text-center">
          <div className="mx-auto flex items-center justify-center h-12 w-12 rounded-full bg-red-100 mb-4">
            <AlertTriangle className="h-6 w-6 text-red-600" />
          </div>
          <CardTitle className="text-2xl font-bold text-gray-900">
            Authentication Error
          </CardTitle>
          <CardDescription className="text-gray-600">
            {domainRejected
              ? 'This workspace is limited to managed company accounts.'
              : 'There was a problem with the authentication process.'}
          </CardDescription>
        </CardHeader>
        
        <CardContent className="space-y-4">
          <div className="text-sm text-gray-700">
            {domainRejected ? (
              <p className="text-gray-600">
                Sign in with a <strong>@people.ai</strong> or <strong>@backstory.ai</strong> Google account.
              </p>
            ) : (
              <>
                <p className="mb-2">This could be due to:</p>
                <ul className="list-disc list-inside space-y-1 text-gray-600">
                  <li>Redirect URI mismatch in Supabase configuration</li>
                  <li>Invalid or expired authentication code</li>
                  <li>Network connectivity issues</li>
                </ul>
              </>
            )}
          </div>
          
          <div className="space-y-3">
            <Button asChild className="w-full">
              <Link href="/auth/login">
                Try Again
              </Link>
            </Button>
            
            <Button variant="outline" asChild className="w-full">
              <Link href="/">
                Go Home
              </Link>
            </Button>
          </div>
          
          <div className="text-xs text-gray-500 text-center">
            <p>If this problem persists, please contact support</p>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

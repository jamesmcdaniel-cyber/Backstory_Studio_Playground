async function main() {
  const a = await import('@/lib/server/auth')
  const b = await import('../../../Users/james.mcdaniel/Backstory_Studio/src/lib/server/auth').catch(() => null)
  console.log('alias === alias2?', a === (await import('@/lib/server/auth')))
  console.log('NODE_ENV', JSON.stringify(process.env.NODE_ENV), 'TEST_DATABASE_URL set:', Boolean(process.env.TEST_DATABASE_URL))
  a.setTestAuthContext({ organizationId: 'x' } as never)
  try {
    const ctx = await a.requireAuthContext()
    console.log('SEAM OK', ctx)
  } catch (e) {
    console.log('SEAM MISS', (e as Error).message)
  }
  process.exit(0)
}
main()

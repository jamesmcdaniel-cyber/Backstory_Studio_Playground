/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  outputFileTracingRoot: __dirname,
  // Pyodide resolves its stdlib and core WASM beside the external package at
  // runtime. Keep it external and explicitly trace those dynamically-loaded
  // artifacts into every Vercel server function that can execute a flow.
  // BullMQ's package exports reference the optional Valkey transport and
  // Supabase Realtime resolves a runtime transport dynamically. They are
  // server dependencies, not bundle targets; externalizing them keeps Next
  // from warning about code paths Node will resolve only when actually used.
  serverExternalPackages: ['@prisma/client', '@supabase/realtime-js', 'bullmq', 'pyodide'],
  outputFileTracingIncludes: {
    '/*': ['./node_modules/pyodide/**/*'],
  },
  async headers() {
    return [
      {
        source: '/api/:path*',
        headers: [{ key: 'Cache-Control', value: 'no-store' }],
      },
      {
        source: '/:path*',
        headers: [
          // X-Frame-Options has no allow-list form, so when an operator turns
          // on embedding (EMBED_FRAME_ANCESTORS, read at build/deploy time) it
          // is omitted and CSP frame-ancestors — which carries the actual
          // allow-list, built in src/lib/security/csp.ts — governs alone.
          // Every modern browser prefers frame-ancestors anyway; sending DENY
          // alongside it would block embedding in the ones that don't.
          ...(process.env.EMBED_FRAME_ANCESTORS?.trim()
            ? []
            : [{ key: 'X-Frame-Options', value: 'DENY' }]),
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          // microphone=(self): the flows voice huddle needs getUserMedia;
          // camera and geolocation stay disabled app-wide.
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(self), geolocation=()' },
          // Force HTTPS for a year (browsers ignore this on localhost/non-TLS).
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
          // Content-Security-Policy is NOT set here. It carries a per-request
          // nonce, which a static config header cannot produce, so it is built
          // and attached in src/middleware.ts (src/lib/security/csp.ts). Adding
          // a static CSP back here would send two policies, and the browser
          // enforces the INTERSECTION — quietly breaking the nonced one.
        ],
      },
    ]
  },
}

module.exports = nextConfig

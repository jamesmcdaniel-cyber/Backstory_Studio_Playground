/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  outputFileTracingRoot: __dirname,
  // Pyodide resolves its stdlib and core WASM beside the external package at
  // runtime. Keep it external and explicitly trace those dynamically-loaded
  // artifacts into every Vercel server function that can execute a flow.
  serverExternalPackages: ['@prisma/client', 'pyodide'],
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
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          // microphone=(self): the flows voice huddle needs getUserMedia;
          // camera and geolocation stay disabled app-wide.
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(self), geolocation=()' },
          // Force HTTPS for a year (browsers ignore this on localhost/non-TLS).
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
          // Conservative CSP: anti-clickjacking (frame-ancestors) + block base-tag
          // hijacking and plugin/object embedding. Deliberately NOT restricting
          // script/style src — Next.js hydration uses inline scripts and a strict
          // script-src needs nonce wiring (post-launch hardening). Generated HTML
          // is already isolated in sandboxed, script-less iframes (HtmlPreview).
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'" },
        ],
      },
    ]
  },
}

module.exports = nextConfig

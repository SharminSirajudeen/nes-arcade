// Vercel Edge Middleware — Cookie-based auth (PWA compatible)

export const config = {
  matcher: ['/((?!api|_next|favicon.ico|icon-|manifest.json|service-worker.js|js/|styles.css|galaga.nes|.*\\.png|.*\\.js|.*\\.css|.*\\.nes).*)'],
};

const COOKIE_NAME = 'nes_auth';

// Credentials from Vercel environment variables ONLY — no fallbacks in source
const VALID_USER = process.env.AUTH_USER;
const VALID_PASS = process.env.AUTH_PASS;

export default function middleware(request) {
  // Block if credentials not configured in Vercel env vars
  if (!VALID_USER || !VALID_PASS) {
    return new Response('Server not configured', { status: 503 });
  }

  // Check cookie first — PWA launches send cookies automatically
  // Parse cookies properly (not substring match)
  const cookies = Object.fromEntries(
    (request.headers.get('cookie') || '').split(';').map(c => {
      const [k, ...v] = c.trim().split('=');
      return [k, v.join('=')];
    })
  );
  if (cookies[COOKIE_NAME] === 'ok') {
    return; // Already authenticated
  }

  // Check Basic Auth
  const authHeader = request.headers.get('authorization');
  if (authHeader) {
    const encoded = authHeader.split(' ')[1];
    if (encoded) {
      const decoded = atob(encoded);
      const [user, pass] = decoded.split(':');
      if (user === VALID_USER && pass === VALID_PASS) {
        // Auth valid — set cookie and redirect (browser will follow with cookie)
        const url = new URL(request.url);
        url.searchParams.set('_auth', '1');
        return new Response(null, {
          status: 302,
          headers: {
            'Location': url.pathname,
            'Set-Cookie': COOKIE_NAME + '=ok; Path=/; Max-Age=2592000; Secure; SameSite=Lax; HttpOnly',
          },
        });
      }
    }
  }

  // Not authenticated
  return new Response('Authentication required', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="NES Arcade"',
      'Content-Type': 'text/plain',
    },
  });
}

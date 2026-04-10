// Vercel Edge Middleware — Basic Auth (works on free Hobby plan)
// Set these env vars in Vercel Dashboard > Settings > Environment Variables:
//   AUTH_USER = your-username
//   AUTH_PASS = your-password

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
};

export default function middleware(request) {
  const authHeader = request.headers.get('authorization');

  if (authHeader) {
    const [scheme, encoded] = authHeader.split(' ');
    if (scheme === 'Basic' && encoded) {
      const decoded = atob(encoded);
      const [user, pass] = decoded.split(':');

      const validUser = process.env.AUTH_USER || 'galaga';
      const validPass = process.env.AUTH_PASS || 'arcade2026';

      if (user === validUser && pass === validPass) {
        return; // Allow through
      }
    }
  }

  return new Response('Authentication required', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="Galaga Arcade"',
      'Content-Type': 'text/plain',
    },
  });
}

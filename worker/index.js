// Serves the static shell from ./public. S2 adds the API routes here.
// /__/auth/ and /__/firebase/ are proxied to the Firebase auth helper so sign-in runs on this origin
// (authDomain in src/config.js): redirect sign-in then works in installed web apps and with partitioned storage.
const AUTH_HELPER = 'https://journalclub-anantf.firebaseapp.com';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/__/auth/') || url.pathname.startsWith('/__/firebase/')) {
      return fetch(new Request(AUTH_HELPER + url.pathname + url.search, request));
    }
    const res = await env.ASSETS.fetch(request);
    const h = new Headers(res.headers);
    h.set('X-Content-Type-Options', 'nosniff');
    h.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    h.set('X-Frame-Options', 'DENY');
    return new Response(res.body, { status: res.status, headers: h });
  },
};

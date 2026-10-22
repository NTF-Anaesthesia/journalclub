// Serves the static shell from ./public. S2 adds the API routes here.
export default {
  async fetch(request, env) {
    const res = await env.ASSETS.fetch(request);
    const h = new Headers(res.headers);
    h.set('X-Content-Type-Options', 'nosniff');
    h.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    h.set('X-Frame-Options', 'DENY');
    return new Response(res.body, { status: res.status, headers: h });
  },
};

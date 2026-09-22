import type { AuthRequest, OAuthHelpers } from '@cloudflare/workers-oauth-provider';

export interface AuthState {
  request: AuthRequest;
  expiresAt: number;
  consented: boolean;
}
export interface AuthStateStore {
  saveAuth(id: string, state: AuthState): Promise<boolean>;
  consentAuth(id: string): Promise<boolean>;
  takeAuth(id: string): Promise<AuthState | undefined>;
}
export interface AuthConfig {
  origin: string;
  githubClientId: string;
  githubClientSecret: string;
  ownerGithubId: string;
}
type Provider = Pick<OAuthHelpers, 'parseAuthRequest' | 'lookupClient' | 'completeAuthorization'>;
const cookieName = '__Host-thyrqel-consent';
const secureHeaders = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; form-action 'self' https://github.com; frame-ancestors 'none'; base-uri 'none'",
};
const cookie = (value: string, maxAge = 600) => `${cookieName}=${value}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
const escape = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const error = (message: string, status = 400) => new Response(message, { status, headers: secureHeaders });

export async function readBoundedBody(response: Response | Request, limit: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) { await reader.cancel(); throw new Error('Body limit exceeded'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(joined);
}

function boundState(request: Request, id: string | null) {
  if (!id || !/^[0-9a-f-]{36}$/.test(id)) return false;
  const matches = (request.headers.get('Cookie') ?? '').split(';')
    .map(value => value.trim()).filter(value => value.startsWith(`${cookieName}=`));
  return matches.length === 1 && matches[0] === `${cookieName}=${id}`;
}

/** OAuth provider owns tokens/PKCE; this handler owns consent and upstream identity. */
export async function handleAuthorization(request: Request, config: AuthConfig,
  provider: Provider, store: AuthStateStore,
  fetchUpstream: typeof fetch = (input, init) => globalThis.fetch(input, init)): Promise<Response> {
  const url = new URL(request.url);
  if (url.origin !== config.origin) return error('Unexpected origin', 421);
  if (!config.githubClientId || !config.githubClientSecret || !/^\d+$/.test(config.ownerGithubId)) {
    return error('Operator authentication is not configured', 503);
  }
  let stage = 'request';
  try {
    if (url.pathname === '/authorize' && request.method === 'GET') {
      const auth = await provider.parseAuthRequest(request);
      if (!auth.codeChallenge || auth.codeChallengeMethod !== 'S256' ||
          auth.scope.some(scope => scope !== 'terminal')) return error('S256 PKCE and terminal scope required');
      const client = await provider.lookupClient(auth.clientId);
      if (!client || !client.redirectUris.includes(auth.redirectUri)) return error('Invalid OAuth client');
      const id = crypto.randomUUID();
      if (!await store.saveAuth(id, { request: auth, expiresAt: Date.now() + 600000, consented: false })) {
        return error('Too many pending authorizations; try again later', 429);
      }
      const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Connect to Thyrqel</title>
<h1>Connect to your terminal</h1><p>Client: ${escape(client.clientName ?? auth.clientId)}</p>
<p>Client ID: ${escape(auth.clientId)}</p><p>Return address: ${escape(auth.redirectUri)}</p>
<p>This client will be able to read terminal output and send commands to your Windows and WSL sessions, with your operating-system permissions.</p>
<p>Only the configured GitHub account can authorize access. Continue only if you initiated this connection.</p>
<form method="post" action="/authorize"><input type="hidden" name="state" value="${id}"><button type="submit">Continue with GitHub</button></form></html>`;
      return new Response(html, { headers: { ...secureHeaders, 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': cookie(id) } });
    }
    if (url.pathname === '/authorize' && request.method === 'POST') {
      // Origin is defense-in-depth. Privacy-focused/embedded browser contexts may
      // omit it or serialize an opaque origin as "null". Consent is still bound
      // to this browser by the __Host cookie plus the single-use server-side state.
      const requestOrigin = request.headers.get('Origin');
      const acceptedOrigin = requestOrigin === null || requestOrigin === 'null' || requestOrigin === config.origin;
      if (!acceptedOrigin ||
          !request.headers.get('Content-Type')?.startsWith('application/x-www-form-urlencoded')) return error('Invalid consent submission', 403);
      const form = new URLSearchParams(await readBoundedBody(request, 4096));
      const id = form.get('state');
      if (form.getAll('state').length !== 1 || !boundState(request, id) || !await store.consentAuth(id!)) return error('Consent expired or invalid', 403);
      const github = new URL('https://github.com/login/oauth/authorize');
      github.search = new URLSearchParams({ client_id: config.githubClientId,
        redirect_uri: `${config.origin}/callback`, scope: 'read:user', state: id! }).toString();
      return new Response(null, { status: 302, headers: { ...secureHeaders, Location: github.href } });
    }
    if (url.pathname === '/callback' && request.method === 'GET') {
      const id = url.searchParams.get('state');
      const code = url.searchParams.get('code');
      if (url.searchParams.getAll('state').length !== 1 || url.searchParams.getAll('code').length !== 1 ||
          !boundState(request, id) || !code || code.length > 1024) return error('Invalid callback', 403);
      // Atomic consume precedes token exchange. Failed callbacks require new consent.
      stage = 'state';
      const state = await store.takeAuth(id!);
      if (!state || !state.consented || state.expiresAt <= Date.now()) return error('Authorization expired or already used', 403);
      stage = 'upstream-token';
      const tokenResponse = await fetchUpstream('https://github.com/login/oauth/access_token', {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10000),
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: config.githubClientId, client_secret: config.githubClientSecret,
          redirect_uri: `${config.origin}/callback`, code }),
      });
      if (!tokenResponse.ok) return error('GitHub token exchange failed', 502);
      stage = 'upstream-token-body';
      const token: unknown = JSON.parse(await readBoundedBody(tokenResponse, 65536));
      if (!token || typeof token !== 'object' || !('access_token' in token) || typeof token.access_token !== 'string') return error('GitHub authentication failed', 403);
      stage = 'upstream-identity';
      const identityResponse = await fetchUpstream('https://api.github.com/user', {
        redirect: 'manual', signal: AbortSignal.timeout(10000),
        headers: { Authorization: `Bearer ${token.access_token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'Thyrqel', 'X-GitHub-Api-Version': '2022-11-28' },
      });
      if (!identityResponse.ok) return error('GitHub identity lookup failed', 502);
      const identity: unknown = JSON.parse(await readBoundedBody(identityResponse, 65536));
      if (!identity || typeof identity !== 'object' || !('id' in identity) ||
          String(identity.id) !== config.ownerGithubId) return error('This GitHub account is not authorized', 403);
      stage = 'grant';
      const { redirectTo } = await provider.completeAuthorization({ request: state.request,
        userId: config.ownerGithubId, scope: state.request.scope, metadata: { label: 'Thyrqel operator' },
        props: { ownerGithubId: config.ownerGithubId },
      });
      // Upstream GitHub access tokens are neither persisted nor embedded in MCP tokens.
      return new Response(null, { status: 302, headers: { ...secureHeaders,
        Location: redirectTo, 'Set-Cookie': cookie('', 0) } });
    }
    return error('Not found', 404);
  } catch {
    // Do not expose codes, cookies, tokens, provider errors or upstream responses.
    return error(`Authorization failed at ${stage}; start a new connection`, 400);
  }
}

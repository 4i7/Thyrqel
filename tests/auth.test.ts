import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AuthRequest, OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import { handleAuthorization, readBoundedBody, type AuthState, type AuthStateStore } from '../src/remote/auth.js';

const origin = 'https://terminal.example.test';
const config = { origin, githubClientId: 'app', githubClientSecret: 'test-secret', ownerGithubId: '3959289' };
function fixture(owner = 3959289) {
  const states = new Map<string, AuthState>();
  const request: AuthRequest = { responseType: 'code', clientId: 'client',
    redirectUri: 'https://client.example.test/callback', scope: ['terminal'], state: 'client-state',
    codeChallenge: 'a'.repeat(43), codeChallengeMethod: 'S256' };
  const grants: Parameters<OAuthHelpers['completeAuthorization']>[0][] = [];
  const provider: Pick<OAuthHelpers, 'parseAuthRequest' | 'lookupClient' | 'completeAuthorization'> = {
    async parseAuthRequest() { return request; },
    async lookupClient() { return { clientId: 'client', redirectUris: [request.redirectUri],
      clientName: '<script>bad()</script>', tokenEndpointAuthMethod: 'none' }; },
    async completeAuthorization(grant) { grants.push(grant); return { redirectTo: `${request.redirectUri}?code=downstream-code` }; },
  };
  const store: AuthStateStore = {
    async saveAuth(id, state) { states.set(id, state); return true; },
    async consentAuth(id) {
      const state = states.get(id);
      if (!state || state.consented || state.expiresAt <= Date.now()) return false;
      state.consented = true;
      return true;
    },
    async takeAuth(id) { const state = states.get(id); states.delete(id); return state; },
  };
  const calls: string[] = [];
  const upstream: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push(url);
    assert.equal(init?.redirect, 'manual');
    if (url === 'https://github.com/login/oauth/access_token') {
      assert.equal(new URLSearchParams(String(init?.body)).get('client_secret'), 'test-secret');
      return Response.json({ access_token: 'upstream-secret' });
    }
    assert.equal(url, 'https://api.github.com/user');
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer upstream-secret');
    return Response.json({ id: owner });
  };
  const handle = (path: string, init?: RequestInit) => handleAuthorization(new Request(`${origin}${path}`, init), config, provider, store, upstream);
  async function begin() {
    const page = await handle('/authorize');
    assert.equal(page.status, 200);
    const cookie = page.headers.get('Set-Cookie')!.split(';')[0]!;
    const state = cookie.split('=')[1]!;
    return { page, cookie, state };
  }
  const consent = (cookie: string, state: string, from: string | null = origin) => {
    const headers = new Headers({ Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' });
    if (from !== null) headers.set('Origin', from);
    return handle('/authorize', { method: 'POST', headers,
      body: new URLSearchParams({ state }).toString() });
  };
  return { handle, begin, consent, request, grants, calls, states };
}

test('OAuth consent binds browser, enforces owner identity and never forwards the upstream token', async () => {
  const f = fixture();
  const { page, cookie, state } = await f.begin();
  const html = await page.text();
  assert.ok(html.includes('&lt;script&gt;bad()&lt;/script&gt;'));
  assert.ok(!html.includes('<script>'));
  assert.ok(page.headers.get('Set-Cookie')!.includes('Secure; HttpOnly; SameSite=Lax'));
  assert.ok(page.headers.get('Content-Security-Policy')!.includes("form-action 'self' https://github.com"));
  assert.equal((await f.consent(cookie, state)).status, 302);
  const callback = `/callback?state=${state}&code=github-code`;
  const response = await f.handle(callback, { headers: { Cookie: cookie } });
  assert.equal(response.status, 302);
  assert.deepEqual(f.grants[0]!.props, { ownerGithubId: '3959289' });
  assert.ok(!JSON.stringify(f.grants).includes('upstream-secret'));
  assert.equal((await f.handle(callback, { headers: { Cookie: cookie } })).status, 403);
  assert.equal(f.calls.length, 2);
});

test('OAuth consent tolerates an omitted Origin while preserving cookie/state binding', async () => {
  const omitted = fixture();
  const ok = await omitted.begin();
  assert.equal((await omitted.consent(ok.cookie, ok.state, null)).status, 302);

  const opaque = fixture();
  const opaqueBound = await opaque.begin();
  assert.equal((await opaque.consent(opaqueBound.cookie, opaqueBound.state, 'null')).status, 302);

  const noCookie = fixture();
  const bound = await noCookie.begin();
  assert.equal((await noCookie.consent('', bound.state, null)).status, 403);

  const noFormType = fixture();
  const typed = await noFormType.begin();
  assert.equal((await noFormType.handle('/authorize', { method: 'POST',
    headers: { Cookie: typed.cookie },
    body: new URLSearchParams({ state: typed.state }).toString() })).status, 403);
});

test('OAuth rejects CSRF, unconsented callback, stale state, weak PKCE and other owners', async () => {
  const f = fixture();
  const { cookie, state } = await f.begin();
  assert.equal((await f.consent(cookie, state, 'https://attacker.example.test')).status, 403);
  assert.equal((await f.consent('', state)).status, 403);
  assert.equal((await f.handle(`/callback?state=${state}&code=x`, { headers: { Cookie: cookie } })).status, 403);
  assert.equal(f.calls.length, 0);
  f.request.codeChallengeMethod = 'plain';
  assert.equal((await f.handle('/authorize')).status, 400);
  const other = fixture(1);
  const bound = await other.begin();
  await other.consent(bound.cookie, bound.state);
  assert.equal((await other.handle(`/callback?state=${bound.state}&code=x`, { headers: { Cookie: bound.cookie } })).status, 403);
  assert.equal(other.grants.length, 0);
  const expired = fixture();
  const old = await expired.begin();
  expired.states.get(old.state)!.expiresAt = 0;
  assert.equal((await expired.consent(old.cookie, old.state)).status, 403);
});

test('bounded auth body reads reject oversized input without buffering the rest', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(8)); },
    cancel() { cancelled = true; },
  }));
  await assert.rejects(readBoundedBody(response, 4), /Body limit/);
  assert.equal(cancelled, true);
});

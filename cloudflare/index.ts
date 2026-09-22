import { DurableObject } from 'cloudflare:workers';
import { timingSafeEqual } from 'node:crypto';
import { OAuthProvider, type OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import { handleAuthorization, readBoundedBody, type AuthState } from '../src/remote/auth.js';
import { Relay, digest } from './relay.js';
import { handleMcp } from './mcp.js';
import type { ExecuteRequest } from '../src/remote/protocol.js';

export class Broker extends DurableObject<Env> {
  private readonly relay = new Relay(this.ctx);
  fetch(request: Request) {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('WebSocket required', { status: 426 });
    return this.relay.connect();
  }
  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    try { await this.relay.message(socket, message); }
    catch { socket.close(1002, 'Invalid device message'); }
  }
  webSocketClose(socket: WebSocket, code: number) { socket.close(code === 1006 ? 1001 : code, 'Device disconnected'); }
  webSocketError(socket: WebSocket) { socket.close(1011, 'Device connection failed'); }
  deviceStatus() { return this.relay.status(); }
  submit(request: ExecuteRequest) { return this.relay.submit(request); }
  operationResult(epoch: string, operationId: string) { return this.relay.result(epoch, operationId); }
  async saveAuth(id: string, state: AuthState) {
    return this.ctx.storage.transaction(async tx => {
      const records = await tx.list<AuthState>({ prefix: 'auth:' });
      let active = 0;
      for (const [key, value] of records) {
        if (value.expiresAt <= Date.now()) await tx.delete(key);
        else active++;
      }
      if (active >= 64 || await tx.get(`auth:${id}`)) return false;
      await tx.put(`auth:${id}`, state);
      return true;
    });
  }
  async consentAuth(id: string) {
    return this.ctx.storage.transaction(async tx => {
      const state = await tx.get<AuthState>(`auth:${id}`);
      if (!state || state.expiresAt <= Date.now()) return false;
      if (!state.consented) await tx.put(`auth:${id}`, { ...state, consented: true });
      return true;
    });
  }
  async takeAuth(id: string) {
    return this.ctx.storage.transaction(async tx => {
      const state = await tx.get<AuthState>(`auth:${id}`);
      await tx.delete(`auth:${id}`);
      return state;
    });
  }
}

type ProviderEnv = Env & { OAUTH_PROVIDER: OAuthHelpers };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    // A configured canonical origin also fixes the OAuth resource audience.
    if (url.origin !== env.PUBLIC_ORIGIN || request.url.length > 8192) return new Response('Invalid origin or URL', { status: 421 });
    if (['/register', '/authorize', '/token', '/callback'].includes(url.pathname)) {
      const { success } = await env.AUTH_LIMIT.limit({ key: request.headers.get('CF-Connecting-IP') ?? 'unknown' });
      if (!success) return new Response('Too many authentication requests', { status: 429, headers: { 'Retry-After': '60' } });
    }
    if (request.method === 'POST') {
      try {
        const body = await readBoundedBody(request, url.pathname === '/mcp' ? 65536 : 16384);
        request = new Request(request, { body });
      } catch { return new Response('Request body is invalid or too large', { status: 413 }); }
    }
    if (url.pathname === '/health' && request.method === 'GET') return Response.json({ service: 'thyrqel', remoteReady: false });
    if (url.pathname === '/device' && request.method === 'GET') {
      const token = request.headers.get('Authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43,128})$/)?.[1];
      if (!token || !/^[a-f0-9]{64}$/.test(env.DEVICE_TOKEN_SHA256)) return new Response('Unauthorized', { status: 401 });
      const actual = new TextEncoder().encode(await digest(token));
      const expected = new TextEncoder().encode(env.DEVICE_TOKEN_SHA256);
      if (!timingSafeEqual(actual, expected)) return new Response('Unauthorized', { status: 401 });
      return env.BROKER.getByName('operator').fetch(request);
    }
    const provider = new OAuthProvider<ProviderEnv>({
      apiRoute: '/mcp', authorizeEndpoint: '/authorize', tokenEndpoint: '/token',
      clientRegistrationEndpoint: '/register', allowPlainPKCE: false,
      clientIdMetadataDocumentEnabled: false,
      scopesSupported: ['terminal'], accessTokenTTL: 900,
      resourceMetadata: { resource: `${env.PUBLIC_ORIGIN}/mcp`, scopes_supported: ['terminal'] },
      apiHandler: {
        async fetch(request, bindings, context) {
          const props: unknown = context.props;
          if (!props || typeof props !== 'object' || !('ownerGithubId' in props) || props.ownerGithubId !== bindings.OWNER_GITHUB_ID) {
            return new Response('Forbidden', { status: 403 });
          }
          return handleMcp(request, bindings.BROKER.getByName('operator'));
        },
      },
      defaultHandler: {
        async fetch(request, bindings) {
          return handleAuthorization(request, {
            origin: bindings.PUBLIC_ORIGIN, ownerGithubId: bindings.OWNER_GITHUB_ID,
            githubClientId: bindings.GITHUB_CLIENT_ID, githubClientSecret: bindings.GITHUB_CLIENT_SECRET,
          }, bindings.OAUTH_PROVIDER, bindings.BROKER.getByName('operator'));
        },
      },
    });
    // OAuthProvider injects OAUTH_PROVIDER before invoking either handler.
    return provider.fetch(request, env as ProviderEnv, ctx);
  },
} satisfies ExportedHandler<Env>;

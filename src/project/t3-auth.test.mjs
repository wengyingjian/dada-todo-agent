import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { buildAuthorizeUrl, createPkce, parseCallback, parseSessionId } from './t3-auth.js';

test('PKCE：verifier 长度合法，challenge 是它的 S256', () => {
  const { verifier, challenge } = createPkce();
  assert.match(verifier, /^[A-Za-z0-9\-._~]{43,128}$/);
  assert.equal(challenge, crypto.createHash('sha256').update(verifier).digest('base64url'));
  assert.equal(challenge.length, 43);
});

test('授权 URL 指向 /oauth/mcp/authorize，并带齐 PKCE 与 resource', () => {
  const url = new URL(buildAuthorizeUrl({
    origin: 'http://127.0.0.1:3773/',
    clientId: 'client-1',
    redirectUri: 'http://127.0.0.1:45871/callback',
    challenge: 'challenge-1',
    state: 'state-1'
  }));
  assert.equal(url.origin + url.pathname, 'http://127.0.0.1:3773/oauth/mcp/authorize');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('client_id'), 'client-1');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:45871/callback');
  assert.equal(url.searchParams.get('code_challenge'), 'challenge-1');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('state'), 'state-1');
  assert.equal(url.searchParams.get('resource'), 'http://127.0.0.1:3773/mcp');
});

test('回调解析：成功取 code，失败取 error，缺 code 也算失败', () => {
  assert.deepEqual(
    parseCallback(new URLSearchParams('code=c1&state=s1')),
    { code: 'c1', state: 's1' }
  );
  assert.deepEqual(
    parseCallback(new URLSearchParams('error=access_denied&state=s1')),
    { error: 'access_denied', state: 's1' }
  );
  assert.deepEqual(
    parseCallback(new URLSearchParams('state=s1')),
    { error: 'missing_code', state: 's1' }
  );
});

test('从 bearer token 载荷里取会话 id', () => {
  const payload = Buffer.from(JSON.stringify({ sid: 'session-1', rtc: 'full-access' })).toString('base64url');
  assert.equal(parseSessionId(`${payload}.signature`), 'session-1');
  assert.equal(parseSessionId('not-a-token'), null);
  assert.equal(parseSessionId(''), null);
});

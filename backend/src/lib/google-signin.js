// Google OAuth 2.0 — Sign In (OpenID Connect) flow. Separate from the
// Ads-API OAuth in lib/google-ads.js because the scopes, redirect URI,
// and token usage are different:
//   - Ads: requests `adwords` scope, needs a refresh_token, callback
//     stores the refresh_token encrypted in google_accounts.
//   - Sign-In: requests `openid email profile`, needs only the id_token
//     to identify the user, no refresh_token retained.
//
// Errors carry a `code`: NOT_CONFIGURED, TOKEN_EXCHANGE, BAD_ID_TOKEN.

const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const OAUTH_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const SIGNIN_SCOPE = 'openid email profile';

function requireConfig() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_SIGNIN_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    const err = new Error(
      'Google Sign-In não configurado. Defina GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET e GOOGLE_SIGNIN_REDIRECT_URI.',
    );
    err.code = 'NOT_CONFIGURED';
    throw err;
  }
  return { clientId, clientSecret, redirectUri };
}

function buildSignInUrl({ state }) {
  const { clientId, redirectUri } = requireConfig();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SIGNIN_SCOPE,
    include_granted_scopes: 'true',
    state,
    // No prompt=consent: returning users should get a silent flow.
    // No access_type=offline: we don't need a refresh_token for identity.
  });
  return `${OAUTH_AUTH_URL}?${params.toString()}`;
}

// Returns { email, sub, name, picture, email_verified } from the id_token.
// We trust the id_token without RSA verification because we receive it
// directly from Google over TLS in exchange for our client secret —
// there's no untrusted intermediary.
async function exchangeCodeForClaims({ code }) {
  const { clientId, clientSecret, redirectUri } = requireConfig();
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.id_token) {
    const err = new Error(
      `Falha ao trocar code: ${data.error ?? res.status}${data.error_description ? ` (${data.error_description})` : ''}`,
    );
    err.code = 'TOKEN_EXCHANGE';
    throw err;
  }
  const parts = data.id_token.split('.');
  if (parts.length !== 3) {
    const err = new Error('id_token inválido');
    err.code = 'BAD_ID_TOKEN';
    throw err;
  }
  let claims;
  try {
    const payload = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    claims = JSON.parse(payload);
  } catch {
    const err = new Error('id_token payload não pôde ser decodificado');
    err.code = 'BAD_ID_TOKEN';
    throw err;
  }
  if (!claims.email) {
    const err = new Error('Google não retornou email — verifique o scope');
    err.code = 'BAD_ID_TOKEN';
    throw err;
  }
  return {
    sub: claims.sub,
    email: String(claims.email).toLowerCase(),
    email_verified: !!claims.email_verified,
    name: claims.name || null,
    picture: claims.picture || null,
  };
}

module.exports = { buildSignInUrl, exchangeCodeForClaims };

// Thin REST wrapper around Google's OAuth2 + Google Ads API. We use the
// global fetch (Node 20+) instead of pulling in google-ads-node, since
// the surface we need is small and the official client drags in gRPC.
//
// Errors thrown here carry a `code` field so the route layer can map to
// the right HTTP status:
//   NOT_CONFIGURED  -> 503 (env vars missing)
//   TOKEN_REFRESH   -> 502 (Google rejected our refresh_token)
//   API_ERROR       -> 502 (Google Ads API call failed)

const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const OAUTH_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const ADS_API_SCOPE = 'https://www.googleapis.com/auth/adwords';
const ADS_API_BASE = 'https://googleads.googleapis.com/v18';

function requireConfig() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const developerToken = process.env.GOOGLE_DEVELOPER_TOKEN;
  if (!clientId || !clientSecret || !developerToken) {
    const err = new Error(
      'Google Ads API não configurada. Defina GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET e GOOGLE_DEVELOPER_TOKEN.',
    );
    err.code = 'NOT_CONFIGURED';
    throw err;
  }
  return { clientId, clientSecret, developerToken };
}

function requireOAuthConfig() {
  const { clientId, clientSecret } = requireConfig();
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  if (!redirectUri) {
    const err = new Error(
      'GOOGLE_REDIRECT_URI não configurada. Defina a URL completa do callback (ex: https://seu-dominio/api/oauth/google/callback).',
    );
    err.code = 'NOT_CONFIGURED';
    throw err;
  }
  return { clientId, clientSecret, redirectUri };
}

// Builds the URL that the browser must visit to begin the consent flow.
// access_type=offline + prompt=consent guarantees a refresh_token even
// for users who have authorized this client before.
function buildAuthUrl({ state }) {
  const { clientId, redirectUri } = requireOAuthConfig();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: ADS_API_SCOPE,
    access_type: 'offline',
    include_granted_scopes: 'true',
    prompt: 'consent',
    state,
  });
  return `${OAUTH_AUTH_URL}?${params.toString()}`;
}

async function exchangeCode({ code }) {
  const { clientId, clientSecret, redirectUri } = requireOAuthConfig();
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
  if (!res.ok) {
    const err = new Error(
      `Falha ao trocar code por tokens: ${data.error ?? res.status}${data.error_description ? ` (${data.error_description})` : ''}`,
    );
    err.code = 'TOKEN_EXCHANGE';
    throw err;
  }
  if (!data.refresh_token) {
    const err = new Error(
      'Google não retornou refresh_token. Verifique se o app está em modo de produção e revogue o acesso anterior em https://myaccount.google.com/permissions antes de tentar novamente.',
    );
    err.code = 'NO_REFRESH_TOKEN';
    throw err;
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
  };
}

async function getAccessToken(refreshToken) {
  const { clientId, clientSecret } = requireConfig();
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Falha ao renovar access_token: ${data.error ?? res.status}${data.error_description ? ` (${data.error_description})` : ''}`);
    err.code = 'TOKEN_REFRESH';
    throw err;
  }
  return { accessToken: data.access_token, expiresIn: data.expires_in };
}

function normalizeCid(cid) {
  return String(cid).replace(/-/g, '');
}

async function adsGet(path, accessToken, loginCustomerId) {
  const { developerToken } = requireConfig();
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'developer-token': developerToken,
  };
  if (loginCustomerId) headers['login-customer-id'] = normalizeCid(loginCustomerId);
  const res = await fetch(`${ADS_API_BASE}${path}`, { headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message ?? `HTTP ${res.status}`;
    const err = new Error(`Google Ads API: ${msg}`);
    err.code = 'API_ERROR';
    err.details = data;
    throw err;
  }
  return data;
}

// Runs a GAQL query against a specific customer. Used for both
// "list MCC children" and "campaigns + metrics" calls. Auto-paginates
// via searchStream (returns all rows at once when small) — for large
// result sets we'd switch to the streaming endpoint.
async function adsSearch({ customerId, accessToken, query, loginCustomerId }) {
  const { developerToken } = requireConfig();
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'developer-token': developerToken,
    'content-type': 'application/json',
  };
  if (loginCustomerId) headers['login-customer-id'] = normalizeCid(loginCustomerId);
  const res = await fetch(
    `${ADS_API_BASE}/customers/${normalizeCid(customerId)}/googleAds:search`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, pageSize: 10000 }),
    },
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message ?? `HTTP ${res.status}`;
    const err = new Error(`Google Ads API: ${msg}`);
    err.code = 'API_ERROR';
    err.details = data;
    throw err;
  }
  return data.results || [];
}

async function listAccessibleCustomers(refreshToken) {
  const { accessToken } = await getAccessToken(refreshToken);
  const data = await adsGet('/customers:listAccessibleCustomers', accessToken);
  return (data.resourceNames || []).map((rn) => rn.split('/')[1]);
}

module.exports = {
  requireConfig,
  requireOAuthConfig,
  buildAuthUrl,
  exchangeCode,
  getAccessToken,
  listAccessibleCustomers,
  adsSearch,
  normalizeCid,
};

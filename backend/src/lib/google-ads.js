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

async function adsGet(path, accessToken, loginCustomerId) {
  const { developerToken } = requireConfig();
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'developer-token': developerToken,
  };
  if (loginCustomerId) {
    headers['login-customer-id'] = String(loginCustomerId).replace(/-/g, '');
  }
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

async function listAccessibleCustomers(refreshToken) {
  const { accessToken } = await getAccessToken(refreshToken);
  const data = await adsGet('/customers:listAccessibleCustomers', accessToken);
  // resourceNames look like "customers/1234567890"
  return (data.resourceNames || []).map((rn) => rn.split('/')[1]);
}

module.exports = {
  requireConfig,
  getAccessToken,
  listAccessibleCustomers,
};

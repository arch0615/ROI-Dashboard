// Google Ad Manager REST API v1 client.
//
// Two things this module owns:
//  1) Service-account JWT bearer auth (RS256-signed assertion exchanged
//     for a 1-hour access_token at oauth2.googleapis.com/token).
//  2) The 3-step async report dance: POST /reports (create) ->
//     POST /reports/{name}:run -> poll the long-running operation ->
//     GET /{result}:fetchRows with pagination.
//
// All errors carry a `code` so the route layer can return the right
// HTTP status. We rate-limit GAM calls in-process: each invocation
// queues behind the previous one and enforces a min interval — the
// Report Service has a tight quota.

const crypto = require('crypto');

const GAM_BASE = 'https://admanager.googleapis.com/v1';
const SCOPE = 'https://www.googleapis.com/auth/admanager';
const MIN_INTERVAL_MS = 350;

let gamQueue = Promise.resolve();
let lastCallAt = 0;

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function buildJwt(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: sa.client_email,
    scope: SCOPE,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const headerB64 = b64url(JSON.stringify(header));
  const claimB64 = b64url(JSON.stringify(claim));
  const unsigned = `${headerB64}.${claimB64}`;

  const privateKey = sa.private_key.replace(/\\n/g, '\n');
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  let signature;
  try {
    signature = signer.sign(privateKey);
  } catch (err) {
    const e = new Error(`Falha ao assinar JWT: ${err.message}`);
    e.code = 'BAD_PRIVATE_KEY';
    throw e;
  }
  return `${unsigned}.${b64url(signature)}`;
}

async function getAccessToken(sa) {
  const jwt = buildJwt(sa);
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(
      `Falha ao obter access_token GAM: ${data.error ?? res.status}${data.error_description ? ` (${data.error_description})` : ''}`,
    );
    err.code = 'TOKEN_REFRESH';
    throw err;
  }
  return data.access_token;
}

async function gamFetch(url, init, attempt = 0) {
  if (attempt === 0) {
    const prev = gamQueue;
    let release;
    gamQueue = new Promise((r) => {
      release = r;
    });
    try {
      await prev;
      const since = Date.now() - lastCallAt;
      if (since < MIN_INTERVAL_MS) {
        await new Promise((r) => setTimeout(r, MIN_INTERVAL_MS - since));
      }
      lastCallAt = Date.now();
      return await gamFetchRaw(url, init, 0);
    } finally {
      release();
    }
  }
  return gamFetchRaw(url, init, attempt);
}

async function gamFetchRaw(url, init, attempt) {
  const res = await fetch(url, init);
  if ((res.status === 429 || res.status === 503) && attempt < 4) {
    const retryAfter = Number(res.headers.get('retry-after')) || 0;
    const backoff = retryAfter > 0 ? retryAfter * 1000 : [3000, 8000, 20000, 45000][attempt];
    await new Promise((r) => setTimeout(r, backoff));
    return gamFetchRaw(url, init, attempt + 1);
  }
  return res;
}

async function gamJson(url, init) {
  const res = await gamFetch(url, init);
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    const err = new Error(
      'GAM API retornou resposta não-JSON. A Google Ad Manager API pode não estar habilitada no projeto GCP da Service Account.',
    );
    err.code = 'API_ERROR';
    err.body = text.slice(0, 300);
    throw err;
  }
  if (!res.ok) {
    const reason = data?.error?.details?.find?.((d) => d?.reason)?.reason;
    let msg = data?.error?.message ?? `HTTP ${res.status}`;
    if (res.status === 401 || reason === 'AUTH_ERROR_AUTHENTICATION_FAILED') {
      msg =
        'GAM não autenticou a Service Account. Adicione o email da SA como usuário da rede no Google Ad Manager com permissão para ver/executar relatórios.';
    }
    const err = new Error(`GAM API: ${msg}`);
    err.code = 'API_ERROR';
    err.details = data;
    throw err;
  }
  return data;
}

async function fetchNetworkCurrency({ networkCode, accessToken }) {
  const data = await gamJson(`${GAM_BASE}/networks/${networkCode}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const cc = String(data?.currencyCode ?? '').toUpperCase();
  return cc || null;
}

// Three GAM revenue metrics; we sum them client-side because Display +
// AdX + AdSense can all contribute to a single ad unit.
const DEFAULT_METRICS = [
  'AD_SERVER_IMPRESSIONS',
  'AD_SERVER_REVENUE',
  'AD_EXCHANGE_IMPRESSIONS',
  'AD_EXCHANGE_REVENUE',
  'ADSENSE_IMPRESSIONS',
  'ADSENSE_REVENUE',
];

function gamMicrosToFloat(v) {
  if (v == null) return 0;
  if (v.intValue != null) return Number(v.intValue) / 1_000_000;
  if (v.doubleValue != null) return Number(v.doubleValue);
  return 0;
}

function gamInt(v) {
  if (v == null) return 0;
  return Number(v.intValue ?? v.doubleValue ?? 0);
}

function parseGamDate(value) {
  const raw = String(value?.stringValue ?? value?.intValue ?? '');
  // GAM emits ISO yyyy-MM-dd or "20260519". Normalize to ISO.
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  if (/^\d{8}$/.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  return raw;
}

// Runs a HISTORICAL report and returns flattened rows:
//   [{ date, dims: [adUnitName | placementName], impressions, revenue }, ...]
// Dimensions[0] must always be DATE. When the dimensions list contains
// CUSTOM_DIMENSION, customDimensionKeyIds must be the array of numeric
// key ids (as strings) GAM should resolve against.
async function runReport({
  networkCode,
  accessToken,
  dateRange,
  dimensions,
  metrics = DEFAULT_METRICS,
  customDimensionKeyIds,
}) {
  const reportDefinition = { reportType: 'HISTORICAL', dimensions, metrics, dateRange };
  if (customDimensionKeyIds && customDimensionKeyIds.length > 0) {
    reportDefinition.customDimensionKeyIds = customDimensionKeyIds.map(String);
  }
  const create = await gamJson(`${GAM_BASE}/networks/${networkCode}/reports`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ visibility: 'DRAFT', reportDefinition }),
  });
  const reportName = create.name;
  if (!reportName) {
    const err = new Error('GAM create report: resposta sem report name');
    err.code = 'API_ERROR';
    throw err;
  }

  const run = await gamJson(`${GAM_BASE}/${reportName}:run`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  const opName = run.name;
  if (!opName) {
    const err = new Error('GAM run report: resposta sem operation name');
    err.code = 'API_ERROR';
    throw err;
  }

  let resultName = null;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const op = await gamJson(`${GAM_BASE}/${opName}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (op.done) {
      if (op.error) {
        const err = new Error(`GAM report operation: ${op.error.message ?? JSON.stringify(op.error)}`);
        err.code = 'API_ERROR';
        throw err;
      }
      resultName =
        op.response?.reportResult?.name ?? op.response?.reportResult ?? op.response?.name;
      if (!resultName) {
        const err = new Error('GAM report concluído sem reportResult');
        err.code = 'API_ERROR';
        throw err;
      }
      break;
    }
  }
  if (!resultName) {
    const err = new Error('GAM report timeout (60s)');
    err.code = 'API_ERROR';
    throw err;
  }

  const allRows = [];
  let pageToken;
  do {
    const url = new URL(`${GAM_BASE}/${resultName}:fetchRows`);
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    url.searchParams.set('pageSize', '1000');
    const page = await gamJson(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const rows = page.rows ?? [];
    for (const r of rows) {
      const dimsVals = r.dimensionValues ?? [];
      const date = parseGamDate(dimsVals[0]);
      const dims = dimsVals.slice(1).map((d) => d?.stringValue ?? String(d?.intValue ?? ''));
      const m = r.metricValueGroups?.[0]?.primaryValues ?? [];
      // metrics order matches DEFAULT_METRICS: imp/rev pairs for
      // AdServer, AdExchange, AdSense. Sum them.
      const impressions = gamInt(m[0]) + gamInt(m[2]) + gamInt(m[4]);
      const revenue = gamMicrosToFloat(m[1]) + gamMicrosToFloat(m[3]) + gamMicrosToFloat(m[5]);
      allRows.push({ date, dims, impressions, revenue });
    }
    pageToken = page.nextPageToken;
  } while (pageToken);

  return allRows;
}

module.exports = {
  getAccessToken,
  fetchNetworkCurrency,
  runReport,
};

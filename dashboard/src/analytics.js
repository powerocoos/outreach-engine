// Google Analytics 4 (Data API) reader. Uses a service account with Viewer access to the property.
// Secrets: GA_SERVICE_ACCOUNT_JSON (full key file contents). Config: GA_PROPERTY_ID.

const b64url = (buf) => {
  const bytes = typeof buf === "string" ? new TextEncoder().encode(buf) : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

function pemToDer(pem) {
  const body = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

let tokenCache = { value: null, exp: 0 };

export async function gaAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache.value && tokenCache.exp - 60 > now) return tokenCache.value;
  const key = JSON.parse(env.GA_SERVICE_ACCOUNT_JSON);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(JSON.stringify({
    iss: key.client_email, scope: "https://www.googleapis.com/auth/analytics.readonly",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
  }));
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8", pemToDer(key.private_key), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, new TextEncoder().encode(`${header}.${claim}`));
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${header}.${claim}.${b64url(sig)}` }),
  });
  if (!res.ok) throw new Error(`Google token ${res.status}`);
  const j = await res.json();
  tokenCache = { value: j.access_token, exp: now + (j.expires_in || 3600) };
  return tokenCache.value;
}

async function runReport(env, token, body) {
  const res = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${env.GA_PROPERTY_ID}:runReport`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Analytics ${res.status}`);
  return res.json();
}

const rowsOf = (r) => (r.rows || []).map((x) => [
  ...(x.dimensionValues || []).map((d) => d.value), ...(x.metricValues || []).map((m) => Number(m.value)),
]);

// Turn the raw GA responses into what the dashboard shows. Pure, so it can be tested.
export function shapeAnalytics(totals, daily, sources, pages, outreach) {
  const t = (totals.rows && totals.rows[0] && totals.rows[0].metricValues || []).map((m) => Number(m.value));
  const o = (outreach.rows && outreach.rows[0] && outreach.rows[0].metricValues || []).map((m) => Number(m.value));
  return {
    totals: { sessions: t[0] || 0, users: t[1] || 0, keyEvents: t[2] || 0, engagementRate: Math.round((t[3] || 0) * 1000) / 10 },
    outreach: { sessions: o[0] || 0, keyEvents: o[1] || 0 },
    daily: rowsOf(daily).map(([d, s]) => ({ date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`, sessions: s })),
    sources: rowsOf(sources).map(([name, sessions, keyEvents]) => ({ name, sessions, keyEvents })),
    pages: rowsOf(pages).map(([path, views]) => ({ path, views })),
  };
}

let reportCache = { key: "", at: 0, data: null };

// Only count traffic from this site. A tracking ID shared with another site would otherwise mix their visits in.
export const hostFilter = (host) => ({ filter: { fieldName: "hostName", stringFilter: { matchType: "CONTAINS", value: host } } });
export const withHost = (host, extra) => ({ dimensionFilter: extra ? { andGroup: { expressions: [hostFilter(host), extra] } } : hostFilter(host) });

export async function analyticsReport(env, days = 30) {
  if (!env.GA_SERVICE_ACCOUNT_JSON || !env.GA_PROPERTY_ID) return { configured: false };
  const d = [30, 7, 90].includes(days) ? days : 30;
  const host = env.GA_HOSTNAME || "ocooswebconsulting.com";
  const key = `${env.GA_PROPERTY_ID}:${d}:${host}`;
  if (reportCache.key === key && Date.now() - reportCache.at < 10 * 60 * 1000) return reportCache.data;
  const token = await gaAccessToken(env);
  const dateRanges = [{ startDate: `${d}daysAgo`, endDate: "today" }];
  const [totals, daily, sources, pages, outreach] = await Promise.all([
    runReport(env, token, { dateRanges, metrics: [{ name: "sessions" }, { name: "totalUsers" }, { name: "keyEvents" }, { name: "engagementRate" }], ...withHost(host) }),
    runReport(env, token, { dateRanges, dimensions: [{ name: "date" }], metrics: [{ name: "sessions" }], orderBys: [{ dimension: { dimensionName: "date" } }], ...withHost(host) }),
    runReport(env, token, { dateRanges, dimensions: [{ name: "sessionSourceMedium" }], metrics: [{ name: "sessions" }, { name: "keyEvents" }], orderBys: [{ metric: { metricName: "sessions" }, desc: true }], limit: 8, ...withHost(host) }),
    runReport(env, token, { dateRanges, dimensions: [{ name: "pagePath" }], metrics: [{ name: "screenPageViews" }], orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }], limit: 8, ...withHost(host) }),
    runReport(env, token, { dateRanges, metrics: [{ name: "sessions" }, { name: "keyEvents" }],
      ...withHost(host, { filter: { fieldName: "sessionSource", stringFilter: { matchType: "EXACT", value: "outreach" } } }) }),
  ]);
  const data = { configured: true, days: d, ...shapeAnalytics(totals, daily, sources, pages, outreach) };
  reportCache = { key, at: Date.now(), data };
  return data;
}

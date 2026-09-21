let jwksCache = { expiresAt: 0, keys: [] };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers }
  });
}

function cleanTeamDomain(value) {
  return String(value || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/$/, "")
    .split("/")[0];
}

function base64UrlBytes(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const raw = atob(padded);
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

function decodeJwtJson(value) {
  return JSON.parse(decoder.decode(base64UrlBytes(value)));
}

async function getAccessKeys(teamDomain) {
  if (jwksCache.expiresAt > Date.now() && jwksCache.keys.length) return jwksCache.keys;

  const response = await fetch("https://" + teamDomain + "/cdn-cgi/access/certs");
  if (!response.ok) throw new Error("Could not load Cloudflare Access signing keys.");

  const data = await response.json();
  const keys = Array.isArray(data?.keys) ? data.keys : [];
  if (!keys.length) throw new Error("Cloudflare Access returned no signing keys.");

  jwksCache = { expiresAt: Date.now() + 5 * 60 * 1000, keys };
  return keys;
}

function audienceMatches(aud, expected) {
  return Array.isArray(aud) ? aud.includes(expected) : aud === expected;
}

function emailAllowed(email, rawAllowlist) {
  const allowlist = String(rawAllowlist || "")
    .split(",")
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);

  if (!allowlist.length) return true;
  return allowlist.includes(String(email || "").trim().toLowerCase());
}

async function authenticate(request, env) {
  if (String(env.AUTH_BYPASS || "").toLowerCase() === "true") {
    return { email: env.DEV_USER_EMAIL || "local-dev@questlog.local", bypass: true };
  }

  const teamDomain = cleanTeamDomain(env.CF_ACCESS_TEAM_DOMAIN);
  const expectedAudience = String(env.CF_ACCESS_AUD || "").trim();
  if (!teamDomain || !expectedAudience) {
    const error = new Error("Cloudflare Access is not configured.");
    error.status = 503;
    throw error;
  }

  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) {
    const error = new Error("Cloudflare Access authentication is required.");
    error.status = 401;
    throw error;
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    const error = new Error("Invalid Cloudflare Access token.");
    error.status = 401;
    throw error;
  }

  const header = decodeJwtJson(parts[0]);
  const claims = decodeJwtJson(parts[1]);

  if (header.alg !== "RS256" || !header.kid) {
    const error = new Error("Unsupported Cloudflare Access token.");
    error.status = 401;
    throw error;
  }

  const keys = await getAccessKeys(teamDomain);
  const jwk = keys.find(key => key.kid === header.kid);
  if (!jwk) {
    jwksCache.expiresAt = 0;
    const error = new Error("Cloudflare Access signing key was not found.");
    error.status = 401;
    throw error;
  }

  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );

  const verified = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    base64UrlBytes(parts[2]),
    encoder.encode(parts[0] + "." + parts[1])
  );

  const now = Math.floor(Date.now() / 1000);
  const expectedIssuer = ("https://" + teamDomain).replace(/\/$/, "");
  const issuer = String(claims.iss || "").replace(/\/$/, "");

  if (
    !verified ||
    issuer !== expectedIssuer ||
    !audienceMatches(claims.aud, expectedAudience) ||
    !claims.exp ||
    claims.exp <= now ||
    (claims.nbf && claims.nbf > now + 30)
  ) {
    const error = new Error("Cloudflare Access token validation failed.");
    error.status = 401;
    throw error;
  }

  const email = String(claims.email || "").trim().toLowerCase();
  if (!emailAllowed(email, env.ALLOWED_EMAILS)) {
    const error = new Error("This account is not allowed to use Quest Log.");
    error.status = 403;
    throw error;
  }

  return { email, bypass: false };
}

function originConfig(env) {
  const raw = String(env.ORIGIN_BASE_URL || "").trim().replace(/\/$/, "");
  if (!raw) throw new Error("ORIGIN_BASE_URL is not configured.");

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("ORIGIN_BASE_URL is invalid.");
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("ORIGIN_BASE_URL must use http or https.");
  }

  const allowUnprotected = String(env.ALLOW_UNPROTECTED_ORIGIN || "").toLowerCase() === "true";
  if (!allowUnprotected && (!env.ORIGIN_ACCESS_CLIENT_ID || !env.ORIGIN_ACCESS_CLIENT_SECRET)) {
    throw new Error("Configure an Access service token for the origin.");
  }

  return url;
}

function stripCloudflareAuthCookie(value) {
  return String(value || "")
    .split(";")
    .map(part => part.trim())
    .filter(part => part && !/^CF_Authorization=/i.test(part))
    .join("; ");
}

async function proxyToOrigin(request, env, identity) {
  const origin = originConfig(env);
  const incoming = new URL(request.url);
  const target = new URL(incoming.pathname + incoming.search, origin);

  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("cf-access-jwt-assertion");
  headers.delete("cf-access-authenticated-user-email");
  headers.delete("cf-connecting-ip");
  headers.delete("cf-ipcountry");
  headers.delete("cf-ray");

  const cookie = stripCloudflareAuthCookie(headers.get("cookie"));
  if (cookie) headers.set("cookie", cookie);
  else headers.delete("cookie");

  headers.set("x-forwarded-host", incoming.host);
  headers.set("x-forwarded-proto", incoming.protocol.replace(":", ""));
  headers.set("x-questlog-cloud-user", identity.email || "");
  headers.set("x-questlog-runtime", "cloudflare-bridge");

  if (env.ORIGIN_ACCESS_CLIENT_ID && env.ORIGIN_ACCESS_CLIENT_SECRET) {
    headers.set("CF-Access-Client-Id", env.ORIGIN_ACCESS_CLIENT_ID);
    headers.set("CF-Access-Client-Secret", env.ORIGIN_ACCESS_CLIENT_SECRET);
  }

  const init = {
    method: request.method,
    headers,
    redirect: "manual"
  };

  if (!["GET", "HEAD"].includes(request.method)) init.body = request.body;

  const response = await fetch(target.toString(), init);
  const responseHeaders = new Headers(response.headers);
  responseHeaders.set("x-questlog-runtime", "cloudflare-bridge");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders
  });
}

function isOriginRoute(pathname) {
  return pathname.startsWith("/api/") || pathname === "/frame";
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/healthz") {
      return json({ ok: true, runtime: "cloudflare-bridge" });
    }

    let identity;
    try {
      identity = await authenticate(request, env);
    } catch (error) {
      return json({ error: error.message || "Authentication failed." }, Number(error.status) || 503);
    }

    if (url.pathname === "/api/runtime") {
      return json({
        runtime: "cloudflare-bridge",
        authenticated: true,
        user: identity.email || null,
        originConfigured: Boolean(env.ORIGIN_BASE_URL),
        originProtected: Boolean(env.ORIGIN_ACCESS_CLIENT_ID && env.ORIGIN_ACCESS_CLIENT_SECRET),
        workerVersion: env.CF_VERSION_METADATA?.id || null,
        workerTag: env.CF_VERSION_METADATA?.tag || null,
        workerTimestamp: env.CF_VERSION_METADATA?.timestamp || null
      });
    }

    if (isOriginRoute(url.pathname)) {
      try {
        return await proxyToOrigin(request, env, identity);
      } catch (error) {
        return json(
          { error: error.message || "Quest Log origin is unavailable.", runtime: "cloudflare-bridge" },
          502
        );
      }
    }

    return env.ASSETS.fetch(request);
  }
};

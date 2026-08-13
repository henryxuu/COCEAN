import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { extname, resolve, sep } from "node:path";
import { isSameOriginMutation, resolveUpstreamUrl } from "./security.mjs";

const host = process.env.HOST ?? "0.0.0.0";
const port = parsePort(process.env.PORT ?? "3000");
const publicRoot = resolve(import.meta.dirname, "public");
const upstreamBase = resolveUpstreamUrl(
  "/",
  process.env.COCEAN_SERVER_URL ?? "http://server:8080",
);
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://cocean.local");
  if (url.pathname === "/healthz") {
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(JSON.stringify({ status: "ok", service: "cocean-web" }));
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    if (
      !isSameOriginMutation(
        request.method ?? "GET",
        request.headers.origin,
        request.headers.host,
      )
    ) {
      response.writeHead(403, {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
      });
      response.end(
        JSON.stringify({
          error: "CROSS_ORIGIN_WRITE_REJECTED",
          message: "COCEAN 拒绝非同源写请求",
        }),
      );
      return;
    }
    if (!isPublicAuthRoute(url.pathname)) {
      const role = await sessionRole(request.headers.cookie);
      if (!role) {
        response.writeHead(401, {
          "cache-control": "no-store",
          "content-type": "application/json; charset=utf-8",
        });
        response.end(
          JSON.stringify({
            error: "AUTHENTICATION_REQUIRED",
            message: "请先登录 COCEAN",
          }),
        );
        return;
      }
      if (
        requiresAdmin(request.method ?? "GET", url.pathname) &&
        role !== "ADMIN"
      ) {
        response.writeHead(403, {
          "cache-control": "no-store",
          "content-type": "application/json; charset=utf-8",
        });
        response.end(
          JSON.stringify({
            error: "ADMIN_REQUIRED",
            message: "成员账号为只读；该操作需要管理员权限",
          }),
        );
        return;
      }
    }
    proxy(url, request, response);
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { allow: "GET, HEAD" });
    response.end();
    return;
  }
  await serveStatic(url.pathname, request.method === "HEAD", response);
});

server.listen(port, host, () =>
  console.log(`COCEAN web listening on http://${host}:${port}`),
);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.close(() => process.exit(0)));
}

async function serveStatic(pathname, headOnly, response) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    response.writeHead(400);
    response.end();
    return;
  }
  if (decoded.includes("\0")) {
    response.writeHead(400);
    response.end();
    return;
  }
  const candidate = resolve(
    publicRoot,
    decoded === "/" ? "index.html" : decoded.slice(1),
  );
  if (
    candidate !== publicRoot &&
    !candidate.startsWith(`${publicRoot}${sep}`)
  ) {
    response.writeHead(403);
    response.end();
    return;
  }
  const file = (await readableFile(candidate))
    ? candidate
    : resolve(publicRoot, "index.html");
  if (!(await readableFile(file))) {
    response.writeHead(404);
    response.end();
    return;
  }
  const headers = {
    "content-type": contentType(file),
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
    "content-security-policy":
      "default-src 'self'; img-src 'self' data: https://*.mzstatic.com; media-src 'self' https://*.itunes.apple.com https://*.mzstatic.com; style-src 'self' 'unsafe-inline'; script-src 'self' https://js-cdn.music.apple.com; connect-src 'self' https://*.apple.com https://*.itunes.apple.com; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    "cache-control": file.includes(`${sep}assets${sep}`)
      ? "public, max-age=31536000, immutable"
      : "no-cache",
  };
  response.writeHead(200, headers);
  if (headOnly) response.end();
  else createReadStream(file).pipe(response);
}

function proxy(requestUrl, request, response) {
  const target = resolveUpstreamUrl(requestUrl.href, upstreamBase);
  const transport = target.protocol === "https:" ? https : http;
  const { authorization: _authorization, ...forwardedHeaders } =
    request.headers;
  const upstream = transport.request(
    target,
    {
      method: request.method,
      headers: {
        ...forwardedHeaders,
        host: target.host,
        connection: "close",
        "x-forwarded-for": request.socket.remoteAddress ?? "unknown",
      },
    },
    (upstreamResponse) => {
      response.writeHead(
        upstreamResponse.statusCode ?? 502,
        upstreamResponse.headers,
      );
      upstreamResponse.pipe(response);
    },
  );
  upstream.setTimeout(30_000, () =>
    upstream.destroy(new Error("upstream timeout")),
  );
  upstream.on("error", () => {
    if (!response.headersSent)
      response.writeHead(502, {
        "content-type": "application/json; charset=utf-8",
      });
    response.end(
      JSON.stringify({
        error: "API_UNAVAILABLE",
        message: "COCEAN API 暂不可用",
      }),
    );
  });
  request.pipe(upstream);
}

function isPublicAuthRoute(pathname) {
  return new Set([
    "/api/health",
    "/api/v1/health",
    "/api/readiness",
    "/api/v1/readiness",
    "/api/v1/auth/login",
    "/api/v1/auth/logout",
    "/api/v1/auth/session",
  ]).has(pathname);
}

function sessionRole(cookie) {
  return new Promise((resolve) => {
    const target = resolveUpstreamUrl("/api/v1/auth/session", upstreamBase);
    const transport = target.protocol === "https:" ? https : http;
    const request = transport.request(
      target,
      {
        method: "GET",
        headers: {
          host: target.host,
          connection: "close",
          ...(cookie ? { cookie } : {}),
        },
      },
      (response) => {
        response.resume();
        response.once("end", () => {
          const role = response.headers["x-cocean-role"];
          resolve(
            response.statusCode === 200 &&
              (role === "ADMIN" || role === "MEMBER")
              ? role
              : null,
          );
        });
      },
    );
    request.setTimeout(5_000, () => request.destroy());
    request.once("error", () => resolve(null));
    request.end();
  });
}

function requiresAdmin(method, pathname) {
  if (["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase())) return false;
  return !new Set([
    "/api/v1/auth/logout",
    "/api/v1/recommendations/discover",
  ]).has(pathname);
}

async function readableFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function parsePort(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535)
    throw new Error(`invalid PORT: ${value}`);
  return parsed;
}

function contentType(path) {
  return (
    {
      ".css": "text/css; charset=utf-8",
      ".html": "text/html; charset=utf-8",
      ".ico": "image/x-icon",
      ".js": "text/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".map": "application/json; charset=utf-8",
      ".png": "image/png",
      ".svg": "image/svg+xml",
      ".webmanifest": "application/manifest+json; charset=utf-8",
      ".webp": "image/webp",
      ".woff": "font/woff",
      ".woff2": "font/woff2",
    }[extname(path).toLowerCase()] ?? "application/octet-stream"
  );
}

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const cleanupTasks = [];

afterEach(async () => {
  for (const task of cleanupTasks.splice(0).reverse()) {
    try {
      await task();
    } catch {
      // Best-effort cleanup must not hide the test assertion that already failed.
    }
  }
});

describe("production Web edge", () => {
  it("protects the UI/API, rejects cross-origin writes and strips credentials", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cocean-web-edge-"));
    cleanupTasks.push(() => rm(directory, { recursive: true, force: true }));
    const upstreamRequests = [];
    const upstream = http.createServer((request, response) => {
      upstreamRequests.push({
        authorization: request.headers.authorization,
        cookie: request.headers.cookie,
        method: request.method,
        url: request.url,
      });
      if (request.url === "/api/v1/auth/session") {
        const valid = [
          "cocean_session=valid",
          "cocean_session=member",
        ].includes(request.headers.cookie);
        response.writeHead(valid ? 200 : 401, {
          "content-type": "application/json",
          ...(valid
            ? {
                "x-cocean-role":
                  request.headers.cookie === "cocean_session=member"
                    ? "MEMBER"
                    : "ADMIN",
              }
            : {}),
        });
        response.end(valid ? '{"user":{"id":"owner"}}' : '{"error":"AUTH"}');
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
    });
    const upstreamPort = await listen(upstream);
    cleanupTasks.push(() => closeServer(upstream));

    const webPort = await unusedPort();
    const child = spawn(
      process.execPath,
      [join(import.meta.dirname, "start.mjs")],
      {
        env: {
          ...process.env,
          NODE_ENV: "production",
          HOST: "127.0.0.1",
          PORT: String(webPort),
          COCEAN_SERVER_URL: `http://127.0.0.1:${upstreamPort}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let diagnostics = "";
    child.stdout.on("data", (chunk) => (diagnostics += chunk));
    child.stderr.on("data", (chunk) => (diagnostics += chunk));
    cleanupTasks.push(() => stopChild(child));

    await waitUntilHealthy(webPort, child, () => diagnostics);
    const baseUrl = `http://127.0.0.1:${webPort}`;

    expect((await fetch(`${baseUrl}/healthz`)).status).toBe(200);
    const unauthorized = await fetch(`${baseUrl}/api/v1/test`);
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("www-authenticate")).toBeNull();

    const login = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: "POST",
      headers: { origin: baseUrl, "content-type": "application/json" },
      body: '{"username":"owner","password":"password"}',
    });
    expect(login.status).toBe(200);

    const crossOrigin = await fetch(`${baseUrl}/api/v1/test`, {
      method: "POST",
      headers: {
        cookie: "cocean_session=valid",
        origin: "http://attacker.invalid",
      },
    });
    expect(crossOrigin.status).toBe(403);

    const memberMutation = await fetch(`${baseUrl}/api/v1/scans`, {
      method: "POST",
      headers: { cookie: "cocean_session=member", origin: baseUrl },
    });
    expect(memberMutation.status).toBe(403);

    const memberDiscover = await fetch(
      `${baseUrl}/api/v1/recommendations/discover`,
      {
        method: "POST",
        headers: { cookie: "cocean_session=member", origin: baseUrl },
      },
    );
    expect(memberDiscover.status).toBe(200);

    const proxied = await absoluteFormRequest(webPort, {
      authorization: "Bearer must-not-reach-server",
      cookie: "cocean_session=valid",
      origin: baseUrl,
    });
    expect(proxied.status).toBe(200);
    const testRequest = upstreamRequests.find(
      (request) => request.url === "/api/v1/test?absolute=1",
    );
    expect(testRequest).toEqual({
      authorization: undefined,
      cookie: "cocean_session=valid",
      method: "POST",
      url: "/api/v1/test?absolute=1",
    });
    expect(
      upstreamRequests.filter(
        (request) => request.url === "/api/v1/auth/session",
      ),
    ).toHaveLength(4);
  }, 10_000);
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

async function unusedPort() {
  const server = http.createServer();
  const port = await listen(server);
  await closeServer(server);
  return port;
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve();
  return new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    }, 1_000).unref();
  });
}

async function waitUntilHealthy(port, child, diagnostics) {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(
        `Web edge exited early (${child.exitCode}): ${diagnostics()}`,
      );
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return;
    } catch {
      // The child may still be binding its port.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Web edge did not become healthy: ${diagnostics()}`);
}

function absoluteFormRequest(port, headers) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "http://attacker.invalid/api/v1/test?absolute=1",
        headers,
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve({ status: response.statusCode }));
      },
    );
    request.once("error", reject);
    request.end();
  });
}

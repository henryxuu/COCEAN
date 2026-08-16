import { useEffect } from "react";
import { MemoryRouter, useLocation, useNavigationType } from "react-router-dom";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api.js";
import { App } from "./app.js";

afterEach(() => vi.restoreAllMocks());

describe("登录后的入口路由", () => {
  it.each(["/", "/login", "/today", "/discover", "/find"])(
    "%s 直接 replace 到唱片库",
    async (entry) => {
      const { renderer, visits } = await renderAppAt(entry);
      const location = renderer.root.findByProps({ "data-route-probe": true });

      expect(location.props["data-pathname"]).toBe("/library");
      expect(location.props["data-search"]).toBe("");
      expect(location.props["data-navigation-type"]).toBe("REPLACE");
      expect(rendererText(renderer.root)).toContain("唱片库");
      expect(visits).toEqual([entry, "/library"]);

      await act(async () => renderer.unmount());
    },
  );

  it("未知路由丢弃 query 并直接 replace 到唱片库", async () => {
    const { renderer, visits } = await renderAppAt(
      "/not-a-product-route?q=fake&filter=HIDDEN",
    );
    const location = renderer.root.findByProps({ "data-route-probe": true });

    expect(location.props["data-pathname"]).toBe("/library");
    expect(location.props["data-search"]).toBe("");
    expect(location.props["data-navigation-type"]).toBe("REPLACE");
    expect(visits).toEqual([
      "/not-a-product-route?q=fake&filter=HIDDEN",
      "/library",
    ]);

    await act(async () => renderer.unmount());
  });

  it.each(["ADMIN", "MEMBER"] as const)(
    "%s 直接访问隔离深链时保留原路由和既有角色页面",
    async (role) => {
      const { renderer, visits } = await renderAppAt("/quarantine", role);
      const location = renderer.root.findByProps({ "data-route-probe": true });

      expect(location.props["data-pathname"]).toBe("/quarantine");
      expect(location.props["data-navigation-type"]).toBe("POP");
      expect(rendererText(renderer.root)).toContain("隔离区");
      expect(visits).toEqual(["/quarantine"]);

      await act(async () => renderer.unmount());
    },
  );

  it("匿名访问隔离深链时仍受登录保护", async () => {
    const { renderer, visits } = await renderAnonymousAppAt("/quarantine");
    const location = renderer.root.findByProps({ "data-route-probe": true });

    expect(location.props["data-pathname"]).toBe("/login");
    expect(location.props["data-navigation-type"]).toBe("REPLACE");
    expect(visits).toEqual(["/quarantine", "/login"]);
    expect(rendererText(renderer.root)).toContain("登录");

    await act(async () => renderer.unmount());
  });

  it("真实登录成功后直接 replace 到唱片库，不经过根路由", async () => {
    const login = vi
      .spyOn(api, "login")
      .mockResolvedValue(authSession("ADMIN"));
    const { renderer, visits } = await renderAnonymousAppAt("/login");
    const [username, password] = renderer.root.findAllByType("input");

    await act(async () => {
      username!.props.onChange({ target: { value: "owner" } });
      password!.props.onChange({ target: { value: "correct-password" } });
    });
    await act(async () => {
      renderer.root.findByType("form").props.onSubmit({
        preventDefault: vi.fn(),
      });
      await Promise.resolve();
    });

    const location = renderer.root.findByProps({ "data-route-probe": true });
    expect(login).toHaveBeenCalledWith("owner", "correct-password");
    expect(location.props["data-pathname"]).toBe("/library");
    expect(location.props["data-navigation-type"]).toBe("REPLACE");
    expect(visits).toEqual(["/login", "/library"]);
    expect(visits).not.toContain("/");

    await act(async () => renderer.unmount());
  });
});

async function renderAppAt(entry: string, role: "ADMIN" | "MEMBER" = "ADMIN") {
  const visits: string[] = [];
  const pending = new Promise<never>(() => undefined);
  vi.spyOn(api, "session").mockResolvedValue(authSession(role));
  vi.spyOn(api, "settings").mockRejectedValue(new Error("not needed"));
  vi.spyOn(api, "albumPage").mockReturnValue(pending);
  vi.spyOn(api, "stats").mockReturnValue(pending);
  vi.spyOn(api, "lifecyclePlans").mockReturnValue(pending);

  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <MemoryRouter initialEntries={[entry]}>
        <RouteProbe visits={visits} />
        <App />
      </MemoryRouter>,
    );
  });
  return { renderer: renderer!, visits };
}

function authSession(role: "ADMIN" | "MEMBER") {
  return {
    user: {
      id: "user-one",
      username: "owner",
      displayName: "Owner",
      role,
      enabled: true,
      createdAt: "2026-08-16T00:00:00.000Z",
      updatedAt: "2026-08-16T00:00:00.000Z",
      lastLoginAt: null,
    },
    expiresAt: "2026-08-17T00:00:00.000Z",
  } as const;
}

async function renderAnonymousAppAt(entry: string) {
  const visits: string[] = [];
  const pending = new Promise<never>(() => undefined);
  vi.spyOn(api, "session").mockRejectedValue(new Error("unauthorized"));
  vi.spyOn(api, "settings").mockRejectedValue(new Error("not needed"));
  vi.spyOn(api, "albumPage").mockReturnValue(pending);
  vi.spyOn(api, "stats").mockReturnValue(pending);

  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <MemoryRouter initialEntries={[entry]}>
        <RouteProbe visits={visits} />
        <App />
      </MemoryRouter>,
    );
  });
  return { renderer: renderer!, visits };
}

function RouteProbe({ visits }: { visits: string[] }) {
  const location = useLocation();
  const navigationType = useNavigationType();
  useEffect(() => {
    visits.push(`${location.pathname}${location.search}`);
  }, [location, visits]);
  return (
    <output
      data-route-probe
      data-pathname={location.pathname}
      data-search={location.search}
      data-navigation-type={navigationType}
    />
  );
}

function rendererText(node: TestRenderer.ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : rendererText(child)))
    .join("");
}

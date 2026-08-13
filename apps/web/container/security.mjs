export function isSameOriginMutation(method, origin, host) {
  if (["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase())) return true;
  if (typeof origin !== "string" || typeof host !== "string" || !host)
    return false;
  try {
    const parsed = new URL(origin);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.host === host &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.pathname === "/" &&
      parsed.search === "" &&
      parsed.hash === ""
    );
  } catch {
    return false;
  }
}

export function resolveUpstreamUrl(requestTarget, upstreamBase) {
  const upstream = new URL(upstreamBase);
  if (
    (upstream.protocol !== "http:" && upstream.protocol !== "https:") ||
    upstream.username !== "" ||
    upstream.password !== ""
  ) {
    throw new Error("COCEAN upstream URL is invalid");
  }
  const requested = new URL(requestTarget ?? "/", "http://cocean.invalid");
  return new URL(`${requested.pathname}${requested.search}`, upstream);
}

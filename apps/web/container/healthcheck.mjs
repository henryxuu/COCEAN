const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 4_000);
try {
  const response = await fetch(
    `http://127.0.0.1:${process.env.PORT ?? "3000"}/healthz`,
    { signal: controller.signal },
  );
  if (!response.ok) process.exitCode = 1;
} catch {
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
}

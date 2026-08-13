import { useCallback, useEffect, useRef, useState } from "react";

export function useAsync<T>(
  loader: () => Promise<T>,
  dependencies: readonly unknown[] = [],
) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);
  const reload = useCallback(async () => {
    const currentGeneration = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const result = await loader();
      if (currentGeneration === generation.current) setData(result);
    } catch (caught) {
      if (currentGeneration === generation.current)
        setError(caught instanceof Error ? caught : new Error(String(caught)));
    } finally {
      if (currentGeneration === generation.current) setLoading(false);
    }
  }, dependencies);
  useEffect(() => {
    void reload();
    return () => {
      generation.current += 1;
    };
  }, [reload]);
  return { data, error, loading, reload };
}

export function useToast() {
  const [message, setMessage] = useState<string | null>(null);
  const show = useCallback((next: string) => {
    setMessage(next);
    window.setTimeout(() => setMessage(null), 2800);
  }, []);
  return { message, show };
}

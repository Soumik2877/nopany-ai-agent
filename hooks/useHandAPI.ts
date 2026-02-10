export const getHandApiBaseUrl = (): string => {
  // Vite inlines env vars at build time. We use the raw key
  // because loadEnv in vite.config is configured with no VITE_ prefix.
  const base = import.meta.env.HAND_API_BASE_URL as string | undefined;
  return base || 'http://localhost:8000';
};

export const openHand = async (): Promise<void> => {
  const base = getHandApiBaseUrl();
  const res = await fetch(`${base}/hand/open`, {
    method: 'POST',
  });
  if (!res.ok) {
    throw new Error(`Failed to open hand: ${res.status}`);
  }
};

export const closeHand = async (): Promise<void> => {
  const base = getHandApiBaseUrl();
  const res = await fetch(`${base}/hand/close`, {
    method: 'POST',
  });
  if (!res.ok) {
    throw new Error(`Failed to close hand: ${res.status}`);
  }
};

// --- LED eyes (same backend) ---

export const setEyeExpression = async (expression: string): Promise<void> => {
  const base = getHandApiBaseUrl();
  const res = await fetch(`${base}/eyes/expression`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expression }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { detail?: string })?.detail || `Eyes API: ${res.status}`);
  }
};

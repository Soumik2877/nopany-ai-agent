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


const getBase = (): string =>
  (import.meta.env.HAND_API_BASE_URL as string | undefined) || 'http://localhost:8000';

// ── Hand ─────────────────────────────────────────────────────────────

export const openHand = async (): Promise<void> => {
  const res = await fetch(`${getBase()}/hand/open`, { method: 'POST' });
  if (!res.ok) throw new Error(`openHand: ${res.status}`);
};

export const closeHand = async (): Promise<void> => {
  const res = await fetch(`${getBase()}/hand/close`, { method: 'POST' });
  if (!res.ok) throw new Error(`closeHand: ${res.status}`);
};

/**
 * Fire-and-forget speak gesture: close → pause → open.
 * Sent once each time the AI agent starts speaking.
 * Uses only 256 steps each way so it's snappy (~1.1 s total).
 */
export const gestureOnSpeak = (): void => {
  fetch(`${getBase()}/hand/gesture`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ close_steps: 256, pause_s: 0.35, open_steps: 256 }),
  }).catch(() => {/* ignore – hardware may not be connected */});
};

// ── LED eyes ─────────────────────────────────────────────────────────

export const setEyeExpression = async (expression: string): Promise<void> => {
  const res = await fetch(`${getBase()}/eyes/expression`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expression }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { detail?: string }).detail || `setEyeExpression: ${res.status}`);
  }
};

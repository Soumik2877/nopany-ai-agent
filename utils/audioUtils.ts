import { Blob } from '@google/genai';

// ── Base64 helpers ────────────────────────────────────────────────────────────

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binaryString = window.atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * Converts an ArrayBuffer to a base64 string.
 * Uses 8 192-byte chunks to avoid the O(n²) cost of single-char string
 * concatenation, while staying within the JS call-stack limit for spread.
 */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return window.btoa(binary);
}

// ── Audio decode ──────────────────────────────────────────────────────────────

/**
 * Synchronous PCM Int16 → AudioBuffer conversion.
 * Intentionally NOT async so the onmessage handler can schedule audio chunks
 * in strict order without any await-interleaving race condition.
 */
export function decodeAudioDataSync(
  data: ArrayBuffer,
  ctx: AudioContext,
  sampleRate = 24000,
  numChannels = 1,
): AudioBuffer {
  const dataInt16  = new Int16Array(data);
  const frameCount = dataInt16.length / numChannels;
  const buffer     = ctx.createBuffer(numChannels, frameCount, sampleRate);

  for (let ch = 0; ch < numChannels; ch++) {
    const channelData = buffer.getChannelData(ch);
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = dataInt16[i * numChannels + ch] / 32768.0;
    }
  }
  return buffer;
}

// ── PCM capture ───────────────────────────────────────────────────────────────

export function createPcmBlob(data: Float32Array): Blob {
  const int16 = new Int16Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const s = Math.max(-1, Math.min(1, data[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return {
    data: arrayBufferToBase64(int16.buffer),
    mimeType: 'audio/pcm;rate=16000',
  };
}

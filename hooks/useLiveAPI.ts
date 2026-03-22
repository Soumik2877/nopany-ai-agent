import { useState, useRef, useCallback, useEffect } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { SYSTEM_INSTRUCTION } from '../utils/schoolData';
import { createPcmBlob, base64ToArrayBuffer, decodeAudioDataSync } from '../utils/audioUtils';

export interface UseLiveAPIOptions {
  /** Fires with AI response text parts (for eye/hand keyword matching). */
  onModelText?: (text: string) => void;
  /** Fires once at the START of each AI speaking turn (first audio chunk). */
  onModelSpeaking?: () => void;
  /** Fires once at the END of each AI speaking turn (turnComplete / interruption). */
  onModelDoneSpeaking?: () => void;
  /** Fires with user speech transcription chunks. isFinal=true means the utterance is complete. */
  onUserTranscript?: (text: string, isFinal: boolean) => void;
  /** Fires with agent speech transcription chunks. isFinal=true means the turn is complete. */
  onAgentTranscript?: (text: string, isFinal: boolean) => void;
}

interface UseLiveAPIResult {
  connect: () => Promise<void>;
  disconnect: () => void;
  isConnected: boolean;
  isConnecting: boolean;
  isDisconnecting: boolean;
  error: string | null;
  analyser: AnalyserNode | null;
}

export const useLiveAPI = (options?: UseLiveAPIOptions): UseLiveAPIResult => {
  const [isConnected,    setIsConnected]    = useState(false);
  const [isConnecting,   setIsConnecting]   = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [error,          setError]          = useState<string | null>(null);
  const [analyser,       setAnalyser]       = useState<AnalyserNode | null>(null);

  // Always holds the latest callbacks — avoids stale-closure bugs
  const callbacksRef = useRef<UseLiveAPIOptions | undefined>(options);
  useEffect(() => { callbacksRef.current = options; });

  const inputAudioContextRef  = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);

  // Resolved session (not a Promise) so onaudioprocess never calls .then()
  const sessionRef   = useRef<any>(null);
  const streamRef    = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef    = useRef<MediaStreamAudioSourceNode | null>(null);

  const nextStartTimeRef   = useRef<number>(0);
  const audioQueueRef      = useRef<Set<AudioBufferSourceNode>>(new Set());
  const isModelSpeakingRef = useRef(false);
  // Guards against re-entrant disconnect calls (e.g. button click + onclose firing together)
  const isDisconnectingRef = useRef(false);

  const disconnect = useCallback(() => {
    // Prevent re-entrant / duplicate teardown
    if (isDisconnectingRef.current) return;
    isDisconnectingRef.current = true;
    setIsDisconnecting(true);

    // Null the session immediately so onaudioprocess stops sending even if
    // the ScriptProcessor fires one last time before the context fully closes.
    sessionRef.current = null;

    // Stop mic tracks first — prevents further onaudioprocess callbacks
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;

    // Disconnect graph nodes before closing contexts
    processorRef.current?.disconnect();
    processorRef.current = null;

    sourceRef.current?.disconnect();
    sourceRef.current = null;

    // Close audio contexts (async internally, but we don't need to await)
    inputAudioContextRef.current?.close();
    inputAudioContextRef.current = null;

    outputAudioContextRef.current?.close();
    outputAudioContextRef.current = null;

    // Stop any queued audio buffers
    audioQueueRef.current.forEach(s => { try { s.stop(); } catch (_) {} });
    audioQueueRef.current.clear();
    nextStartTimeRef.current = 0;

    if (isModelSpeakingRef.current) {
      isModelSpeakingRef.current = false;
      callbacksRef.current?.onModelDoneSpeaking?.();
    }

    setIsConnected(false);
    setIsConnecting(false);
    setIsDisconnecting(false);
    setAnalyser(null);

    isDisconnectingRef.current = false;
  }, []);

  const connect = useCallback(async () => {
    if (isConnecting || isConnected) return;
    setIsConnecting(true);
    setError(null);

    try {
      const apiKey = process.env.API_KEY;
      if (!apiKey) throw new Error('API Key not found in environment variables');

      const ai = new GoogleGenAI({ apiKey });

      // Input at 16 kHz mono — matches what Gemini expects
      const inputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: 16000,
        latencyHint: 'interactive',
      });
      // Output at 24 kHz — matches Gemini's PCM output rate
      const outputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: 24000,
        latencyHint: 'playback',
      });

      inputAudioContextRef.current  = inputCtx;
      outputAudioContextRef.current = outputCtx;

      if (inputCtx.state  === 'suspended') await inputCtx.resume();
      if (outputCtx.state === 'suspended') await outputCtx.resume();

      const newAnalyser = outputCtx.createAnalyser();
      newAnalyser.fftSize = 32;
      setAnalyser(newAnalyser);

      // Explicit mono + standard processing helps VAD work cleanly
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount:     1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl:  true,
        },
      });
      streamRef.current = stream;

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          // Audio-only response — no TEXT modality overhead
          responseModalities: [Modality.AUDIO],
          systemInstruction: SYSTEM_INSTRUCTION,
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
          },
          // Transcription of user speech and agent speech for the chat log.
          // These use a lightweight STT pass, NOT text generation, so they
          // do NOT add response latency.
          inputAudioTranscription:  {} as any,
          outputAudioTranscription: {} as any,
          // ── Voice-activity detection ─────────────────────────────────────────
          // Default silenceDurationMs is ~2 000 ms which is the main cause of
          // 10–30 s response latency.  Setting it to 500 ms means the model
          // fires within ~0.5 s of the user stopping speech.
          realtimeInputConfig: {
            automaticActivityDetection: {
              disabled: false,
              // Detect end of speech quickly after short silence
              endOfSpeechSensitivity:   'END_SENSITIVITY_HIGH'   as any,
              // Detect start of speech immediately
              startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH' as any,
              // Include 200 ms of audio before speech starts (avoids clipping first word)
              prefixPaddingMs:  200,
              // Commit user turn after 500 ms of silence
              silenceDurationMs: 500,
            },
          } as any,
        },

        callbacks: {
          onopen: () => {
            // Cache the real session object once — hot audio path uses ref directly
            sessionPromise.then(s => { sessionRef.current = s; });

            setIsConnected(true);
            setIsConnecting(false);

            const source      = inputCtx.createMediaStreamSource(stream);
            sourceRef.current = source;

            // 2048 samples @ 16 kHz = 128 ms per chunk (vs 256 ms at 4096)
            // Lower buffer = less input lag, still stable on Pi
            const proc = inputCtx.createScriptProcessor(2048, 1, 1);
            processorRef.current = proc;

            proc.onaudioprocess = (e) => {
              const session = sessionRef.current;
              if (!session) return;
              try {
                session.sendRealtimeInput({
                  media: createPcmBlob(e.inputBuffer.getChannelData(0)),
                });
              } catch (_) {}
            };

            source.connect(proc);
            proc.connect(inputCtx.destination);
          },

          // ── Fully synchronous message handler — no async, no await ───────────
          // Using sync audio decode means chunks are always scheduled in the
          // order they arrive; no two chunks can race on nextStartTimeRef.
          onmessage: (message: LiveServerMessage) => {
            const ctx = outputAudioContextRef.current;

            // ── Audio output ──────────────────────────────────────────────────
            const base64Audio =
              message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;

            if (base64Audio && ctx) {
              // Fire speaking signal once per turn
              if (!isModelSpeakingRef.current) {
                isModelSpeakingRef.current = true;
                callbacksRef.current?.onModelSpeaking?.();
              }

              // Resume context if suspended (tab backgrounded) — fire-and-forget
              if (ctx.state === 'suspended') ctx.resume();

              // Jitter buffer: schedule at "now + small safety pad" when there is
              // no existing queued audio (first chunk of a turn or after underrun).
              if (nextStartTimeRef.current <= ctx.currentTime) {
                nextStartTimeRef.current = ctx.currentTime + 0.04; // 40 ms pad
              }

              try {
                const arrayBuffer = base64ToArrayBuffer(base64Audio);
                const audioBuffer = decodeAudioDataSync(arrayBuffer, ctx, 24000, 1);

                const src = ctx.createBufferSource();
                src.buffer = audioBuffer;
                src.connect(newAnalyser);
                newAnalyser.connect(ctx.destination);
                src.onended = () => audioQueueRef.current.delete(src);
                src.start(nextStartTimeRef.current);
                nextStartTimeRef.current += audioBuffer.duration;
                audioQueueRef.current.add(src);
              } catch (e) {
                console.error('Audio schedule error:', e);
              }
            }

            // ── Text parts → hand / eye keyword actions ───────────────────────
            const parts = message.serverContent?.modelTurn?.parts;
            if (parts) {
              const text = parts
                .map((p: any) => (typeof p.text === 'string' ? p.text : ''))
                .join(' ')
                .trim();
              if (text) callbacksRef.current?.onModelText?.(text);
            }

            // ── User speech transcription ─────────────────────────────────────
            const inputTx = (message as any).serverContent?.inputTranscription;
            if (inputTx?.text !== undefined) {
              callbacksRef.current?.onUserTranscript?.(inputTx.text, inputTx.final ?? false);
            }

            // ── Agent speech transcription ────────────────────────────────────
            const outputTx = (message as any).serverContent?.outputTranscription;
            if (outputTx?.text !== undefined) {
              callbacksRef.current?.onAgentTranscript?.(outputTx.text, outputTx.final ?? false);
            }

            // ── Turn complete ─────────────────────────────────────────────────
            if (message.serverContent?.turnComplete) {
              if (isModelSpeakingRef.current) {
                isModelSpeakingRef.current = false;
                callbacksRef.current?.onModelDoneSpeaking?.();
              }
            }

            // ── Interruption (user spoke over the agent) ──────────────────────
            if (message.serverContent?.interrupted) {
              audioQueueRef.current.forEach(s => { try { s.stop(); } catch (_) {} });
              audioQueueRef.current.clear();
              nextStartTimeRef.current = 0;

              if (isModelSpeakingRef.current) {
                isModelSpeakingRef.current = false;
                callbacksRef.current?.onModelDoneSpeaking?.();
              }
            }
          },

          onclose: (e) => { console.log('Session closed', e); disconnect(); },
          onerror: (e) => {
            console.error('Live API error', e);
            setError('Connection error occurred.');
            disconnect();
          },
        },
      });

    } catch (err: any) {
      console.error('Connection failed:', err);
      setError(err.message || 'Failed to connect');
      setIsConnecting(false);
      disconnect();
    }
  }, [disconnect, isConnecting, isConnected]);

  return { connect, disconnect, isConnected, isConnecting, isDisconnecting, error, analyser };
};

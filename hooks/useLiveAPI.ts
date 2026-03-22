import { useState, useRef, useCallback, useEffect } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { SYSTEM_INSTRUCTION } from '../utils/schoolData';
import { base64ToArrayBuffer, decodeAudioDataSync, float32ToWav } from '../utils/audioUtils';

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

  // Resolved session (not a Promise) so the worklet port handler never calls .then()
  const sessionRef   = useRef<any>(null);
  const streamRef    = useRef<MediaStream | null>(null);
  const processorRef = useRef<AudioWorkletNode | null>(null);
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

    // Null the session immediately so the worklet port handler stops sending
    sessionRef.current = null;

    // Stop mic tracks first — prevents further worklet callbacks
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

      // ── Load AudioWorklet VAD processor ─────────────────────────────────────
      // This worklet runs on the audio rendering thread (off main thread) and
      // performs amplitude-based Voice Activity Detection.  When it detects a
      // complete speech segment it emits the raw Float32Array via postMessage —
      // we then encode it as WAV and transcribe with Groq Whisper-large-v3.
      // Gemini receives the *text* transcript, not raw audio.
      const WORKLET_CODE = `
        class VadCaptureProcessor extends AudioWorkletProcessor {
          constructor() {
            super();
            this._threshold  = 0.012;  // RMS energy level above which we consider speech
            this._prePad     = 15;     // frames to keep before speech onset (~120ms)
            this._endPad     = 45;     // silent frames before committing utterance (~360ms)
            this._minFrames  = 10;     // minimum speech frames — avoids noise blips (~80ms)
            this._preBuffer  = [];     // rolling window of frames before speech
            this._speech     = [];     // frames accumulated during speech
            this._speaking   = false;
            this._silFrames  = 0;
            this._speechFrames = 0;
          }

          _rms(ch) {
            let s = 0;
            for (let i = 0; i < ch.length; i++) s += ch[i] * ch[i];
            return Math.sqrt(s / ch.length);
          }

          process(inputs) {
            const ch = inputs[0]?.[0];
            if (!ch) return true;

            const rms   = this._rms(ch);
            const frame = ch.slice(); // copy — the engine reuses the underlying buffer

            if (!this._speaking) {
              // Maintain a rolling pre-speech buffer for prefix padding
              this._preBuffer.push(frame);
              if (this._preBuffer.length > this._prePad) this._preBuffer.shift();

              if (rms > this._threshold) {
                this._speaking     = true;
                this._silFrames    = 0;
                this._speechFrames = 0;
                // Include pre-buffer so we don't clip the first phoneme
                this._speech = [...this._preBuffer, frame];
              }
            } else {
              this._speech.push(frame);
              this._speechFrames++;

              if (rms < this._threshold) {
                this._silFrames++;
                if (this._silFrames >= this._endPad) {
                  if (this._speechFrames >= this._minFrames) {
                    // Flatten all frames into one Float32Array and transfer ownership
                    const total = this._speech.reduce((s, c) => s + c.length, 0);
                    const out   = new Float32Array(total);
                    let off = 0;
                    for (const c of this._speech) { out.set(c, off); off += c.length; }
                    this.port.postMessage(out, [out.buffer]);
                  }
                  this._speaking     = false;
                  this._silFrames    = 0;
                  this._speechFrames = 0;
                  this._speech       = [];
                  this._preBuffer    = [];
                }
              } else {
                this._silFrames = 0;
              }
            }
            return true;
          }
        }
        registerProcessor('vad-capture', VadCaptureProcessor);
      `;
      const workletBlob = new Blob([WORKLET_CODE], { type: 'application/javascript' });
      const workletUrl  = URL.createObjectURL(workletBlob);
      await inputCtx.audioWorklet.addModule(workletUrl);
      URL.revokeObjectURL(workletUrl);

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
          // Gemini receives TEXT from Groq Whisper and replies with AUDIO.
          // All user-side VAD and STT is now handled client-side via Groq.
          responseModalities: [Modality.AUDIO],
          systemInstruction: SYSTEM_INSTRUCTION,
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
          },
          // Agent speech transcription for the chat log (lightweight STT pass,
          // does NOT add latency to Gemini's response generation).
          outputAudioTranscription: {} as any,
          // No realtimeInputConfig — we send text, not audio, to Gemini.
        },

        callbacks: {
          onopen: () => {
            // Cache the real session object once — hot path uses ref directly
            sessionPromise.then(s => { sessionRef.current = s; });

            setIsConnected(true);
            setIsConnecting(false);

            const source      = inputCtx.createMediaStreamSource(stream);
            sourceRef.current = source;

            // VAD AudioWorkletNode — runs off the main thread
            const workletNode = new AudioWorkletNode(inputCtx, 'vad-capture');
            processorRef.current = workletNode;

            // ── Groq Whisper transcription ──────────────────────────────────
            // Called whenever the VAD emits a completed speech segment.
            // The whole pipeline: Float32 PCM → WAV → Groq API → transcript
            // text → Gemini sendClientContent (text turn).
            const GROQ_KEY = process.env.GROQ_API_KEY;

            workletNode.port.onmessage = async (e: MessageEvent<Float32Array>) => {
              const session = sessionRef.current;
              if (!session || !GROQ_KEY) return;

              const samples = e.data;

              // Show a pending bubble so the user knows their speech was captured
              callbacksRef.current?.onUserTranscript?.('…', false);

              try {
                const wav      = float32ToWav(samples, 16000);
                const formData = new FormData();
                formData.append(
                  'file',
                  new Blob([wav], { type: 'audio/wav' }),
                  'audio.wav',
                );
                formData.append('model', 'whisper-large-v3');
                formData.append('response_format', 'json');

                const res = await fetch(
                  'https://api.groq.com/openai/v1/audio/transcriptions',
                  {
                    method:  'POST',
                    headers: { Authorization: `Bearer ${GROQ_KEY}` },
                    body:    formData,
                  },
                );

                if (!res.ok) throw new Error(`Groq ${res.status}`);
                const { text } = await res.json() as { text?: string };
                const transcript = (text ?? '').trim();

                if (!transcript) {
                  // Noise / silence — remove the pending placeholder bubble
                  callbacksRef.current?.onUserTranscript?.('\x00', true);
                  return;
                }

                // Replace the '…' bubble with the real transcript
                callbacksRef.current?.onUserTranscript?.(transcript, true);

                // Send the transcript text to Gemini as the user's turn
                (session as any).sendClientContent({
                  turns: [{ role: 'user', parts: [{ text: transcript }] }],
                  turnComplete: true,
                });
              } catch (err) {
                console.error('Groq STT error:', err);
                // Remove the pending placeholder on failure
                callbacksRef.current?.onUserTranscript?.('\x00', true);
              }
            };

            // mic → worklet (VAD + capture) → silent destination
            source.connect(workletNode);
            workletNode.connect(inputCtx.destination);
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

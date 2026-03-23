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

            // ── Phase 1: Ambient noise calibration ───────────────────────────
            // Spend the first ~1.5 s measuring the room's noise floor before
            // attempting any speech detection.  The threshold is then set
            // dynamically as 4× the measured ambient RMS, so the VAD adapts to
            // quiet studio environments AND noisy classrooms equally well.
            this._calibrating  = true;
            this._calibTarget  = 200;   // ~200 blocks × 8 ms = 1.6 s
            this._calibFrames  = 0;
            this._calibSumSq   = 0;
            this._threshold    = 0.018; // safe conservative fallback

            // ── Phase 2: VAD parameters ───────────────────────────────────────
            this._onsetFrames  = 3;     // consecutive hot frames needed to start (~24 ms)
            this._onsetCount   = 0;
            this._prePad       = 15;    // pre-speech buffer (~120 ms)
            this._endPad       = 50;    // silence frames before commit (~400 ms)
            this._minFrames    = 12;    // ~96ms minimum — short enough for "ok" / "hi"

            this._preBuffer    = [];
            this._speech       = [];
            this._speaking     = false;
            this._silFrames    = 0;
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
            const frame = ch.slice();

            // ── Calibration phase ─────────────────────────────────────────────
            if (this._calibrating) {
              this._calibSumSq += rms * rms;
              this._calibFrames++;
              // Keep pre-buffer rolling even during calibration
              this._preBuffer.push(frame);
              if (this._preBuffer.length > this._prePad) this._preBuffer.shift();

              if (this._calibFrames >= this._calibTarget) {
                this._calibrating = false;
                const ambientRms  = Math.sqrt(this._calibSumSq / this._calibFrames);
                // 4× noise floor, with a sensible minimum so very quiet rooms
                // don't end up with a threshold below measurable noise.
                this._threshold   = Math.max(0.018, ambientRms * 4.0);
                this.port.postMessage({
                  type: 'calibrated',
                  threshold:  this._threshold,
                  noiseFloor: ambientRms,
                });
              }
              return true;
            }

            // ── VAD detection ─────────────────────────────────────────────────
            if (!this._speaking) {
              this._preBuffer.push(frame);
              if (this._preBuffer.length > this._prePad) this._preBuffer.shift();

              if (rms > this._threshold) {
                this._onsetCount++;
                if (this._onsetCount >= this._onsetFrames) {
                  // Confirmed onset — start buffering speech
                  this._speaking     = true;
                  this._silFrames    = 0;
                  this._speechFrames = 0;
                  this._speech       = [...this._preBuffer]; // include pre-pad
                  this._onsetCount   = 0;
                }
              } else {
                this._onsetCount = 0; // reset if any quiet frame interrupts onset
              }
            } else {
              this._speech.push(frame);
              this._speechFrames++;

              if (rms < this._threshold) {
                this._silFrames++;
                if (this._silFrames >= this._endPad) {
                  if (this._speechFrames >= this._minFrames) {
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

            workletNode.port.onmessage = async (e: MessageEvent) => {
              // ── Calibration notification ──────────────────────────────────
              if (e.data?.type === 'calibrated') {
                console.debug(
                  `[VAD] Calibrated — noise floor: ${e.data.noiseFloor.toFixed(4)}, ` +
                  `threshold: ${e.data.threshold.toFixed(4)}`
                );
                return;
              }

              // ── Speech segment ─────────────────────────────────────────────
              if (!(e.data instanceof Float32Array)) return;

              const session = sessionRef.current;
              if (!session || !GROQ_KEY) return;

              const samples = e.data;

              callbacksRef.current?.onUserTranscript?.('…', false);

              try {
                // ── Known Whisper hallucination blocklist ─────────────────────
                // Whisper was trained on YouTube subtitles and memorises these
                // phrases.  It outputs them verbatim when the audio is silence,
                // background noise, music, or very low-energy speech.
                // All entries are lowercased and punctuation-stripped for matching.
                const HALLUCINATIONS = new Set([
                  'thank you', 'thank you for watching', 'thanks for watching',
                  'thank you for watching this video', 'thanks for watching this video',
                  'thank you for listening', 'thanks for listening',
                  'please subscribe', 'please like and subscribe',
                  'like and subscribe', 'dont forget to subscribe',
                  'see you next time', 'see you in the next video',
                  'see you next week', 'ill see you in the next one',
                  'this video was made possible by', 'sponsored by',
                  'subtitles by', 'captions by', 'transcript by',
                  'transcribed by', 'edited by', 'music by',
                  'subscribe to my channel', 'hit the bell icon',
                  'turn on notifications', 'click the notification bell',
                  'you', 'the', 'i', 'uh', 'um', 'hmm', 'hm', 'ah',
                  'foreign', 'music', 'applause', 'laughter', 'silence',
                ]);

                const wav      = float32ToWav(samples, 16000);
                const formData = new FormData();
                formData.append(
                  'file',
                  new Blob([wav], { type: 'audio/wav' }),
                  'audio.wav',
                );
                formData.append('model',           'whisper-large-v3');
                // verbose_json exposes Whisper's internal confidence scores:
                //   avg_log_prob  — average log-probability per token.
                //                   Values near 0 = high confidence.
                //                   Values < -0.6  = model is guessing → discard.
                //   no_speech_prob — probability the audio contains no speech.
                //                   Values > 0.5   = likely silence/noise → discard.
                // These are the same signals OpenAI uses to suppress hallucinations
                // in their own Whisper post-processing pipeline.
                formData.append('response_format', 'verbose_json');
                formData.append('temperature',     '0');

                const res = await fetch(
                  'https://api.groq.com/openai/v1/audio/transcriptions',
                  {
                    method:  'POST',
                    headers: { Authorization: `Bearer ${GROQ_KEY}` },
                    body:    formData,
                  },
                );

                if (!res.ok) throw new Error(`Groq ${res.status}`);

                const data     = await res.json() as {
                  text?: string;
                  segments?: Array<{
                    avg_log_prob?: number;
                    no_speech_prob?: number;
                    compression_ratio?: number;
                  }>;
                };
                const transcript = (data.text ?? '').trim();
                const segs       = data.segments ?? [];

                // ── Layer A: Whisper confidence scores ────────────────────────
                // Reject when the model itself signals low confidence.
                if (segs.length > 0) {
                  const avgLogProb  = segs.reduce((s, g) => s + (g.avg_log_prob  ?? 0), 0) / segs.length;
                  const maxNoSpeech = Math.max(...segs.map(g => g.no_speech_prob ?? 0));

                  if (avgLogProb < -0.6 || maxNoSpeech > 0.5) {
                    callbacksRef.current?.onUserTranscript?.('\x00', true);
                    return;
                  }
                }

                // ── Layer B: text-level filters ───────────────────────────────
                const norm = transcript.toLowerCase().replace(/[^a-z\u0900-\u09FF\s]/g, '').trim();
                const isNoise =
                  !transcript ||
                  // Whisper bracketed/parenthesised no-speech markers
                  /^\s*[\[\(].*[\]\)]\s*$/.test(transcript) ||
                  // Fewer than 2 real alphabet letters
                  transcript.replace(/[^a-zA-Z\u0900-\u09FF]/g, '').length < 2 ||
                  // Direct match against known hallucination phrases
                  HALLUCINATIONS.has(norm) ||
                  // Multi-word repetition: "Thank you. Thank you. Thank you."
                  (() => {
                    const words = norm.split(/\s+/).filter(Boolean);
                    return words.length >= 2 && words.length <= 8 && new Set(words).size === 1;
                  })();

                if (isNoise) {
                  callbacksRef.current?.onUserTranscript?.('\x00', true);
                  return;
                }

                callbacksRef.current?.onUserTranscript?.(transcript, true);

                (session as any).sendClientContent({
                  turns: [{ role: 'user', parts: [{ text: transcript }] }],
                  turnComplete: true,
                });
              } catch (err) {
                console.error('Groq STT error:', err);
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

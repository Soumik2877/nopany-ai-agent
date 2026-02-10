import { useState, useRef, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { SYSTEM_INSTRUCTION } from '../utils/schoolData';
import { createPcmBlob, base64ToArrayBuffer, decodeAudioData } from '../utils/audioUtils';

interface UseLiveAPIOptions {
  onModelText?: (text: string) => void;
}

interface UseLiveAPIResult {
  connect: () => Promise<void>;
  disconnect: () => void;
  isConnected: boolean;
  isConnecting: boolean;
  error: string | null;
  analyser: AnalyserNode | null; // For visualization
}

export const useLiveAPI = (options?: UseLiveAPIOptions): UseLiveAPIResult => {
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);

  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const sessionRef = useRef<any>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const audioQueueRef = useRef<Set<AudioBufferSourceNode>>(new Set());

  const disconnect = useCallback(() => {
    // 1. Close session
    if (sessionRef.current) {
       // There is no explicit .close() in the JS SDK generic session object usually exposed, 
       // but typically we just stop sending data and let it timeout or if the SDK provides a close method.
       // The example mentions onclose callback but not explicit close method on session object in the snippet.
       // We can assume dropping the reference and stopping streams is enough or if the specific SDK version has .close()
       // For safety, we just clean up local resources.
       sessionRef.current = null;
    }

    // 2. Stop audio tracks
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }

    // 3. Close audio contexts
    if (inputAudioContextRef.current) {
      inputAudioContextRef.current.close();
      inputAudioContextRef.current = null;
    }
    if (outputAudioContextRef.current) {
      outputAudioContextRef.current.close();
      outputAudioContextRef.current = null;
    }

    // 4. Disconnect nodes
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (sourceRef.current) {
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }

    // 5. Clear audio queue
    audioQueueRef.current.forEach(source => source.stop());
    audioQueueRef.current.clear();

    setIsConnected(false);
    setIsConnecting(false);
    setAnalyser(null);
  }, []);

  const connect = useCallback(async () => {
    if (isConnecting || isConnected) return;
    setIsConnecting(true);
    setError(null);

    try {
      const apiKey = process.env.API_KEY;
      if (!apiKey) {
        throw new Error("API Key not found in environment variables");
      }

      const ai = new GoogleGenAI({ apiKey });

      // Setup Audio Contexts
      const inputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      const outputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      
      inputAudioContextRef.current = inputCtx;
      outputAudioContextRef.current = outputCtx;

      // Setup Visualizer Analyser
      const newAnalyser = outputCtx.createAnalyser();
      newAnalyser.fftSize = 256; // Smaller FFT size for smoother visuals
      setAnalyser(newAnalyser);

      // Get Microphone Stream
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      // Connect to Gemini Live
      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: SYSTEM_INSTRUCTION,
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } }, // Professional tone
          },
        },
        callbacks: {
          onopen: () => {
            console.log("Gemini Live Session Opened");
            setIsConnected(true);
            setIsConnecting(false);

            // Start processing microphone input
            const source = inputCtx.createMediaStreamSource(stream);
            sourceRef.current = source;
            
            // Use ScriptProcessor (as per guidelines example)
            const scriptProcessor = inputCtx.createScriptProcessor(4096, 1, 1);
            processorRef.current = scriptProcessor;

            scriptProcessor.onaudioprocess = (audioProcessingEvent) => {
              const inputData = audioProcessingEvent.inputBuffer.getChannelData(0);
              const pcmBlob = createPcmBlob(inputData);
              
              // Send to model
              sessionPromise.then((session) => {
                session.sendRealtimeInput({ media: pcmBlob });
              }).catch(err => console.error("Session send error", err));
            };

            source.connect(scriptProcessor);
            scriptProcessor.connect(inputCtx.destination); // Mute locally, but needed for processing
          },
          onmessage: async (message: LiveServerMessage) => {
            // Handle Audio Output
            const base64Audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (base64Audio) {
              const ctx = outputAudioContextRef.current;
              if (!ctx) return;

              // Ensure timing
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);

              try {
                const arrayBuffer = base64ToArrayBuffer(base64Audio);
                const audioBuffer = await decodeAudioData(arrayBuffer, ctx, 24000, 1);
                
                const source = ctx.createBufferSource();
                source.buffer = audioBuffer;
                
                // Connect to analyser for visualization, then to destination
                source.connect(newAnalyser);
                newAnalyser.connect(ctx.destination);

                source.addEventListener('ended', () => {
                   audioQueueRef.current.delete(source);
                });

                source.start(nextStartTimeRef.current);
                nextStartTimeRef.current += audioBuffer.duration;
                audioQueueRef.current.add(source);

              } catch (decodeErr) {
                console.error("Audio decode error:", decodeErr);
              }
            }

            // Handle text output (if provided) so the agent can trigger actions.
            const parts = message.serverContent?.modelTurn?.parts;
            if (parts && options?.onModelText) {
              const combinedText = parts
                .map((p: any) => (typeof p.text === 'string' ? p.text : ''))
                .join(' ')
                .trim();
              if (combinedText) {
                options.onModelText(combinedText);
              }
            }

            // Handle Interruption
            if (message.serverContent?.interrupted) {
              console.log("Model interrupted");
              audioQueueRef.current.forEach(source => {
                try { source.stop(); } catch(e){}
              });
              audioQueueRef.current.clear();
              nextStartTimeRef.current = 0; // Reset timing
            }
          },
          onclose: (e) => {
            console.log("Gemini Live Session Closed", e);
            disconnect();
          },
          onerror: (e) => {
            console.error("Gemini Live API Error", e);
            setError("Connection error occurred.");
            disconnect();
          }
        }
      });
      
      sessionRef.current = sessionPromise;

    } catch (err: any) {
      console.error("Connection failed:", err);
      setError(err.message || "Failed to connect");
      setIsConnecting(false);
      disconnect();
    }
  }, [disconnect, isConnecting, isConnected]);

  return {
    connect,
    disconnect,
    isConnected,
    isConnecting,
    error,
    analyser
  };
};

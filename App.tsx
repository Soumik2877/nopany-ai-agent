import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useLiveAPI } from './hooks/useLiveAPI';
import { openHand, closeHand, gestureOnSpeak, setEyeExpression } from './hooks/useHandAPI';
import { eyeExpressionFromText } from './utils/eyeExpressionFromText';
import AudioVisualizer from './components/AudioVisualizer';
import ChatLog, { TranscriptEntry } from './components/ChatLog';
import {
  Mic, MicOff, Phone, PhoneOff, AlertCircle, Info, GraduationCap,
} from 'lucide-react';

const App: React.FC = () => {
  const [showInfo,    setShowInfo]    = useState(false);
  const [handError,   setHandError]   = useState<string | null>(null);
  const [handBusy,    setHandBusy]    = useState(false);
  const [transcript,  setTranscript]  = useState<TranscriptEntry[]>([]);

  // Keep handBusy accessible in async callbacks without stale closure
  const handBusyRef = useRef(false);
  useEffect(() => { handBusyRef.current = handBusy; }, [handBusy]);

  // ── Transcript helpers ─────────────────────────────────────────────

  const upsertTranscript = useCallback((role: 'user' | 'agent', text: string, isFinal: boolean) => {
    // Gemini sends transcription as incremental delta chunks, not accumulated text.
    // Ignore empty chunks to avoid overwriting good text with blanks.
    if (!text) return;
    setTranscript(prev => {
      const last = prev[prev.length - 1];
      // Append the new chunk to the existing pending entry for this role
      if (last && last.role === role && last.pending) {
        return [...prev.slice(0, -1), { ...last, text: last.text + text, pending: !isFinal }];
      }
      // No open pending entry — start a fresh one
      return [...prev, { id: `${role}-${Date.now()}`, role, text, pending: !isFinal }];
    });
  }, []);

  // ── Hardware helpers ───────────────────────────────────────────────

  /**
   * Full open/close hand — used only for explicit keyword commands.
   */
  const runHandCommand = useCallback(async (action: 'open' | 'close') => {
    if (handBusyRef.current) return;
    setHandBusy(true);
    setHandError(null);
    try {
      if (action === 'open') await openHand();
      else                   await closeHand();
    } catch (e: any) {
      setHandError(e?.message || 'Hand action failed');
    } finally {
      setHandBusy(false);
    }
  }, []);

  // ── AI callbacks ───────────────────────────────────────────────────

  const { connect, disconnect, isConnected, isConnecting, isDisconnecting, error, analyser } = useLiveAPI({

    /**
     * Fires the moment the AI starts speaking (first audio chunk).
     * → Trigger the quick speak gesture (close → pause → open).
     * → Set eyes to "surprised" briefly to signal activation.
     *   Both are fire-and-forget so they never block the audio pipeline.
     */
    onModelSpeaking: () => {
      gestureOnSpeak();
      setEyeExpression('surprised').catch(() => {});
      // Open an empty agent bubble immediately so typing dots show
      // while transcription is still streaming in
      setTranscript(prev => {
        const last = prev[prev.length - 1];
        if (last && last.role === 'agent' && last.pending) return prev;
        return [...prev, { id: `agent-${Date.now()}`, role: 'agent', text: '', pending: true }];
      });
    },

    /**
     * Fires when the AI finishes a turn.
     * → Return eyes to neutral, hand stays open (last position from gesture).
     */
    onModelDoneSpeaking: () => {
      setEyeExpression('neutral').catch(() => {});
      // Finalise any still-pending agent entry
      setTranscript(prev => {
        const last = prev[prev.length - 1];
        if (last && last.role === 'agent' && last.pending) {
          return [...prev.slice(0, -1), { ...last, pending: false }];
        }
        return prev;
      });
    },

    /**
     * Fires with any text parts from the AI turn.
     * → Map keywords to eye expressions.
     * → Honour explicit hand commands.
     */
    onUserTranscript:  (text, isFinal) => upsertTranscript('user',  text, isFinal),
    onAgentTranscript: (text, isFinal) => upsertTranscript('agent', text, isFinal),

    onModelText: async (text: string) => {
      // Eye expression from semantic content
      try {
        const expr = eyeExpressionFromText(text);
        await setEyeExpression(expr);
      } catch { /* no hardware / backend not reachable */ }

      // Explicit hand movement commands
      const lower = text.toLowerCase();
      if (lower.includes('open hand') || lower.includes('release the hand')) {
        runHandCommand('open');
      } else if (
        lower.includes('close hand') ||
        lower.includes('grab with your hand') ||
        lower.includes('close your hand')
      ) {
        runHandCommand('close');
      }
    },
  });

  // ── Eyes follow call state ─────────────────────────────────────────
  useEffect(() => {
    if (isConnecting) return;
    setEyeExpression(isConnected ? 'neutral' : 'blink').catch(() => {});
  }, [isConnected, isConnecting]);

  // Clear chat log at the start of each new call
  useEffect(() => {
    if (isConnected) setTranscript([]);
  }, [isConnected]);

  // ── Render ─────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-slate-50 flex flex-col font-sans text-slate-900">

      {/* Header */}
      <header className="bg-white shadow-sm sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="bg-blue-900 p-2 rounded-lg text-white">
              <GraduationCap size={24} />
            </div>
            <div>
              <h1 className="text-xl font-bold text-slate-800 leading-tight">
                Nopany High School
              </h1>
              <p className="text-xs text-slate-500 font-medium tracking-wide uppercase">
                AI Receptionist
              </p>
            </div>
          </div>
          <button
            onClick={() => setShowInfo(s => !s)}
            className="text-slate-400 hover:text-slate-600 transition-colors"
          >
            <Info size={24} />
          </button>
        </div>
      </header>

      {/* Main */}
      <main className="flex-1 flex flex-col items-center justify-center p-6 relative overflow-hidden">

        {showInfo && (
          <div className="absolute top-4 right-4 max-w-sm bg-white p-4 rounded-xl shadow-lg border border-slate-100 z-20 text-sm">
            <h3 className="font-semibold mb-2 flex items-center gap-2">
              <Info size={16} className="text-blue-600" /> About this AI
            </h3>
            <p className="text-slate-600 mb-2">
              This AI receptionist can answer questions about admissions, fees,
              staff, and school policies based on the official school handbook.
            </p>
            <p className="text-slate-600">
              It supports <strong>English, Hindi, and Bengali</strong>. Just start speaking!
            </p>
          </div>
        )}

        <div className="w-full max-w-md flex flex-col items-center space-y-10 z-0">

          {/* Status text */}
          <div className="text-center space-y-2">
            <h2 className="text-3xl font-bold text-slate-800">
              {isConnected ? 'Listening…' : isConnecting ? 'Connecting…' : 'How can I help you?'}
            </h2>
            <p className="text-slate-500 text-lg">
              {isConnected
                ? 'Go ahead, ask me about fees or admissions.'
                : 'Tap the button below to start a call.'}
            </p>
          </div>

          {/* Visualizer ring */}
          <div className="relative w-72 h-72 flex items-center justify-center">
            <div className={`absolute inset-0 rounded-full border-4 border-slate-100 ${isConnected ? 'animate-pulse' : ''}`} />
            <div className={`absolute inset-4 rounded-full border-4 border-slate-50  ${isConnected ? 'animate-ping opacity-20' : ''}`} />

            <div className="w-64 h-32 absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-10 flex items-center justify-center opacity-80 pointer-events-none">
              <AudioVisualizer analyser={analyser} isActive={isConnected} barColor="#2563EB" />
            </div>

            <div className={`relative z-20 w-32 h-32 rounded-full flex items-center justify-center shadow-xl transition-all duration-500
              ${isConnected ? 'bg-blue-600 shadow-blue-200 scale-110' : 'bg-white shadow-slate-200'}`}>
              {isConnected
                ? <Mic    className="text-white     w-12 h-12" />
                : <MicOff className="text-slate-300 w-12 h-12" />}
            </div>
          </div>

          {/* Chat log — shown during a call or when there is history */}
          {(isConnected || transcript.length > 0) && (
            <ChatLog entries={transcript} />
          )}

          {/* Controls */}
          <div className="flex flex-col items-center space-y-4 w-full">

            {error && (
              <div className="bg-red-50 text-red-600 px-4 py-2 rounded-full text-sm font-medium flex items-center gap-2">
                <AlertCircle size={16} /> {error}
              </div>
            )}

            {handError && (
              <div className="bg-amber-50 text-amber-700 px-4 py-2 rounded-full text-xs font-medium flex items-center gap-2">
                <AlertCircle size={14} /> {handError}
              </div>
            )}

            {/* Call button */}
            {!isConnected ? (
              <button
                onClick={connect}
                disabled={isConnecting}
                className={`flex items-center justify-center gap-3 px-8 py-4 rounded-full text-white font-semibold text-lg transition-all duration-200 shadow-lg hover:shadow-xl hover:-translate-y-1 w-full max-w-xs
                  ${isConnecting ? 'bg-slate-400 cursor-wait' : 'bg-blue-600 hover:bg-blue-700'}`}
              >
                <Phone size={24} className={isConnecting ? 'animate-spin' : ''} />
                <span>{isConnecting ? 'Connecting…' : 'Start Conversation'}</span>
              </button>
            ) : (
              <button
                onClick={disconnect}
                disabled={isDisconnecting}
                className={`flex items-center justify-center gap-3 px-8 py-4 rounded-full font-semibold text-lg transition-all duration-200 shadow-sm w-full max-w-xs
                  ${isDisconnecting
                    ? 'bg-slate-200 text-slate-400 cursor-wait'
                    : 'bg-red-100 text-red-600 hover:bg-red-200'}`}
              >
                <PhoneOff size={24} className={isDisconnecting ? 'animate-spin' : ''} />
                <span>{isDisconnecting ? 'Ending…' : 'End Call'}</span>
              </button>
            )}

            {/* Manual hand controls */}
            <div className="flex gap-3 w-full max-w-xs">
              <button
                type="button"
                disabled={handBusy}
                onClick={() => runHandCommand('open')}
                className={`flex-1 px-4 py-2 rounded-full text-sm font-semibold border transition-colors
                  ${handBusy
                    ? 'bg-slate-200 text-slate-500 border-slate-200 cursor-wait'
                    : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'}`}
              >
                Open Hand
              </button>
              <button
                type="button"
                disabled={handBusy}
                onClick={() => runHandCommand('close')}
                className={`flex-1 px-4 py-2 rounded-full text-sm font-semibold border transition-colors
                  ${handBusy
                    ? 'bg-slate-200 text-slate-500 border-slate-200 cursor-wait'
                    : 'bg-slate-900 text-white border-slate-900 hover:bg-slate-800'}`}
              >
                Close Hand
              </button>
            </div>

            <p className="text-xs text-slate-400 text-center max-w-xs">
              Microphone access required. Please speak clearly for the best experience.
            </p>
          </div>
        </div>
      </main>

      <footer className="bg-white border-t border-slate-100 py-4 text-center text-slate-400 text-xs">
        <p>© 2026 Nopany High School. All rights reserved.</p>
        <p className="mt-1">Powered by Gemini 2.5 Live API</p>
      </footer>
    </div>
  );
};

export default App;

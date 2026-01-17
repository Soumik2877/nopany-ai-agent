import React, { useEffect, useState } from 'react';
import { useLiveAPI } from './hooks/useLiveAPI';
import AudioVisualizer from './components/AudioVisualizer';
import { Mic, MicOff, Phone, PhoneOff, AlertCircle, Info, GraduationCap } from 'lucide-react';

const App: React.FC = () => {
  const { connect, disconnect, isConnected, isConnecting, error, analyser } = useLiveAPI();
  const [showInfo, setShowInfo] = useState(false);

  // Auto-scroll logic or other UI effects could go here
  
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
                <h1 className="text-xl font-bold text-slate-800 leading-tight">Nopany High School</h1>
                <p className="text-xs text-slate-500 font-medium tracking-wide uppercase">AI Receptionist</p>
             </div>
          </div>
          <button 
            onClick={() => setShowInfo(!showInfo)}
            className="text-slate-400 hover:text-slate-600 transition-colors"
          >
            <Info size={24} />
          </button>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 flex flex-col items-center justify-center p-6 relative overflow-hidden">
        
        {/* Info Modal/Overlay */}
        {showInfo && (
          <div className="absolute top-4 right-4 max-w-sm bg-white p-4 rounded-xl shadow-lg border border-slate-100 z-20 text-sm animate-in fade-in slide-in-from-top-4">
             <h3 className="font-semibold mb-2 flex items-center gap-2">
                <Info size={16} className="text-blue-600"/> About this AI
             </h3>
             <p className="text-slate-600 mb-2">
                This AI receptionist can answer questions about admissions, fees, staff, and school policies based on the official school handbook.
             </p>
             <p className="text-slate-600">
                It supports <strong>English, Hindi, and Bengali</strong>. Just start speaking!
             </p>
          </div>
        )}

        <div className="w-full max-w-md flex flex-col items-center space-y-10 z-0">
          
          {/* Status Text */}
          <div className="text-center space-y-2">
            <h2 className="text-3xl font-bold text-slate-800">
              {isConnected 
                ? "Listening..." 
                : isConnecting 
                  ? "Connecting..." 
                  : "How can I help you?"}
            </h2>
            <p className="text-slate-500 text-lg">
               {isConnected 
                 ? "Go ahead, ask me about fees or admissions." 
                 : "Tap the button below to start a call."}
            </p>
          </div>

          {/* Visualizer & Avatar Area */}
          <div className="relative w-72 h-72 flex items-center justify-center">
            {/* Background Rings */}
            <div className={`absolute inset-0 rounded-full border-4 border-slate-100 ${isConnected ? 'animate-pulse' : ''}`}></div>
            <div className={`absolute inset-4 rounded-full border-4 border-slate-50 ${isConnected ? 'animate-ping opacity-20' : ''}`}></div>

            {/* Visualizer Container */}
            <div className="w-64 h-32 absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-10 flex items-center justify-center opacity-80 pointer-events-none">
                 {/* We only show visualizer when connected to indicate activity */}
                <AudioVisualizer analyser={analyser} isActive={isConnected} barColor="#2563EB" />
            </div>
            
            {/* Central Icon */}
            <div className={`relative z-20 w-32 h-32 rounded-full flex items-center justify-center shadow-xl transition-all duration-500 
                ${isConnected ? 'bg-blue-600 shadow-blue-200 scale-110' : 'bg-white shadow-slate-200'}`}>
                {isConnected ? (
                   <Mic className="text-white w-12 h-12" />
                ) : (
                   <MicOff className="text-slate-300 w-12 h-12" />
                )}
            </div>
          </div>

          {/* Controls */}
          <div className="flex flex-col items-center space-y-4 w-full">
            {error && (
               <div className="bg-red-50 text-red-600 px-4 py-2 rounded-full text-sm font-medium flex items-center gap-2">
                 <AlertCircle size={16} />
                 {error}
               </div>
            )}
            
            {!isConnected ? (
              <button
                onClick={connect}
                disabled={isConnecting}
                className={`group relative flex items-center justify-center gap-3 px-8 py-4 rounded-full text-white font-semibold text-lg transition-all duration-200 shadow-lg hover:shadow-xl hover:-translate-y-1 w-full max-w-xs
                    ${isConnecting ? 'bg-slate-400 cursor-wait' : 'bg-blue-600 hover:bg-blue-700'}`}
              >
                 <Phone size={24} className={isConnecting ? 'animate-spin' : ''} />
                 <span>{isConnecting ? 'Connecting...' : 'Start Conversation'}</span>
              </button>
            ) : (
              <button
                onClick={disconnect}
                className="group flex items-center justify-center gap-3 px-8 py-4 rounded-full bg-red-100 text-red-600 font-semibold text-lg transition-all duration-200 shadow-sm hover:bg-red-200 hover:shadow-md w-full max-w-xs"
              >
                <PhoneOff size={24} />
                <span>End Call</span>
              </button>
            )}
            
            <p className="text-xs text-slate-400 text-center max-w-xs">
               Microphone access required. Please speak clearly for the best experience.
            </p>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="bg-white border-t border-slate-100 py-4 text-center text-slate-400 text-xs">
         <p>© 2026 Nopany High School. All rights reserved.</p>
         <p className="mt-1">Powered by Gemini 2.5 Live API</p>
      </footer>
    </div>
  );
};

export default App;

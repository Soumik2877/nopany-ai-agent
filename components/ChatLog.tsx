import React, { useEffect, useRef } from 'react';
import { Bot, User } from 'lucide-react';

export interface TranscriptEntry {
  id: string;
  role: 'user' | 'agent';
  /** Current text — may be partial while pending is true */
  text: string;
  /** True while the turn is still streaming; false once the transcript is final */
  pending: boolean;
}

interface ChatLogProps {
  entries: TranscriptEntry[];
}

const TypingDots: React.FC = () => (
  <span className="flex items-center gap-1 py-0.5 px-1">
    {[0, 150, 300].map(delay => (
      <span
        key={delay}
        className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce"
        style={{ animationDelay: `${delay}ms` }}
      />
    ))}
  </span>
);

const ChatLog: React.FC<ChatLogProps> = ({ entries }) => {
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to newest message
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [entries]);

  if (entries.length === 0) {
    return (
      <div className="w-full rounded-2xl border border-slate-100 bg-white px-4 py-5 text-center text-slate-400 text-sm select-none">
        Your conversation will appear here once you start talking.
      </div>
    );
  }

  return (
    <div className="w-full rounded-2xl border border-slate-100 bg-white shadow-sm overflow-hidden">
      {/* Header */}
      <div className="px-4 py-2 border-b border-slate-100 flex items-center justify-between">
        <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">
          Conversation
        </span>
        <span className="text-xs text-slate-400">{entries.filter(e => e.role === 'user').length} message{entries.filter(e => e.role === 'user').length !== 1 ? 's' : ''}</span>
      </div>

      {/* Scrollable bubble list */}
      <div className="max-h-56 overflow-y-auto px-4 py-3 flex flex-col gap-3 scroll-smooth">
        {entries.map(entry => (
          <div
            key={entry.id}
            className={`flex items-end gap-2 ${entry.role === 'user' ? 'flex-row-reverse' : 'flex-row'}`}
          >
            {/* Avatar */}
            <div className={`flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center shadow-sm
              ${entry.role === 'agent' ? 'bg-blue-600' : 'bg-slate-700'}`}>
              {entry.role === 'agent'
                ? <Bot  size={14} className="text-white" />
                : <User size={14} className="text-white" />}
            </div>

            {/* Bubble */}
            <div className={`max-w-[78%] px-3 py-2 rounded-2xl text-sm leading-relaxed
              transition-opacity duration-200
              ${entry.pending ? 'opacity-70' : 'opacity-100'}
              ${entry.role === 'user'
                ? 'bg-blue-600 text-white rounded-br-none'
                : 'bg-slate-50 text-slate-800 border border-slate-100 rounded-bl-none'}`}>
              {entry.text
                ? entry.text
                : <TypingDots />}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
};

export default ChatLog;

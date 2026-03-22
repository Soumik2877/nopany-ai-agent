import React, { useEffect, useRef } from 'react';

interface AudioVisualizerProps {
  analyser: AnalyserNode | null;
  isActive: boolean;
  barColor?: string;
}

const AudioVisualizer: React.FC<AudioVisualizerProps> = ({
  analyser,
  isActive,
  barColor = '#4F46E5',
}) => {
  const canvasRef      = useRef<HTMLCanvasElement>(null);
  const requestRef     = useRef<number>();
  const lastDrawRef    = useRef<number>(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // alpha: false avoids compositing overhead on every frame
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    const dpr  = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width  = rect.width  * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const bufferLength = analyser ? analyser.frequencyBinCount : 0;
    const dataArray    = analyser ? new Uint8Array(bufferLength) : new Uint8Array(0);
    const BG           = '#f8fafc';

    const draw = (ts: number) => {
      requestRef.current = requestAnimationFrame(draw);

      // 20 FPS is plenty for a visualizer; saves CPU for audio and GPIO
      if (ts - lastDrawRef.current < 50) return;
      lastDrawRef.current = ts;

      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, rect.width, rect.height);

      if (!isActive || !analyser) return;

      analyser.getByteFrequencyData(dataArray);

      const barWidth = (rect.width / bufferLength) * 2.5;
      ctx.fillStyle  = barColor;

      let x = 0;
      for (let i = 0; i < bufferLength; i++) {
        const h = (dataArray[i] / 255) * rect.height;
        ctx.fillRect(x, (rect.height - h) / 2, barWidth, h);
        x += barWidth + 2;
      }
    };

    if (isActive) {
      requestRef.current = requestAnimationFrame(draw);
    } else {
      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, rect.width, rect.height);
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
    }

    return () => {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
    };
  }, [analyser, isActive, barColor]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: '100%', height: '100%' }}
      className="w-full h-full rounded-lg"
    />
  );
};

export default AudioVisualizer;

// import React, { useEffect, useRef } from 'react';

// interface AudioVisualizerProps {
//   analyser: AnalyserNode | null;
//   isActive: boolean;
//   barColor?: string;
// }

// const AudioVisualizer: React.FC<AudioVisualizerProps> = ({ analyser, isActive, barColor = '#4F46E5' }) => {
//   const canvasRef = useRef<HTMLCanvasElement>(null);
//   const requestRef = useRef<number>();

//   useEffect(() => {
//     const canvas = canvasRef.current;
//     if (!canvas) return;

//     const ctx = canvas.getContext('2d');
//     if (!ctx) return;

//     // Set canvas size for high DPI
//     const dpr = window.devicePixelRatio || 1;
//     const rect = canvas.getBoundingClientRect();
//     canvas.width = rect.width * dpr;
//     canvas.height = rect.height * dpr;
//     ctx.scale(dpr, dpr);

//     const bufferLength = analyser ? analyser.frequencyBinCount : 0;
//     const dataArray = analyser ? new Uint8Array(bufferLength) : new Uint8Array(0);

//     const draw = () => {
//       if (!isActive || !analyser) {
//         ctx.clearRect(0, 0, rect.width, rect.height);
//         // Draw a flat line or idle state
//         ctx.beginPath();
//         ctx.moveTo(0, rect.height / 2);
//         ctx.lineTo(rect.width, rect.height / 2);
//         ctx.strokeStyle = '#e2e8f0';
//         ctx.lineWidth = 2;
//         ctx.stroke();
//         return;
//       }

//       requestRef.current = requestAnimationFrame(draw);

//       analyser.getByteFrequencyData(dataArray);

//       ctx.clearRect(0, 0, rect.width, rect.height);

//       const barWidth = (rect.width / bufferLength) * 2.5;
//       let barHeight;
//       let x = 0;

//       for (let i = 0; i < bufferLength; i++) {
//         barHeight = (dataArray[i] / 255) * rect.height;

//         // Gradient color
//         const gradient = ctx.createLinearGradient(0, rect.height - barHeight, 0, rect.height);
//         gradient.addColorStop(0, barColor);
//         gradient.addColorStop(1, '#818CF8'); // Lighter shade

//         ctx.fillStyle = gradient;
        
//         // Center the bars vertically
//         const y = (rect.height - barHeight) / 2;
        
//         // Rounded bars
//         ctx.beginPath();
//         ctx.roundRect(x, y, barWidth, barHeight, 2);
//         ctx.fill();

//         x += barWidth + 1;
//       }
//     };

//     if (isActive) {
//       draw();
//     } else {
//         // Clear immediately if not active
//         ctx.clearRect(0, 0, rect.width, rect.height);
//         ctx.beginPath();
//         ctx.moveTo(0, rect.height / 2);
//         ctx.lineTo(rect.width, rect.height / 2);
//         ctx.strokeStyle = '#cbd5e1';
//         ctx.lineWidth = 2;
//         ctx.stroke();
//         if (requestRef.current) {
//             cancelAnimationFrame(requestRef.current);
//         }
//     }

//     return () => {
//       if (requestRef.current) {
//         cancelAnimationFrame(requestRef.current);
//       }
//     };
//   }, [analyser, isActive, barColor]);

//   return <canvas ref={canvasRef} className="w-full h-full rounded-lg" style={{ width: '100%', height: '100%' }} />;
// };

// export default AudioVisualizer;

//v2
import React, { useEffect, useRef } from 'react';

interface AudioVisualizerProps {
  analyser: AnalyserNode | null;
  isActive: boolean;
  barColor?: string;
}

const AudioVisualizer: React.FC<AudioVisualizerProps> = ({ analyser, isActive, barColor = '#4F46E5' }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const requestRef = useRef<number>();
  const lastDrawTimeRef = useRef<number>(0); // New: For throttling

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d', { alpha: false }); // Optimization: Disable alpha if not needed
    if (!ctx) return;

    // Set canvas size
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const bufferLength = analyser ? analyser.frequencyBinCount : 0;
    const dataArray = analyser ? new Uint8Array(bufferLength) : new Uint8Array(0);

    const draw = (timestamp: number) => {
      requestRef.current = requestAnimationFrame(draw);

      // Throttling: Only draw every ~33ms (30 FPS) to save CPU for Audio
      if (timestamp - lastDrawTimeRef.current < 33) return;
      lastDrawTimeRef.current = timestamp;

      if (!isActive || !analyser) {
        ctx.fillStyle = '#f8fafc'; // Clear with solid color instead of clearRect (faster)
        ctx.fillRect(0, 0, rect.width, rect.height);
        return;
      }

      analyser.getByteFrequencyData(dataArray);

      // Clear background
      ctx.fillStyle = '#f8fafc';
      ctx.fillRect(0, 0, rect.width, rect.height);

      // Wider bars = fewer bars to draw = faster
      const barWidth = (rect.width / bufferLength) * 2.5; 
      let x = 0;

      ctx.fillStyle = barColor; // Optimization: Solid color instead of Gradient

      for (let i = 0; i < bufferLength; i++) {
        const barHeight = (dataArray[i] / 255) * rect.height;
        
        // Simple rectangle is much faster than roundRect or gradients
        ctx.fillRect(x, (rect.height - barHeight) / 2, barWidth, barHeight);

        x += barWidth + 2;
      }
    };

    if (isActive) {
      requestRef.current = requestAnimationFrame(draw);
    } else {
        // Idle state
        ctx.fillStyle = '#f8fafc';
        ctx.fillRect(0, 0, rect.width, rect.height);
        if (requestRef.current) cancelAnimationFrame(requestRef.current);
    }

    return () => {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
    };
  }, [analyser, isActive, barColor]);

  return <canvas ref={canvasRef} className="w-full h-full rounded-lg" style={{ width: '100%', height: '100%' }} />;
};

export default AudioVisualizer;
import { useEffect, useRef, useState } from 'react';
import { useTheme } from '../store/theme.js';

/** Particle flow on a canvas (pauses when hidden; static for reduced motion). */
export function Particles({ count = 70 }) {
  const ref = useRef(null);
  const dark = useTheme((s) => s.resolved === 'dark');
  useEffect(() => {
    const c = ref.current;
    const ctx = c.getContext('2d');
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let raf; let w; let h;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const resize = () => {
      w = c.clientWidth; h = c.clientHeight;
      c.width = w * dpr; c.height = h * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ps = Array.from({ length: count }, () => ({
      x: Math.random() * w, y: h * (0.35 + Math.random() * 0.65), r: 0.6 + Math.random() * 1.8,
      vx: 0.15 + Math.random() * 0.45, ph: Math.random() * Math.PI * 2, a: 0.25 + Math.random() * 0.6,
    }));
    const color = dark ? '125,190,255' : '58,99,251';
    const tick = (t) => {
      ctx.clearRect(0, 0, w, h);
      for (const p of ps) {
        if (!reduce) {
          p.x += p.vx;
          p.y += Math.sin(t / 1400 + p.ph) * 0.25 - 0.08;
          if (p.x > w + 10 || p.y < h * 0.25) { p.x = -10; p.y = h * (0.45 + Math.random() * 0.55); }
        }
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${color},${p.a * (0.6 + 0.4 * Math.sin(t / 900 + p.ph))})`;
        ctx.shadowColor = `rgba(${color},0.9)`;
        ctx.shadowBlur = dark ? 8 : 4;
        ctx.fill();
      }
      if (!reduce && !document.hidden) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const onVis = () => { if (!document.hidden) { cancelAnimationFrame(raf); raf = requestAnimationFrame(tick); } };
    window.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', onVis);
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', resize); document.removeEventListener('visibilitychange', onVis); };
  }, [count, dark]);
  return <canvas ref={ref} className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true" />;
}

function wavePath(amp, len, y, width = 2880, height = 400) {
  let d = `M0 ${y}`;
  for (let x = 0; x <= width; x += len) {
    d += ` Q ${x + len / 4} ${y - amp} ${x + len / 2} ${y} T ${x + len} ${y}`;
  }
  return `${d} V ${height} H 0 Z`;
}

/** Slowly moving layered waves along the bottom of the scene. */
export function Waves({ className = '' }) {
  const dark = useTheme((s) => s.resolved === 'dark');
  const layers = dark
    ? [['rgba(37,99,235,0.22)', 60, 720, 230, 26], ['rgba(56,189,248,0.16)', 40, 480, 270, 18], ['rgba(99,102,241,0.18)', 30, 960, 310, 34]]
    : [['rgba(58,99,251,0.12)', 60, 720, 230, 26], ['rgba(56,189,248,0.14)', 40, 480, 270, 18], ['rgba(111,140,255,0.16)', 30, 960, 310, 34]];
  return (
    <div className={`pointer-events-none absolute inset-x-0 bottom-0 h-[46vh] overflow-hidden ${className}`} aria-hidden="true">
      {layers.map(([fill, amp, len, y, dur], i) => (
        <svg key={i} className="absolute bottom-0 left-0 h-full" style={{ width: '200%', animation: `wave ${dur}s linear infinite` }} viewBox="0 0 2880 400" preserveAspectRatio="none">
          <path d={wavePath(amp, len, y)} fill={fill} />
          <path d={wavePath(amp, len, y)} fill="none" stroke={dark ? 'rgba(125,190,255,0.35)' : 'rgba(58,99,251,0.25)'} strokeWidth="1.2" />
        </svg>
      ))}
    </div>
  );
}

/** Floating envelope with a check badge + paper plane flying along a dashed curve (loop). */
export function FlightIllustration() {
  const dark = useTheme((s) => s.resolved === 'dark');
  const path = 'M 70 250 C 150 250, 190 170, 230 130 S 330 40, 400 20';
  return (
    <div className="relative mx-auto h-[280px] w-full max-w-[460px]" aria-hidden="true">
      <svg viewBox="0 0 460 280" className="absolute inset-0 h-full w-full overflow-visible">
        <defs>
          <linearGradient id="plane" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stopColor="#e0f2ff" /><stop offset="1" stopColor="#5aa9ff" /></linearGradient>
          <filter id="planeGlow"><feGaussianBlur stdDeviation="3" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
        </defs>
        <path d={path} fill="none" stroke={dark ? 'rgba(125,190,255,0.55)' : 'rgba(58,99,251,0.45)'} strokeWidth="2" strokeDasharray="5 8" strokeLinecap="round" />
        <circle cx="300" cy="150" r="28" fill="none" stroke={dark ? 'rgba(125,190,255,0.35)' : 'rgba(58,99,251,0.3)'} strokeDasharray="4 7" />
        <g filter="url(#planeGlow)">
          <g>
            <path d="M -20 -2 L 22 -16 L 6 18 L 0 4 Z" fill="url(#plane)" />
            <path d="M 0 4 L 22 -16 L 4 8 Z" fill="#2f6bff" opacity="0.85" />
            <animateMotion dur="6.5s" repeatCount="indefinite" rotate="auto" path={path} keyPoints="0;1" keyTimes="0;1" calcMode="spline" keySplines="0.45 0 0.35 1" />
          </g>
          <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.1;0.85;1" dur="6.5s" repeatCount="indefinite" />
        </g>
      </svg>
      <div className="absolute bottom-0 left-0 animate-float">
        <svg width="170" height="130" viewBox="0 0 170 130">
          <defs>
            <linearGradient id="envBody" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#ffffff" /><stop offset="1" stopColor="#cfe1ff" /></linearGradient>
            <linearGradient id="envFlap" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#eef5ff" /><stop offset="1" stopColor="#b9d2ff" /></linearGradient>
            <filter id="envShadow" x="-30%" y="-30%" width="160%" height="170%"><feDropShadow dx="0" dy="14" stdDeviation="12" floodColor="#1d4ed8" floodOpacity="0.35" /></filter>
          </defs>
          <g filter="url(#envShadow)">
            <rect x="12" y="28" width="130" height="88" rx="14" fill="url(#envBody)" />
            <path d="M 14 36 L 77 82 L 140 36" fill="none" stroke="#9cbcff" strokeWidth="3" strokeLinejoin="round" />
            <path d="M 14 112 L 60 72 M 140 112 L 94 72" stroke="#c4d8ff" strokeWidth="2.5" />
            <path d="M 18 32 L 77 76 L 136 32 Z" fill="url(#envFlap)" opacity="0.7" />
          </g>
          <circle cx="138" cy="30" r="20" fill="#2f6bff" stroke="#fff" strokeWidth="3" />
          <path d="M 129 30 L 136 37 L 148 24" fill="none" stroke="#fff" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
    </div>
  );
}

/** Typewriter headline, line by line. Full text is reserved invisibly so layout never shifts. */
export function TypeHeadline({ parts, speed = 38, className = '' }) {
  const total = parts.reduce((s, p) => s + (p.br ? 0 : p.t.length), 0);
  const [n, setN] = useState(() => (window.matchMedia('(prefers-reduced-motion: reduce)').matches ? total : 0));
  useEffect(() => {
    if (n >= total) return undefined;
    const t = setTimeout(() => setN((x) => x + 1), n === 0 ? 650 : speed);
    return () => clearTimeout(t);
  }, [n, total, speed]);
  const render = (limit) => {
    let left = limit;
    return parts.map((p, i) => {
      if (p.br) return <br key={i} />;
      const s = p.t.slice(0, Math.max(0, left));
      left -= p.t.length;
      return <span key={i} className={p.cls}>{s}</span>;
    });
  };
  return (
    <h1 className={`relative ${className}`} aria-label={parts.map((p) => p.t || ' ').join('')}>
      <span className="invisible" aria-hidden="true">{render(total)}</span>
      <span className="absolute inset-0" aria-hidden="true">
        {render(n)}
        <span className={`ml-1 inline-block h-[0.9em] w-[3px] translate-y-[0.1em] bg-sky-400 ${n >= total ? 'animate-pulse' : ''}`} />
      </span>
    </h1>
  );
}

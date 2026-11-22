import { useEffect, useRef, useState } from 'react';

const BASE_CSS = `html,body{margin:0;padding:0;background:#fff}
body{font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#1f2937;word-wrap:break-word;overflow-wrap:anywhere;padding:2px 2px 6px}
a{color:#2563eb}img{max-width:100%;height:auto}blockquote{margin:6px 0 6px 6px;padding-left:12px;border-left:3px solid #e5e7eb;color:#4b5563}
p{margin:0 0 10px}table{max-width:100%}pre{white-space:pre-wrap}`;

/**
 * Renders received (already sanitized) email HTML in an isolated, script-free frame that grows to fit its content.
 * sandbox without "allow-scripts": no code can run inside; "allow-same-origin" only lets us measure the height.
 */
export default function EmailFrame({ html, minHeight = 60, className = '' }) {
  const ref = useRef(null);
  const [height, setHeight] = useState(minHeight);
  const doc = `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>${BASE_CSS}</style></head><body>${html || ''}</body></html>`;

  useEffect(() => {
    const frame = ref.current;
    if (!frame) return undefined;
    let ro;
    const measure = () => {
      try {
        const d = frame.contentDocument;
        if (!d?.body) return;
        setHeight(Math.max(minHeight, Math.ceil(d.documentElement.scrollHeight)));
        if (!ro && typeof ResizeObserver !== 'undefined') { ro = new ResizeObserver(measure); ro.observe(d.body); }
      } catch { /* cross-origin: keep default height */ }
    };
    frame.addEventListener('load', measure);
    measure();
    return () => { frame.removeEventListener('load', measure); ro?.disconnect(); };
  }, [doc, minHeight]);

  return (
    <iframe ref={ref} title="Email message" srcDoc={doc} style={{ height }}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      className={`block w-full rounded-xl border-0 bg-white ${className}`} />
  );
}
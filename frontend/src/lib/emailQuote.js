/**
 * Split an email reply into the new message and the quoted earlier conversation, like Gmail's "•••".
 * Works on already-sanitized HTML (classes are stripped, so it looks for the "On … wrote:" line,
 * Outlook's "From: … Sent:" header, "-----Original Message-----" or the first <blockquote>).
 */
const ATTRIBUTION = [
  /^On\b[\s\S]{3,300}?\bwrote:\s*$/i, // Gmail / Apple Mail: "On Fri, 20 Nov 2026 at 8:43 PM, Name <x@y> wrote:"
  /^Le\b[\s\S]{3,300}?a écrit\s*:\s*$/i,
  /^Am\b[\s\S]{3,300}?schrieb[\s\S]{0,60}:\s*$/i,
  /^El\b[\s\S]{3,300}?escribió:\s*$/i,
  /^-{2,}\s*(Original Message|Forwarded message)\s*-{2,}/i,
  /^From:\s[\s\S]{1,200}?(Sent|Date):\s/i, // Outlook
];

const isAttribution = (t) => ATTRIBUTION.some((re) => re.test(t));

export function splitQuotedHtml(html) {
  if (!html) return { main: '', quoted: '' };
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, 'text/html');
  const body = doc.body;
  let cut = null;
  const walker = doc.createTreeWalker(body, NodeFilter.SHOW_ELEMENT);
  for (let el = walker.nextNode(); el; el = walker.nextNode()) {
    if (el.tagName === 'BLOCKQUOTE') { cut = el; break; }
    if (el.tagName === 'HR') { const next = el.nextElementSibling; if (next && /^From:/i.test(next.textContent.trim())) { cut = el; break; } }
    if (!/^(DIV|P|SPAN|TD|FONT|B)$/.test(el.tagName)) continue;
    const t = el.textContent.replace(/\s+/g, ' ').trim();
    if (t.length > 400 || !isAttribution(t)) continue;
    // Use the smallest element that holds exactly the attribution line.
    const child = [...el.children].find((c) => isAttribution(c.textContent.replace(/\s+/g, ' ').trim()));
    if (child) continue;
    cut = el;
    break;
  }
  if (!cut) {
    // Plain "On … wrote:" text directly inside a block with <br>s.
    const tw = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    for (let n = tw.nextNode(); n; n = tw.nextNode()) {
      if (/\bwrote:\s*$/i.test(n.data) && /^\s*On\b/i.test(n.data)) { cut = n; break; }
    }
  }
  if (!cut) return { main: html, quoted: '' };
  const range = doc.createRange();
  range.setStartBefore(cut);
  range.setEndAfter(body.lastChild);
  const frag = range.extractContents();
  const holder = doc.createElement('div');
  holder.appendChild(frag);
  // Drop trailing empty lines from the main part.
  const main = body.innerHTML.replace(/(\s|<br\s*\/?>|<div>\s*(<br\s*\/?>)?\s*<\/div>)+$/gi, '');
  if (!main.replace(/<[^>]+>|&nbsp;/g, '').trim()) return { main: html, quoted: '' }; // everything was "quote": show all
  return { main, quoted: holder.innerHTML };
}

export function splitQuotedText(text) {
  const lines = String(text || '').split(/\r?\n/);
  const at = lines.findIndex((l, i) => {
    const t = l.trim();
    if (/^>/.test(t)) return true;
    if (isAttribution(t)) return true;
    // "On Fri, 20 Nov 2026 at 8:43 PM, Name <x@y>" + next line "wrote:"
    return /^On\b/.test(t) && /^wrote:/.test((lines[i + 1] || '').trim());
  });
  if (at <= 0) return { main: String(text || '').trim(), quoted: '' };
  return { main: lines.slice(0, at).join('\n').trimEnd(), quoted: lines.slice(at).join('\n') };
}
/**
 * Pitch text helpers for the visual editor.
 *  - plainTextToHtml: pasted plain text → paragraphs (blank line = new paragraph, single newline = line break)
 *  - formatPitch:     the "Format" button — tidy spacing, greeting, bullets, signature, links, pasted styles
 *  - toEmailHtml:     editor HTML → email-client-safe HTML with inline spacing (what gets saved and sent)
 */

const ESC = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
export const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

const GREETING =
  /^(hi|hello|hey|dear|greetings|good\s+(morning|afternoon|evening)|namaste)\b/i;
const SIGNOFF =
  /^(best\s+regards|kind\s+regards|warm(est)?\s+regards|regards|best\s+wishes|best|thanks\s*(and|&)\s*regards|thanks|thank\s+you|many\s+thanks|sincerely|yours\s+(sincerely|truly|faithfully)|cheers|respectfully|with\s+regards)\s*[,.!]?$/i;
const PS = /^p\.?\s?s\.?(\s|:|$)/i;
const BULLET = /^\s*[-*•·▪◦‣–]\s+/;
const NUMBERED = /^\s*\d{1,2}[.)]\s+/;
const BLOCK = new Set([
  "P",
  "DIV",
  "BLOCKQUOTE",
  "PRE",
  "SECTION",
  "ARTICLE",
  "HEADER",
  "FOOTER",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
]);
const LIST = new Set(["UL", "OL"]);
const FONT_SIZES = new Set(["13px", "18px", "22px"]);

const parse = (html) =>
  new DOMParser().parseFromString(
    `<!doctype html><body>${html || ""}</body>`,
    "text/html",
  );
const textOf = (html) => {
  const d = document.createElement("div");
  d.innerHTML = html;
  return (d.textContent || "").replace(/ /g, " ").replace(/\s+/g, " ").trim();
};

/* ------------------------------------------------------------------ paste */

export function plainTextToHtml(text) {
  const blocks = String(text || "")
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ")
    .split(/\n[ \t]*\n+/);
  const out = [];
  for (const block of blocks) {
    const lines = block
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l.trim());
    if (!lines.length) continue;
    let para = [];
    let list = null;
    const flushPara = () => {
      if (para.length) out.push(`<p>${para.join("<br>")}</p>`);
      para = [];
    };
    const flushList = () => {
      if (list)
        out.push(
          `<${list.tag}>${list.items.map((i) => `<li><p>${i}</p></li>`).join("")}</${list.tag}>`,
        );
      list = null;
    };
    for (const line of lines) {
      const tag = BULLET.test(line) ? "ul" : NUMBERED.test(line) ? "ol" : null;
      if (tag) {
        flushPara();
        if (list && list.tag !== tag) flushList();
        list ||= { tag, items: [] };
        list.items.push(
          escapeHtml(line.replace(tag === "ul" ? BULLET : NUMBERED, "").trim()),
        );
      } else {
        flushList();
        para.push(escapeHtml(line.trim()));
      }
    }
    flushList();
    flushPara();
  }
  return out.join("");
}

/* ------------------------------------------------------------------ format */

function stripMarker(html, re) {
  const d = document.createElement("div");
  d.innerHTML = html;
  const walker = document.createTreeWalker(d, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.data.trim()) continue;
    n.data = n.data.replace(re, "");
    break;
  }
  return d.innerHTML;
}

function addTrailingComma(line) {
  if (/[A-Za-z0-9}\])]$/.test(line.text)) {
    line.html += ",";
    line.text += ",";
  }
}

/** Tidy one line/paragraph of inline HTML: spaces, punctuation, pasted styles, bare links, capital first letter. */
function tidyInline(html, { capitalize = false } = {}) {
  const d = document.createElement("div");
  d.innerHTML = html;

  // Pasted styles: keep the editor's own sizes/colours, drop fonts, near-black text and white backgrounds.
  for (const el of [...d.querySelectorAll("[style]")]) {
    const s = el.style;
    s.removeProperty("font-family");
    s.removeProperty("line-height");
    if (s.fontSize && !FONT_SIZES.has(s.fontSize))
      s.removeProperty("font-size");
    const rgb = (v) => (v.match(/\d+/g) || []).map(Number);
    if (s.color) {
      const [r, g, b] = rgb(s.color);
      if (
        r !== undefined &&
        Math.max(r, g, b) < 90 &&
        Math.max(r, g, b) - Math.min(r, g, b) < 25
      )
        s.removeProperty("color");
    }
    if (s.backgroundColor) {
      const [r, g, b, a] = rgb(s.backgroundColor);
      if (
        /transparent/.test(s.backgroundColor) ||
        a === 0 ||
        (r > 245 && g > 245 && b > 245)
      )
        s.removeProperty("background-color");
    }
    for (const p of Array.from({ length: s.length }, (_, i) => s.item(i)))
      if (!["color", "background-color", "font-size", "text-align"].includes(p))
        s.removeProperty(p);
    if (!el.getAttribute("style")?.trim()) el.removeAttribute("style");
  }
  for (const span of [...d.querySelectorAll("span:not([style]), font")])
    span.replaceWith(...span.childNodes);

  const texts = [];
  const walker = document.createTreeWalker(d, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n);
  for (const n of texts) {
    let t = n.data
      .replace(/ /g, " ")
      .replace(/[ \t\n]{2,}/g, " ")
      .replace(/\n/g, " ");
    if (!n.parentElement?.closest("a")) {
      t = t
        .replace(/\s+([,.!?;:])(?=\s|$)/g, "$1") // "word ," → "word,"
        .replace(/([A-Za-z])\s+([,.!?;])(?=[A-Za-z])/g, "$1$2 ") // "time .We" → "time. We"
        .replace(/([a-z])([.!?])([A-Z])/g, "$1$2 $3") // "end.Next" → "end. Next"
        .replace(/([A-Za-z])([,;])([A-Za-z])/g, "$1$2 $3"); // "one,two" → "one, two"
    }
    n.data = t;
  }
  // Trim the outer edges.
  const nonEmpty = texts.filter((n) => n.data.length);
  if (nonEmpty.length) {
    nonEmpty[0].data = nonEmpty[0].data.replace(/^\s+/, "");
    const last = nonEmpty[nonEmpty.length - 1];
    last.data = last.data.replace(/\s+$/, "");
    if (capitalize) {
      const first = nonEmpty.find((n) => n.data.trim());
      if (
        first &&
        /^[a-z]/.test(first.data) &&
        !/^(www\.|https?:|\S*@)/i.test(first.data)
      )
        first.data = first.data[0].toUpperCase() + first.data.slice(1);
    }
  }
  // Bare links and email addresses → clickable.
  const LINK =
    /((?:https?:\/\/|www\.)[^\s<]+[^\s<.,;:!?)\]'"]|[\w.+-]+@[\w-]+\.[\w.-]*[A-Za-z])/g;
  for (const n of texts) {
    if (!d.contains(n) || n.parentElement?.closest("a") || !LINK.test(n.data))
      continue;
    LINK.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const m of n.data.matchAll(LINK)) {
      frag.append(n.data.slice(last, m.index));
      const a = document.createElement("a");
      const v = m[0];
      a.href =
        v.includes("@") && !/^https?:/i.test(v) && !v.startsWith("www.")
          ? `mailto:${v}`
          : v.startsWith("www.")
            ? `https://${v}`
            : v;
      a.textContent = v;
      frag.append(a);
      last = m.index + v.length;
    }
    frag.append(n.data.slice(last));
    n.replaceWith(frag);
  }
  return d.innerHTML;
}

/**
 * Re-flow a pitch: one paragraph per idea with even spacing, greeting on its own line,
 * bullet/numbered lines as lists, hard-wrapped lines joined, the sign-off kept as a compact signature block.
 */
export function formatPitch(html) {
  const doc = parse(html);
  const items = []; // {kind:'line', html, text} | {kind:'gap'} | {kind:'pend'} | {kind:'list', tag, items}

  const addParagraph = (inner) => {
    const lines = inner.split(/<br\s*\/?>/i).map((h) => h.trim());
    if (lines.every((h) => !textOf(h))) {
      items.push({ kind: "gap" });
      return;
    }
    for (const h of lines) {
      const text = textOf(h);
      items.push(text ? { kind: "line", html: h, text } : { kind: "gap" });
    }
    items.push({ kind: "pend" });
  };
  const addList = (el) => {
    const lis = [...el.children]
      .filter((c) => c.tagName === "LI")
      .map((li) =>
        [...li.childNodes]
          .map((c) =>
            c.nodeType === 1 && BLOCK.has(c.tagName)
              ? c.innerHTML
              : c.nodeType === 1
                ? c.outerHTML
                : escapeHtml(c.textContent),
          )
          .join(" ")
          .trim(),
      )
      .filter((h) => textOf(h));
    if (lis.length)
      items.push({ kind: "list", tag: el.tagName.toLowerCase(), items: lis });
  };
  const hasBlockChild = (el) =>
    [...el.children].some((c) => BLOCK.has(c.tagName) || LIST.has(c.tagName));
  const walk = (parent) => {
    let run = [];
    const flush = () => {
      if (!run.length) return;
      const tmp = doc.createElement("div");
      run.forEach((n) => tmp.appendChild(n.cloneNode(true)));
      if (textOf(tmp.innerHTML)) addParagraph(tmp.innerHTML);
      run = [];
    };
    for (const n of [...parent.childNodes]) {
      if (n.nodeType === 1 && LIST.has(n.tagName)) {
        flush();
        addList(n);
      } else if (n.nodeType === 1 && BLOCK.has(n.tagName)) {
        flush();
        if (hasBlockChild(n)) walk(n);
        else if (/^H\d$/.test(n.tagName))
          addParagraph(`<strong>${n.innerHTML}</strong>`);
        else addParagraph(n.innerHTML);
      } else if (n.nodeType === 3 && !n.data.trim() && !run.length) continue;
      else run.push(n);
    }
    flush();
  };
  walk(doc.body);

  // Group lines into paragraphs. If the text uses blank lines between paragraphs, those decide;
  // otherwise every original paragraph stays a paragraph.
  const hasGaps = items.some((i) => i.kind === "gap");
  let groups = [];
  let cur = null;
  const close = () => {
    if (cur?.lines.length) groups.push(cur);
    cur = null;
  };
  for (const it of items) {
    if (it.kind === "line") {
      cur ||= { type: "p", lines: [] };
      cur.lines.push(it);
    } else if (it.kind === "gap" || (it.kind === "pend" && !hasGaps)) close();
    else if (it.kind === "list") {
      close();
      groups.push(it);
    }
  }
  close();

  // Signature: last sign-off line ("Regards,") + the short lines after it become one compact block.
  let sig = null;
  outer: for (
    let gi = groups.length - 1;
    gi >= Math.max(0, groups.length - 4);
    gi--
  ) {
    const g = groups[gi];
    if (g.type !== "p") continue;
    for (let li = g.lines.length - 1; li >= 0; li--) {
      if (!SIGNOFF.test(g.lines[li].text)) continue;
      const tail = [];
      let rest = [];
      let stop = false;
      for (const l of g.lines.slice(li + 1)) {
        if (stop || PS.test(l.text)) {
          stop = true;
          rest.push(l);
        } else tail.push(l);
      }
      const after = [];
      for (const ng of groups.slice(gi + 1)) {
        if (stop || ng.type !== "p") {
          stop = true;
          after.push(ng);
          continue;
        }
        const psAt = ng.lines.findIndex((l) => PS.test(l.text));
        if (psAt === -1) tail.push(...ng.lines);
        else {
          tail.push(...ng.lines.slice(0, psAt));
          rest = rest.concat(ng.lines.slice(psAt));
          stop = true;
        }
      }
      if (tail.length > 8 || tail.some((l) => l.text.length > 80)) break outer;
      const sign = { ...g.lines[li] };
      addTrailingComma(sign);
      sig = { type: "p", sig: true, lines: [sign, ...tail] };
      const before = g.lines.slice(0, li);
      const extra = rest.length ? [{ type: "p", lines: rest }] : [];
      groups = [
        ...groups.slice(0, gi),
        ...(before.length ? [{ type: "p", lines: before }] : []),
        sig,
        ...extra,
        ...after.filter(
          (x) => x.type !== "p" || !x.lines.every((l) => tail.includes(l)),
        ),
      ];
      break outer;
    }
  }

  // Greeting on its own line, ending with a comma.
  const firstIdx = groups.findIndex((g) => g.type === "p");
  if (firstIdx !== -1 && !groups[firstIdx].sig) {
    const g = groups[firstIdx];
    const first = g.lines[0];
    if (GREETING.test(first.text) && first.text.length <= 60) {
      addTrailingComma(first);
      if (g.lines.length > 1)
        groups.splice(
          firstIdx,
          1,
          { type: "p", lines: [first] },
          { type: "p", lines: g.lines.slice(1) },
        );
    }
  }

  // Bullet / numbered lines → real lists; hard-wrapped lines → joined sentences.
  const isItem = (l) => BULLET.test(l.text) || NUMBERED.test(l.text);
  groups = groups.reduce((acc, g) => {
    const prev = acc[acc.length - 1];
    if (
      g.type === "p" &&
      !g.sig &&
      prev?.type === "p" &&
      !prev.sig &&
      g.lines.every(isItem) &&
      isItem(prev.lines[prev.lines.length - 1])
    )
      prev.lines = prev.lines.concat(g.lines);
    else acc.push(g.type === "p" ? { ...g, lines: [...g.lines] } : g);
    return acc;
  }, []);
  const next = [];
  for (const g of groups) {
    if (g.type !== "p" || g.sig) {
      next.push(g);
      continue;
    }
    let para = [];
    let list = null;
    const flushP = () => {
      if (para.length) next.push({ type: "p", lines: para });
      para = [];
    };
    const flushL = () => {
      if (list && (list.tag === "ul" || list.items.length > 1)) next.push(list);
      else if (list) para.push(...list.raw);
      list = null;
    };
    for (const l of g.lines) {
      const tag = BULLET.test(l.text)
        ? "ul"
        : NUMBERED.test(l.text)
          ? "ol"
          : null;
      if (tag) {
        if (list && list.tag !== tag) {
          flushL();
        }
        if (!list) flushP();
        list ||= { type: "list", kind: "list", tag, items: [], raw: [] };
        list.items.push(stripMarker(l.html, tag === "ul" ? BULLET : NUMBERED));
        list.raw.push(l);
      } else {
        flushL();
        const prev = para[para.length - 1];
        if (
          prev &&
          !/[.!?:;,)"'\]}]$/.test(prev.text) &&
          (/^[a-z(]/.test(l.text) ||
            (/^\d/.test(l.text) &&
              /[a-z]$/.test(prev.text) &&
              prev.text.length >= 50))
        )
          para[para.length - 1] = {
            html: `${prev.html} ${l.html}`,
            text: `${prev.text} ${l.text}`,
          };
        else para.push(l);
      }
    }
    flushL();
    flushP();
  }

  return next
    .map((g) => {
      if (g.type === "list" || g.kind === "list") {
        const tag = g.tag;
        return `<${tag}>${g.items.map((h) => `<li><p>${tidyInline(h, { capitalize: true })}</p></li>`).join("")}</${tag}>`;
      }
      const lines = g.lines
        .map((l, i) => tidyInline(l.html, { capitalize: i === 0 || g.sig }))
        .filter((h) => textOf(h));
      return lines.length ? `<p>${lines.join("<br>")}</p>` : "";
    })
    .join("");
}

/* ------------------------------------------------------------------ export */

const BODY_STYLE =
  "font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#1f2937";

/** Editor HTML → email-safe HTML: inline spacing so Gmail/Outlook/Apple Mail show the same paragraphs. */
export function toEmailHtml(html) {
  const doc = parse(html);
  const body = doc.body;
  const addStyle = (el, css) => {
    el.setAttribute(
      "style",
      `${css}${el.getAttribute("style") ? `;${el.getAttribute("style")}` : ""}`,
    );
  };
  for (const li of body.querySelectorAll("li")) {
    const ps = [...li.children].filter((c) => c.tagName === "P");
    ps.forEach((p, i) => {
      if (i > 0) p.before(doc.createElement("br"));
      p.replaceWith(...p.childNodes);
    });
    addStyle(li, "margin:0 0 6px 0");
  }
  for (const p of body.querySelectorAll("p")) {
    if (!textOf(p.innerHTML) && !p.querySelector("img")) p.innerHTML = "&nbsp;";
    addStyle(p, "margin:0 0 16px 0");
  }
  for (const l of body.querySelectorAll("ul, ol"))
    addStyle(l, "margin:0 0 16px 0;padding-left:24px");
  for (const a of body.querySelectorAll("a")) {
    a.removeAttribute("rel");
    a.removeAttribute("class");
    if (!/color/.test(a.getAttribute("style") || ""))
      addStyle(a, "color:#2563eb;text-decoration:underline");
  }
  for (const m of body.querySelectorAll("mark")) {
    const s = doc.createElement("span");
    s.setAttribute(
      "style",
      m.getAttribute("style") || "background-color:#fef08a",
    );
    s.append(...m.childNodes);
    m.replaceWith(s);
  }
  const inner = body.innerHTML.trim();
  return inner ? `<div style="${BODY_STYLE}">${inner}</div>` : "";
}

/** Does this HTML use layout the visual editor can't keep (tables, images, custom blocks)? */
export const needsCodeMode = (html) =>
  /<(table|img|center|font|style|h[1-6]|hr|iframe|video)\b/i.test(html || "");

export const wordCount = (html) => (textOf(html).match(/\S+/g) || []).length;

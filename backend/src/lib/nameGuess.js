/**
 * Guess a person's name and company from an email address.
 *   ravi.kumar@acme-tools.co.in  → { firstName: 'Ravi', lastName: 'Kumar', company: 'Acme Tools' }
 *   info@acme.com                → { firstName: '', lastName: '', company: 'Acme' }   (role address: no name)
 *   priya123@gmail.com           → { firstName: 'Priya', lastName: '', company: '' }  (free provider: no company)
 * Guesses are conservative: when unsure the field stays empty so templates fall back
 * (e.g. "Hi {{firstName|there}},").
 * NOTE: the same file exists in frontend/src/lib/nameGuess.js — keep both in sync.
 */

const ROLE = new Set(
  (
    "info contact contacts sales support help hello hi admin administrator office team hr careers jobs " +
    "billing accounts account accounting finance marketing enquiry enquiries inquiry inquiries mail email noreply no-reply " +
    "donotreply do-not-reply service services customerservice customercare care feedback press media pr webmaster postmaster " +
    "hostmaster abuse security legal compliance privacy orders order booking bookings reservations purchase purchasing " +
    "procurement export import director manager ceo cfo cto md founder owner reception frontdesk general business biz " +
    "newsletter news notifications alerts system root test demo user users group all staff everyone hey query queries"
  ).split(/\s+/),
);

const FREE = new Set(
  (
    "gmail googlemail yahoo ymail rocketmail hotmail outlook live msn aol icloud me mac rediffmail rediff " +
    "protonmail proton pm zoho zohomail gmx mail yandex qq 163 126 sina inbox fastmail tutanota tuta hey hushmail " +
    "aim lycos rambler web freenet orange wanadoo sify vsnl bsnl airtelmail indiatimes"
  ).split(/\s+/),
);

// Second-level public suffixes, so acme.co.in → "acme", not "co".
const SLD = new Set(
  "co com net org gov edu ac ltd plc nic res gen firm ind info biz".split(" "),
);

const ONSETS = new Set(
  "bh bl br ch cl cr dh dr fl fr gh gl gr jh kh kl kr ph pl pr sh sk sl sm sn sp sr st sw th tr vr".split(
    " ",
  ),
);
const VOWEL = /[aeiouy]/;

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

function looksLikeName(token, { single = false } = {}) {
  if (!/^[a-z]+$/.test(token) || token.length < 2) return false;
  if (!VOWEL.test(token) || ROLE.has(token)) return false;
  if (single) {
    if (token.length < 3 || token.length > 12) return false;
    const a = token[0];
    const b = token[1];
    const cons = (c) => !/[aeiou]/.test(c);
    if (cons(a) && cons(b) && !ONSETS.has(a + b)) return false; // "jsmith", "mkumar" → not a first name
  }
  return true;
}

export function guessFromEmail(email) {
  const out = { firstName: "", lastName: "", company: "" };
  const m = String(email || "")
    .trim()
    .toLowerCase()
    .match(/^([^@\s]+)@([^@\s]+\.[^@\s]+)$/);
  if (!m) return out;
  const local = m[1].replace(/\+.*$/, "");
  const domain = m[2];

  // Name from the part before "@".
  if (!ROLE.has(local.replace(/[^a-z]/g, ""))) {
    const parts = local.split(/[._\-\d]+/).filter(Boolean);
    if (parts.length >= 2) {
      if (parts[0].length >= 2 && looksLikeName(parts[0]))
        out.firstName = cap(parts[0]);
      if (out.firstName && parts[1].length >= 2 && looksLikeName(parts[1]))
        out.lastName = cap(parts[1]);
    } else if (
      parts.length === 1 &&
      looksLikeName(parts[0], { single: true })
    ) {
      out.firstName = cap(parts[0]);
    }
  }

  // Company from the domain (not for free mailbox providers).
  const labels = domain.split(".");
  let i = labels.length - 2;
  if (i > 0 && SLD.has(labels[i]) && labels[labels.length - 1].length === 2)
    i -= 1;
  const brand = labels[Math.max(0, i)] || "";
  if (
    brand &&
    !FREE.has(brand) &&
    !/^(mail|email|webmail|smtp|mx)$/.test(brand)
  ) {
    out.company = brand
      .split(/[-_]+/)
      .filter(Boolean)
      .map((w) => (w.length <= 3 ? w.toUpperCase() : cap(w)))
      .join(" ");
  }
  return out;
}

/** Split "Ravi Kumar" / "Kumar, Ravi" / "Dr. Ravi Kumar" into first and last name. */
export function splitFullName(full) {
  let s = String(full || "")
    .replace(/["'<>()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!s || /@/.test(s)) return { firstName: "", lastName: "" };
  if (/^[^,]+,\s*[^,]+$/.test(s)) {
    const [last, first] = s.split(/,\s*/);
    s = `${first} ${last}`;
  }
  s = s.replace(/^(mr|mrs|ms|miss|dr|prof|shri|smt|sir|madam)\.?\s+/i, "");
  const words = s.split(" ").filter(Boolean);
  const fix = (w) =>
    w === w.toUpperCase() || w === w.toLowerCase() ? cap(w) : w;
  return {
    firstName: words[0] ? fix(words[0]) : "",
    lastName: words.slice(1).map(fix).join(" "),
  };
}

/**
 * Turn whatever an employee pastes or uploads into contact rows:
 *  - plain emails (one per line, or separated by commas / semicolons / spaces)
 *  - "Ravi Kumar <ravi@acme.com>" (copied from Gmail / Outlook "To" fields)
 *  - rows copied from Excel / Google Sheets (tab separated), with or without a header row
 *  - CSV text, .csv files and .xlsx files
 * Missing first name / company are guessed from the address and flagged, so the employee can check them.
 */
import { guessFromEmail, splitFullName } from "./nameGuess.js";

const EMAIL_RE = /[a-z0-9._%+'-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi;
const EMAIL_ONE = new RegExp(EMAIL_RE.source, "i");
const VALID = /^[a-z0-9._%+'-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i;
export const isEmail = (s) => VALID.test(String(s || "").trim());

const HEADERS = {
  email: [
    "email",
    "e-mail",
    "email address",
    "e-mail address",
    "mail",
    "email id",
    "emailid",
    "mail id",
    "email_id",
  ],
  name: [
    "name",
    "full name",
    "fullname",
    "full_name",
    "contact name",
    "contact",
  ],
  firstName: ["firstname", "first name", "first_name", "given name", "fname"],
  lastName: [
    "lastname",
    "last name",
    "last_name",
    "surname",
    "family name",
    "lname",
  ],
  company: [
    "company",
    "companyname",
    "company name",
    "company_name",
    "organisation",
    "organization",
    "organisation name",
    "organization name",
    "business",
    "firm",
  ],
};
const norm = (h) =>
  String(h ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
const headerKey = (h) =>
  Object.entries(HEADERS).find(([, alts]) => alts.includes(norm(h)))?.[0];
const cellText = (v) =>
  v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? "").trim();
const looksLikeName = (s) =>
  /^[\p{L}][\p{L} .'-]{0,58}$/u.test(s) && !/\d/.test(s);

function finish(row, { guess }) {
  const out = {
    email: row.email.toLowerCase(),
    firstName: row.firstName || "",
    lastName: row.lastName || "",
    company: row.company || "",
    fields: row.fields,
    guessed: {},
  };
  if (guess) {
    const g = guessFromEmail(out.email);
    if (!out.firstName && g.firstName) {
      out.firstName = g.firstName;
      out.guessed.firstName = true;
      if (!out.lastName && g.lastName) {
        out.lastName = g.lastName;
        out.guessed.lastName = true;
      }
    }
    if (!out.company && g.company) {
      out.company = g.company;
      out.guessed.company = true;
    }
  }
  if (!out.fields || !Object.keys(out.fields).length) delete out.fields;
  return out;
}

/** Rows (array of arrays) with a header row → contacts. */
function fromTable(rows, opts) {
  const header = rows[0].map(cellText);
  const keys = header.map(headerKey);
  if (!keys.includes("email")) return null;
  const out = [];
  for (const r of rows.slice(1)) {
    const row = { fields: {} };
    header.forEach((h, i) => {
      const v = cellText(r[i]);
      if (!v) return;
      const k = keys[i];
      if (k === "name")
        Object.assign(
          row,
          Object.fromEntries(
            Object.entries(splitFullName(v)).filter(([kk]) => !row[kk]),
          ),
        );
      else if (k && !row[k]) row[k] = v;
      else if (!k) {
        // "Phone Number" → {{phoneNumber}}, "City" → {{city}}
        const key = h
          .trim()
          .replace(/[^A-Za-z0-9]+(\w)/g, (_, c) => c.toUpperCase())
          .replace(/[^A-Za-z0-9_]/g, "");
        const camel = key.charAt(0).toLowerCase() + key.slice(1);
        if (/^[A-Za-z][A-Za-z0-9_]{0,49}$/.test(camel))
          row.fields[camel] = v.slice(0, 500);
      }
    });
    if (row.email) out.push(row);
    else {
      const m = r.map(cellText).join(" ").match(EMAIL_RE);
      if (m) out.push({ email: m[0] });
    } // email in an unlabelled column
  }
  return out.map((r) => finish(r, opts));
}

/** One pasted line without a header → contacts (usually one, sometimes several emails on a line). */
function fromLine(line, opts) {
  const emails = line.match(EMAIL_RE) || [];
  if (!emails.length) return [];
  if (emails.length > 1) {
    // "Ravi Kumar <ravi@acme.com>, "Meera Shah" <meera@nova.in>" — keep the display names.
    const named = new Map();
    for (const m of line.matchAll(
      /(?:"([^"]*)"|([^,;<>"\t]*?))\s*<\s*([^>\s]+@[^>\s]+)\s*>/g,
    )) {
      const nm = (m[1] ?? m[2] ?? "").trim();
      if (nm && looksLikeName(nm))
        named.set(m[3].toLowerCase(), splitFullName(nm));
    }
    return emails.map((e) =>
      finish({ email: e, ...(named.get(e.toLowerCase()) || {}) }, opts),
    );
  }
  const email = emails[0];
  const row = { email };
  // "Ravi Kumar <ravi@acme.com>"
  const angle = line.match(/^\s*"?([^"<@]*?)"?\s*<[^>]+>/);
  if (angle && looksLikeName(angle[1].trim()))
    Object.assign(row, splitFullName(angle[1]));
  else {
    // "ravi@acme.com, Ravi Kumar, Acme Ltd"   or   "Ravi<TAB>Kumar<TAB>ravi@acme.com<TAB>Acme"
    const cells = line
      .split(/\t|,|;|\|/)
      .map((c) => c.replace(/[<>"]/g, "").trim())
      .filter((c) => c && !c.includes("@"));
    const names = cells.filter((c) => looksLikeName(c));
    if (
      line.includes("\t") &&
      names.length >= 2 &&
      names[0].split(" ").length === 1 &&
      names[1].split(" ").length === 1
    ) {
      row.firstName = splitFullName(names[0]).firstName;
      row.lastName = splitFullName(names[1]).firstName;
      if (names[2]) row.company = names[2];
    } else if (names.length) {
      Object.assign(row, splitFullName(names[0]));
      if (names[1]) row.company = names[1];
      else if (cells[1] && !looksLikeName(cells[1])) row.company = cells[1];
    }
  }
  return [finish(row, opts)];
}

/**
 * Parse pasted text. Returns { contacts, invalid, duplicates }.
 * `invalid` lists things that look like an attempt at an email but are not valid.
 */
export function parsePasted(text, { guess = true } = {}) {
  const src = String(text || "")
    .replace(/\r\n?/g, "\n")
    .trim();
  if (!src) return { contacts: [], invalid: [], duplicates: 0 };
  const lines = src.split("\n").filter((l) => l.trim());
  let rows = null;
  // Header row? (copied from Excel / Sheets, or CSV)
  const delim = lines[0].includes("\t")
    ? "\t"
    : lines[0].includes(",")
      ? ","
      : lines[0].includes(";")
        ? ";"
        : null;
  if (
    delim &&
    lines.length > 1 &&
    headerKey(
      lines[0].split(delim).find((h) => headerKey(h) === "email") || "",
    ) === "email"
  ) {
    rows = fromTable(
      lines.map((l) => splitDelimited(l, delim)),
      { guess },
    );
  }
  if (!rows) rows = lines.flatMap((l) => fromLine(l, { guess }));
  const invalid = [];
  for (const tok of src.split(/[\s,;<>"()|]+/))
    if (tok.includes("@") && !EMAIL_ONE.test(tok)) invalid.push(tok);
  return dedupe(rows, invalid);
}

function splitDelimited(line, d) {
  if (d === "\t") return line.split("\t");
  const out = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === '"') {
      if (q && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else q = !q;
    } else if (c === d && !q) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

function dedupe(rows, invalid = []) {
  const seen = new Map();
  let duplicates = 0;
  for (const r of rows) {
    if (!isEmail(r.email)) {
      invalid.push(r.email);
      continue;
    }
    if (seen.has(r.email)) {
      duplicates += 1;
      continue;
    }
    seen.set(r.email, r);
  }
  return {
    contacts: [...seen.values()],
    invalid: [...new Set(invalid)].slice(0, 50),
    duplicates,
  };
}

/** Parse an uploaded .csv / .txt / .xlsx file. */
export async function parseFile(file, { guess = true } = {}) {
  const name = file.name.toLowerCase();
  if (name.endsWith(".xls"))
    throw new Error(
      "Old .xls files are not supported. In Excel choose File → Save As → “Excel Workbook (.xlsx)” or “CSV”, then upload again.",
    );
  if (name.endsWith(".xlsx")) {
    const { readSheet } = await import("read-excel-file/universal");
    const rows = (await readSheet(file)).filter((r) =>
      r.some((c) => cellText(c)),
    );
    if (!rows.length) return { contacts: [], invalid: [], duplicates: 0 };
    const table = fromTable(rows, { guess });
    if (table) return dedupe(table);
    return parsePasted(rows.map((r) => r.map(cellText).join("\t")).join("\n"), {
      guess,
    });
  }
  const text = await file.text();
  const Papa = (await import("papaparse")).default;
  const res = Papa.parse(text.trim(), { skipEmptyLines: true });
  const table = res.data.length > 1 ? fromTable(res.data, { guess }) : null;
  return table ? dedupe(table) : parsePasted(text, { guess });
}

/** Contacts → API rows (drops UI-only flags). */
export const toApiRows = (contacts) =>
  contacts.map(({ email, firstName, lastName, company, fields }) => ({
    email,
    firstName: firstName || undefined,
    lastName: lastName || undefined,
    company: company || undefined,
    ...(fields ? { fields } : {}),
  }));

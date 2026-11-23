// site-generator-speed-01: a faster drop-in for makefun-site 1.0.0.
//
// Same answers as makefun-site 1.0.0's build(), byte for byte, but written for
// speed: single-pass Markdown rendering with no token allocation, a chunk-based
// inline renderer (no per-character regex escapes), manual front-matter
// scanning, memoised slugs, hand-counted words, and a tight tree-walking
// template renderer over prototype-chained scopes with array output.
// Dependency-free ES module; run(input) is the entrypoint.

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ------------------------------------------------------------------ text

const ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const RE_ESC_G = /[&<>"']/g;

/** `s` HTML-escaped, pushed as chunks into `out` (no intermediate string). */
function escPush(s, out) {
  RE_ESC_G.lastIndex = 0;
  let i = 0;
  let m;
  let found = false;
  while ((m = RE_ESC_G.exec(s)) !== null) {
    found = true;
    if (m.index > i) out.push(s.slice(i, m.index));
    out.push(ENT[s[m.index]]);
    i = m.index + 1;
  }
  if (!found) {
    out.push(s);
    return;
  }
  if (i < s.length) out.push(s.slice(i));
}

/** `s` HTML-escaped, as a string. */
function escStr(s) {
  const out = [];
  escPush(s, out);
  return out.length === 1 && out[0] === s ? s : out.join('');
}

/** The range s[a..b) HTML-escaped, pushed as chunks into `out`. */
function escRange(s, a, b, out) {
  RE_ESC_G.lastIndex = a;
  let i = a;
  let m;
  let found = false;
  while ((m = RE_ESC_G.exec(s)) !== null && m.index < b) {
    found = true;
    if (m.index > i) out.push(s.slice(i, m.index));
    out.push(ENT[s[m.index]]);
    i = m.index + 1;
  }
  if (!found) {
    out.push(s.slice(a, b));
    return;
  }
  if (i < b) out.push(s.slice(i, b));
}

const HAS_NONASCII = /[^\x00-\x7F]/;
const RE_MARK = /\p{M}/gu;

/** The slug of `text` (README "Text"); pure, so callers may memoise it. */
function slugifyRaw(text) {
  // ASCII is stable under NFKD and holds no combining marks: skip both steps.
  const plain = HAS_NONASCII.test(text) ? text.normalize('NFKD').replace(RE_MARK, '') : text;
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const ch = plain[i];
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** ASCII whitespace flags, for wordsOf. */
const WS8 = new Uint8Array(128);
for (const c of [9, 10, 11, 12, 13, 32]) WS8[c] = 1;

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 128 ? WS8[c] === 1 : isWS(c)) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

// ------------------------------------------------------------ front matter

const KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

/** Whether char code `c` is JS whitespace (\s). */
function isWS(c) {
  return (
    c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 160 || c === 5760 ||
    (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279
  );
}

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const nx = raw[i + 1];
        if ((nx !== '"' && nx !== '\\') || i + 1 === raw.length - 1) {
          return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        }
        out += nx;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      if (ok) {
        for (const k of [0, 1, 2, 3, 5, 6, 8, 9]) {
          const c = raw.charCodeAt(k);
          if (c < 48 || c > 57) { ok = false; break; }
        }
      }
      const y = ok ? Number(raw.slice(0, 4)) : 0;
      const mo = ok ? Number(raw.slice(5, 7)) : 0;
      const d = ok ? Number(raw.slice(8, 10)) : 0;
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (raw.length < 2 || raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) {
        return { error: 'key "tags": not a list [a, b]' };
      }
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',');
      for (let k = 0; k < tags.length; k++) tags[k] = tags[k].trim();
      for (const t of tags) {
        if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        for (let k = 0; k < t.length; k++) {
          const c = t[k];
          if (c === '"' || c === '[' || c === ']') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      let ok = raw.length >= 1;
      for (let k = 0; ok && k < raw.length; k++) {
        const c = raw.charCodeAt(k);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) ok = false;
      }
      return ok ? { value: raw } : { error: 'key "layout": not a template name' };
    }
    case 'slug': {
      let ok = raw.length >= 1 && raw.length <= 64;
      // [a-z0-9]+(-[a-z0-9]+)* : alnum runs joined by single dashes.
      let k = 0;
      let needAlnum = true;
      for (; ok && k < raw.length; k++) {
        const c = raw.charCodeAt(k);
        const alnum = (c >= 97 && c <= 122) || (c >= 48 && c <= 57);
        if (needAlnum) {
          if (!alnum) ok = false;
          else needAlnum = false;
        } else if (c === 45) needAlnum = true;
        else if (!alnum) ok = false;
      }
      if (needAlnum) ok = false;
      return ok ? { value: raw } : { error: 'key "slug": not a slug' };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** Split a front-matter line into [key, raw], or null when it is not "key: value". */
function parseKV(line) {
  const n = line.length;
  let j = 0;
  while (j < n) {
    const c = line.charCodeAt(j);
    if ((c >= 97 && c <= 122) || c === 95) j++;
    else break;
  }
  if (j === 0) return null;
  if (line.charCodeAt(j) !== 58) return null;
  let raw;
  if (j + 1 === n) raw = '';
  else if (line.charCodeAt(j + 1) === 32) raw = line.slice(j + 2);
  else return null;
  let e = raw.length;
  while (e > 0 && (raw.charCodeAt(e - 1) === 32 || raw.charCodeAt(e - 1) === 9)) e--;
  return [line.slice(0, j), raw.slice(0, e)];
}

/** Whether the range src[a..b) is blank (spaces and tabs only). */
function isBlankRange(src, a, b) {
  for (let p = a; p < b; p++) {
    const c = src.charCodeAt(p);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/**
 * A source's front matter and body: { data, body }, or { error }. `text` has
 * "\n" line ends.
 */
function parseFrontMatter(text) {
  const len = text.length;
  if (len < 3 || text.charCodeAt(0) !== 45 || text.charCodeAt(1) !== 45 || text.charCodeAt(2) !== 45) {
    return { error: 'no front matter' };
  }
  if (len !== 3 && text.charCodeAt(3) !== 10) return { error: 'no front matter' };
  // Find the closing line, exactly "---".
  let pos = 4;
  let close = -1;
  let closeEnd = len;
  let idx = 1;
  while (pos <= len) {
    let eol = text.indexOf('\n', pos);
    if (eol === -1) eol = len;
    if (eol - pos === 3 && text.charCodeAt(pos) === 45 && text.charCodeAt(pos + 1) === 45 && text.charCodeAt(pos + 2) === 45) {
      close = idx;
      closeEnd = eol === len ? len : eol + 1;
      break;
    }
    if (eol === len) break;
    pos = eol + 1;
    idx++;
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let p = 4;
  for (let i = 1; i < close; i++) {
    let eol = text.indexOf('\n', p);
    if (eol === -1) eol = len;
    const line = text.slice(p, eol);
    if (line === '' || isBlankRange(line, 0, line.length) || line.charCodeAt(0) === 35) {
      // blank line or comment: skip
    } else {
      const kv = parseKV(line);
      if (kv === null) return { error: `line ${i + 1} is not "key: value"` };
      const key = kv[0];
      const raw = kv[1];
      if (!KEYS.has(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    p = eol + 1;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(closeEnd) };
}

// ---------------------------------------------------------------- markdown

/** The characters a backslash escapes. */
const ESCAPABLE_CODE = new Set([92, 96, 42, 95, 91, 93, 40, 41, 35, 43, 45, 46, 33, 62]);

/** First index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  let j = from;
  for (;;) {
    const w = s.indexOf(what, j);
    if (w === -1) return -1;
    const bs = s.indexOf('\\', j);
    if (bs === -1 || w < bs) return w;
    if (bs + 1 < s.length && ESCAPABLE_CODE.has(s.charCodeAt(bs + 1))) j = bs + 2;
    else j = bs + 1;
  }
}

/** First single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  let j = from;
  while (j < s.length) {
    const st = s.indexOf('*', j);
    if (st === -1) return -1;
    const bs = s.indexOf('\\', j);
    if (bs !== -1 && bs < st) {
      if (bs + 1 < s.length && ESCAPABLE_CODE.has(s.charCodeAt(bs + 1))) j = bs + 2;
      else j = bs + 1;
      continue;
    }
    if (s.charCodeAt(st + 1) === 42) {
      j = st + 2;
      continue;
    }
    return st;
  }
  return -1;
}

const RE_SPECIAL = /[\\`*\[&<>"']/g;
const RE_WS = /\s/;

/** `s` rendered inline into `out`; `link(target)` is a link's href. */
function inlineTo(s, out, link) {
  let i = 0;
  RE_SPECIAL.lastIndex = 0;
  let m;
  while ((m = RE_SPECIAL.exec(s)) !== null) {
    const j = m.index;
    if (j > i) out.push(s.slice(i, j));
    const c = s.charCodeAt(j);
    if (c === 92) {
      // backslash
      const n = j + 1 < s.length ? s.charCodeAt(j + 1) : -1;
      if (n !== -1 && ESCAPABLE_CODE.has(n)) {
        out.push(n === 62 ? '&gt;' : s[j + 1]);
        i = j + 2;
      } else {
        out.push('\\');
        i = j + 1;
      }
    } else if (c === 96) {
      // code span: the next backtick closes it, escapes ignored
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        out.push('<code>');
        escRange(s, j + 1, k, out);
        out.push('</code>');
        i = k + 1;
      } else {
        out.push('`');
        i = j + 1;
      }
    } else if (c === 42) {
      // strong / emphasis
      if (s.charCodeAt(j + 1) === 42) {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          out.push('<strong>');
          inlineTo(s.slice(j + 2, k), out, link);
          out.push('</strong>');
          i = k + 2;
        } else {
          out.push('**');
          i = j + 2;
        }
      } else {
        const k = findSingleStar(s, j + 1);
        if (k > j + 1) {
          out.push('<em>');
          inlineTo(s.slice(j + 1, k), out, link);
          out.push('</em>');
          i = k + 1;
        } else {
          out.push('*');
          i = j + 1;
        }
      }
    } else if (c === 91) {
      // link
      const k = findUnescaped(s, ']', j + 1);
      const mm = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      const target = mm === -1 ? '' : s.slice(k + 2, mm);
      if (target !== '' && !RE_WS.test(target)) {
        out.push('<a href="');
        escPush(link(target), out);
        out.push('">');
        inlineTo(s.slice(j + 1, k), out, link);
        out.push('</a>');
        i = mm + 1;
      } else {
        out.push('[');
        i = j + 1;
      }
    } else {
      // & < > " '
      out.push(ENT[s[j]]);
      i = j + 1;
    }
    RE_SPECIAL.lastIndex = i;
  }
  if (i < s.length) out.push(s.slice(i));
}

/** `s` rendered inline, as a string. */
function inlineStr(s, link) {
  const out = [];
  inlineTo(s, out, link);
  return out.join('');
}

/** `src[a..b)` with spaces/tabs at either end dropped. */
function trimSlice(src, a, b) {
  while (a < b && (src.charCodeAt(a) === 32 || src.charCodeAt(a) === 9)) a++;
  while (b > a && (src.charCodeAt(b - 1) === 32 || src.charCodeAt(b - 1) === 9)) b--;
  return src.slice(a, b);
}

/** A fence's language at src[pos..eol), or null when the line opens no fence. */
function fenceLang(src, pos, eol) {
  if (src.charCodeAt(pos) !== 96 || src.charCodeAt(pos + 1) !== 96 || src.charCodeAt(pos + 2) !== 96) return null;
  let p = pos + 3;
  while (p < eol) {
    const c = src.charCodeAt(p);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) p++;
    else break;
  }
  const lang = src.slice(pos + 3, p);
  while (p < eol) {
    const c = src.charCodeAt(p);
    if (c !== 32 && c !== 9) return null;
    p++;
  }
  return lang;
}

/** Whether src[pos..eol) closes a fence: three backticks, spaces/tabs after. */
function isFenceClose(src, pos, eol) {
  if (src.charCodeAt(pos) !== 96 || src.charCodeAt(pos + 1) !== 96 || src.charCodeAt(pos + 2) !== 96) return false;
  for (let p = pos + 3; p < eol; p++) {
    const c = src.charCodeAt(p);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's depth and text range, or null. */
function headingAt(src, pos, eol) {
  let p = pos;
  let depth = 0;
  while (p < eol && src.charCodeAt(p) === 35 && depth < 7) {
    depth++;
    p++;
  }
  if (depth === 0 || depth > 6) return null;
  if (p >= eol || (src.charCodeAt(p) !== 32 && src.charCodeAt(p) !== 9)) return null;
  while (p < eol && (src.charCodeAt(p) === 32 || src.charCodeAt(p) === 9)) p++;
  let te = eol;
  while (te > p && (src.charCodeAt(te - 1) === 32 || src.charCodeAt(te - 1) === 9)) te--;
  if (te <= p) return null;
  return { depth, ts: p, te };
}

/** Whether src[pos..eol) is a thematic break: --- or ***, spaces/tabs after. */
function isHr(src, pos, eol) {
  if (eol - pos < 3) return false;
  const c = src.charCodeAt(pos);
  if (c !== 45 && c !== 42) return false;
  if (src.charCodeAt(pos + 1) !== c || src.charCodeAt(pos + 2) !== c) return false;
  for (let p = pos + 3; p < eol; p++) {
    const ch = src.charCodeAt(p);
    if (ch !== 32 && ch !== 9) return false;
  }
  return true;
}

/** Whether src[pos..eol) ends a paragraph: blank, fence, heading or break. */
function endsParagraph(src, pos, eol) {
  return isBlankRange(src, pos, eol) || fenceLang(src, pos, eol) !== null || headingAt(src, pos, eol) !== null || isHr(src, pos, eol);
}

/** A list marker's item-text start at src[pos..eol), or -1. `ordered` fixes the kind. */
function listMarker(src, pos, eol, ordered) {
  if (ordered) {
    let p = pos;
    let n = 0;
    while (p < eol && n < 9) {
      const c = src.charCodeAt(p);
      if (c < 48 || c > 57) break;
      n++;
      p++;
    }
    if (n === 0 || n > 9) return -1;
    if (p + 1 >= eol || src.charCodeAt(p) !== 46 || src.charCodeAt(p + 1) !== 32) return -1;
    return p + 2;
  }
  const c = src.charCodeAt(pos);
  if ((c === 45 || c === 42) && src.charCodeAt(pos + 1) === 32) return pos + 2;
  return -1;
}

/** An ordered list's first number at src[pos..eol). */
function listStart(src, pos, eol) {
  let p = pos;
  let n = 0;
  while (p < eol) {
    const c = src.charCodeAt(p);
    if (c < 48 || c > 57) break;
    n = n * 10 + (c - 48);
    p++;
  }
  return n;
}

/** Whether src[pos..eol) continues a list item: two or more spaces, then non-space. */
function isContinued(src, pos, eol) {
  let p = pos;
  let n = 0;
  while (p < eol && src.charCodeAt(p) === 32) {
    n++;
    p++;
  }
  return n >= 2 && p < eol && !isWS(src.charCodeAt(p));
}

/**
 * `src` rendered: its HTML, table of contents and excerpt. `link(target)` is a
 * link's href. Single pass over the lines, no token objects.
 */
function renderMarkdown(src, link, slugify) {
  const out = [];
  const toc = [];
  const ids = new Set();
  let excerpt = '';
  let hasExcerpt = false;
  const len = src.length;
  let pos = 0;
  const eolAt = (p) => {
    const i = src.indexOf('\n', p);
    return i === -1 ? len : i;
  };
  while (pos < len) {
    const eol = eolAt(pos);
    if (isBlankRange(src, pos, eol)) {
      pos = eol + 1;
      continue;
    }
    const lang = fenceLang(src, pos, eol);
    if (lang !== null) {
      pos = eol + 1;
      out.push(lang === '' ? '<pre><code>' : `<pre><code class="language-${lang}">`);
      while (pos < len) {
        const e2 = eolAt(pos);
        if (isFenceClose(src, pos, e2)) {
          pos = e2 + 1;
          break;
        }
        escRange(src, pos, e2, out);
        out.push('\n');
        pos = e2 + 1;
      }
      out.push('</code></pre>\n');
      continue;
    }
    const hd = headingAt(src, pos, eol);
    if (hd !== null) {
      const text = src.slice(hd.ts, hd.te);
      const id = uniqueSlug(slugify(text), ids);
      const html = inlineStr(text, link);
      out.push(`<h${hd.depth} id="${id}">${html}</h${hd.depth}>\n`);
      if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
      pos = eol + 1;
      continue;
    }
    if (isHr(src, pos, eol)) {
      out.push('<hr>\n');
      pos = eol + 1;
      continue;
    }
    if (src.charCodeAt(pos) === 62) {
      // blockquote
      const lines = [];
      while (pos < len && src.charCodeAt(pos) === 62) {
        const e2 = eolAt(pos);
        let a = pos + 1;
        if (src.charCodeAt(a) === 32) a++;
        const t = trimSlice(src, a, e2);
        if (t !== '') lines.push(t);
        pos = e2 + 1;
      }
      if (lines.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else out.push(`<blockquote>\n<p>${inlineStr(lines.join('\n'), link)}</p>\n</blockquote>\n`);
      continue;
    }
    const bullet = listMarker(src, pos, eol, false);
    const ordered = bullet === -1 ? listMarker(src, pos, eol, true) : -1;
    if (bullet !== -1 || ordered !== -1) {
      const isOrdered = ordered !== -1;
      const start = isOrdered ? listStart(src, pos, eol) : 1;
      const items = [];
      while (pos < len) {
        const e2 = eolAt(pos);
        const ts = listMarker(src, pos, e2, isOrdered);
        if (ts !== -1) {
          items.push([trimSlice(src, ts, e2)]);
          pos = e2 + 1;
        } else if (isContinued(src, pos, e2)) {
          items[items.length - 1].push(trimSlice(src, pos, e2));
          pos = e2 + 1;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      out.push(isOrdered && start !== 1 ? `<ol start="${start}">\n` : `<${tag}>\n`);
      for (const parts of items) out.push(`<li>${inlineStr(parts.join('\n'), link)}</li>\n`);
      out.push(`</${tag}>\n`);
      continue;
    }
    // paragraph
    const parts = [trimSlice(src, pos, eol)];
    pos = eol + 1;
    while (pos < len) {
      const e2 = eolAt(pos);
      if (endsParagraph(src, pos, e2)) break;
      parts.push(trimSlice(src, pos, e2));
      pos = e2 + 1;
    }
    const html = inlineStr(parts.join('\n'), link);
    if (!hasExcerpt) {
      excerpt = html;
      hasExcerpt = true;
    }
    out.push(`<p>${html}</p>\n`);
  }
  return { html: out.join(''), toc, excerpt };
}

// ---------------------------------------------------------------- templates

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) {
          throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        }
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  if (path.length === 1) return scope[path[0]];
  let v = scope[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** Push a value escaped (a {{ }} node). */
function pesc(out, v) {
  if (typeof v === 'string') escPush(v, out);
  else if (typeof v === 'number') out.push(String(v));
  else if (typeof v === 'boolean') out.push(v ? 'true' : 'false');
  else if (Array.isArray(v)) out.push(escStr(v.map(textOf).join(', ')));
}

/** Push a value raw (a {{{ }}} node). */
function praw(out, v) {
  if (typeof v === 'string') out.push(v);
  else if (typeof v === 'number') out.push(String(v));
  else if (typeof v === 'boolean') out.push(v ? 'true' : 'false');
  else if (Array.isArray(v)) out.push(v.map(textOf).join(', '));
}

/** The node tree rendered in `scope`, into `out`. */
function renderNodes(nodes, scope, out, ctx, depth) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        pesc(out, lookup(scope, n.path));
        break;
      case 'raw':
        praw(out, lookup(scope, n.path));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        if (v !== n.not) renderNodes(n.then, scope, out, ctx, depth);
        else if (n.else !== null) renderNodes(n.else, scope, out, ctx, depth);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (Array.isArray(xs)) {
          const loop = { index: 0, first: false, last: false, length: xs.length };
          for (let k = 0; k < xs.length; k++) {
            const cs = Object.create(scope);
            cs[n.name] = xs[k];
            loop.index = k + 1;
            loop.first = k === 0;
            loop.last = k === xs.length - 1;
            cs.loop = loop;
            renderNodes(n.body, cs, out, ctx, depth);
          }
        }
        break;
      }
      case 'include': {
        if (depth < 8) {
          const t = ctx.templates.get(n.name);
          if (t !== undefined) renderNodes(t, scope, out, ctx, depth + 1);
        }
        break;
      }
    }
  }
}

// --------------------------------------------------------------------- build

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
const RESERVED = Object.freeze(['posts', 'tags', 'page']);

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** Whether `target` opens on a scheme (https:, mailto: ...). */
function isScheme(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < target.length; i++) {
    const c = target.charCodeAt(i);
    if (c === 58) return true;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) return false;
  }
  return false;
}

/** A page's link record as templates read it. */
const linkOf = (s) =>
  s === null
    ? null
    : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };

/** One site's output tree: path -> text. */
function build(input) {
  const slugCache = new Map();
  const slugify = (t) => {
    let s = slugCache.get(t);
    if (s === undefined) {
      s = slugifyRaw(t);
      slugCache.set(t, s);
    }
    return s;
  };

  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. The sources, in code-unit order of their paths; a source that is not .md is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const taken = new Map();
  const takenIn = (dir) => {
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    return set;
  };
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (isScheme(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null) {
        const pg = bySource.get(path);
        if (pg !== undefined) return `${pg.url}${frag}`;
        if (staticPaths.has(path)) return `${base}/${path}${frag}`;
      }
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, link, slugify);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const tags = s.data.tags;
    if (tags === undefined) return [];
    const seen = new Set();
    const out = [];
    for (const name of tags) {
      const sl = slugify(name);
      if (!seen.has(sl)) {
        seen.add(sl);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugify(name);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  /** A post's card, as lists show it. */
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  /** A page as its layout reads it. */
  const pageOf = (s) => {
    const card = cards.get(s) ?? cardOf(s);
    return {
      ...card,
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
  };
  const cards = new Map();
  for (const p of posts) cards.set(p, cardOf(p));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const ctx = { templates };
  const output = {};
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const scope = Object.create(null);
    scope.site = site;
    scope.tags = allTags;
    scope.recent = recent;
    for (const k of Object.keys(vars)) scope[k] = vars[k];
    const out = [];
    renderNodes(nodes, scope, out, ctx, 0);
    return out.join('');
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', {
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) },
    });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pagesCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pagesCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  return build(input);
}

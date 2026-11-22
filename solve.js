// A fast drop-in for csv-reader 1.0.0: the same reading of every input, {columns, rows, errors}, produced by
// slice-and-jump scanning instead of one character at a time. The text is walked once, left to right; each field is
// taken as one slice between delimiters found with indexOf, and the rare broken things (a stray CR, junk after a
// closing quote, a quote that never closes) fall back to the same readings the plain reader makes.
//
// The reading, exactly: a U+FEFF at the very start is dropped; a record ends at LF or CRLF and a line left with no
// characters is no record; outside quotes a CR not followed by LF is dropped (stray_cr); a field that opens with a
// quote runs to the next quote that is not doubled ("" inside it one quote, each CRLF or lone CR inside it read as
// LF), what follows its closing quote up to the next comma or line break is appended as it stands (quote_junk when
// the field ends), and a quote that never closes is a literal character with the text after it read again as
// unquoted (unterminated_quote); a quote inside an unquoted field is a literal character; fields stay strings.
// columns is the first record when header is true, else null; rows are padded (short_row) or cut (long_row) to the
// first record's width; each error is {code, line, row} in the order met.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const n = text.length;
  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // The position of the next CR at or after the last place one was looked for (-2: not looked yet, -1: none left).
  // CRs are rare outside quoted fields, so the search is cached and only ever moves forward: over a whole reading
  // the CR searches together scan the text once.
  let nextCr = -2;

  // The field just read: its value and how it ended (COMMA, LINE_BREAK or END).
  let fValue = '';
  let fEnded = END;

  function crFrom(p) {
    if (nextCr !== -1 && nextCr < p) nextCr = text.indexOf('\r', p);
    return nextCr;
  }

  // Reads an unquoted field whose value so far is `prefix` ('' normally, '"' after an unterminated quote).
  function readUnquoted(prefix) {
    let parts = null;
    let start = pos;
    for (;;) {
      const iComma = text.indexOf(',', pos);
      const iLf = text.indexOf('\n', pos);
      let idx = iComma === -1 ? iLf : iLf === -1 ? iComma : iComma < iLf ? iComma : iLf;
      const cr = crFrom(pos);
      if (cr !== -1 && (idx === -1 || cr < idx)) idx = cr;
      if (idx === -1) {
        const seg = text.slice(start, n);
        pos = n;
        fValue = parts ? parts.join('') + seg : prefix + seg;
        fEnded = END;
        return;
      }
      const c = text.charCodeAt(idx);
      if (c === 44) {
        const seg = text.slice(start, idx);
        pos = idx + 1;
        fValue = parts ? parts.join('') + seg : prefix + seg;
        fEnded = COMMA;
        return;
      }
      if (c === 10) {
        const seg = text.slice(start, idx);
        pos = idx + 1;
        line += 1;
        fValue = parts ? parts.join('') + seg : prefix + seg;
        fEnded = LINE_BREAK;
        return;
      }
      // c is CR.
      if (text.charCodeAt(idx + 1) === 10) {
        const seg = text.slice(start, idx);
        pos = idx + 2;
        line += 1;
        fValue = parts ? parts.join('') + seg : prefix + seg;
        fEnded = LINE_BREAK;
        return;
      }
      // A stray CR: dropped, an error, and the field goes on.
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      if (parts === null) parts = [prefix];
      parts.push(text.slice(start, idx));
      pos = idx + 1;
      start = pos;
    }
  }

  // The value a quoted field holds for the span text[from, to): with no CR inside it is the span itself, counting
  // its LFs; with a CR inside, quotedSpan converts (each CRLF or lone CR reads as one LF).
  function quotedPart(from, to) {
    const cr = crFrom(from);
    if (cr === -1 || cr >= to) {
      let i = from;
      for (;;) {
        const j = text.indexOf('\n', i);
        if (j === -1 || j >= to) break;
        line += 1;
        i = j + 1;
      }
      return text.slice(from, to);
    }
    return quotedSpan(from, to);
  }

  // Counts the line breaks in text[from, to) as a quoted field reads them (each CRLF or lone CR is one, each LF
  // one) and builds the value the field holds for that span: CRs and CRLFs read as LF.
  function quotedSpan(from, to) {
    let value = '';
    let segStart = from;
    let i = from;
    while (i < to) {
      const c = text.charCodeAt(i);
      if (c === 13) {
        value += text.slice(segStart, i) + '\n';
        line += 1;
        i += text.charCodeAt(i + 1) === 10 ? 2 : 1;
        segStart = i;
      } else {
        if (c === 10) line += 1;
        i += 1;
      }
    }
    return value + text.slice(segStart, to);
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let parts = null;
    let segStart = pos + 1;
    let scan = segStart;
    for (;;) {
      const q = text.indexOf('"', scan);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text after it is read again as unquoted.
        pos = open + 1;
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        readUnquoted('"');
        return;
      }
      if (text.charCodeAt(q + 1) === 34) {
        // A doubled quote: one quote in the value, and the field goes on.
        if (parts === null) parts = [];
        parts.push(quotedPart(segStart, q) + '"');
        scan = q + 2;
        segStart = scan;
        continue;
      }
      // The closing quote.
      const tail = quotedPart(segStart, q);
      const value = parts ? parts.join('') + tail : tail;
      pos = q + 1;
      if (pos >= n) {
        fValue = value;
        fEnded = END;
        return;
      }
      const c = text.charCodeAt(pos);
      if (c === 44) {
        pos += 1;
        fValue = value;
        fEnded = COMMA;
        return;
      }
      if (c === 10) {
        pos += 1;
        line += 1;
        fValue = value;
        fEnded = LINE_BREAK;
        return;
      }
      if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
        fValue = value;
        fEnded = LINE_BREAK;
        return;
      }
      // What follows the closing quote is appended as it stands, up to the next comma or line break.
      readUnquoted(value);
      if (fValue.length > value.length) {
        errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
      }
      return;
    }
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted = false;
    do {
      quoted = text.charCodeAt(pos) === 34;
      if (quoted) readQuoted();
      else readUnquoted('');
      fields.push(fValue);
    } while (fEnded === COMMA);

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}

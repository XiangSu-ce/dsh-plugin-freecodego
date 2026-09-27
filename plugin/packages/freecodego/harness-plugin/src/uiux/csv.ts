/**
 * The CSV reader the vendored UI/UX catalog is loaded with.
 *
 * Why not a split on the delimiter
 * -------------------------------
 * The corpus cannot be read that way, and the measurement is the argument: 17 of the
 * 34 shipped tables carry commas inside quoted fields, and `stacks/nextjs.csv` has a
 * field whose text contains a newline. A reader that split on commas would turn one
 * of its rows into two, and a reader that also split on newlines would move every
 * subsequent row one column out — returning a table that still *parses*, which is
 * what makes it dangerous: a misaligned row is a plausible row.
 *
 * What is deliberately not here
 * -----------------------------
 * No delimiter sniffing, no comment syntax, no type coercion, no column names. The
 * files are a fixed corpus that upstream generates; a reader that guessed would be
 * adapting to inputs that do not exist, and every guess is a rule a real file could
 * later disagree with. Cells stay text, because the contract that names the columns
 * (`catalog.ts`) is what decides what a column means.
 *
 * Two states this reader reports rather than hides
 * -----------------------------------------------
 * A physical line that holds nothing but a terminator, and a record whose field count
 * differs from the header's, are both recorded instead of being dropped or padded. The
 * catalog ships none of either — the specs assert that against the real files — so the
 * records exist to make a future hand-edit or a partial download visible at the point
 * it happens rather than as a ranking that quietly shifted.
 *
 * @module uiux/csv
 */

/** One physical record: the line it starts on, and its fields in column order. */
export interface CsvRecord {
  /** 1-based line the record starts on; quoted newlines do not start new records. */
  readonly line: number
  /** The record's fields, with quoting removed and doubled quotes unescaped. */
  readonly fields: readonly string[]
}

/** A parsed table file: its records in file order, and the blank lines it held. */
export interface ParsedCsv {
  /** Every non-blank record, including the header as the first one. */
  readonly records: readonly CsvRecord[]
  /** 1-based line numbers that held no field at all, in file order. */
  readonly blankLines: readonly number[]
}

/** The character a field may be quoted with. */
const QUOTE = '"'
/** The field delimiter. */
const DELIMITER = ','
/** The line feed that ends a record. */
const LINE_FEED = '\n'
/** The carriage return that ends a record, or precedes a line feed. */
const CARRIAGE_RETURN = '\r'
/** The byte order mark some exporters prepend; it is not part of the first column's name. */
const BYTE_ORDER_MARK = '\uFEFF'

/**
 * Parse one CSV table.
 *
 * Quoting follows the usual rule: a field that begins with a quote runs to its closing
 * quote, and commas, line feeds and doubled quotes inside it are literal. A quote
 * anywhere else is ordinary text, which preserves measurements such as `5" screen`.
 * After a closing quote, only a delimiter or record ending is legal; accepting more
 * would turn malformed/truncated input into a plausible cell.
 *
 * Line endings inside a quoted field are normalized to a line feed, and CRLF record
 * endings count as one physical line. Empty physical lines are reported; a comma-only
 * line is not empty because it contains fields, even if their values are empty.
 *
 * @param source - the complete file contents, with or without a byte order mark.
 * @returns the records and the blank lines, in file order.
 * @throws When quoting is unbalanced or malformed.
 */
export function parseCsv(source: string): ParsedCsv {
  const records: CsvRecord[] = []
  const blankLines: number[] = []
  const text = source.startsWith(BYTE_ORDER_MARK) ? source.slice(BYTE_ORDER_MARK.length) : source
  let fields: string[] = []
  let field = ''
  let quoted = false
  let afterQuote = false
  let hasContent = false
  let line = 1
  let recordLine = 1

  const finishRecord = (): void => {
    if (hasContent) {
      fields.push(field)
      records.push({ line: recordLine, fields })
    } else {
      blankLines.push(recordLine)
    }
    fields = []
    field = ''
    hasContent = false
  }

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? ''

    if (quoted) {
      if (character === QUOTE) {
        if (text[index + 1] === QUOTE) {
          field += QUOTE
          index += 1
        } else {
          quoted = false
          afterQuote = true
        }
        continue
      }
      if (character === CARRIAGE_RETURN && text[index + 1] === LINE_FEED) {
        field += LINE_FEED
        index += 1
        line += 1
        continue
      }
      field += character
      if (character === LINE_FEED || character === CARRIAGE_RETURN) line += 1
      continue
    }

    if (afterQuote) {
      if (character === DELIMITER) {
        fields.push(field)
        field = ''
        hasContent = true
        afterQuote = false
        continue
      }
      if (character === LINE_FEED || character === CARRIAGE_RETURN) {
        if (character === CARRIAGE_RETURN && text[index + 1] === LINE_FEED) index += 1
        finishRecord()
        line += 1
        recordLine = line
        afterQuote = false
        continue
      }
      throw new Error(`parseCsv: unexpected ${JSON.stringify(character)} after closing quote on line ${String(line)}.`)
    }

    if (character === QUOTE && field === '') {
      quoted = true
      hasContent = true
      continue
    }
    if (character === QUOTE) {
      // Python's csv.reader, which upstream uses with strict=False, keeps a quote
      // inside an unquoted field as a literal character (for example 5" screen).
      field += character
      hasContent = true
      continue
    }
    if (character === DELIMITER) {
      fields.push(field)
      field = ''
      hasContent = true
      continue
    }
    if (character === LINE_FEED || character === CARRIAGE_RETURN) {
      if (character === CARRIAGE_RETURN && text[index + 1] === LINE_FEED) index += 1
      finishRecord()
      line += 1
      recordLine = line
      continue
    }
    field += character
    hasContent = true
  }

  if (quoted) {
    throw new Error(`parseCsv: quoted field opened on line ${String(recordLine)} is never closed; the file is truncated or unbalanced.`)
  }
  // No record follows a trailing line ending. A final line without an ending does.
  if (hasContent || fields.length > 0 || field !== '' || afterQuote) finishRecord()
  return { records, blankLines }
}

/**
 * The header names a parsed file repeats.
 *
 * A repeated column name is not a syntax error, which is exactly why it is checked:
 * the row object would keep only the last of the two, so a table whose `Notes` column
 * was duplicated would silently search one of them.
 *
 * @param records - the records a file parsed to.
 * @returns the duplicated names, in first-appearance order, or an empty list.
 */
export function duplicateColumns(records: readonly CsvRecord[]): readonly string[] {
  const header = records[0]
  if (header === undefined) return []
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const name of header.fields) {
    if (seen.has(name)) duplicates.add(name)
    seen.add(name)
  }
  return [...duplicates]
}

/**
 * Build one row per record, keyed by the header.
 *
 * @param records - the records a file parsed to, header first.
 * @returns the data rows, and the lines whose field count disagrees with the header's.
 */
export function toRows(records: readonly CsvRecord[]): {
  readonly columns: readonly string[]
  readonly rows: readonly Readonly<Record<string, string>>[]
  readonly ragged: readonly { readonly line: number; readonly fields: number }[]
} {
  const header = records[0]
  if (header === undefined) return { columns: [], rows: [], ragged: [] }
  const columns = header.fields
  const rows: Record<string, string>[] = []
  const ragged: { line: number; fields: number }[] = []
  for (const record of records.slice(1)) {
    if (record.fields.length !== columns.length) {
      ragged.push({ line: record.line, fields: record.fields.length })
      continue
    }
    const entries: [string, string][] = []
    for (let index = 0; index < columns.length; index += 1) {
      const name = columns[index]
      if (name === undefined) continue
      entries.push([name, record.fields[index] ?? ''])
    }
    // Object.fromEntries keeps special names such as `__proto__` as own data
    // properties while preserving the normal plain-object shape expected by callers.
    rows.push(Object.fromEntries(entries))
  }
  return { columns, rows, ragged }
}

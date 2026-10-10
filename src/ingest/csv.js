function parseCsv(input, { delimiter = ',' } = {}) {
  if (typeof delimiter !== 'string' || delimiter.length !== 1 || delimiter === '"' || delimiter === '\r' || delimiter === '\n') {
    throw new TypeError('CSV delimiter must be one non-quote character.');
  }
  let source = Buffer.isBuffer(input) ? input.toString('utf8') : String(input ?? '');
  source = source.replace(/^\uFEFF/u, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let atFieldStart = true;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"' && atFieldStart) {
      quoted = true;
      atFieldStart = false;
    } else if (char === delimiter) {
      row.push(field);
      field = '';
      atFieldStart = true;
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[index + 1] === '\n') index += 1;
      row.push(field);
      if (row.some((value) => value.trim() !== '')) rows.push(row);
      row = [];
      field = '';
      atFieldStart = true;
    } else {
      field += char;
      atFieldStart = false;
    }
  }
  if (quoted) throw new Error('CSV contains an unterminated quoted field.');
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (row.some((value) => value.trim() !== '')) rows.push(row);
  }
  if (rows.length === 0) return [];

  const headers = rows[0].map((header) => header.trim());
  if (headers.some((header) => !header)) throw new Error('CSV header names cannot be empty.');
  if (new Set(headers).size !== headers.length) throw new Error('CSV header names must be unique.');
  return rows.slice(1).map((values, rowIndex) => {
    if (values.length !== headers.length) {
      throw new Error(`CSV row ${rowIndex + 2} has ${values.length} columns; expected ${headers.length} columns.`);
    }
    return Object.fromEntries(headers.map((header, columnIndex) => [header, values[columnIndex].trim()]));
  });
}

module.exports = { parseCsv };

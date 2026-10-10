const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { parseCsv } = require('./csv');

const execFileAsync = promisify(execFile);
const MAX_TEXT_CHARS = 180_000;
const MAX_SOURCE_REFS = 2_500;
const MAX_TABULAR_ROWS = 500;
const OCR_LANGUAGES = String(process.env.OCR_LANGUAGES || 'eng').trim() || 'eng';

function linesToPages(text) {
  return String(text).split('\f').map((page) => page.replace(/\r/g, '')).filter((page) => page.trim());
}
function buildTextResult(pages, kind = 'ocr') {
  let remaining = MAX_TEXT_CHARS;
  const clippedPages = [];
  let truncated = false;
  for (const page of pages) {
    if (remaining <= 0) { truncated = true; break; }
    const value = String(page).slice(0, remaining);
    if (value.length < String(page).length) truncated = true;
    clippedPages.push(value);
    remaining -= value.length;
  }
  const text = clippedPages.join('\n\n');
  const sourceRefs = [];
  clippedPages.forEach((page, pageIndex) => page.split('\n').forEach((line, lineIndex) => {
    if (line.trim() && sourceRefs.length < MAX_SOURCE_REFS) sourceRefs.push({ page: pageIndex + 1, line: lineIndex + 1, quote: line.trim().slice(0, 500) });
    else if (line.trim()) truncated = true;
  }));
  if (!text.trim()) throw Object.assign(new Error('No readable text was found in the uploaded document.'), { code: 'OCR_EMPTY' });
  return { kind, text, pages: clippedPages, sourceRefs, truncated };
}

async function run(command, args, options = {}) {
  try {
    const { stdout } = await execFileAsync(command, args, {
      encoding: 'utf8', timeout: 120_000, maxBuffer: 24 * 1024 * 1024, windowsHide: true, ...options,
    });
    return stdout;
  } catch (error) {
    if (error.code === 'ENOENT') throw Object.assign(new Error(`${command} is unavailable. Install Tesseract OCR and Poppler utilities to process this file type.`), { code: 'OCR_UNAVAILABLE' });
    throw Object.assign(new Error(`${command} could not process the document: ${error.message}`), { code: 'OCR_FAILED' });
  }
}

async function extractDocument({ filename, bytes }) {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes || '');
  if (!bytes.length) throw Object.assign(new Error('The uploaded file is empty.'), { code: 'OCR_EMPTY' });
  const extension = path.extname(String(filename || '')).toLowerCase();
  if (extension === '.csv' || extension === '.tsv') {
    const parsedRows = parseCsv(bytes, { delimiter: extension === '.tsv' ? '\t' : ',' });
    const rows = parsedRows.slice(0, MAX_TABULAR_ROWS).map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key.slice(0, 200), value.slice(0, 2000)])));
    const sourceRefs = rows.map((_, index) => ({ row: index + 2 }));
    return { kind: 'tabular', rows, rowCount: parsedRows.length, headers: rows[0] ? Object.keys(rows[0]) : [], text: JSON.stringify(rows).slice(0, MAX_TEXT_CHARS), sourceRefs, truncated: parsedRows.length > rows.length };
  }
  if (extension === '.txt') {
    const text = bytes.toString('utf8').replace(/^\uFEFF/u, '');
    if (!text.trim()) throw Object.assign(new Error('The uploaded text file is blank.'), { code: 'OCR_EMPTY' });
    return buildTextResult([text], 'text');
  }
  if (['.png', '.jpg', '.jpeg', '.webp'].includes(extension)) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tutupbuku-ocr-'));
    const imagePath = path.join(directory, `image${extension}`);
    try {
      await fs.writeFile(imagePath, bytes, { flag: 'wx', mode: 0o600 });
      const text = await run('tesseract', [imagePath, 'stdout', '-l', OCR_LANGUAGES, '--psm', '3']);
      return buildTextResult([text]);
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  }
  if (extension === '.pdf') {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tutupbuku-ocr-'));
    const pdfPath = path.join(directory, 'document.pdf');
    try {
      await fs.writeFile(pdfPath, bytes, { flag: 'wx', mode: 0o600 });
      const extracted = await run('pdftotext', ['-f', '1', '-l', '30', '-layout', pdfPath, '-']);
      if (extracted.trim()) return buildTextResult(linesToPages(extracted), 'pdf-text');
      const prefix = path.join(directory, 'page');
      await run('pdftoppm', ['-f', '1', '-l', '30', '-png', '-r', '180', pdfPath, prefix]);
      const pages = (await fs.readdir(directory)).filter((name) => /^page-\d+\.png$/u.test(name)).sort((a, b) => Number(a.match(/\d+/u)[0]) - Number(b.match(/\d+/u)[0]));
      if (!pages.length) throw Object.assign(new Error('No readable text or renderable pages were found in the PDF.'), { code: 'OCR_EMPTY' });
      const texts = [];
      for (const page of pages) texts.push(await run('tesseract', [path.join(directory, page), 'stdout', '-l', OCR_LANGUAGES, '--psm', '3']));
      return buildTextResult(texts, 'pdf-image-ocr');
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  }
  throw Object.assign(new Error('Supported files are CSV, TSV, TXT, PDF, PNG, JPG, JPEG, and WEBP.'), { code: 'UNSUPPORTED_FILE' });
}

module.exports = { extractDocument, buildTextResult, MAX_TEXT_CHARS, MAX_SOURCE_REFS, MAX_TABULAR_ROWS };

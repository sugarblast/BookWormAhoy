// Plain text: decoded (UTF-8, UTF-16 or Windows-1252), split into chapters at
// headings such as "Chapter 3" or into even parts, and shown as paragraphs.

import { BookError } from './errors.js';

const escapeHtml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const HEADING = /^\s*(chapter|book|part|section|volume|act|canto|prologue|epilogue|preface|foreword|introduction|afterword|appendix)\b[^\n]{0,70}$/i;
const NUMBERED = /^\s*(chapter|part|book)\s+([ivxlcdm]+|\d+|[a-z]+)\b[.:\-\s]*[^\n]{0,60}$/i;
const PART_CHARS = 30_000;

export function decodeText(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

function paragraphsOf(lines) {
  const blank = lines.filter((line) => !line.trim()).length;
  // Mostly no blank lines: every line is its own paragraph. Otherwise blank lines separate
  // paragraphs and the hard line breaks inside them (Project Gutenberg style) are joined.
  if (blank / Math.max(lines.length, 1) < 0.05) return lines.map((line) => line.trim()).filter(Boolean);
  const paragraphs = [];
  let current = [];
  for (const line of lines) {
    if (line.trim()) current.push(line.trim());
    else if (current.length) {
      paragraphs.push(current.join(' '));
      current = [];
    }
  }
  if (current.length) paragraphs.push(current.join(' '));
  return paragraphs;
}

export async function openTxt(blob, fileName = '') {
  const text = decodeText(new Uint8Array(await blob.arrayBuffer())).replace(/\r\n?/g, '\n');
  if (!text.trim()) throw new BookError('This text file is empty.');
  const lines = text.split('\n');

  const headingAt = [];
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed && trimmed.length < 80 && (NUMBERED.test(trimmed) || (HEADING.test(trimmed) && !/[.,;]$/.test(trimmed)))) {
      if (!lines[i - 1]?.trim()) headingAt.push(i); // a heading follows a blank line (or starts the file)
    }
  });

  const parts = [];
  if (headingAt.length >= 3) {
    if (headingAt[0] > 0 && lines.slice(0, headingAt[0]).join('').trim()) parts.push({ title: 'Beginning', lines: lines.slice(0, headingAt[0]) });
    headingAt.forEach((start, n) => {
      const end = headingAt[n + 1] ?? lines.length;
      parts.push({ title: lines[start].trim(), lines: lines.slice(start + 1, end), heading: true });
    });
  } else {
    // No chapters found: even parts at paragraph boundaries.
    const paragraphs = paragraphsOf(lines);
    let current = [];
    let size = 0;
    for (const paragraph of paragraphs) {
      current.push(paragraph);
      size += paragraph.length;
      if (size >= PART_CHARS) {
        parts.push({ paragraphs: current });
        current = [];
        size = 0;
      }
    }
    if (current.length) parts.push({ paragraphs: current });
    parts.forEach((part, n) => (part.title = parts.length > 1 ? `Part ${n + 1}` : 'Text'));
  }

  for (const part of parts) {
    part.paragraphs ??= paragraphsOf(part.lines);
    part.size = Math.max(1, part.paragraphs.join('').length);
  }
  const usable = parts.filter((part) => part.paragraphs.length || part.heading);

  const BOOK_CSS = 'p { margin: 0 0 0.9em; }';
  return {
    format: 'txt',
    fixed: false,
    metadata: { title: fileName.replace(/\.txt$/i, '').replace(/_+/g, ' ').trim(), author: '', language: '' },
    sections: usable.map((part, index) => ({ index, size: part.size })),
    outline: (() => {
      const flat = [];
      const tree = usable.length > 1 ? usable.map((part, index) => {
        const node = { title: part.title, depth: 0, parent: null, children: [], target: { index, fragment: '' }, page: null };
        flat.push(node);
        return node;
      }) : [];
      return { tree, flat };
    })(),
    async load(index) {
      const part = usable[index];
      const heading = part.heading ? `<h2>${escapeHtml(part.title)}</h2>` : '';
      return {
        css: BOOK_CSS,
        bodyHtml: heading + part.paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join(''),
        bodyClass: 'txt',
        bodyId: '',
        lang: '',
        dir: '',
        text: part.paragraphs.join(' '),
        revoke() {},
      };
    },
    cover: async () => null,
    destroy() {},
  };
}

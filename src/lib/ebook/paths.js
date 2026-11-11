// Path helpers for resolving links between files inside an archive.

export function dirname(path) {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash + 1);
}

function decode(part) {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/** Resolves `href` against the file at `fromPath`; returns { path, fragment } (path is '' for "#frag" only). */
export function resolveHref(fromPath, href = '') {
  const hashAt = href.indexOf('#');
  const fragment = hashAt >= 0 ? decode(href.slice(hashAt + 1)) : '';
  let target = hashAt >= 0 ? href.slice(0, hashAt) : href;
  target = target.split('?')[0];
  if (!target) return { path: '', fragment };
  const parts = [];
  const full = target.startsWith('/') ? target.slice(1) : dirname(fromPath) + target;
  for (const part of full.split('/')) {
    if (part === '..') parts.pop();
    else if (part !== '.' && part !== '') parts.push(decode(part));
  }
  return { path: parts.join('/'), fragment };
}

/** "http:", "https:", "mailto:", "data:" ... (anything that is not a path inside the book). */
export const schemeOf = (href = '') => /^([a-z][a-z0-9+.-]*):/i.exec(href.trim())?.[1]?.toLowerCase() ?? '';

/** Natural sort ("page2" before "page10"). */
export const naturalCompare = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

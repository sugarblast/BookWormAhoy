/** Thrown by the book engines. `kind` picks the message the reader shows. */
export class BookError extends Error {
  constructor(message, kind = 'invalid') {
    super(message);
    this.name = 'BookError';
    this.kind = kind; // 'invalid' | 'unsupported' | 'drm'
  }
}

// Minimal Google Drive v3 client (read metadata, build download URLs). Which files
// exist on the shelf is decided by the Picker (picker.js); with the `drive.file`
// scope Google only serves files the user picked.
// Every request carries the access token from auth.js; a 401 drops the token
// and retries once through the silent refresh path before asking the user to
// reconnect.

import { AuthError, ensureToken, invalidateToken } from './auth.js';
import { driveBook } from './books.js';

const API = 'https://www.googleapis.com/drive/v3';

export class DriveError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'DriveError';
    this.status = status;
  }
}

async function driveFetch(path, params = {}, { signal } = {}, retried = false) {
  const token = await ensureToken();
  const url = new URL(API + path);
  for (const [key, value] of Object.entries(params)) {
    if (value != null) url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal });
  if (response.status === 401) {
    invalidateToken();
    if (!retried) return driveFetch(path, params, { signal }, true);
    throw new AuthError('Google no longer accepts the saved sign-in. Reconnect to continue.', 'expired');
  }
  if (!response.ok) {
    let detail = '';
    try {
      detail = (await response.json())?.error?.message ?? '';
    } catch {
      /* body was not JSON */
    }
    throw new DriveError(detail || `Google Drive answered ${response.status}.`, response.status);
  }
  return response;
}

const FILE_FIELDS = 'id,name,size,modifiedTime';

export async function getFileMeta(fileId, { signal } = {}) {
  const response = await driveFetch(`/files/${encodeURIComponent(fileId)}`, {
    fields: FILE_FIELDS,
    supportsAllDrives: true,
  }, { signal });
  return driveBook(await response.json());
}

export async function getAccount() {
  const response = await driveFetch('/about', { fields: 'user(displayName,emailAddress,photoLink)' });
  return (await response.json()).user ?? null;
}

/** URL PDF.js streams from (it sends the Authorization header itself). */
export const mediaUrl = (fileId) =>
  `${API}/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;

// Google OAuth configuration for a static (no backend) site.
//
// The "token model" of Google Identity Services is used: the browser opens a
// Google popup, the user approves, and Google hands an access token straight
// back to this page. No redirect URI, client secret or server is involved.

// Read-only access to every file in the user's Drive. Needed to *list* the PDFs
// that were not created by this app. (`drive.file` + the Google Picker is the
// narrower alternative; see README.)
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';

const CLIENT_ID_KEY = 'bw.clientId';

/** Client ID baked in at build time, or one the user pasted into the app. */
export function getClientId() {
  const built = import.meta.env.VITE_GOOGLE_CLIENT_ID;
  if (built) return String(built).trim();
  try {
    return (localStorage.getItem(CLIENT_ID_KEY) || '').trim();
  } catch {
    return '';
  }
}

export function looksLikeClientId(value) {
  return /^[\w-]+\.apps\.googleusercontent\.com$/.test(String(value).trim());
}

export function saveClientId(value) {
  try {
    localStorage.setItem(CLIENT_ID_KEY, String(value).trim());
  } catch {
    /* storage unavailable: the id only lasts until reload */
  }
}

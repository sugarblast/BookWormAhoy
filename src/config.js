// Google and Dropbox configuration for a static (no backend) site.
//
// The values are public identifiers, not secrets. They are read when the site is
// built (GitHub Actions repository variables, or .env.local while developing),
// so the deployed site has them baked in and visitors never configure anything.
//
// Google sign-in uses the "token model" of Google Identity Services: the browser
// opens a Google popup, the user approves, and Google hands an access token
// straight back to this page. No redirect URI, client secret or server is involved.
//
// Files are chosen with the Google Picker, the same window other sites use for
// "Open from Drive". With the `drive.file` scope the app can only read the files
// the user picks there, never the rest of the Drive.
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

const clean = (value) => String(value ?? '').trim();
const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;
const apiKey = import.meta.env.VITE_GOOGLE_API_KEY;

/** OAuth client ID (VITE_GOOGLE_CLIENT_ID). */
export const getClientId = () => clean(clientId);

/** API key for the Picker (VITE_GOOGLE_API_KEY); locked to this site's address in Cloud Console. */
export const getApiKey = () => clean(apiKey);

/** Dropbox app key for the Chooser (VITE_DROPBOX_APP_KEY). Optional. */
export const getDropboxKey = () => clean(import.meta.env.VITE_DROPBOX_APP_KEY);

/**
 * The Picker wants the Cloud project number as its "app id". Every OAuth client
 * ID starts with it ("1234567890-abc.apps.googleusercontent.com"), so there is
 * nothing extra to configure.
 */
export function getAppId() {
  const [first] = getClientId().split('-');
  return /^\d+$/.test(first) ? first : '';
}

/**
 * Google Drive is switched on with VITE_GOOGLE_DRIVE=on, on top of the two Google values. Until then
 * the Add books window shows it as "Coming soon" and the app never contacts Google. Keep it off while
 * the Google OAuth app is still in Testing (anyone outside the test users would hit "Access blocked").
 */
export const isDriveSwitchedOn = () => clean(import.meta.env.VITE_GOOGLE_DRIVE).toLowerCase() === 'on';

export const isDriveConfigured = () => Boolean(isDriveSwitchedOn() && getClientId() && getApiKey());
export const isDropboxConfigured = () => Boolean(getDropboxKey());

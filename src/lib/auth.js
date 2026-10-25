// Google sign-in for a site with no backend.
//
// Google Identity Services "token model": the browser asks Google for an
// access token via a popup and gets it back directly. The token lives in
// localStorage (so a reload does not sign you out) and is only ever sent to
// googleapis.com in an Authorization header.
//
// Honest limits of having no server:
//  * Access tokens last about one hour and there are no refresh tokens. After
//    that we try a silent re-request (works when the browser lets Google's
//    popup open without a click); if that fails the UI shows "Reconnect".
//  * localStorage is readable by any script on this origin. That is why the
//    production build ships a strict Content-Security-Policy and the app never
//    inserts untrusted text as HTML.

import { DRIVE_SCOPE, getClientId } from '../config.js';

const TOKEN_KEY = 'bw.token.v1';
const CONNECTED_KEY = 'bw.connected.v1';
const GIS_SRC = 'https://accounts.google.com/gsi/client';

export class AuthError extends Error {
  constructor(message, code = 'auth') {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}

const listeners = new Set();
let token = readStoredToken();
let inflight = null;
let gisLoading = null;

function readStoredToken() {
  try {
    const saved = JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null');
    if (saved?.access_token && saved.expires_at > Date.now()) return saved;
  } catch {
    /* corrupt or unavailable: treat as signed out */
  }
  return null;
}

const remaining = () => (token ? token.expires_at - Date.now() : 0);
const wasConnected = () => {
  try {
    return localStorage.getItem(CONNECTED_KEY) === '1';
  } catch {
    return false;
  }
};

function setToken(next) {
  token = next;
  try {
    if (next) localStorage.setItem(TOKEN_KEY, JSON.stringify(next));
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* keep the token in memory only */
  }
  for (const listener of listeners) {
    try {
      listener(getAuthStatus());
    } catch {
      /* a broken listener must not block the others */
    }
  }
}

/** 'signed-in' (valid token), 'expired' (connected before, token gone) or 'signed-out'. */
export function getAuthStatus() {
  if (remaining() > 30_000) return 'signed-in';
  return wasConnected() ? 'expired' : 'signed-out';
}

export function onAuthChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  gisLoading ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = GIS_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      gisLoading = null;
      script.remove();
      reject(new AuthError('Could not load Google sign-in. Check your connection or content blocker.', 'gis_load'));
    };
    document.head.append(script);
  });
  return gisLoading;
}

/** Load Google's script ahead of time so the sign-in popup can open straight from a click. */
export function preloadGis() {
  if (getClientId()) loadGis().catch(() => {});
}

function requestToken({ prompt = '', timeoutMs = 0 } = {}) {
  if (inflight) return inflight;
  inflight = (async () => {
    const clientId = getClientId();
    if (!clientId) throw new AuthError('Add a Google OAuth client ID to connect Drive.', 'no_client_id');
    await loadGis();
    return new Promise((resolve, reject) => {
      let timer;
      const finish = (fn, value) => {
        clearTimeout(timer);
        fn(value);
      };
      if (timeoutMs) {
        timer = setTimeout(() => reject(new AuthError('Silent sign-in timed out.', 'timeout')), timeoutMs);
      }
      const client = window.google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: DRIVE_SCOPE,
        prompt,
        callback: (response) => {
          if (response.error) {
            return finish(reject, new AuthError(response.error_description || response.error, response.error));
          }
          if (response.scope && !response.scope.split(' ').includes(DRIVE_SCOPE)) {
            return finish(
              reject,
              new AuthError('Drive access was not granted. Tick the Drive permission on the Google screen and try again.', 'scope_missing'),
            );
          }
          setToken({
            access_token: response.access_token,
            expires_at: Date.now() + Number(response.expires_in || 3600) * 1000,
          });
          try {
            localStorage.setItem(CONNECTED_KEY, '1');
          } catch {
            /* fine */
          }
          finish(resolve, response.access_token);
        },
        error_callback: (error) =>
          finish(
            reject,
            new AuthError(
              error?.type === 'popup_closed'
                ? 'The Google window was closed before sign-in finished.'
                : error?.message || 'Google sign-in did not complete.',
              error?.type || 'popup',
            ),
          ),
      });
      client.requestAccessToken();
    });
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

/** Interactive sign-in. Call from a click handler so the popup is allowed. */
export function connect({ chooseAccount = false } = {}) {
  return requestToken({ prompt: chooseAccount ? 'select_account' : '' });
}

/**
 * Returns a usable access token, refreshing quietly when it is close to expiry.
 * Throws AuthError when the user has to click "Reconnect".
 */
export async function ensureToken({ minTtlMs = 60_000 } = {}) {
  if (remaining() > minTtlMs) return token.access_token;
  if (!wasConnected()) throw new AuthError('Connect Google Drive to open this file.', 'not_connected');
  try {
    return await requestToken({ prompt: 'none', timeoutMs: 8000 });
  } catch {
    if (remaining() > 30_000) return token.access_token; // still valid, just short
    throw new AuthError('Your Google Drive session timed out. Reconnect to keep reading.', 'expired');
  }
}

/** Drop a token Google rejected (HTTP 401) without forgetting the connection. */
export function invalidateToken() {
  setToken(null);
}

export async function disconnect() {
  const old = token?.access_token;
  try {
    localStorage.removeItem(CONNECTED_KEY);
  } catch {
    /* fine */
  }
  setToken(null);
  const revoke = window.google?.accounts?.oauth2?.revoke;
  if (old && revoke) {
    await Promise.race([
      new Promise((resolve) => revoke(old, () => resolve())),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
  }
}

export { getClientId };

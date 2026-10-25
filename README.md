# Bookworm

A zero-backend PDF reader. It signs in to **your** Google Drive, lists the PDFs
you already keep there as a shelf of covers, and opens them in a quiet,
book-like reader. Everything runs in the browser, so it can be hosted as static
files on GitHub Pages. There is no server, no database and no analytics.

- **Library shelf**: responsive grid, covers made from page 1, search, sort, a
  "Continue reading" row. PDFs from your computer can be added too (stored in
  this browser only).
- **Reader**: single page, facing pages, or continuous scroll; page-turn
  animation; fit page / fit width / zoom; light, sepia and dark themes; a ribbon
  scrubber; a drawer with the PDF's own table of contents and a page thumbnail grid.
- **Progress**: last page per book, kept in IndexedDB.

## Run it

Needs Node 22.13 or newer.

```bash
npm install
cp .env.example .env.local      # then paste your OAuth client ID (see below)
npm run dev                     # http://localhost:5173
```

Commit the `package-lock.json` that `npm install` creates, so the deploy
workflow installs exactly the same versions.

No client ID yet? The app still works: the first screen has a field to paste
one (saved in this browser), and "Add from device" works without Google at all.

## Google Cloud setup (about five minutes)

1. Open the [Google Cloud Console](https://console.cloud.google.com/), create a project.
2. **APIs & Services > Library**: enable the **Google Drive API**.
3. **APIs & Services > OAuth consent screen** (Google Auth Platform):
   - User type **External**, fill in the app name and your email.
   - Add the scope `https://www.googleapis.com/auth/drive.readonly`.
   - Leave the publishing status on **Testing** and add your own Google account
     under **Test users**. `drive.readonly` is a "restricted" scope; for a
     personal tool, Testing mode is the intended route. Google will show an
     "unverified app" warning on sign-in; that is expected for you.
4. **Credentials > Create credentials > OAuth client ID**, type **Web application**.
   Under **Authorized JavaScript origins** add (origins only, no path, no trailing slash):
   - `http://localhost:5173`
   - `https://<your-github-username>.github.io`
5. Copy the client ID (`...apps.googleusercontent.com`). Do not create or copy a client secret; this app has none.

Locally: put the ID in `.env.local` as `VITE_GOOGLE_CLIENT_ID=...`.

## Deploy to GitHub Pages

1. Push this folder to a GitHub repository (default branch `main`).
2. **Settings > Pages > Source: GitHub Actions**.
3. **Settings > Secrets and variables > Actions > Variables**: add a *variable*
   (not a secret) named `GOOGLE_CLIENT_ID` with your client ID.
4. Push to `main`. `.github/workflows/deploy.yml` builds and publishes. The
   site lives at `https://<user>.github.io/<repo>/`, which is covered by the
   origin you added in step 4 above (origins ignore the path).

The build uses relative asset paths and hash routing (`#/read/drive/<id>`), so
it works under a repo sub-path or a custom domain with no 404 tricks.

## Project structure

```
index.html                  entry; theme bootstrap script; CSP placeholder
vite.config.js              base './', Tailwind plugin, build-time CSP plugin
build/csp.js                the Content-Security-Policy (shared by the build and tests)
scripts/copy-pdfjs-assets.mjs   copies PDF.js cmaps/fonts/wasm into public/pdfjs
.github/workflows/deploy.yml    GitHub Pages deploy
src/
  main.js                   hash router; lazy-loads the reader
  config.js                 OAuth client ID + Drive scope
  style.css                 Tailwind v4 + theme tokens (light / sepia / dark)
  lib/
    auth.js                 Google Identity Services token flow, silent refresh
    drive.js                Drive v3 calls (list PDFs, file metadata, media URL)
    pdfdoc.js               PDF.js setup: open a book, covers, outline
    covers.js               cover queue + IndexedDB cache
    books.js  progress.js  settings.js  db.js  dom.js  icons.js
  views/library.js          connect screen, shelf, search, sort, continue reading
  reader/
    reader.js               the reader: layouts, zoom, page turns, drawer, keys, progress
    outline.js              table of contents tree
    thumbnails.js           lazy page thumbnail grid
```

## How sign-in and the token work

- Sign-in uses **Google Identity Services' token model** (OAuth 2.0 for browser
  apps). It needs no backend and no client secret.
- The access token lives in `localStorage` (`bw.token.v1`). It is only ever sent
  in an `Authorization` header to `www.googleapis.com`; nothing else is contacted.
- Tokens last about an hour, and without a backend there are no refresh tokens.
  Near expiry the app asks Google for a new one silently; if the browser
  blocks that (popup blockers, third-party-cookie settings) a **Reconnect**
  button appears. Your place in the book is kept.
- `localStorage` is readable by any script on the page, so the production build
  ships a strict CSP: scripts only from the site itself and Google's sign-in
  script, network only to `googleapis.com` and Google sign-in, no inline script
  except the one theme bootstrap (allowed by hash). File names from Drive are
  always inserted as text, never as HTML.
- "Disconnect" revokes the token with Google and clears it locally.

## Keyboard (reader)

`←` `→` turn pages · `Space` / `Shift+Space` next / previous · `Home` `End` ·
`+` `-` zoom · `0` reset fit · `t` contents drawer · `f` fullscreen · `Esc` close drawer.
On touch screens: swipe to turn, tap to show or hide the controls.

## What has and has not been verified

Tested in headless Chromium with PDF.js and a stand-in for Google:

- Library, adding local PDFs, covers, search/sort, continue reading, progress restore.
- Reader: all three layouts, page turns, zoom presets, table of contents,
  thumbnails, three themes, phone-width layout, landscape PDFs, reload at saved page.
- Drive flow against a local HTTPS server pretending to be the Drive API:
  connect, two-page file listing, covers via HTTP range requests, opening a
  Drive book, progress saved, a 401 followed by a silent refresh, expired
  session banner and Reconnect, consent denied, disconnect, a hostile file name
  that must not inject HTML, and the token appearing in requests to
  `googleapis.com` only.
- The production CSP is applied during those tests.

Not verified yet (could not be done in the build environment):

- `npm install` and `vite build` with the real dependency versions. The
  versions in `package.json` are my best choice; if one fails to resolve, bump it.
- Real Google sign-in and the real Drive API, including whether Drive serves
  range requests the way the stand-in does.
- The Literata and Hanken Grotesk fonts (screenshots used fallbacks).

## Good to know

- Covers: for a large PDF, PDF.js uses range requests when the server
  supports them and fetches only what page 1 needs. If it does not, the whole
  file is downloaded once to make the cover, then cached.
- `drive.readonly` can read every PDF you have. If you prefer, switch to the
  narrower `drive.file` scope plus the Google Picker, so the app can only see
  files you pick. That needs a small UI change (a "Pick files" button) and an
  API key.
- Password-protected PDFs prompt for the password. Scanned PDFs without an
  outline show page thumbnails only.

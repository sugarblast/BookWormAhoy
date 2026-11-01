# Bookworm

A zero-backend PDF reader. Click **Add books** and choose where the PDFs are:
this device, Google Drive or Dropbox (or just drop files on the window). You get a
shelf of covers and a quiet, book-like reader. Everything runs in the browser, so
it can be hosted as static files on GitHub Pages. There is no server, no
database and no analytics.

- **Add books window**: tiles for This device, Google Drive and Dropbox, a drop
  area, and a bar showing how much browser storage is left. Google Drive and
  Dropbox tiles appear only when the site owner has set them up (below).
- **Google Drive**: Google's own file picker; Bookworm can read only the files you pick,
  never the rest of your Drive. These books are not copied into the browser.
- **Dropbox**: Dropbox's own file chooser; each chosen PDF is downloaded into this
  browser (Dropbox's links expire after a few hours, so there is nothing to refer back to).
- **Shelf**: responsive grid, covers made from page 1, search, sort, "Continue reading".
- **Reader**: single page, facing pages, or continuous scroll; page-turn
  animation; fit page / fit width / zoom; light, sepia and dark themes; a ribbon
  scrubber; a drawer with the PDF's own table of contents and a page thumbnail grid.
- **Progress**: last page per book, kept in IndexedDB.

## Run it

Needs Node 22.13 or newer.

```bash
npm install
cp .env.example .env.local      # then paste your keys (see "Cloud sources" below)
npm run dev                     # http://localhost:5173
```

Commit the `package-lock.json` that `npm install` creates, so the deploy
workflow installs exactly the same versions.

The keys are read when the site is built (`.env.local` while developing, the
repository variables on GitHub). Visitors are never asked for anything. Without
keys the site still works with "This device"; the Google Drive and Dropbox tiles
and the cloud icon simply do not appear.

**A tile is missing?** Open the browser console (F12). The page prints one line such as
`[Bookworm] Google Drive: off (the build is missing GOOGLE_CLIENT_ID and GOOGLE_API_KEY); Dropbox: off.`
(no values are printed). If it says off, the build did not receive the variable: check the
spelling (names are case-sensitive), that they are *Variables* and not *Secrets*, that
`.github/workflows/deploy.yml` is the current one, and re-run the workflow after saving them.

## Cloud sources (once, by whoever runs the site)

### Google Drive (about ten minutes)

Visitors never see Google Cloud. The site owner creates **one** OAuth client ID
and **one** API key and builds them into the site. Everyone else opens
**Add books**, chooses **Google Drive**, signs in with Google's normal "Allow
access?" screen and picks files.

1. Open the [Google Cloud Console](https://console.cloud.google.com/) and create a project.
2. **APIs & Services > Library**: enable the **Google Drive API** and the **Google Picker API**.
3. **OAuth consent screen** (Google Auth Platform):
   - User type **External**, fill in the app name and your email.
   - Add the scope `https://www.googleapis.com/auth/drive.file`.
   - Leave the publishing status on **Testing** and add your own Google account
     under **Test users**. In Testing mode only listed accounts (up to 100) can
     sign in, they see an "unverified app" warning, and Google expires their
     authorization after 7 days, so expect to approve again about weekly.
4. **Credentials > Create credentials > OAuth client ID**, type **Web application**.
   Under **Authorized JavaScript origins** add (origins only, no path, no trailing slash):
   - `http://localhost:5173`
   - `https://<your-github-username>.github.io`
5. **Credentials > Create credentials > API key**. Restrict it:
   - Application restriction: **Websites**, with `https://<your-github-username>.github.io/*`,
     `http://localhost:5173/*` and `https://docs.google.com/*` (the picker window is a docs.google.com frame).
   - API restriction: **Google Picker API**.
6. Keep the client ID (`1234567890-abc...apps.googleusercontent.com`) and the key (`AIza...`).
   Do not create or copy a client secret; this app has none. The number at the
   start of the client ID is your project number, which the picker needs, so it
   is read from the client ID and is not a third setting.

Locally: put both in `.env.local` as `VITE_GOOGLE_CLIENT_ID=...` and `VITE_GOOGLE_API_KEY=...`.

### Dropbox (optional, about five minutes)

1. Open the [Dropbox App Console](https://www.dropbox.com/developers/apps) and create an app
   (Scoped access; the Chooser needs no special permissions, so the smallest access type is fine).
2. On the app's **Settings** tab, add your site's domain (for example
   `<your-github-username>.github.io`) to **Chooser / Saver domains**.
3. Copy the **App key** (not the app secret).

Locally: `VITE_DROPBOX_APP_KEY=...` in `.env.local`. Leave it empty and the Dropbox tile is hidden.

### Privacy policy and terms

`public/privacy.html` and `public/terms.html` are single-file pages, published with the site at
`https://<your-github-username>.github.io/<repo>/privacy.html` and `.../terms.html`. They are the
pages to link from Google's **Branding** screen (Privacy policy and Terms of service links) when you
move the app out of Testing. The shelf footer links to both (they open in a new tab, so a book, an
upload or a transfer in progress is never interrupted); the links use `import.meta.env.BASE_URL`,
so they are right on GitHub Pages and on localhost.

If you change what the app stores or which hosts it talks to, update `privacy.html` and its
"Last updated" date. Add your own email to the Contact section of either page if you want one
listed (a comment shows where).

## Deploy to GitHub Pages

1. Push this folder to a GitHub repository (default branch `main`).
2. **Settings > Pages > Source: GitHub Actions**.
3. **Settings > Environments > github-pages**: the deployment branch rule must allow `main`.
4. **Settings > Secrets and variables > Actions > Variables**: add *variables*
   (not secrets) named `GOOGLE_CLIENT_ID` and `GOOGLE_API_KEY`, and optionally `DROPBOX_APP_KEY`.
5. Push to `main`. `.github/workflows/deploy.yml` builds and publishes. The
   site lives at `https://<user>.github.io/<repo>/`, which is covered by the
   origin from step 4 above (origins ignore the path). The values are read when
   the site is built, so re-run the workflow after changing a variable.

The build uses relative asset paths and hash routing (`#/read/drive/<id>`), so
it works under a repo sub-path or a custom domain with no 404 tricks.

## Project structure

```
index.html                  entry; theme bootstrap script; CSP placeholder
vite.config.js              base './', Tailwind plugin, build-time CSP plugin
build/csp.js                the Content-Security-Policy (shared by the build and tests)
scripts/copy-pdfjs-assets.mjs   copies PDF.js cmaps/fonts/wasm into public/pdfjs
public/privacy.html         the privacy policy page (served as /privacy.html)
public/terms.html           the terms of service page (served as /terms.html)
.github/workflows/deploy.yml    GitHub Pages deploy
src/
  main.js                   hash router; lazy-loads the reader
  config.js                 client ID, API key, Dropbox key (build-time), project number, Drive scope
  style.css                 Tailwind v4 + theme tokens (light / sepia / dark)
  lib/
    auth.js                 Google Identity Services token flow, silent refresh
    picker.js               Google Drive source: loads and runs the Google Picker
    dropbox.js              Dropbox source: the Chooser window, then downloads the PDFs
    storage.js              browser storage estimate, "keep my files" request, room checks
    drive.js                Drive v3 calls (file metadata, media URL, account name)
    pdfdoc.js               PDF.js setup: open a book, covers, outline
    covers.js               cover queue + IndexedDB cache
    books.js  progress.js  settings.js  db.js  dom.js  icons.js
  views/library.js          first screen, shelf, search, sort, continue reading, adding books
  views/addDialog.js        the Add books window (tiles, drop area)
  views/storageMeter.js     the storage bar
  reader/
    reader.js               the reader: layouts, zoom, page turns, drawer, keys, progress
    outline.js              table of contents tree
    thumbnails.js           lazy page thumbnail grid
```

## How sign-in and the token work

- Sign-in uses **Google Identity Services' token model** (OAuth 2.0 for browser
  apps). It needs no backend and no client secret.
- The only permission asked for is `drive.file`: access to the files you pick in
  the Google window, nothing else. Picked files are remembered on the shelf
  (their IDs and names live in this browser's IndexedDB).
- The access token lives in `localStorage` (`bw.token.v1`). It is only ever sent
  in an `Authorization` header to `www.googleapis.com` and given to the Picker.
- Tokens last about an hour, and without a backend there are no refresh tokens.
  Near expiry the app asks Google for a new one silently; if the browser
  blocks that (popup blockers, third-party-cookie settings) a **Reconnect**
  button appears. Your place in the book is kept.
- **Disconnect** forgets the sign-in on this device. **Disconnect and revoke
  access** also tells Google to cancel the app's access; after that you pick the
  Drive files again.
- `localStorage` is readable by any script on the page, so the production build
  ships a strict CSP: scripts only from the site itself, Google's sign-in script
  and Google's script loader (for the picker), network only to `googleapis.com`
  and Google sign-in, no inline script except the one theme bootstrap (allowed
  by hash). File names from Drive are always inserted as text, never as HTML.

## Storage

Browsers give each website a limited amount of room. The bar in the Add books
window and at the bottom of the shelf shows how much of it is left (the browser's
own estimate for this site). What counts:

- PDFs added from **this device** or **Dropbox** are copied into the browser, so they take space.
- PDFs from **Google Drive** are not copied; only a small cover image is kept.
- Covers are small and are kept for every book.

Bookworm refuses a file that clearly will not fit and says so; remove books with
the ✕ on the shelf to make room. Browsers may clear a site's data when the disk
is nearly full, so the bar has an **Ask it to keep them** button, which requests
"persistent storage" (the browser decides; it is more likely to agree for a site
you use often). Private or incognito windows have little room and forget everything when closed.

## Keyboard (reader)

`←` `→` turn pages · `Space` / `Shift+Space` next / previous · `Home` `End` ·
`+` `-` zoom · `0` reset fit · `t` contents drawer · `f` fullscreen · `Esc` close drawer.
On touch screens: swipe to turn, tap to show or hide the controls.

## What has and has not been verified

Tested in headless Chromium with PDF.js, using stand-ins for Google:

- Shelf, adding local PDFs, covers, search/sort, continue reading, progress restore.
- Reader: all three layouts, page turns, zoom presets, table of contents,
  thumbnails, three themes, phone-width layout, landscape PDFs, reload at saved page.
- The Google Drive source against a mocked Google sign-in and Picker plus a local
  HTTPS server pretending to be the Drive file endpoints (it refuses files that
  were not picked): sign-in with the `drive.file` scope, the picker receiving
  the token, API key and project number, picked files on the shelf and
  persisted, covers via HTTP range requests, opening a book and saving progress,
  reloading the reader URL, silent refresh, expired session and Reconnect,
  removing a book, disconnect with and without revoke, denied consent, a hostile
  file name that must not inject HTML, and the token appearing in requests to
  `googleapis.com` only.
- The Add books window: tiles per configured source, drop area, closing by Escape or the backdrop,
  dropping files on the window and anywhere on the shelf, refusing non-PDFs, phone width.
- The storage bar (with a faked browser quota): space left, warning colour above 80%,
  "keep my files" request, refusing a file that does not fit.
- Dropbox against a faked Dropbox window and faked download links: several PDFs at once,
  folders ignored, a saved book opening in the reader, and clear messages when a download
  fails, is not a PDF or is blocked.
- The first screen with and without keys: no setup text, no input fields, no demo covers,
  and the cloud icon and Drive tile only when the keys are present.
- The production CSP is applied during those tests.

Not verified yet (could not be done in the build environment):

- `npm install` and `vite build` with the real dependency versions. The
  versions in `package.json` are my best choice; if one fails to resolve, bump it.
- Real Google sign-in, the real Picker and the real Drive API. In particular:
  the exact CSP hosts the real Picker needs (I allowed `apis.google.com` for
  scripts and `docs.google.com` for the frame; if the picker opens blank, look
  for a "Content-Security-Policy" error in the browser console), and whether
  Drive serves range requests as the stand-in does.
- The real Dropbox Chooser and, above all, whether the browser is allowed to download
  the chosen file from Dropbox's link (a browser cross-origin rule). If Dropbox refuses,
  you will see "Dropbox did not let the browser download this file"; the workaround is
  to download from Dropbox and add the file with "This device". Tell me if that happens
  and I will add a different route.
- Browser storage numbers are estimates and differ by browser; I only tested with a faked quota.
- The Literata and Hanken Grotesk fonts (screenshots used fallbacks).

## Good to know

- Covers: for a large PDF, PDF.js uses range requests when the server
  supports them and fetches only what page 1 needs. If it does not, the whole
  file is downloaded once to make the cover, then cached.
- **If a book stops opening** ("could not find this file"): Google no longer
  gives the app access to it (revoked, moved out of reach, or deleted). Take it
  off the shelf with the ✕ button and pick it again.
- **Opening this to the public**: with `drive.file` visitors only ever share the
  files they pick, which is the lighter route for Google's app review, but
  while the app is in Testing mode only the accounts you list can sign in.
  Moving to production means going through Google's app verification; check
  Google's current requirements before promising anyone a date.
- Password-protected PDFs prompt for the password. Scanned PDFs without an
  outline show page thumbnails only.

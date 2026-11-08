# BookWormAhoy 📚⚓

A privacy-focused, zero-backend browser digital library and PDF reader powered by Vite, pdf.js, IndexedDB, and the Google Drive / Picker API.

Live App (Cloudflare Pages): https://bookworm-1rt.pages.dev

Legacy URL (GitHub Pages): https://sugarblast.github.io/BookWormAhoy/

⚡ Quick Start (Local Development)

Prerequisites: Node.js v22.13 or newer.

\# 1. Install dependencies

npm install

\# 2. Set up environment variables

cp .env.example .env.local   # Fill in your Google/Dropbox credentials

\# 3. Start dev server

npm run dev                  # Opens at http://localhost:5173

🔑 Environment Variables

To enable Google Drive sync and Dropbox imports, the following build-time environment variables are required:

Variable Name    Description    Required?

VITE\_GOOGLE\_CLIENT\_ID    Google OAuth 2.0 Web Client ID    Yes (for Drive sync)

VITE\_GOOGLE\_API\_KEY    Google API Key (restricted to Google Picker API)    Yes (for Drive picker)

VITE\_DROPBOX\_APP\_KEY    Dropbox Chooser App Key    Optional

⚠️ Important Note on Build Variables: Because Vite injects VITE\_\* variables at compile time, environment variables must be configured prior to triggering a production build or deployment. If deployed without these variables set, cloud tiles will be hidden automatically.

☁️ Cloudflare Pages Deployment Setup

Create Project: Connect Cloudflare Pages to the GitHub repository sugarblast/BookWormAhoy (production branch: master).

Build Configurations:

Build Command: npm run build

Build Output Directory: dist

Environment Variables: In the Cloudflare Pages Dashboard, navigate to Settings \> Environment variables and add VITE\_GOOGLE\_CLIENT\_ID, VITE\_GOOGLE\_API\_KEY, and optional VITE\_DROPBOX\_APP\_KEY.

🔒 Google Cloud Console Configuration

To prevent OAuth errors and CORS issues on bookworm-1rt.pages.dev, ensure the following are configured in your Google Cloud Console:

APIs Enabled: Enable both Google Drive API and Google Picker API.

Credentials \> API Key:

Application restrictions: Set to HTTP referrers (web sites).

Allowed Referrers: Add https://bookworm-1rt.pages.dev/\*, http://localhost:5173/\*, and https://docs.google.com/\*.

API restrictions: Restrict key to Google Picker API.

Credentials \> OAuth 2.0 Client ID:

Authorized JavaScript origins: Add https://bookworm-1rt.pages.dev and http://localhost:5173.

OAuth Consent Screen:

Authorized domains: Add bookworm-1rt.pages.dev.

App URLs: Set Homepage, Privacy Policy (/privacy.html), and Terms (/terms.html) to the https://bookworm-1rt.pages.dev domain.

📜 License \& Privacy

BookWormAhoy operates completely client-side without external tracking or databases. All stored PDFs and progress markers remain strictly inside the browser's IndexedDB storage.


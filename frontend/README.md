# TutupBuku frontend

React + TypeScript (Vite) workspace for authenticated purchasing documents, employee claims, backend processing progress, issues, review decisions, and approved exports.

## Local development

Run the Node backend from the repository root. It loads the root `.env` file and listens on port `3000` by default:

```powershell
node --env-file-if-exists=.env src/server.js
```

In a second terminal, start Vite:

```powershell
cd frontend
npm run dev
```

Vite proxies `/api/*` to the backend. When root `.env` contains a live `NGROK_URL`, it sends API requests through that HTTPS tunnel; otherwise it uses `http://127.0.0.1:3000`. The root `.env` must also contain `TUTUPBUKU_DEV_PROXY_SECRET` for local development through ngrok. Keep that secret private and out of frontend build variables.

The separate month-end bank-matching flow uses the Python service at `127.0.0.1:8765` through `/month-end-api/*`.

## Backend processing and sign-in

Local sign-in is development-only. The backend accepts raw uploads, retains the source file, creates a processing job, and exposes progress and results to the authenticated workspace. AI/OCR processing remains unavailable until `AI_BASE_URL` and `AI_MODEL` are configured in the backend environment. A file accepted while processing is unconfigured remains in Documents with its backend status; the UI must not fabricate extracted values.

For a deployed Vercel frontend, set `VITE_API_BASE_URL` to the public HTTPS backend origin in Vercel's environment settings and set the exact deployed frontend origin in the backend's `TUTUPBUKU_ALLOWED_ORIGINS`. Configure `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` on the backend for production sign-in and storage. Do not use local sign-in or a development proxy secret on a public deployment. A Vercel build cannot read a developer's ignored local `.env` file.

## Build

```powershell
npm run build
```

The build type-checks the frontend and writes the deployable bundle to `frontend/dist/`.

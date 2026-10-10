# TutupBuku frontend

This React + TypeScript app is the authenticated browser client for the Node service in `../src`. It uses same-origin `/api` routes for uploads, processing jobs, purchasing records, claims, issues, source files, review decisions, and approved CSV exports.

The agent skill files live in `../skills`. The server loads those skills during document processing; the frontend uploads each file to the service, follows the persisted job events, and displays the saved findings and review actions. Corrections include a reviewer reason and start a new check. The app does not approve documents automatically.

## Run locally

Start the API from the repository root:

```powershell
Copy-Item .env.example .env
node --env-file=.env src/server.js
```

In a second terminal, run the frontend:

```powershell
Set-Location frontend
npm install
npm run dev
```

Vite serves the app on port 5173 and proxies `/api` to the Node service on port 3000. Local sign-in is for development only. The service stores development records under the ignored `.tutupbuku-data` directory.

## Production build

```powershell
Set-Location frontend
npm install
npm run build
```

The Node service serves `frontend/dist` when it exists. Build the frontend before packaging or deploying the service. Supabase deployments also need both SQL migrations from `../supabase/migrations`, applied in order; see the root README for production configuration.

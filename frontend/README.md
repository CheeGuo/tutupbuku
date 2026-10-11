# TutupBuku frontend

React + TypeScript (Vite). Three pages, following `TutupBuku_Project_Context.md`:

| Page | Route | Data |
| --- | --- | --- |
| Agentic Live Execution | `/` | **Live** — Python service (`/api/execution`, `/api/cases`, `/api/exports/*`). The orbit follows the real stage state. |
| Documents | `/documents` | **Dummy** purchasing chains and claims (`src/data/dummy.ts`), plus **live** case source files (`Live case files` tab). |
| Issues | `/issues` | **Dummy** issues (`INFO` / `WARNING` / `HIGH`, `OPEN → UNDER_REVIEW → RESOLVED \| DISMISSED`), plus **live** run issues (`Live run` tab). |

The backend currently implements the month-end bank-matching workflow only. Purchasing and claims screens run on
session-only dummy data (state in `src/state/store.tsx`, reset on reload) and are labelled "Sample data" in the UI.

## Run

```bash
npm install
npm run build                                  # type-check + production build to dist/
python -m tutupbuku.app --frontend --web-only  # from the repo root; serves dist/ and /api on :8765
npm run dev                                    # Vite on :5173, proxying /api to :8765
```

## Orbit

`src/components/Orbit.tsx` ports the canvas orbit from `orbitanimation.html` (3D-rotated ellipses, perspective
projection, mouse parallax, depth-sorted nodes). Speed follows the run state; it pauses when offscreen or hidden and
renders one still frame under `prefers-reduced-motion`.

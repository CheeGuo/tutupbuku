# UX contract

## Application shell and navigation

The three peer work areas are Upload, Records, and Issues; Business setup is a supporting configuration view. Use same-context tabs with `aria-selected`, keyboard arrow navigation, visible focus, and a hash in the URL so a view survives refresh and Back. The current view updates `document.title`. Desktop uses a left rail; narrow viewports use horizontally scrollable labeled navigation.

## Authentication and tenant scope

Every business data request requires a bearer token. Local development uses the explicitly labeled email-only local sign-in. Production uses Supabase Auth email/password. The service derives the business from the verified user; the browser never submits a business ID. Access tokens are held in tab-scoped `sessionStorage`, never `localStorage`, and are cleared on sign-out or 401; no refresh token is retained by this UI. Production must be served over HTTPS. An expired session returns to sign-in with non-sensitive view state preserved.

An employee can submit claims and see only their own claims and issues; employee access cannot use purchasing upload, issue resolution, or approval. Owners and reviewers can inspect business records, with reviewers able to resolve issues and approve. Only owners can edit company reference data. Production API checks and Supabase row policies both enforce these scopes.

## Upload

The upload form accepts one or more CSV, TSV, TXT, PDF, PNG, JPG, JPEG, or WEBP files up to 15 MiB each. File selection and drag/drop are equivalent; each file shows validation and upload/processing state. Automatic routing is the default; the Master Agent chooses purchasing or claims from document evidence. Operators can also select a workflow manually. Employee purpose is labeled, and an automatically routed claim without a purpose is flagged. Upload retry carries an idempotency key. Agent progress uses named stages and factual text, never a fabricated percentage. OCR and AI configuration failures leave a visible saved-file state with a recovery action.

## Records and review

Records use a semantic horizontally scrollable table. Corrections require a supported field, value, and reason, create an immutable audit event, increment input version, and offer an explicit recheck. Recheck does not resolve old issues by itself; matching issues are reopened if the new pass still finds them. Approval is available only after an analysis exists and every issue for that document is resolved by a human. Rejected or pending work remains visible with its status.

## Issues

Issues are listed with severity text, status, affected document, expected/observed values, evidence references, and a human resolution reason. AI output cannot resolve an issue. Empty state says there are no flagged issues only after records have loaded successfully; loading, failed, and empty states are distinct.

## Business setup

The signed-in business configures its chart of accounts, approved suppliers, and buyer profile. AI may recommend only active account codes from this list. If chart or party master data is missing, the relevant checks stay unverified and request setup or reviewer input.

## Feedback and recovery

Use inline messages for field errors, a persistent page banner for configuration/service conditions, and a polite status live region for completed actions. Keep forms busy without changing control geometry; preserve non-sensitive input on API errors. A 401 clears the expired access token and returns to sign-in. Retry is explicit, uploads are idempotent, and the interface does not expose raw provider or database error text.

## Forms and controls

All forms use `novalidate` and application-owned validation. Every field has a persistent label, associated help/error text, and visible invalid state. Native select controls are intentional for choosing workflow, filters, and correction fields; platform popup geometry is accepted. Long textareas use adequate fixed height and `resize: none`. HTML `<dialog>` is used only for reviewer corrections; Escape closes it and focus returns to its opener.

## Responsive, accessibility, and locale

Target WCAG 2.2 AA: semantic landmarks, keyboard-equivalent actions, visible focus, status text beyond color, reduced-motion support, and 200% zoom/reflow. Real comparison tables may scroll horizontally. Product display locale is en-MY; amounts use MYR/RM with two decimals, and date-only values display without timezone shifts. Timestamps include the configured timezone label when presented.

## Export and document title

Records and issues can be exported as CSV. Each work area sets a title in `{Page} — TutupBuku` form. CSV output neutralizes formula-leading values and contains only the authenticated business's records.

## Separate AWS connection demo

The standalone demo server serves `agent-test.html` at its root. HTTP Basic operator authentication protects its entire page and API; this demo does not request business records or reuse the accounting application's email-only local sign-in. Its backend retains the separate private CodeBuddy gateway password. The browser calls only same-origin demo routes.

The main button requests one fixed response. Setup checks and page reloads never submit model requests. Show queued, running, completed, failed, and unknown states as text; only a confirmed final reply is a successful test. Disable new submissions while a request is active or uncertain. Recovery checks the existing job or explicitly reuses the original request key after checking for a server restart. Lost in-memory state is explained without automatic resubmission. Display returned text using text nodes, with a live status region and accessible keyboard controls. This page tests the connection only; accounting tools and parallel agent workflows need separate integration.

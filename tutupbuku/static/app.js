"use strict";

const CASE_ID = new URLSearchParams(window.location.search).get("case_id") || "Sept2026";
const ROOT_INPUTS = new Map([
  ["profile.md", "profile.md"],
  ["bank.csv", "bank.csv"],
  ["bank_metadata.json", "bank_metadata.json"],
  ["sales.csv", "sales.csv"],
]);
const EXPORTS = [
  ["01_proposals.csv", "Transaction match proposals", "Bank rows, conservative match states and source references.", "CSV"],
  ["02_exceptions.md", "Open questions and exceptions", "Items that need a person to check or explain.", "MD"],
  ["03_records_summary.md", "Summary of supplied records", "Counts and balances from the records supplied for this period.", "MD"],
  ["04_decisions_log.csv", "Operator decisions log", "Answers saved by the person reviewing this case.", "CSV"],
  ["05_manifest.csv", "Input and evidence manifest", "Input file hashes and processing labels for this build.", "CSV"],
];

let caseData = null;
let matching = null;
let reviewItems = [];
let packStatus = { status: "not built", files: [] };
let busy = false;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function formatDate(value) {
  if (!value) return "—";
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return value;
  return new Intl.DateTimeFormat("en-MY", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" })
    .format(new Date(Date.UTC(year, month - 1, day)));
}

function money(row) {
  const amount = row.amount_myr || "0.00";
  return `${row.amount_sen >= 0 ? "+" : "−"}RM ${amount}`;
}

function sourceURL(path) {
  const safePath = String(path || "").split("#", 1)[0];
  return `/api/source/${encodeURIComponent(safePath)}?case_id=${encodeURIComponent(CASE_ID)}`;
}

function showNotice(message, kind = "info") {
  const notice = $("#notice");
  notice.textContent = message;
  notice.dataset.kind = kind;
  notice.hidden = false;
}

function clearNotice() {
  const notice = $("#notice");
  notice.textContent = "";
  notice.hidden = true;
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) },
    cache: "no-store",
  });
  const type = response.headers.get("content-type") || "";
  const result = type.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) throw new Error(result?.error || `The local server returned ${response.status}.`);
  return result;
}

function requestPath(path) {
  return `${path}${path.includes("?") ? "&" : "?"}case_id=${encodeURIComponent(CASE_ID)}`;
}

function setBusy(button, isBusy, busyText = "Working…") {
  if (!button) return () => {};
  const oldText = button.innerHTML;
  button.disabled = isBusy;
  button.setAttribute("aria-busy", String(isBusy));
  if (isBusy) button.textContent = busyText;
  return () => {
    button.innerHTML = oldText;
    button.disabled = false;
    button.removeAttribute("aria-busy");
  };
}

function switchView(name) {
  const target = $(`#view-${name}`);
  if (!target) return;
  $$(".view").forEach((view) => {
    const isCurrent = view === target;
    view.hidden = !isCurrent;
    view.classList.toggle("is-visible", isCurrent);
  });
  $$(".nav-step").forEach((button) => {
    const isCurrent = button.dataset.view === name;
    button.classList.toggle("is-current", isCurrent);
    if (isCurrent) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  $("#main-content").focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
}

function renderCase(data) {
  caseData = data;
  const start = formatDate(data.period_start);
  const end = formatDate(data.period_end);
  const period = data.period_start ? new Intl.DateTimeFormat("en-MY", { month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(`${data.period_start}T00:00:00Z`)) : "Review period";
  $("#period-label").textContent = period;
  $("#period-heading").textContent = period;
  $("#business-name").textContent = data.business_name || data.case_id;
  $("#business-label").textContent = data.business_name || data.case_id;
  $("#period-dates").textContent = `${start} – ${end}`;
  $("#input-count").textContent = String((data.files || []).length);
  $("#extraction-notice").textContent = data.cached_extraction_notice || "Receipt fields are tied to the image hash.";
  renderInputFiles(data.files || []);
  renderReceipts(data.files || [], data.receipt_fields || {});
}

function renderInputFiles(files) {
  const container = $("#input-rows");
  if (!files.length) {
    container.innerHTML = '<tr><td colspan="5" class="loading-cell">No input files supplied yet.</td></tr>';
    return;
  }
  container.innerHTML = files.map((file) => {
    const name = file.path.split("/").pop();
    const ext = (name.split(".").pop() || "FILE").slice(0, 4).toUpperCase();
    const cached = file.processing === "cached extraction";
    const processingClass = cached ? "cached" : file.supported ? "" : "unsupported";
    const fileLabel = file.supported ? file.status : "Unsupported file";
    return `<tr>
      <td><a class="file-name source-link" href="${sourceURL(file.path)}" target="_blank" rel="noreferrer"><span class="file-icon" aria-hidden="true">${escapeHTML(ext)}</span>${escapeHTML(file.path)}</a></td>
      <td class="type-label">${escapeHTML(file.supported ? (file.path.startsWith("receipts/") ? "Receipt image" : "Case record") : "Other")}</td>
      <td><span class="process-label ${processingClass}">${escapeHTML(cached ? "cached synthetic extraction" : file.processing || fileLabel)}</span></td>
      <td class="hash-cell" title="${escapeHTML(file.sha256)}">${escapeHTML((file.sha256 || "").slice(0, 18))}…</td>
      <td class="size-cell">${Number(file.size_bytes || 0).toLocaleString("en-MY")} B</td>
    </tr>`;
  }).join("");
}

function renderReceipts(files, fields) {
  const receipts = files.filter((file) => file.path.startsWith("receipts/") && /\.(png|jpe?g)$/i.test(file.path));
  const grid = $("#receipt-grid");
  if (!receipts.length) {
    grid.innerHTML = '<p class="muted">No receipt images supplied in this case.</p>';
    return;
  }
  grid.innerHTML = receipts.map((file) => {
    const receiptId = file.path.split("/").pop().replace(/\.[^.]+$/, "");
    const field = fields[receiptId];
    const evidence = field
      ? `<div class="receipt-facts"><span>Date <strong>${escapeHTML(formatDate(field.document_date))}</strong></span><span>Total <strong>RM ${escapeHTML(field.total_myr)}</strong></span><span class="receipt-supplier">Supplier <strong>${escapeHTML(field.supplier)}</strong></span><span>No. <strong>${escapeHTML(field.receipt_number || "Not recorded")}</strong></span></div><span class="cached-chip">${field.cached ? "Cached synthetic extraction · verify image" : "Saved fields · verify image"}</span>`
      : '<p class="muted receipt-missing">No extraction fields saved. WorkBuddy can read this image and save verified fields.</p>';
    return `<article class="receipt-card">
      <a href="${sourceURL(file.path)}" target="_blank" rel="noreferrer" aria-label="Open receipt image ${escapeHTML(receiptId)}"><img class="receipt-thumb" src="${sourceURL(file.path)}" alt="Synthetic receipt ${escapeHTML(receiptId)}"></a>
      <div class="receipt-meta"><div class="receipt-title-row"><strong>${escapeHTML(receiptId)}</strong><a href="${sourceURL(file.path)}" target="_blank" rel="noreferrer">View image ↗</a></div>${evidence}</div>
    </article>`;
  }).join("");
}

function renderMatching(result, items = null) {
  matching = result;
  if (items) reviewItems = items;
  else reviewItems = (result.bank_rows || []).filter((row) => ["review_required", "unsupported"].includes(row.state));
  const rows = result.bank_rows || [];
  const open = rows.filter((row) => ["review_required", "unsupported"].includes(row.state)).length;
  const confirmed = rows.filter((row) => row.state === "confirmed_by_operator").length;
  const proposed = rows.filter((row) => row.state === "proposed_match").length;
  $("#review-count").textContent = String(open);
  $("#review-summary").innerHTML = `<span class="summary-indicator" aria-hidden="true">${open ? "!" : "✓"}</span><span><strong>${rows.length} bank rows</strong> · ${proposed} proposed · ${confirmed} confirmed by operator · ${open} still need review. Proposals are not confirmations.</span>`;
  renderReviewItems(reviewItems);
  renderBankRows(rows);
}

function renderCandidate(candidate, rowId) {
  const inputId = `choice-${rowId}-${candidate.id}`;
  const source = candidate.source_path || "";
  const sourceName = source.split("#", 1)[0];
  const sourceLabel = source.includes("#") ? `${sourceName} · ${source.split("#")[1]}` : source;
  return `<div class="candidate-option">
    <input id="${escapeHTML(inputId)}" type="radio" name="choice-${escapeHTML(rowId)}" value="${escapeHTML(candidate.id)}">
    <label class="candidate-main" for="${escapeHTML(inputId)}"><strong>${escapeHTML(candidate.id)} · ${escapeHTML(candidate.name)}</strong><small>${escapeHTML(candidate.kind)} · document date ${escapeHTML(formatDate(candidate.date))}</small></label>
    <span class="candidate-amount">RM ${escapeHTML(candidate.amount_myr)}</span>
    <a class="candidate-source" href="${sourceURL(source)}" target="_blank" rel="noreferrer">Source: ${escapeHTML(sourceLabel)} ↗</a>
  </div>`;
}

function renderReviewItems(items) {
  const list = $("#review-list");
  if (!items.length) {
    list.innerHTML = '<p class="empty-state">No unresolved bank rows. Check the status table below; proposals remain subject to accountant review.</p>';
    return;
  }
  list.innerHTML = items.map((row) => {
    const candidates = row.candidates || [];
    const unsupported = row.unsupported_candidates || [];
    const options = candidates.map((candidate) => renderCandidate(candidate, row.row_id)).join("");
    const noOptionId = `choice-${row.row_id}-neither`;
    const noOption = `<label class="candidate-option no-candidate" for="${escapeHTML(noOptionId)}"><input id="${escapeHTML(noOptionId)}" type="radio" name="choice-${escapeHTML(row.row_id)}" value="__neither__"><span class="candidate-main"><strong>Neither / no supported match</strong><small>Leave this bank row unclassified for the reviewer.</small></span></label>`;
    const nearby = unsupported.length ? `<div class="unsupported-note"><p><strong>Nearby amount records · not safe to allocate</strong></p>${unsupported.map((candidate) => `<p>${escapeHTML(candidate.id)} · ${escapeHTML(candidate.name)} · RM ${escapeHTML(candidate.amount_myr)} · ${escapeHTML(formatDate(candidate.date))}</p>`).join("")}</div>` : "";
    return `<article class="review-card" aria-labelledby="review-row-${escapeHTML(row.row_id)}">
      <header class="review-card-head"><div class="review-card-title"><span class="row-token">ROW ${escapeHTML(row.row_id)}</span><div><h3 id="review-row-${escapeHTML(row.row_id)}">${escapeHTML(row.reason_code.replaceAll("_", " "))}</h3><p>${escapeHTML(row.reason)}</p></div></div><span class="review-badge">${escapeHTML(row.state.replaceAll("_", " "))}</span></header>
      <div class="review-card-body">
        <div class="bank-evidence"><p class="evidence-label">Bank statement evidence</p><p class="bank-description">${escapeHTML(row.description)}</p><div class="bank-details"><div class="bank-detail"><span>Transaction date</span><strong>${escapeHTML(formatDate(row.date))}</strong></div><div class="bank-detail"><span>Amount</span><strong>${escapeHTML(money(row))}</strong></div></div></div>
        <div class="candidate-area"><p>${candidates.length ? `${candidates.length} exact candidate${candidates.length === 1 ? "" : "s"} in the date window` : "No supported exact candidate"}</p><fieldset class="candidate-options"><legend class="visually-hidden">Choose a candidate for bank row ${escapeHTML(row.row_id)}</legend>${options}${noOption}</fieldset>${nearby}</div>
      </div>
      <form class="review-form" data-row-id="${escapeHTML(row.row_id)}" novalidate>
        <label for="answer-${escapeHTML(row.row_id)}">What evidence supports your choice?</label>
        <textarea id="answer-${escapeHTML(row.row_id)}" name="answer" maxlength="1000" aria-describedby="answer-help-${escapeHTML(row.row_id)}" required></textarea>
        <div class="review-form-footer"><p class="form-hint" id="answer-help-${escapeHTML(row.row_id)}">Record the operator’s words or source checked; the agent must not guess.</p><button class="button button-primary save-decision" type="submit">Save decision <span aria-hidden="true">→</span></button></div>
        <p class="review-form-error" role="status" aria-live="polite"></p>
      </form>
    </article>`;
  }).join("");
}

function renderBankRows(rows) {
  const body = $("#bank-rows");
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="5" class="loading-cell">No bank rows available.</td></tr>';
    return;
  }
  body.innerHTML = rows.map((row) => `<tr class="${["review_required", "unsupported"].includes(row.state) ? "row-review" : ""}">
    <td>${escapeHTML(row.row_id)}</td><td>${escapeHTML(formatDate(row.date))}</td><td>${escapeHTML(row.description)}</td><td>${escapeHTML(money(row))}</td>
    <td><span class="state-pill state-${escapeHTML(row.state)}">${escapeHTML(row.state.replaceAll("_", " "))}</span></td></tr>`).join("");
}

function renderPack(status) {
  packStatus = status;
  const built = status.status === "Review pack exported" && status.files.length === 5;
  $("#pack-mark").textContent = built ? "✓" : "○";
  $("#pack-state-title").textContent = built ? "Five files ready for review" : "Not built yet";
  $("#pack-state-copy").textContent = built
    ? `${status.decision_count} saved decision${status.decision_count === 1 ? "" : "s"} · ${status.open_item_count} open exception${status.open_item_count === 1 ? "" : "s"}. This remains a review pack, not a completed accounting close.`
    : "Run validation and resolve any questions you can before building. Unanswered rows remain clearly marked for review.";
  $("#export-list").innerHTML = EXPORTS.map(([filename, title, description, type]) => {
    const ready = built && status.files.includes(filename);
    const href = `/api/exports/${encodeURIComponent(filename)}?case_id=${encodeURIComponent(CASE_ID)}`;
    return `<article class="export-row"><span class="export-icon" aria-hidden="true">${type}</span><div class="export-info"><strong>${escapeHTML(filename)}</strong><span>${escapeHTML(title)} · ${escapeHTML(description)}</span></div>${ready ? `<a class="export-action is-ready" href="${href}" download>Download <span aria-hidden="true">↓</span></a>` : '<span class="export-action">Not built</span>'}</article>`;
  }).join("");
}

async function refreshCase() {
  const data = await request(requestPath("/api/case"));
  renderCase(data);
  return data;
}

async function runChecks(button = null, quiet = false) {
  const restore = setBusy(button, true, "Checking records…");
  try {
    const result = await request("/api/run", { method: "POST", body: JSON.stringify({ case_id: CASE_ID }) });
    renderMatching(result);
    await refreshCase();
    await refreshPackStatus();
    if (!quiet) showNotice("Validation complete. Review each unresolved row with its source evidence.", "info");
    return result;
  } catch (error) {
    matching = null;
    reviewItems = [];
    $("#review-summary").textContent = `Validation stopped: ${error.message}`;
    $("#review-list").innerHTML = `<p class="empty-state">${escapeHTML(error.message)} Check the input files, then run validation again.</p>`;
    $("#bank-rows").innerHTML = '<tr><td colspan="5" class="loading-cell">Rows are unavailable until validation passes.</td></tr>';
    if (!quiet) showNotice(`Validation stopped: ${error.message}`, "error");
    return null;
  } finally {
    restore();
  }
}

async function refreshPackStatus() {
  try {
    renderPack(await request(requestPath("/api/review-pack")));
  } catch (error) {
    renderPack({ status: "not built", files: [] });
    showNotice(`Could not read review pack status: ${error.message}`, "error");
  }
}

async function saveDecision(form) {
  const rowId = form.dataset.rowId;
  const answer = $("textarea[name=answer]", form).value.trim();
  const errorRegion = $(".review-form-error", form);
  const selected = $("input[type=radio]:checked", form);
  if (!selected) {
    errorRegion.textContent = "Choose one displayed candidate or “Neither / no supported match”.";
    return;
  }
  if (!answer) {
    const textarea = $("textarea[name=answer]", form);
    textarea.setAttribute("aria-invalid", "true");
    textarea.focus();
    errorRegion.textContent = "Enter the evidence or operator's answer before saving.";
    return;
  }
  const button = $("button[type=submit]", form);
  const restore = setBusy(button, true, "Saving…");
  errorRegion.textContent = "";
  $("textarea[name=answer]", form).removeAttribute("aria-invalid");
  try {
    const candidateId = selected.value === "__neither__" ? null : selected.value;
    await request("/api/decisions", {
      method: "POST",
      body: JSON.stringify({ case_id: CASE_ID, bank_row_id: rowId, candidate_id: candidateId, answer }),
    });
    await refreshCase();
    await runChecks(null, true);
    await refreshPackStatus();
    showNotice(`Decision for bank row ${rowId} saved. The review pack will use this saved answer when rebuilt.`, "info");
  } catch (error) {
    errorRegion.textContent = `Decision was not saved: ${error.message}`;
  } finally {
    restore();
  }
}

function base64FromBuffer(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, Math.min(index + chunkSize, bytes.length)));
  }
  return btoa(binary);
}

function uploadPathFor(file) {
  const lowered = file.name.toLowerCase();
  if (ROOT_INPUTS.has(lowered)) return ROOT_INPUTS.get(lowered);
  if (!/^[A-Za-z0-9_-]{1,64}\.(png|jpe?g)$/i.test(file.name)) {
    throw new Error("Use one of the four named case files, or a PNG/JPEG receipt with a simple filename.");
  }
  return `receipts/${file.name}`;
}

async function uploadFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  busy = true;
  const picker = $("#file-input");
  picker.disabled = true;
  try {
    for (const file of files) {
      if (!file.size || file.size > 5 * 1024 * 1024) throw new Error(`${file.name} must be between 1 byte and 5 MB.`);
      const path = uploadPathFor(file);
      const fileBase64 = base64FromBuffer(await file.arrayBuffer());
      await request("/api/uploads", { method: "POST", body: JSON.stringify({ case_id: CASE_ID, path, file_base64: fileBase64 }) });
    }
    await refreshCase();
    matching = null;
    reviewItems = [];
    $("#review-count").textContent = "—";
    renderPack({ status: "not built", files: [] });
    showNotice("Input saved locally. Previous review results are now stale; validate the case again before building exports.", "warning");
  } catch (error) {
    showNotice(`Input was not accepted: ${error.message}`, "error");
  } finally {
    picker.disabled = false;
    picker.value = "";
    busy = false;
  }
}

async function buildReviewPack(button) {
  const restore = setBusy(button, true, "Building files…");
  try {
    const result = await request("/api/build-review-pack", { method: "POST", body: JSON.stringify({ case_id: CASE_ID }) });
    renderPack(result);
    showNotice("Review pack exported. Download the five files below and have a qualified reviewer check the records.", "info");
  } catch (error) {
    renderPack({ status: "not built", files: [] });
    showNotice(`Review pack was not built: ${error.message}`, "error");
  } finally {
    restore();
  }
}

$(".step-nav").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-view]");
  if (button) switchView(button.dataset.view);
});
$("#run-button").addEventListener("click", (event) => runChecks(event.currentTarget));
$("#rerun-button").addEventListener("click", (event) => runChecks(event.currentTarget));
$("#build-button").addEventListener("click", (event) => buildReviewPack(event.currentTarget));
$("#file-input").addEventListener("change", (event) => uploadFiles(event.currentTarget.files));
$("#review-list").addEventListener("submit", (event) => {
  const form = event.target.closest("form[data-row-id]");
  if (!form) return;
  event.preventDefault();
  saveDecision(form);
});
$("#review-list").addEventListener("input", (event) => {
  if (event.target.matches("textarea[aria-invalid=true]")) {
    event.target.removeAttribute("aria-invalid");
    $(".review-form-error", event.target.closest("form")).textContent = "";
  }
});
$("#review-list").addEventListener("click", (event) => {
  if (event.target.closest("a.candidate-source")) event.stopPropagation();
});

async function start() {
  try {
    await refreshCase();
    await refreshPackStatus();
    await runChecks(null, true);
  } catch (error) {
    showNotice(`Could not open the local case: ${error.message}`, "error");
    $("#input-rows").innerHTML = `<tr><td colspan="5" class="loading-cell">${escapeHTML(error.message)}</td></tr>`;
  }
}

start();

(() => {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const authView = $('#authView');
  const appView = $('#appView');
  const config = { authMode: 'local-development', aiConfigured: false, maxUploadBytes: 15 * 1024 * 1024 };
  const state = { documents: [], issues: [], jobs: [], masterData: { chartOfAccounts: [], suppliers: [], buyerProfile: null }, selectedFiles: [], refreshVersion: 0, authMode: 'signin', correctionDocument: null, role: 'owner' };
  const tokenKey = 'tutupbuku.access-token';
  const emailKey = 'tutupbuku.signed-in-email';
  let accessToken = sessionStorage.getItem(tokenKey) || '';
  let toastTimer;

  async function fetchConfig() {
    try {
      const response = await fetch('/api/config', { cache: 'no-store' });
      if (!response.ok) throw new Error('Service configuration is unavailable.');
      Object.assign(config, await response.json());
      setConnection();
    } catch {
      $('#connectionLabel').textContent = 'Service unavailable';
      showNotice('The service could not be reached. Refresh the page or check the server.', 'error');
    }
  }

  function setConnection() {
    const label = $('#connectionLabel');
    const dot = $('.connection-dot');
    if (config.aiConfigured) {
      label.textContent = 'AI endpoint configured';
      dot.className = 'connection-dot good';
      $('#globalNotice').hidden = true;
    } else {
      label.textContent = 'AI setup needed';
      dot.className = 'connection-dot warn';
      showNotice('AI processing is not configured. Files can be saved, but agent extraction and review will wait until an AI endpoint is added.', 'warning');
    }
    $('#authModeNote').textContent = config.authMode === 'local-development'
      ? 'Local development sign-in: enter an email. The password field is not used here.'
      : config.authMode === 'unconfigured' ? 'Production sign-in is waiting for service setup.' : 'Sign in with your business account.';
    $('#authSetupNotice').hidden = config.authMode !== 'unconfigured';
    $('#authSubmit').disabled = config.authMode === 'unconfigured';
    $('#authModeToggle').hidden = config.authMode !== 'supabase';
  }

  function showNotice(message, tone = 'warning') {
    const notice = $('#globalNotice');
    notice.textContent = message;
    notice.className = `notice${tone === 'error' ? ' error' : ''}`;
    notice.hidden = false;
  }

  function clearNotice() { $('#globalNotice').hidden = true; }

  function applyRole(role) {
    state.role = ['owner', 'reviewer', 'employee'].includes(role) ? role : 'owner';
    $('#roleLabel').textContent = state.role[0].toUpperCase() + state.role.slice(1);
    $('#tab-setup').hidden = state.role !== 'owner';
    const workflow = $('#workflow');
    workflow.disabled = state.role === 'employee';
    if (state.role === 'employee') workflow.value = 'claim';
    workflow.dispatchEvent(new Event('change'));
    if (state.role !== 'owner' && location.hash === '#setup') setView('upload');
  }

  function showToast(message, tone = 'success') {
    const toast = $('#toast');
    toast.textContent = message;
    toast.className = `toast${tone === 'error' ? ' error' : ''}`;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, 4200);
  }

  function apiHeaders(extra = {}) {
    return { ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}), ...extra };
  }

  async function api(path, options = {}) {
    const response = await fetch(path, { ...options, headers: apiHeaders(options.headers || {}) });
    if (response.status === 401) {
      expireSession();
      throw new Error('Your sign-in expired. Sign in again to continue.');
    }
    if (!response.ok) {
      let message = `Request could not be completed (${response.status}).`;
      try { message = (await response.json()).error || message; } catch {}
      throw new Error(message);
    }
    return response;
  }

  async function jsonApi(path, options = {}) {
    const response = await api(path, {
      ...options,
      headers: { 'content-type': 'application/json', ...(options.headers || {}) },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    return response.json();
  }

  function expireSession() {
    accessToken = '';
    sessionStorage.removeItem(tokenKey);
    sessionStorage.removeItem(emailKey);
    appView.hidden = true;
    authView.hidden = false;
    $('#authError').textContent = 'Your sign-in expired. Please sign in again.';
    $('#authError').hidden = false;
  }

  function setAuthMode(mode) {
    state.authMode = mode;
    const signingUp = mode === 'signup';
    $('#authTitle').textContent = signingUp ? 'Create your business account' : 'Sign in to your desk';
    $('#authSubmit').textContent = signingUp ? 'Create account' : 'Sign in';
    $('#authModeToggle').textContent = signingUp ? 'Back to sign in' : 'Create an account';
    $('#authPassword').autocomplete = signingUp ? 'new-password' : 'current-password';
    $('#authPasswordHelp').textContent = config.authMode === 'local-development'
      ? 'Local development sign-in does not use a password.'
      : signingUp ? 'Choose at least 8 characters for your business account.' : 'Enter your business account password.';
    $('#authError').hidden = true;
  }

  async function authSubmit(event) {
    event.preventDefault();
    const email = $('#authEmail').value.trim();
    const password = $('#authPassword').value;
    const emailError = $('#authEmailError');
    const passwordError = $('#authPasswordError');
    emailError.hidden = true;
    passwordError.hidden = true;
    $('#authError').hidden = true;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
      emailError.textContent = 'Enter a valid email address.';
      emailError.hidden = false;
      $('#authEmail').setAttribute('aria-invalid', 'true');
      $('#authEmail').focus();
      return;
    }
    if (config.authMode === 'supabase' && password.length < 8) {
      passwordError.textContent = 'Enter a password with at least 8 characters.';
      passwordError.hidden = false;
      $('#authPassword').setAttribute('aria-invalid', 'true');
      $('#authPassword').focus();
      return;
    }
    $('#authEmail').removeAttribute('aria-invalid');
    $('#authPassword').removeAttribute('aria-invalid');
    const button = $('#authSubmit');
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    const original = state.authMode === 'signup' ? 'Create account' : 'Sign in';
    button.textContent = state.authMode === 'signup' ? 'Creating account…' : 'Signing in…';
    try {
      if (config.authMode === 'local-development') {
        const result = await jsonApi('/api/auth/local', { method: 'POST', body: { email } });
        startSession(result.accessToken, email);
      } else {
        const signup = state.authMode === 'signup';
        const endpoint = signup ? '/auth/v1/signup' : '/auth/v1/token?grant_type=password';
        const response = await fetch(`${config.supabaseUrl.replace(/\/$/u, '')}${endpoint}`, {
          method: 'POST',
          headers: { apikey: config.supabaseAnonKey, 'content-type': 'application/json' },
          body: JSON.stringify({ email, password }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(signup ? 'Account could not be created. Check the email and password requirements.' : 'Email or password was not accepted.');
        if (!result.access_token) {
          $('#authError').textContent = 'Account created. Check your email to confirm it, then sign in.';
          $('#authError').hidden = false;
          return;
        }
        startSession(result.access_token, email);
      }
    } catch (error) {
      $('#authError').textContent = error.message || 'Sign-in could not be completed. Try again.';
      $('#authError').hidden = false;
    } finally {
      button.disabled = false;
      button.removeAttribute('aria-busy');
      button.textContent = original;
    }
  }

  function startSession(token, email) {
    accessToken = token;
    sessionStorage.setItem(tokenKey, token);
    sessionStorage.setItem(emailKey, email);
    authView.hidden = true;
    appView.hidden = false;
    $('#signedInEmail').textContent = email;
    setView(location.hash.slice(1) || 'upload', false);
    loadWorkspace().catch((error) => showToast(error.message, 'error'));
  }

  function setView(name, updateUrl = true) {
    const valid = ['upload', 'records', 'issues', 'setup'];
    const view = valid.includes(name) ? name : 'upload';
    $$('[role="tab"]').forEach((tab) => {
      const selected = tab.dataset.view === view;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    });
    $$('.view-panel').forEach((panel) => { panel.hidden = panel.id !== `panel-${view}`; });
    const titles = { upload: ['Upload documents', 'INTAKE WORKSPACE'], records: ['Records', 'BUSINESS RECORDS'], issues: ['Issues', 'HUMAN REVIEW QUEUE'], setup: ['Business setup', 'BUSINESS REFERENCE DATA'] };
    $('#pageTitle').textContent = titles[view][0];
    $('#pageEyebrow').textContent = titles[view][1];
    document.title = `${titles[view][0]} — TutupBuku`;
    if (updateUrl && location.hash !== `#${view}`) history.pushState({ view }, '', `#${view}`);
  }

  function tabKeydown(event) {
    const tabs = $$('[role="tab"]');
    const active = tabs.indexOf(event.currentTarget);
    const horizontal = matchMedia('(max-width: 720px)').matches;
    const nextKey = horizontal ? 'ArrowRight' : 'ArrowDown';
    const prevKey = horizontal ? 'ArrowLeft' : 'ArrowUp';
    if (event.key !== nextKey && event.key !== prevKey && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (active + (event.key === nextKey ? 1 : -1) + tabs.length) % tabs.length;
    tabs[index].focus();
    tabs[index].click();
  }

  async function loadWorkspace() {
    if (!accessToken) return;
    const version = ++state.refreshVersion;
    const [documentsResponse, issuesResponse, jobsResponse, masterResponse, sessionResponse] = await Promise.all([
      api('/api/documents'), api('/api/issues'), api('/api/jobs'), api('/api/master-data'), api('/api/session'),
    ]);
    const [documents, issues, jobs, masterData, session] = await Promise.all([documentsResponse.json(), issuesResponse.json(), jobsResponse.json(), masterResponse.json(), sessionResponse.json()]);
    if (version !== state.refreshVersion) return;
    applyRole(session.role);
    state.documents = documents;
    state.issues = issues;
    state.jobs = jobs;
    state.masterData = masterData;
    $('#recordTotal').textContent = String(documents.length);
    renderRecords();
    renderIssues();
    renderJobs(jobs);
    populateMasterData(masterData);
    setConnection();
    jobs.filter((job) => ['queued', 'processing'].includes(job.status)).forEach((job) => watchJob(job.id));
  }

  async function loadRecordsAndIssues() {
    try {
      const [documentsResponse, issuesResponse] = await Promise.all([api('/api/documents'), api('/api/issues')]);
      state.documents = await documentsResponse.json();
      state.issues = await issuesResponse.json();
      $('#recordTotal').textContent = String(state.documents.length);
      renderRecords();
      renderIssues();
    } catch (error) { showToast(error.message, 'error'); }
  }

  function setFieldError(field, target, message) {
    const input = $(field);
    const error = $(target);
    error.textContent = message;
    error.hidden = !message;
    if (message) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  }

  function isSupportedFile(file) {
    return /\.(csv|tsv|txt|pdf|png|jpe?g|webp)$/iu.test(file.name);
  }

  function addFiles(fileList) {
    const error = $('#fileError');
    error.hidden = true;
    const incoming = [...fileList];
    const rejected = incoming.find((file) => !isSupportedFile(file) || !file.size || file.size > config.maxUploadBytes);
    if (rejected) {
      error.textContent = !isSupportedFile(rejected) ? `${rejected.name}: file type is not supported.` : !rejected.size ? `${rejected.name}: file is empty.` : `${rejected.name}: file exceeds 15 MB.`;
      error.hidden = false;
      $('#fileInput').setAttribute('aria-invalid', 'true');
    } else {
      $('#fileInput').removeAttribute('aria-invalid');
      for (const file of incoming) {
        if (state.selectedFiles.length >= 20) break;
        if (!state.selectedFiles.some((item) => item.file.name === file.name && item.file.size === file.size && item.file.lastModified === file.lastModified)) state.selectedFiles.push({ file, status: 'Ready to upload' });
      }
      if (state.selectedFiles.length >= 20 && incoming.length > state.selectedFiles.length) {
        error.textContent = 'Select up to 20 files at a time.';
        error.hidden = false;
      }
    }
    renderSelectedFiles();
    $('#fileInput').value = '';
  }

  function renderSelectedFiles() {
    const list = $('#selectedFiles');
    list.replaceChildren();
    state.selectedFiles.forEach((item, index) => {
      const row = document.createElement('li');
      row.className = 'file-row';
      const main = document.createElement('span'); main.className = 'file-main';
      const name = document.createElement('strong'); name.className = 'file-name'; name.textContent = item.file.name;
      const meta = document.createElement('span'); meta.className = 'file-meta'; meta.textContent = `${(item.file.size / 1024).toFixed(0)} KB`;
      main.append(name, meta);
      const status = document.createElement('span'); status.className = 'file-status'; status.textContent = item.status;
      row.append(main, status);
      if (!item.busy && item.status !== 'Saved') {
        const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'remove-file'; remove.textContent = '×'; remove.setAttribute('aria-label', `Remove ${item.file.name}`);
        remove.addEventListener('click', () => { state.selectedFiles.splice(index, 1); renderSelectedFiles(); });
        row.append(remove);
      }
      list.append(row);
    });
  }

  async function uploadSelected(event) {
    event.preventDefault();
    const workflow = $('#workflow').value;
    const purpose = $('#claimPurpose').value.trim();
    setFieldError('#claimPurpose', '#purposeError', workflow === 'claim' && !purpose ? 'Add the employee’s stated business purpose.' : '');
    setFieldError('#workflow', '#workflowError', ['auto', 'purchasing', 'claim'].includes(workflow) ? '' : 'Choose a workflow.');
    if (!state.selectedFiles.length) {
      $('#fileError').textContent = 'Choose at least one file to upload.';
      $('#fileError').hidden = false;
      $('#fileInput').focus();
      return;
    }
    if (workflow === 'claim' && !purpose) { $('#claimPurpose').focus(); return; }
    const button = $('#uploadButton');
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    let saved = 0;
    try {
      for (const item of state.selectedFiles) {
        if (item.status === 'Saved') continue;
        item.busy = true;
        item.status = 'Uploading…';
        renderSelectedFiles();
        const response = await api('/api/documents', {
          method: 'POST',
          headers: {
            'content-type': item.file.type || 'application/octet-stream',
            'x-filename': encodeURIComponent(item.file.name),
            'x-workflow': workflow,
            'x-claim-purpose': encodeURIComponent(['auto', 'claim'].includes(workflow) ? purpose : ''),
            'idempotency-key': crypto.randomUUID(),
          },
          body: item.file,
        });
        const result = await response.json();
        item.status = 'Saved · checks queued';
        item.busy = false;
        saved += 1;
        state.jobs.unshift({ id: result.job.id, documentId: result.document.id, status: result.job.status, events: [], originalFilename: item.file.name });
        renderJobs(state.jobs);
        watchJob(result.job.id);
      }
      state.selectedFiles = state.selectedFiles.filter((item) => item.status !== 'Saved · checks queued');
      renderSelectedFiles();
      await loadRecordsAndIssues();
      showToast(`${saved} ${saved === 1 ? 'document' : 'documents'} saved. Processing status is shown below.`);
    } catch (error) {
      const active = state.selectedFiles.find((item) => item.busy);
      if (active) { active.busy = false; active.status = 'Upload failed · retry available'; }
      renderSelectedFiles();
      showToast(error.message, 'error');
    } finally {
      button.disabled = false;
      button.removeAttribute('aria-busy');
    }
  }

  const terminalStates = new Set(['completed', 'needs_review', 'needs_configuration', 'failed', 'approved']);
  const watched = new Set();
  async function watchJob(jobId) {
    if (!jobId || watched.has(jobId)) return;
    watched.add(jobId);
    try {
      for (let count = 0; count < 240; count += 1) {
        const response = await api(`/api/jobs/${encodeURIComponent(jobId)}`);
        const job = await response.json();
        const index = state.jobs.findIndex((item) => item.id === job.id);
        if (index >= 0) state.jobs[index] = job; else state.jobs.unshift(job);
        renderJobs(state.jobs);
        if (terminalStates.has(job.status)) {
          await loadRecordsAndIssues();
          if (job.status === 'needs_review') showToast('Checks finished with items waiting for a human decision.', 'error');
          else if (job.status === 'needs_configuration') showToast('The file is saved. Set up AI/OCR before running agent checks.', 'error');
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 1600));
      }
      showToast('This document is still processing. Refresh the page to check its saved status.', 'error');
    } catch (error) {
      showToast(error.message, 'error');
    } finally { watched.delete(jobId); }
  }

  function badge(status) {
    const element = document.createElement('span');
    const normalized = status || 'unknown';
    const classes = normalized === 'completed' ? 'success' : normalized === 'approved' || normalized === 'resolved' ? normalized : normalized === 'failed' ? 'failed' : normalized === 'needs_review' ? 'review' : normalized === 'open' ? 'open' : 'pending';
    element.className = `status-badge ${classes}`;
    element.textContent = normalized.replaceAll('_', ' ');
    return element;
  }

  function renderJobs(jobs) {
    const list = $('#jobsList');
    list.replaceChildren();
    if (!jobs.length) { const empty = document.createElement('p'); empty.className = 'empty-inline'; empty.textContent = 'No document checks are running yet. Upload a file to see each processing stage here.'; list.append(empty); return; }
    for (const job of jobs.slice(0, 12)) {
      const card = document.createElement('article'); card.className = 'job-card';
      const top = document.createElement('div'); top.className = 'job-top';
      const info = document.createElement('div');
      const file = document.createElement('h3'); file.className = 'job-file';
      const documentRecord = state.documents.find((doc) => doc.id === job.documentId);
      file.textContent = job.originalFilename || documentRecord?.originalFilename || 'Document processing';
      const id = document.createElement('span'); id.className = 'job-id'; id.textContent = `Job ${job.id}`;
      info.append(file, id); top.append(info, badge(job.status)); card.append(top);
      if (job.error?.message) { const summary = document.createElement('p'); summary.className = 'job-summary'; summary.textContent = job.error.message; card.append(summary); }
      const events = (job.events || []).filter((event) => event.agent && event.agent !== 'workflow');
      if (events.length) {
        const timeline = document.createElement('ol'); timeline.className = 'agent-timeline'; timeline.setAttribute('aria-label', 'Agent progress');
        const latestByAgent = new Map();
        events.forEach((event) => latestByAgent.set(`${event.agent}:${event.perspective || ''}`, event));
        for (const event of latestByAgent.values()) {
          const step = document.createElement('li'); step.className = 'agent-step'; step.dataset.state = event.state || '';
          const text = document.createElement('span'); const name = document.createElement('strong'); name.textContent = `${event.agent.replaceAll('-', ' ')}${event.perspective ? ` · ${event.perspective.replaceAll('-', ' ')}` : ''}`;
          const detail = document.createElement('small'); detail.textContent = event.summary || event.state || 'In progress'; text.append(name, detail); step.append(text); timeline.append(step);
        }
        card.append(timeline);
      } else if (['queued','processing'].includes(job.status)) {
        const summary = document.createElement('p'); summary.className = 'job-summary'; summary.textContent = 'Waiting for the document processor to start.'; card.append(summary);
      }
      list.append(card);
    }
  }

  function amountLabel(sen) {
    if (!Number.isSafeInteger(sen)) return '—';
    return new Intl.NumberFormat('en-MY', { style: 'currency', currency: 'MYR', minimumFractionDigits: 2 }).format(sen / 100);
  }
  function prettyType(type) {
    const names = { purchase_order: 'PO', delivery_order: 'Delivery order', payment_advice: 'Payment advice' };
    return names[type] || (type ? type.replaceAll('_', ' ') : 'Unclassified');
  }
  function displayReference(data = {}) { return data.documentNumber || data.invoiceNumber || data.poNumber || '—'; }

  function renderRecords() {
    const body = $('#recordsBody');
    body.replaceChildren();
    $('#recordsCount').textContent = `${state.documents.length} ${state.documents.length === 1 ? 'record' : 'records'}`;
    if (!state.documents.length) {
      const row = document.createElement('tr'); const cell = document.createElement('td'); cell.colSpan = 8; cell.className = 'table-empty'; cell.textContent = 'No records yet. Upload a purchasing file or employee claim to start a document trail.'; row.append(cell); body.append(row); return;
    }
    for (const documentRecord of state.documents) {
      const data = documentRecord.analysis?.document || {};
      const row = document.createElement('tr');
      const fileCell = document.createElement('td'); const file = document.createElement('div'); file.className = 'table-file'; file.textContent = documentRecord.originalFilename || 'Untitled file'; fileCell.append(file);
      const context = document.createElement('small'); context.className = 'file-meta'; context.textContent = documentRecord.workflow === 'claim' ? data.standardizedDescription || data.purpose || documentRecord.purpose || data.description || '' : data.supplierName || ''; fileCell.append(context); row.append(fileCell);
      const workflowCell = document.createElement('td'); workflowCell.textContent = `${documentRecord.workflow || '—'}${data.type ? ` · ${prettyType(data.type)}` : ''}`; row.append(workflowCell);
      const refCell = document.createElement('td'); refCell.className = 'mono'; refCell.textContent = displayReference(data); row.append(refCell);
      const dateCell = document.createElement('td'); dateCell.textContent = data.documentDate || '—'; row.append(dateCell);
      const amountCell = document.createElement('td'); amountCell.className = 'mono'; amountCell.textContent = amountLabel(data.totalAmountSen); row.append(amountCell);
      const accountCell = document.createElement('td'); accountCell.className = 'mono'; accountCell.textContent = data.accountCode || data.category?.code || '—'; row.append(accountCell);
      const poCell = document.createElement('td'); poCell.className = 'mono';
      const poDoc = state.documents.find((item) => item.id === (data.linkedPoDocumentId || documentRecord.linkedPoDocumentId));
      poCell.textContent = poDoc ? displayReference(poDoc.analysis?.document || {}) : data.linkedPoDocumentId || '—'; row.append(poCell);
      const statusCell = document.createElement('td'); statusCell.append(badge(documentRecord.status)); row.append(statusCell);
      const actionCell = document.createElement('td'); const actions = document.createElement('div'); actions.className = 'table-actions';
      if (documentRecord.analysis) {
        const correct = document.createElement('button'); correct.type = 'button'; correct.className = 'table-action'; correct.textContent = 'Correct'; correct.setAttribute('aria-label', `Correct extracted information for ${documentRecord.originalFilename}`); correct.addEventListener('click', () => openCorrection(documentRecord)); actions.append(correct);
        const recheck = document.createElement('button'); recheck.type = 'button'; recheck.className = 'table-action'; recheck.textContent = 'Recheck'; recheck.setAttribute('aria-label', `Recheck ${documentRecord.originalFilename}`); recheck.addEventListener('click', () => reprocessDocument(documentRecord.id, recheck)); actions.append(recheck);
        const unresolved = state.issues.some((issue) => issue.documentId === documentRecord.id && issue.status !== 'resolved');
        if (state.role !== 'employee' && !unresolved && ['completed','needs_review'].includes(documentRecord.status)) {
          const approve = document.createElement('button'); approve.type = 'button'; approve.className = 'table-action'; approve.textContent = 'Approve'; approve.setAttribute('aria-label', `Approve ${documentRecord.originalFilename}`); approve.addEventListener('click', () => approveDocument(documentRecord.id, approve)); actions.append(approve);
        }
      }
      actionCell.append(actions); row.append(actionCell); body.append(row);
    }
  }

  async function downloadCsv(kind) {
    try {
      const response = await api(`/api/export?kind=${encodeURIComponent(kind)}`);
      const file = await response.blob();
      const url = URL.createObjectURL(file);
      const link = document.createElement('a'); link.href = url; link.download = `tutupbuku-${kind}.csv`; document.body.append(link); link.click(); link.remove(); URL.revokeObjectURL(url);
      showToast(`${kind === 'issues' ? 'Issues' : 'Records'} CSV exported.`);
    } catch (error) { showToast(error.message, 'error'); }
  }

  function displayUnknown(value) {
    if (value === null || value === undefined || value === '') return '—';
    return typeof value === 'string' ? value : JSON.stringify(value);
  }

  function renderIssues() {
    const list = $('#issuesList');
    const filter = $('#issueFilter').value;
    const openCount = state.issues.filter((issue) => issue.status !== 'resolved').length;
    $('#issueCount').textContent = String(openCount);
    $('#issueCount').hidden = openCount === 0;
    $('#issuesCount').textContent = `${openCount} open · ${state.issues.length} total`;
    list.replaceChildren();
    const visible = state.issues.filter((issue) => filter === 'all' || (filter === 'resolved' ? issue.status === 'resolved' : issue.status !== 'resolved'));
    if (!visible.length) {
      const empty = document.createElement('p'); empty.className = 'empty-inline';
      empty.textContent = state.issues.length ? 'No issues match this view.' : 'No flagged issues. Once documents are processed, any missing evidence or mismatch will appear here.';
      list.append(empty); return;
    }
    for (const issue of visible) {
      const card = document.createElement('article'); card.className = 'issue-card'; card.dataset.severity = issue.severity || 'warning'; card.dataset.status = issue.status || 'open';
      const top = document.createElement('div'); top.className = 'issue-top'; const left = document.createElement('div');
      const code = document.createElement('p'); code.className = 'issue-code'; code.textContent = `${issue.code || 'REVIEW REQUIRED'} · ${(issue.severity || 'warning').toUpperCase()}`;
      const title = document.createElement('h2'); title.className = 'issue-title'; title.textContent = issue.message || 'Review required.';
      const doc = document.createElement('span'); doc.className = 'issue-doc'; doc.textContent = `Document ${issue.documentId || 'unknown'}`;
      left.append(code, title, doc); top.append(left, badge(issue.status)); card.append(top);
      const details = document.createElement('div'); details.className = 'issue-details';
      for (const [label, value] of [['Expected', issue.expected], ['Observed', issue.observed]]) {
        if (value === null || value === undefined) continue;
        const item = document.createElement('div'); item.className = 'detail-block'; const name = document.createElement('small'); name.textContent = label; const content = document.createElement('span'); content.textContent = displayUnknown(value); item.append(name, content); details.append(item);
      }
      if (details.childElementCount) card.append(details);
      if (Array.isArray(issue.sourceRefs) && issue.sourceRefs.length) {
        const sources = document.createElement('ul'); sources.className = 'source-list';
        issue.sourceRefs.forEach((ref) => {
          const source = document.createElement('li');
          const location = [ref.page ? `page ${ref.page}` : '', ref.row ? `row ${ref.row}` : '', ref.line ? `line ${ref.line}` : '', ref.field || ''].filter(Boolean).join(' · ');
          source.textContent = `${ref.documentId || 'Source'}${location ? ` · ${location}` : ''}${ref.quote ? ': ' : ''}`;
          if (ref.quote) { const quote = document.createElement('span'); quote.className = 'source-quote'; quote.textContent = `“${ref.quote}”`; source.append(quote); }
          sources.append(source);
        });
        card.append(sources);
      }
      if (issue.status === 'resolved') {
        const resolution = document.createElement('p'); resolution.className = 'job-summary'; resolution.textContent = `Resolved by ${issue.resolvedBy || 'reviewer'}: ${issue.resolutionReason || 'No reason recorded.'}`; card.append(resolution);
      } else if (state.role === 'employee') {
        const waiting = document.createElement('p'); waiting.className = 'job-summary'; waiting.textContent = 'This item is waiting for a reviewer to resolve it.'; card.append(waiting);
      } else {
        const form = document.createElement('form'); form.className = 'resolution-form'; form.noValidate = true;
        const group = document.createElement('div'); group.className = 'field-group'; const label = document.createElement('label'); label.textContent = 'Resolution note';
        const input = document.createElement('input'); input.type = 'text'; input.required = true; input.maxLength = 1000; input.placeholder = 'What evidence or correction resolved this?'; const error = document.createElement('span'); error.className = 'field-error'; error.hidden = true;
        label.htmlFor = `resolve-${issue.id}`; input.id = `resolve-${issue.id}`; group.append(label, input, error);
        const button = document.createElement('button'); button.type = 'submit'; button.className = 'button subtle'; button.textContent = 'Resolve issue';
        form.append(group, button); form.addEventListener('submit', async (event) => {
          event.preventDefault(); const reason = input.value.trim();
          if (reason.length < 3) { error.textContent = 'Add a short reason before resolving this issue.'; error.hidden = false; input.setAttribute('aria-invalid', 'true'); input.focus(); return; }
          button.disabled = true; button.setAttribute('aria-busy', 'true');
          try { await jsonApi(`/api/issues/${encodeURIComponent(issue.id)}/resolve`, { method: 'POST', body: { reason } }); await loadWorkspace(); showToast('Issue resolved and recorded in the audit trail.'); }
          catch (apiError) { error.textContent = apiError.message; error.hidden = false; }
          finally { button.disabled = false; button.removeAttribute('aria-busy'); }
        });
        card.append(form);
      }
      list.append(card);
    }
  }

  async function reprocessDocument(documentId, button) {
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    try {
      const result = await jsonApi(`/api/documents/${encodeURIComponent(documentId)}/reprocess`, { method: 'POST', body: {} });
      const existing = state.jobs.findIndex((job) => job.id === result.job.id);
      const job = { id: result.job.id, documentId, status: 'queued', events: [] };
      if (existing >= 0) state.jobs[existing] = job; else state.jobs.unshift(job);
      renderJobs(state.jobs); setView('upload'); watchJob(job.id); showToast('Checks queued using the saved reviewer corrections.');
    } catch (error) { showToast(error.message, 'error'); }
    finally { button.disabled = false; button.removeAttribute('aria-busy'); }
  }

  async function approveDocument(documentId, button) {
    button.disabled = true;
    try { await jsonApi(`/api/documents/${encodeURIComponent(documentId)}/approve`, { method: 'POST', body: {} }); await loadWorkspace(); showToast('Document approved by you.'); }
    catch (error) { showToast(error.message, 'error'); }
    finally { button.disabled = false; }
  }

  function openCorrection(documentRecord) {
    state.correctionDocument = documentRecord;
    $('#correctionDocumentId').value = documentRecord.id;
    $('#correctionField').value = 'documentNumber';
    updateCorrectionValue();
    $('#correctionReason').value = '';
    $('#correctionError').hidden = true;
    $('#correctionDialog').showModal();
  }

  function updateCorrectionValue() {
    const field = $('#correctionField').value;
    const data = state.correctionDocument?.analysis?.document || {};
    const value = state.correctionDocument?.manualOverrides?.[field] ?? data[field] ?? '';
    $('#correctionValue').value = value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value);
  }

  async function saveCorrection(event) {
    event.preventDefault();
    const field = $('#correctionField').value;
    const rawValue = $('#correctionValue').value.trim();
    const reason = $('#correctionReason').value.trim();
    const error = $('#correctionError');
    error.hidden = true;
    let value = rawValue;
    if (field === 'totalAmountSen') {
      if (!/^\d+$/u.test(rawValue) || !Number.isSafeInteger(Number(rawValue))) { error.textContent = 'Enter an amount in integer sen. Example: RM 5.00 is 500.'; error.hidden = false; $('#correctionValue').focus(); return; }
      value = Number(rawValue);
    }
    if (!rawValue || reason.length < 3) { error.textContent = 'Enter a corrected value and a reason of at least three characters.'; error.hidden = false; (!rawValue ? $('#correctionValue') : $('#correctionReason')).focus(); return; }
    const button = $('#saveCorrection'); button.disabled = true; button.setAttribute('aria-busy', 'true');
    try {
      await jsonApi(`/api/documents/${encodeURIComponent($('#correctionDocumentId').value)}/corrections`, { method: 'POST', body: { field, value, reason } });
      $('#correctionDialog').close();
      const record = state.documents.find((item) => item.id === $('#correctionDocumentId').value);
      if (record) await reprocessDocument(record.id, button);
      else { await loadWorkspace(); showToast('Correction saved to the audit trail.'); }
    } catch (saveError) { error.textContent = saveError.message; error.hidden = false; }
    finally { button.disabled = false; button.removeAttribute('aria-busy'); }
  }

  function parseLines(value, allowNumber) {
    const lines = value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
    return lines.map((line) => {
      const divider = line.indexOf('|');
      if (divider < 1) throw new Error(`Use “code | name” on this line: ${line}`);
      const first = line.slice(0, divider).trim(); const second = line.slice(divider + 1).trim();
      if (allowNumber && !second) throw new Error('Each line needs a name after the | separator.');
      return allowNumber ? { code: first, label: second, active: true } : { legalName: first, registrationNumber: second, active: true };
    });
  }

  function populateMasterData(data) {
    const accounts = (data.chartOfAccounts || []).map((account) => `${account.code} | ${account.label}`).join('\n');
    const suppliers = (data.suppliers || []).map((supplier) => `${supplier.legalName} | ${supplier.registrationNumber || ''}`.trimEnd()).join('\n');
    $('#accountsText').value = accounts;
    $('#suppliersText').value = suppliers;
    $('#buyerName').value = data.buyerProfile?.legalName || '';
    $('#buyerRegistration').value = data.buyerProfile?.registrationNumber || '';
  }

  async function saveMasterData(event) {
    event.preventDefault();
    const status = $('#setupStatus'); status.textContent = 'Checking and saving business setup…';
    $('#accountsError').hidden = true; $('#suppliersError').hidden = true;
    let chartOfAccounts; let suppliers;
    try { chartOfAccounts = parseLines($('#accountsText').value, true); }
    catch (error) { $('#accountsError').textContent = error.message; $('#accountsError').hidden = false; $('#accountsText').focus(); status.textContent = 'Business setup was not saved.'; return; }
    try { suppliers = parseLines($('#suppliersText').value, false); }
    catch (error) { $('#suppliersError').textContent = error.message; $('#suppliersError').hidden = false; $('#suppliersText').focus(); status.textContent = 'Business setup was not saved.'; return; }
    if (new Set(chartOfAccounts.map((account) => account.code)).size !== chartOfAccounts.length) { $('#accountsError').textContent = 'Each account code must be unique.'; $('#accountsError').hidden = false; $('#accountsText').focus(); return; }
    const button = $('#saveMasterData'); button.disabled = true; button.setAttribute('aria-busy', 'true');
    try {
      state.masterData = await jsonApi('/api/master-data', { method: 'PUT', body: {
        chartOfAccounts, suppliers,
        buyerProfile: $('#buyerName').value.trim() ? { legalName: $('#buyerName').value.trim(), registrationNumber: $('#buyerRegistration').value.trim() } : null,
      } });
      status.textContent = 'Business setup saved. Agent recommendations will use these approved records.';
      showToast('Business setup saved.');
    } catch (error) { status.textContent = 'Business setup was not saved.'; showToast(error.message, 'error'); }
    finally { button.disabled = false; button.removeAttribute('aria-busy'); }
  }

  async function handleExport(event) { await downloadCsv(event.currentTarget.dataset.kind || (event.currentTarget.id === 'exportIssues' ? 'issues' : 'records')); }

  $('#authForm').addEventListener('submit', authSubmit);
  $('#authModeToggle').addEventListener('click', () => setAuthMode(state.authMode === 'signin' ? 'signup' : 'signin'));
  $('#togglePassword').addEventListener('click', (event) => {
    const password = $('#authPassword'); const showing = password.type === 'text';
    password.type = showing ? 'password' : 'text'; event.currentTarget.textContent = showing ? 'Show' : 'Hide'; event.currentTarget.setAttribute('aria-pressed', String(!showing));
  });
  $('#signOut').addEventListener('click', () => { accessToken = ''; sessionStorage.removeItem(tokenKey); sessionStorage.removeItem(emailKey); appView.hidden = true; authView.hidden = false; setAuthMode('signin'); document.title = 'Sign in — TutupBuku'; });
  $$('[role="tab"]').forEach((tab) => { tab.addEventListener('click', () => setView(tab.dataset.view)); tab.addEventListener('keydown', tabKeydown); });
  $$('[data-go]').forEach((link) => link.addEventListener('click', (event) => { event.preventDefault(); setView(link.dataset.go); }));
  window.addEventListener('hashchange', () => setView(location.hash.slice(1), false));
  window.addEventListener('popstate', () => setView(location.hash.slice(1), false));
  $('#workflow').addEventListener('change', () => {
    const workflow = $('#workflow').value;
    const claims = workflow === 'claim'; const automatic = workflow === 'auto';
    $('#purposeGroup').hidden = !claims && !automatic;
    $('#purposeGroup label').textContent = automatic ? 'Claim purpose (if this upload is an employee expense)' : "Employee's stated purpose";
    $('#claimPurpose').required = claims || state.role === 'employee';
    $('#purposeHelp').textContent = automatic
      ? 'Optional during upload. If Master Agent routes this to claims without a purpose, it will be flagged for follow-up.'
      : 'Write the actual reason. The system will compare it with the receipt contents.';
    if (!claims && !automatic) setFieldError('#claimPurpose', '#purposeError', '');
  });
  $('#workflow').dispatchEvent(new Event('change'));
  $('#fileInput').addEventListener('change', (event) => addFiles(event.currentTarget.files));
  const dropZone = $('#dropZone');
  dropZone.addEventListener('dragover', (event) => { event.preventDefault(); dropZone.classList.add('dragging'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragging'));
  dropZone.addEventListener('drop', (event) => { event.preventDefault(); dropZone.classList.remove('dragging'); addFiles(event.dataTransfer.files); });
  $('#uploadForm').addEventListener('submit', uploadSelected);
  $('#refreshJobs').addEventListener('click', () => loadWorkspace().catch((error) => showToast(error.message, 'error')));
  $('#reloadRecords').addEventListener('click', () => loadRecordsAndIssues());
  $('#exportRecords').addEventListener('click', handleExport);
  $('#exportIssues').addEventListener('click', handleExport);
  $('#issueFilter').addEventListener('change', renderIssues);
  $('#masterDataForm').addEventListener('submit', saveMasterData);
  $('#correctionField').addEventListener('change', updateCorrectionValue);
  $('#correctionForm').addEventListener('submit', saveCorrection);
  $('#closeCorrection').addEventListener('click', () => $('#correctionDialog').close());
  $('#cancelCorrection').addEventListener('click', () => $('#correctionDialog').close());
  $('#correctionDialog').addEventListener('close', () => {
    if (!state.correctionDocument) return;
    const opener = $$('[aria-label^="Correct extracted information for "]').find((button) => button.getAttribute('aria-label') === `Correct extracted information for ${state.correctionDocument.originalFilename}`);
    opener?.focus();
  });
  $('#footerYear').textContent = String(new Date().getFullYear());

  fetchConfig().then(() => {
    if (accessToken) {
      authView.hidden = true; appView.hidden = false;
      $('#signedInEmail').textContent = sessionStorage.getItem(emailKey) || 'Signed-in user';
      setView(location.hash.slice(1) || 'upload', false);
      loadWorkspace().catch((error) => showToast(error.message, 'error'));
    } else setView('upload', false);
    const navigation = matchMedia('(max-width: 720px)');
    const updateNavigationOrientation = () => $('.main-nav').setAttribute('aria-orientation', navigation.matches ? 'horizontal' : 'vertical');
    updateNavigationOrientation();
    navigation.addEventListener?.('change', updateNavigationOrientation);
  });
})();

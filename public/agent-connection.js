'use strict';

(() => {
  const storageKey = 'tutupbuku.agentTest.v1';
  const pollIntervalMs = 1200;
  const activeStates = new Set(['queued', 'running']);
  const elements = Object.fromEntries([
    'runTest', 'refreshStatus', 'retryRequest', 'recoveryNote', 'jobBadge',
    'statusText', 'notice', 'resultPanel', 'answer', 'resultNote', 'jobDetails',
    'jobId', 'createdAt', 'updatedAt', 'gatewayReference', 'gatewayRunId'
  ].map(id => [id, document.getElementById(id)]));

  const state = {
    configured: false,
    checking: true,
    submitting: false,
    refreshing: false,
    lookupFailed: false,
    uncertain: false,
    job: null,
    jobId: null,
    pendingKey: null,
    instanceId: null,
    jobFetchVersion: 0,
    timer: null,
    notice: '',
    noticeError: false,
    statusText: 'Checking whether the backend is configured. No AI request is sent on page load.'
  };

  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
    if (typeof saved?.jobId === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(saved.jobId)) state.jobId = saved.jobId;
    if (typeof saved?.pendingKey === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(saved.pendingKey)) state.pendingKey = saved.pendingKey;
    if (typeof saved?.instanceId === 'string') state.instanceId = saved.instanceId;
    state.uncertain = Boolean(state.pendingKey && !state.jobId);
  } catch {
    // Storage can be unavailable in private or restricted browser contexts.
  }

  function saveReference() {
    try {
      if (state.jobId || state.pendingKey) {
        sessionStorage.setItem(storageKey, JSON.stringify({ jobId: state.jobId, pendingKey: state.pendingKey, instanceId: state.instanceId }));
      } else {
        sessionStorage.removeItem(storageKey);
      }
    } catch {
      // The current tab still works when persistence is unavailable.
    }
  }

  function setNotice(message = '', isError = false) {
    state.notice = message;
    state.noticeError = isError;
  }

  function formatTime(value) {
    const date = new Date(value);
    if (!value || Number.isNaN(date.valueOf())) return 'Not available';
    return `${new Intl.DateTimeFormat('en-MY', {
      year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit',
      minute: '2-digit', second: '2-digit', timeZone: 'Asia/Kuala_Lumpur'
    }).format(date)} (MYT)`;
  }

  function render() {
    const active = activeStates.has(state.job?.status) || Boolean(state.jobId && !state.job);
    const busy = state.submitting || state.refreshing || state.checking;
    elements.runTest.disabled = busy || active || state.uncertain || state.lookupFailed || !state.configured;
    elements.runTest.setAttribute('aria-busy', String(state.submitting));
    elements.refreshStatus.hidden = !(state.lookupFailed || state.uncertain || !state.configured && !state.checking);
    elements.refreshStatus.disabled = busy;
    elements.refreshStatus.setAttribute('aria-busy', String(state.refreshing));
    elements.retryRequest.hidden = !(state.uncertain && state.pendingKey && state.configured);
    elements.retryRequest.disabled = busy;
    elements.recoveryNote.hidden = elements.retryRequest.hidden;
    elements.statusText.textContent = state.statusText;
    elements.notice.hidden = !state.notice;
    elements.notice.textContent = state.notice;
    elements.notice.classList.toggle('error', state.noticeError);

    let badge = 'Ready';
    let tone = 'pending';
    if (state.checking) badge = 'Checking setup';
    else if (state.submitting) badge = 'Sending';
    else if (state.uncertain) badge = 'Status unknown';
    else if (state.lookupFailed) badge = 'Status unavailable';
    else if (state.job?.status === 'completed') { badge = 'Completed'; tone = 'success'; }
    else if (state.job?.status === 'failed') { badge = 'Failed'; tone = 'failed'; }
    else if (state.job?.status === 'running') badge = 'Running';
    else if (state.job?.status === 'queued' || state.jobId) badge = 'Queued';
    else if (!state.configured) { badge = 'Needs setup'; tone = 'review'; }
    elements.jobBadge.textContent = badge;
    elements.jobBadge.className = `status-badge ${tone}`;

    const completed = state.job?.status === 'completed';
    elements.resultPanel.hidden = !completed;
    elements.answer.textContent = completed ? (state.job.answer || '(No text reply was returned.)') : '';
    elements.resultNote.textContent = completed && String(state.job.answer || '').trim() === 'AWS_BUDDY_OK'
      ? 'The expected reply was received. The website-to-agent request completed.'
      : 'The request completed. Inspect the actual reply above; it did not exactly match the expected text.';
    elements.jobDetails.hidden = !state.job;
    if (state.job) {
      elements.jobId.textContent = state.job.id;
      elements.createdAt.textContent = formatTime(state.job.createdAt);
      elements.updatedAt.textContent = formatTime(state.job.updatedAt);
      elements.gatewayReference.hidden = !state.job.gatewayRunId;
      elements.gatewayRunId.textContent = state.job.gatewayRunId || '';
    }
  }

  async function request(path, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(path, {
        ...options,
        credentials: 'same-origin',
        cache: 'no-store',
        signal: controller.signal
      });
      let data;
      try { data = await response.json(); } catch {
        const error = new Error('The backend returned an unreadable response. Refresh status before starting another test.');
        error.status = response.status;
        throw error;
      }
      if (!response.ok) {
        const error = new Error(typeof data.error === 'string' ? data.error : 'The backend could not complete this request.');
        error.status = response.status;
        error.code = data.code;
        throw error;
      }
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('The backend did not reply in time. Refresh status to check the existing request.');
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  function stopPolling() {
    clearTimeout(state.timer);
    state.timer = null;
  }

  function acceptJob(job) {
    if (!job || typeof job.id !== 'string' || !['queued', 'running', 'completed', 'failed'].includes(job.status)) {
      throw new Error('The backend returned an invalid job status. Refresh status before starting another test.');
    }
    state.job = job;
    state.jobId = job.id;
    state.pendingKey = null;
    state.uncertain = false;
    state.lookupFailed = false;
    saveReference();
    stopPolling();
    if (job.status === 'queued') state.statusText = 'The backend accepted the request. Waiting for the AWS agent.';
    if (job.status === 'running') state.statusText = 'The AWS agent request is running. Its reply will appear here when it completes.';
    if (job.status === 'completed') state.statusText = 'The AI request completed. Its actual reply is shown below.';
    if (job.status === 'failed') {
      state.statusText = 'The test failed. Review the message below before starting another test.';
      setNotice(job.error || 'The agent request failed. Check the service configuration and try again.', true);
    } else {
      setNotice();
    }
    if (activeStates.has(job.status)) state.timer = setTimeout(pollJob, pollIntervalMs);
    render();
  }

  async function pollJob() {
    stopPolling();
    if (!state.jobId) return;
    const requestedId = state.jobId;
    const requestedVersion = ++state.jobFetchVersion;
    try {
      const data = await request(`/api/demo/jobs/${encodeURIComponent(requestedId)}`);
      if (state.jobId !== requestedId || state.jobFetchVersion !== requestedVersion) return;
      acceptJob(data.job);
    } catch (error) {
      if (state.jobId !== requestedId || state.jobFetchVersion !== requestedVersion) return;
      if (error.status === 404) {
        state.job = null;
        state.jobId = null;
        state.pendingKey = null;
        state.uncertain = false;
        state.lookupFailed = false;
        saveReference();
        state.statusText = 'The saved job is no longer available.';
        setNotice('The backend may have restarted. No new AI request was sent. A new test is a separate request and uses credits.', true);
      } else {
        state.lookupFailed = true;
        state.statusText = 'The job status could not be refreshed. The agent may still be working.';
        setNotice('Use Refresh status to check this same job. Starting another test is disabled until its outcome is known.', true);
      }
      render();
    }
  }

  async function refreshStatus() {
    if (state.submitting || state.refreshing) return;
    state.refreshing = true;
    stopPolling();
    render();
    try {
      const data = await request('/api/demo/status');
      if (typeof data.configured !== 'boolean') throw new Error('The backend returned an invalid setup status.');
      const restarted = typeof data.instanceId === 'string' && state.instanceId && state.instanceId !== data.instanceId;
      const lostUncertainRequest = restarted && state.uncertain && !state.jobId;
      if (typeof data.instanceId === 'string') state.instanceId = data.instanceId;
      if (lostUncertainRequest) {
        state.pendingKey = null;
        state.uncertain = false;
        saveReference();
      }
      state.configured = data.configured;
      state.lookupFailed = false;
      if (data.activeJob?.id && state.jobId !== data.activeJob.id) {
        state.job = null;
        state.jobId = data.activeJob.id;
        saveReference();
      }
      if (state.jobId) {
        await pollJob();
      } else if (lostUncertainRequest) {
        state.statusText = 'The backend restarted. The original request outcome cannot be verified.';
        setNotice('No AI request was retried. Check the agent before choosing to start a new test, which is a separate request and uses credits.', true);
      } else if (state.uncertain) {
        state.statusText = 'The original request outcome is unknown. No active job was found.';
        setNotice('You can refresh again or explicitly retry the same request. A new test stays disabled to avoid duplicate credit use.', true);
      } else if (!state.configured) {
        state.statusText = 'The backend needs its AWS agent connection configured before a test can run.';
        setNotice(typeof data.message === 'string' ? data.message : 'Ask the service operator to finish the backend configuration.');
      } else if (state.job?.status === 'completed' || state.job?.status === 'failed') {
        acceptJob(state.job);
      } else {
        state.statusText = 'Ready. Click Run AWS agent test to send one real AI request.';
        setNotice();
      }
    } catch (error) {
      state.lookupFailed = true;
      state.statusText = 'The backend status is unavailable. No new AI request was sent.';
      setNotice('Check your connection and use Refresh status. The test button stays disabled until the backend can be checked.', true);
      state.configured = false;
    } finally {
      state.checking = false;
      state.refreshing = false;
      render();
    }
  }

  async function startTest(retrySameRequest = false) {
    if (state.submitting || state.refreshing || state.checking || !state.configured) return;
    if (activeStates.has(state.job?.status) || state.jobId && !state.job) return;
    if (state.uncertain && !retrySameRequest) return;
    stopPolling();
    state.pendingKey = retrySameRequest ? state.pendingKey : crypto.randomUUID();
    if (!state.pendingKey) return;
    state.job = null;
    state.jobId = null;
    state.submitting = true;
    state.lookupFailed = false;
    state.statusText = retrySameRequest ? 'Checking the original request with the same request key.' : 'Sending one AI test request to the backend.';
    setNotice();
    saveReference();
    render();
    try {
      const data = await request('/api/demo/jobs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-TutupBuku-Request': '1',
          'Idempotency-Key': state.pendingKey
        },
        body: '{}'
      });
      acceptJob(data.job);
    } catch (error) {
      const rejected = [400, 401, 403, 409, 413, 429, 503].includes(error.status);
      state.uncertain = !rejected;
      state.lookupFailed = true;
      if (rejected) {
        state.pendingKey = null;
        saveReference();
      }
      state.statusText = rejected ? 'The backend did not accept this test request.' : 'The request was sent, but its outcome is unknown.';
      setNotice(rejected ? error.message : 'Do not start a second test. Refresh status to check whether the original request is running.', true);
      if (error.status === 503) state.configured = false;
    } finally {
      state.submitting = false;
      render();
    }
  }

  elements.runTest.addEventListener('click', () => startTest());
  elements.refreshStatus.addEventListener('click', refreshStatus);
  elements.retryRequest.addEventListener('click', async () => {
    // Recheck the server instance before reusing a request key. Its in-memory
    // idempotency record may have disappeared during a backend restart.
    await refreshStatus();
    if (state.uncertain && state.pendingKey && !state.lookupFailed) await startTest(true);
  });
  window.addEventListener('pagehide', stopPolling);
  render();
  refreshStatus();
})();

// popup.js (CNX build)

let CURRENT_RUN = null;

// Public Suffix List parsing (bundled as public_suffix_list.dat)
// This allows us to reliably determine the registrable/root domain for any TLD variant.
const PSL_STATE = {
  loaded: false,
  loadingPromise: null,
  normalRules: new Set(),
  wildcardRules: new Set(),
  exceptionRules: new Set()
};

document.addEventListener('DOMContentLoaded', () => {
  chrome.storage.local.get(['lastSending', 'lastTracking'], (data) => {
    if (data.lastSending) document.getElementById('sendingDomain').value = data.lastSending;
    if (data.lastTracking) document.getElementById('trackingDomain').value = data.lastTracking;
  });

  document.getElementById('verifyBtn').addEventListener('click', runVerification);
  document.getElementById('clearBtn').addEventListener('click', clearData);

  // Render macros immediately (DMARC placeholder until a run happens)
  renderCnxMacros(null);
});

const SHARED_CLICK_TRACKING_DOMAINS = new Set([
  'trk.klclick.com',
  'ct.klclick.com',
  'ctrk.klclick.com',
  'trk.klclick1.com',
  'ct.klclick1.com',
  'ctrk.klclick1.com',
  'trk.klclick2.com',
  'ct.klclick2.com',
  'ctrk.klclick2.com',
  'trk.klclick3.com',
  'ct.klclick3.com',
  'ctrk.klclick3.com'
]);

async function runVerification() {
  const sendingInputRaw = document.getElementById('sendingDomain').value.trim();
  const trackingInputRaw = document.getElementById('trackingDomain').value.trim();

  if (!sendingInputRaw && !trackingInputRaw) {
    alert('Please enter a domain to verify.');
    return;
  }

  const sendingInput = normalizeDomain(sendingInputRaw);
  const trackingInput = normalizeDomain(trackingInputRaw);

  chrome.storage.local.set({
    lastSending: sendingInputRaw,
    lastTracking: trackingInputRaw
  });

  // Ensure we have the Public Suffix List loaded before computing root domains.
  // This makes root domain handling accurate for ccTLDs and other multi-level suffixes.
  await ensurePublicSuffixList();

  CURRENT_RUN = createEmptyRunState(sendingInput, trackingInput);

  hideResults();
  showLoading();
  clearResults();

  try {
    if (sendingInput) {
      await verifySendingDomain(sendingInput);
      await verifySiteVerification(CURRENT_RUN.sending.rootDomain);
      await verifyDmarc(CURRENT_RUN.sending.rootDomain);
    }

    if (trackingInput) {
      await verifyClickTrackingDomain(trackingInput);
    }
  } catch (err) {
    console.error(err);
    alert('Error querying DNS. Please try again or check the console for details.');
  } finally {
    hideLoading();
    showResults();

    const now = new Date();
    CURRENT_RUN.lastChecked = now;
    renderLastChecked(now);
    renderResolverCheckBanner(CURRENT_RUN);
    renderEscalationSummary(CURRENT_RUN);

    // Update macros with the latest DMARC record (if present)
    renderCnxMacros(CURRENT_RUN);
  }
}

function createEmptyRunState(sendingDomain, trackingDomain) {
  return {
    lastChecked: null,
    resolverMismatches: [],
    sending: sendingDomain ? { input: sendingDomain, rootDomain: getRootDomain(sendingDomain), mode: null, status: null, statusLabel: null, providers: new Set(), records: [], notes: [] } : null,
    siteVerification: null,
    dmarc: null,
    clickTracking: trackingDomain ? { input: trackingDomain, status: null, statusLabel: null, record: null } : null
  };
}

/* -------------------------
   Sending domain verification
-------------------------- */
async function verifySendingDomain(sendingDomain) {
  const rootDomain = CURRENT_RUN.sending.rootDomain;

  // Detect dynamic via NS records (Klaviyo dynamic uses klaviyo.com NS)
  const nsCheck = await checkRecordWithCrossCheck(sendingDomain, 'NS');
  const nsAnswers = nsCheck.answers || [];
  const isDynamic = nsCheck.found && nsAnswers.some(ans => normalizeDomain(ans.data).includes('klaviyo.com'));

  if (isDynamic) {
    CURRENT_RUN.sending.mode = 'Dynamic';
    await verifyDynamicSendingDomain(sendingDomain, rootDomain, nsAnswers);
  } else {
    // Do not assume Static when there is no DNS evidence.
    // verifyStaticSendingDomain will set mode to 'Static' only when we detect relevant CNAME records.
    CURRENT_RUN.sending.mode = null;
    await verifyStaticSendingDomain(sendingDomain, rootDomain);
  }
}

async function verifyDynamicSendingDomain(sendingDomain, rootDomain, nsAnswers) {
  const containerId = 'sendingResults';
  const relativeName = toRelativeName(sendingDomain, rootDomain);

  if (!nsAnswers || nsAnswers.length === 0) {
    CURRENT_RUN.sending.status = 'Missing';
    CURRENT_RUN.sending.statusLabel = 'Missing';

    renderSummaryCard(
      containerId,
      'Sending Domain',
      'Missing',
      `Branded sending domain: ${sendingDomain}`,
      'status-error'
    );

    renderInfoNote(containerId, 'This is a <b>Dynamic Domain</b> setup.');
    return;
  }

  const allNsAreKlaviyo = nsAnswers.every(a => normalizeDomain(a.data).includes('klaviyo.com'));
  const overallStatus = allNsAreKlaviyo ? 'Verified' : 'Warning';

  const inferred = await inferSendingInfrastructure(sendingDomain);
  CURRENT_RUN.sending.providers = inferred.providers;

  CURRENT_RUN.sending.status = overallStatus;
  CURRENT_RUN.sending.statusLabel = overallStatus === 'Verified'
    ? buildVerifiedInfrastructureLabel(inferred.providers, { fallback: 'Verified' })
    : overallStatus;

  renderSummaryCard(
    containerId,
    'Sending Domain',
    CURRENT_RUN.sending.statusLabel,
    `Branded sending domain: ${sendingDomain}`,
    overallStatus === 'Verified' ? 'status-verified' : 'status-warning'
  );

  nsAnswers.forEach((ans, idx) => {
    const target = stripTrailingDot(ans.data);
    const isKlaviyo = normalizeDomain(target).includes('klaviyo.com');

    const status = isKlaviyo ? 'Verified' : 'Warning';
    const badgeClass = isKlaviyo ? 'status-verified' : 'status-warning';

    renderRecordCard(
      containerId,
      `NS Record ${idx + 1}`,
      status,
      'NS',
      relativeName,
      target,
      badgeClass
    );

    CURRENT_RUN.sending.records.push({
      label: `NS Record ${idx + 1}`,
      type: 'NS',
      name: relativeName,
      value: target,
      status
    });
  });

  renderInfoNote(containerId, 'This is a <b>Dynamic Domain</b> setup.');
  renderInfrastructureNote(containerId, inferred, sendingDomain);
}

async function verifyStaticSendingDomain(sendingDomain, rootDomain) {
  const containerId = 'sendingResults';
  const relativeName = toRelativeName(sendingDomain, rootDomain);

  const cnameCheck = await checkRecordWithCrossCheck(sendingDomain, 'CNAME');
  const cnameAnswers = cnameCheck.answers || [];

  const validCnameTargets = ['sendgrid.net', 'klaviyodns.com', 'klaviyomail.com', 'klaviyo.com'];

  let record1Status = 'Missing';
  let record1Badge = 'status-error';
  let record1Target = 'No CNAME record found';
  let record1Provider = null;

  if (cnameCheck.found && cnameAnswers.length > 0) {
    const match = cnameAnswers.find(a => validCnameTargets.some(t => normalizeDomain(a.data).includes(t))) || cnameAnswers[0];
    record1Target = stripTrailingDot(match.data);

    const matchesExpected = validCnameTargets.some(t => normalizeDomain(record1Target).includes(t));
    record1Provider = classifyProviderFromTarget(record1Target);

    if (matchesExpected) {
      record1Status = 'Verified';
      record1Badge = 'status-verified';
    } else {
      record1Status = 'Warning';
      record1Badge = 'status-warning';
    }
  }

  const record2 = await findAndVerifyDomainKeyCname(rootDomain, ['kl', 'kl1', 's1']);
  const record3 = await findAndVerifyDomainKeyCname(rootDomain, ['kl2', 'kl3', 's2']);

  // Only label this as a Static setup if we can see any relevant CNAME evidence.
  // If all required CNAME records are missing, we treat the setup type as unknown.
  const hasAnyStaticEvidence = [record1Status, record2.status, record3.status].some(s => s && s !== 'Missing');
  CURRENT_RUN.sending.mode = hasAnyStaticEvidence ? 'Static' : null;

  const inferred = await inferSendingInfrastructure(sendingDomain, {
    extraEvidence: [
      { domain: sendingDomain, target: record1Target, provider: record1Provider },
      record2.evidence,
      record3.evidence
    ]
  });

  CURRENT_RUN.sending.providers = inferred.providers;

  const recordStatuses = [record1Status, record2.status, record3.status];

  let overallStatus = 'Verified';
  if (recordStatuses.includes('Missing')) overallStatus = 'Missing';
  else if (recordStatuses.includes('Warning')) overallStatus = 'Warning';

  CURRENT_RUN.sending.status = overallStatus;
  CURRENT_RUN.sending.statusLabel = overallStatus === 'Verified'
    ? buildVerifiedInfrastructureLabel(inferred.providers, { fallback: 'Verified' })
    : overallStatus;

  renderSummaryCard(
    containerId,
    'Sending Domain',
    CURRENT_RUN.sending.statusLabel,
    `Branded sending domain: ${sendingDomain}`,
    overallStatus === 'Verified' ? 'status-verified' : (overallStatus === 'Warning' ? 'status-warning' : 'status-error')
  );

  renderRecordCard(
    containerId,
    'CNAME Record 1',
    record1Status,
    'CNAME',
    relativeName,
    record1Provider ? `${record1Target} (${record1Provider})` : record1Target,
    record1Badge
  );
  CURRENT_RUN.sending.records.push({ label: 'CNAME Record 1', type: 'CNAME', name: relativeName, value: record1Target, status: record1Status });

  renderRecordCard(
    containerId,
    'CNAME Record 2',
    record2.status,
    'CNAME',
    record2.name,
    record2.valueDisplay,
    record2.badgeClass
  );
  CURRENT_RUN.sending.records.push({ label: 'CNAME Record 2', type: 'CNAME', name: record2.name, value: record2.valueRaw, status: record2.status });

  renderRecordCard(
    containerId,
    'CNAME Record 3',
    record3.status,
    'CNAME',
    record3.name,
    record3.valueDisplay,
    record3.badgeClass
  );
  CURRENT_RUN.sending.records.push({ label: 'CNAME Record 3', type: 'CNAME', name: record3.name, value: record3.valueRaw, status: record3.status });

  if (CURRENT_RUN.sending.mode === 'Static') {
    renderInfoNote(containerId, 'This is a <b>Static</b> setup.');
  }
  renderInfrastructureNote(containerId, inferred, sendingDomain);
}

async function findAndVerifyDomainKeyCname(rootDomain, prefixes) {
  const validTargets = ['sendgrid.net', 'klaviyodns.com', 'klaviyomail.com', 'klaviyo.com'];

  for (const prefix of prefixes) {
    const host = `${prefix}._domainkey.${rootDomain}`;
    const relativeName = toRelativeName(host, rootDomain);

    const check = await checkRecordWithCrossCheck(host, 'CNAME');
    const answers = check.answers || [];

    if (check.found && answers.length > 0) {
      const match = answers.find(a => validTargets.some(t => normalizeDomain(a.data).includes(t))) || answers[0];
      const target = stripTrailingDot(match.data);

      const matchesExpected = validTargets.some(t => normalizeDomain(target).includes(t));
      const provider = classifyProviderFromTarget(target);

      if (matchesExpected) {
        return {
          status: 'Verified',
          badgeClass: 'status-verified',
          name: relativeName,
          valueRaw: target,
          valueDisplay: provider ? `${target} (${provider})` : target,
          evidence: { domain: host, target, provider }
        };
      }

      return {
        status: 'Warning',
        badgeClass: 'status-warning',
        name: relativeName,
        valueRaw: target,
        valueDisplay: `${target} (Mismatch)`,
        evidence: { domain: host, target, provider }
      };
    }
  }

  const fallbackHost = `${prefixes[0]}._domainkey.${rootDomain}`;
  const fallbackName = toRelativeName(fallbackHost, rootDomain);
  return {
    status: 'Missing',
    badgeClass: 'status-error',
    name: fallbackName,
    valueRaw: 'No CNAME record found',
    valueDisplay: 'No CNAME record found',
    evidence: { domain: fallbackHost, target: null, provider: null }
  };
}

/* -------------------------
   Site verification + DMARC
-------------------------- */
async function verifySiteVerification(rootDomain) {
  const containerId = 'rootResults';

  const check = await checkRecordWithCrossCheck(rootDomain, 'TXT', {
    txtPredicate: (v) => (v || '').toLowerCase().includes('klaviyo-site-verification')
  });
  const answers = check.answers || [];
  const match = answers.find(a => (a.data || '').includes('klaviyo-site-verification'));

  if (!check.found || answers.length === 0) {
    CURRENT_RUN.siteVerification = { domain: rootDomain, status: 'Missing', value: 'No TXT records found' };
    renderRecordCard(containerId, 'Site Verification (TXT)', 'Missing', 'TXT', '@', 'No TXT records found', 'status-error');
    return;
  }

  if (!match) {
    const fallback = answers[0].data || '';
    CURRENT_RUN.siteVerification = { domain: rootDomain, status: 'Warning', value: fallback };
    renderRecordCard(containerId, 'Site Verification (TXT)', 'Warning', 'TXT', '@', `${stripQuotes(fallback)} (Not found)`, 'status-warning');
    return;
  }

  const value = stripQuotes(match.data || '');
  CURRENT_RUN.siteVerification = { domain: rootDomain, status: 'Verified', value };
  renderRecordCard(containerId, 'Site Verification (TXT)', 'Verified', 'TXT', '@', value, 'status-verified');
}

async function verifyDmarc(rootDomain) {
  const containerId = 'dmarcResults';
  const host = `_dmarc.${rootDomain}`;
  const relativeName = toRelativeName(host, rootDomain);

  const check = await checkRecordWithCrossCheck(host, 'TXT', {
    txtPredicate: (v) => /v=DMARC1/i.test(v || '')
  });
  const answers = check.answers || [];

  const dmarcRecords = answers
    .map(a => stripQuotes(a.data || ''))
    .filter(v => /v=DMARC1/i.test(v));

  if (!check.found || answers.length === 0 || dmarcRecords.length === 0) {
    CURRENT_RUN.dmarc = { domain: host, status: 'Missing', value: 'No DMARC record found' };
    renderRecordCard(containerId, 'DMARC Record', 'Missing', 'TXT', relativeName, 'No DMARC record found', 'status-error');
    return;
  }

  if (dmarcRecords.length > 1) {
    CURRENT_RUN.dmarc = {
      domain: host,
      status: 'Error',
      value: `Multiple DMARC records detected (${dmarcRecords.length})`,
      values: dmarcRecords
    };

    renderRecordCard(
      containerId,
      'DMARC Record',
      'Error',
      'TXT',
      relativeName,
      `Multiple DMARC records detected (${dmarcRecords.length}). Only one DMARC record should be published.`,
      'status-error'
    );

    dmarcRecords.forEach((rec, idx) => {
      renderRecordCard(
        containerId,
        `DMARC Record ${idx + 1}`,
        'Found',
        'TXT',
        relativeName,
        rec,
        'status-warning'
      );
    });

    return;
  }

  const value = dmarcRecords[0];
  CURRENT_RUN.dmarc = { domain: host, status: 'Verified', value };
  renderRecordCard(containerId, 'DMARC Record', 'Verified', 'TXT', relativeName, value, 'status-verified');
}

/* -------------------------
   Click tracking verification
-------------------------- */
async function verifyClickTrackingDomain(trackingDomain) {
  const containerId = 'trackingResults';
  const rootDomain = getRootDomain(trackingDomain);
  const relativeName = toRelativeName(trackingDomain, rootDomain);

  if (SHARED_CLICK_TRACKING_DOMAINS.has(trackingDomain)) {
    const statusLabel = 'Verified - Shared domain';
    const value = `Shared click tracking domain: ${trackingDomain} (Klaviyo-hosted)`;

    CURRENT_RUN.clickTracking.status = 'Verified';
    CURRENT_RUN.clickTracking.statusLabel = statusLabel;
    CURRENT_RUN.clickTracking.record = { type: 'Shared', name: relativeName, value: trackingDomain };

    renderRecordCard(containerId, 'Tracking Domain', statusLabel, 'Shared', relativeName, value, 'status-verified');
    return;
  }

  const check = await checkRecordWithCrossCheck(trackingDomain, 'CNAME');
  const answers = check.answers || [];

  if (!check.found || answers.length === 0) {
    CURRENT_RUN.clickTracking.status = 'Missing';
    CURRENT_RUN.clickTracking.statusLabel = 'Missing';
    CURRENT_RUN.clickTracking.record = { type: 'CNAME', name: relativeName, value: 'No CNAME record found' };

    renderRecordCard(containerId, 'Tracking Domain', 'Missing', 'CNAME', relativeName, `No CNAME record found for ${trackingDomain}`, 'status-error');
    return;
  }

  const normalizedTargets = answers.map(a => normalizeDomain(a.data));
  const sharedTarget = normalizedTargets.find(t => SHARED_CLICK_TRACKING_DOMAINS.has(t));
  if (sharedTarget) {
    const statusLabel = 'Verified - Shared domain';
    CURRENT_RUN.clickTracking.status = 'Verified';
    CURRENT_RUN.clickTracking.statusLabel = statusLabel;
    CURRENT_RUN.clickTracking.record = { type: 'CNAME', name: relativeName, value: sharedTarget };

    renderRecordCard(containerId, 'Tracking Domain', statusLabel, 'CNAME', relativeName, `CNAME target: ${sharedTarget} (Shared domain)`, 'status-verified');
    return;
  }

  const sendgridTarget = normalizedTargets.find(t => t.includes('sendgrid.net'));
  if (sendgridTarget) {
    const statusLabel = 'Verified - SendGrid';
    CURRENT_RUN.clickTracking.status = 'Verified';
    CURRENT_RUN.clickTracking.statusLabel = statusLabel;
    CURRENT_RUN.clickTracking.record = { type: 'CNAME', name: relativeName, value: sendgridTarget };

    renderRecordCard(containerId, 'Tracking Domain', statusLabel, 'CNAME', relativeName, `CNAME target: ${sendgridTarget} (SendGrid)`, 'status-verified');
    return;
  }

  const kmtaTarget = normalizedTargets.find(t => t.includes('klaviyodns.com') || t.includes('klaviyomail.com'));
  if (kmtaTarget) {
    const statusLabel = 'Verified - KMTA';
    CURRENT_RUN.clickTracking.status = 'Verified';
    CURRENT_RUN.clickTracking.statusLabel = statusLabel;
    CURRENT_RUN.clickTracking.record = { type: 'CNAME', name: relativeName, value: kmtaTarget };

    renderRecordCard(containerId, 'Tracking Domain', statusLabel, 'CNAME', relativeName, `CNAME target: ${kmtaTarget} (KMTA)`, 'status-verified');
    return;
  }

  const fallback = stripTrailingDot(answers[0].data || '');
  CURRENT_RUN.clickTracking.status = 'Warning';
  CURRENT_RUN.clickTracking.statusLabel = 'Warning';
  CURRENT_RUN.clickTracking.record = { type: 'CNAME', name: relativeName, value: fallback };

  renderRecordCard(containerId, 'Tracking Domain', 'Warning', 'CNAME', relativeName, `CNAME target: ${fallback} (Mismatch)`, 'status-warning');
}

/* -------------------------
   Infrastructure inference
-------------------------- */
function classifyProviderFromTarget(target) {
  const t = normalizeDomain(target);
  if (!t) return null;

  if (t.includes('sendgrid.net')) return 'SendGrid';
  if (t.includes('klaviyodns.com') || t.includes('klaviyomail.com') || t.includes('klaviyo.com')) return 'KMTA';
  return null;
}

function providersToLabel(providers) {
  const hasSendGrid = providers && providers.has('SendGrid');
  const hasKmta = providers && providers.has('KMTA');

  if (hasSendGrid && hasKmta) return 'SendGrid + KMTA';
  if (hasSendGrid) return 'SendGrid';
  if (hasKmta) return 'KMTA';
  return 'Unknown';
}

function buildVerifiedInfrastructureLabel(providers, { fallback = 'Verified' } = {}) {
  const label = providersToLabel(providers);
  if (label === 'Unknown') return fallback;
  return `Verified - ${label}`;
}

function getSiblingSendingDomains(domain) {
  const d = normalizeDomain(domain);
  if (!d) return [];

  if (d.startsWith('k1.')) return [`k3.${d.slice(3)}`];
  if (d.startsWith('k3.')) return [`k1.${d.slice(3)}`];

  return [`k1.${d}`, `k3.${d}`];
}

async function inferSendingInfrastructure(domain, { extraEvidence = [] } = {}) {
  const providers = new Set();
  const evidence = { sendgridDomains: new Set(), kmtaDomains: new Set() };

  (extraEvidence || []).forEach(ev => {
    if (!ev || !ev.domain || !ev.target) return;
    const provider = ev.provider || classifyProviderFromTarget(ev.target);
    if (!provider) return;

    providers.add(provider);
    if (provider === 'SendGrid') evidence.sendgridDomains.add(normalizeDomain(ev.domain));
    if (provider === 'KMTA') evidence.kmtaDomains.add(normalizeDomain(ev.domain));
  });

  const cname = await checkRecord(domain, 'CNAME');
  if (cname.found) {
    (cname.answers || []).forEach(a => {
      const target = stripTrailingDot(a.data || '');
      const provider = classifyProviderFromTarget(target);
      if (!provider) return;

      providers.add(provider);
      if (provider === 'SendGrid') evidence.sendgridDomains.add(normalizeDomain(domain));
      if (provider === 'KMTA') evidence.kmtaDomains.add(normalizeDomain(domain));
    });
  }

  const siblings = getSiblingSendingDomains(domain);
  for (const sibling of siblings) {
    const sib = normalizeDomain(sibling);
    const sibCname = await checkRecord(sib, 'CNAME');
    if (!sibCname.found) continue;

    (sibCname.answers || []).forEach(a => {
      const target = stripTrailingDot(a.data || '');
      const provider = classifyProviderFromTarget(target);
      if (!provider) return;

      providers.add(provider);
      if (provider === 'SendGrid') evidence.sendgridDomains.add(sib);
      if (provider === 'KMTA') evidence.kmtaDomains.add(sib);
    });
  }

  return { providers, evidence };
}

function renderInfrastructureNote(containerId, inferred, inputDomain) {
  const providers = (inferred && inferred.providers) ? inferred.providers : new Set();
  const label = providersToLabel(providers);

  // If we can't confidently classify the infrastructure, still show a helpful note
  // when we have evidence that DNS is present but misconfigured (for example, a typo
  // in the CNAME target such as sendgrid.ne instead of sendgrid.net).
  if (!providers || providers.size === 0 || label === 'Unknown') {
    const hasWarningCname = !!(CURRENT_RUN && CURRENT_RUN.sending && Array.isArray(CURRENT_RUN.sending.records)) &&
      CURRENT_RUN.sending.records.some(r => r.type === 'CNAME' && r.status === 'Warning');

    if (hasWarningCname) {
      renderInfoNote(
        containerId,
        'Sending infrastructure could not be determined due to an <b>invalid CNAME target</b>. Please correct the CNAME value and recheck.'
      );
    }
    return;
  }

  if (label === 'SendGrid + KMTA') {
    renderInfoNote(containerId, 'Detected <b>both</b> sending infrastructures for this brand: <b>SendGrid + KMTA</b>.');
    return;
  }

  if (label === 'SendGrid') {
    renderInfoNote(containerId, 'Detected sending infrastructure: <b>SendGrid</b>.');
    return;
  }

  if (label === 'KMTA') {
    renderInfoNote(containerId, 'Detected sending infrastructure: <b>KMTA</b>.');
  }
}


/* -------------------------
   Escalation summary + copy
-------------------------- */
function renderEscalationSummary(runState) {
  const container = document.getElementById('summaryResults');
  container.innerHTML = '';

  const summaryText = buildSummaryText(runState);

  const card = document.createElement('div');
  card.className = 'result-section';
  card.innerHTML = `
    <div class="result-row">
      <strong>Copy summary for escalation</strong>
      <button id="copySummaryBtn" class="small-btn copy" type="button">Copy</button>
    </div>
    <div id="summaryText" class="summary-text"></div>
  `;

  container.appendChild(card);

  const summaryEl = document.getElementById('summaryText');
  summaryEl.textContent = summaryText;

  const btn = document.getElementById('copySummaryBtn');
  btn.addEventListener('click', async () => {
    const ok = await copyTextToClipboard(summaryText);
    if (!ok) return;

    const original = btn.textContent;
    btn.textContent = 'Copied';
    setTimeout(() => { btn.textContent = original; }, 1200);
  });
}

function buildSummaryText(runState) {
  const lines = [];
  const ts = runState.lastChecked ? runState.lastChecked.toLocaleString() : '';

  lines.push(`DNS Verifier summary`);
  if (ts) lines.push(`Last checked: ${ts}`);

  if (runState.resolverMismatches && runState.resolverMismatches.length) {
    const items = runState.resolverMismatches.map(m => `${m.type} ${m.domain}`).join(', ');
    lines.push(`Propagation check: Google DNS and Cloudflare DNS disagree for: ${items}`);
  }

  if (runState.sending) {
    const infra = runState.sending.status === 'Verified'
      ? buildVerifiedInfrastructureLabel(runState.sending.providers, { fallback: 'Verified' })
      : runState.sending.statusLabel;

    lines.push('');
    lines.push(`Branded sending domain: ${runState.sending.input}`);
    if (runState.sending.mode) {
      lines.push(`Mode: ${runState.sending.mode}`);
    }
    lines.push(`Sending infrastructure: ${infra}`);

    if (runState.sending.records && runState.sending.records.length) {
      if (runState.sending.mode === 'Dynamic') {
        const nsTargets = runState.sending.records
          .filter(r => r.type === 'NS' && r.value && r.value !== 'No CNAME record found')
          .map(r => r.value);
        if (nsTargets.length) lines.push(`NS records: ${nsTargets.join(', ')}`);
      } else {
        const cnameLines = runState.sending.records
          .filter(r => r.type === 'CNAME')
          .map(r => `${r.name} -> ${r.value}`);
        if (cnameLines.length) lines.push(`CNAME records: ${cnameLines.join(' | ')}`);
      }
    }
  }

  if (runState.siteVerification) {
    lines.push('');
    lines.push(`Site verification (TXT): ${runState.siteVerification.status}`);
    if (runState.siteVerification.value && runState.siteVerification.status === 'Verified') {
      lines.push(`Value: ${runState.siteVerification.value}`);
    }
  }

  if (runState.dmarc) {
    lines.push('');
    lines.push(`DMARC: ${runState.dmarc.status}`);

    if (runState.dmarc.status === 'Verified' && runState.dmarc.value) {
      lines.push(`Record: ${runState.dmarc.value}`);
    } else if (runState.dmarc.status === 'Error' && runState.dmarc.values && runState.dmarc.values.length) {
      lines.push(`Records found (${runState.dmarc.values.length}): ${runState.dmarc.values.join(' | ')}`);
    }
  }


  if (runState.clickTracking) {
    lines.push('');
    lines.push(`Click tracking domain: ${runState.clickTracking.input}`);
    lines.push(`Status: ${runState.clickTracking.statusLabel || runState.clickTracking.status}`);
    if (runState.clickTracking.record && runState.clickTracking.record.value) {
      lines.push(`Record: ${runState.clickTracking.record.type}: ${runState.clickTracking.record.value}`);
    }
  }

  return lines.join('\n');
}

async function copyTextToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (err) {
      console.error(err);
      alert('Unable to copy to clipboard. Please copy manually.');
      return false;
    }
  }
}

/* -------------------------
   CNX macros
-------------------------- */
function getDmarcForMacro(runState) {
  if (!runState || !runState.dmarc || runState.dmarc.status !== 'Verified') return '(insert DMARC record)';
  return runState.dmarc.value || '(insert DMARC record)';
}

function buildMacroTexts(runState) {
  const macro1 =
`I have been unable to verify the required DNS records for your branded sending domain.

Please review the following guide to confirm which records need to be added to your domain:
https://help.klaviyo.com/hc/en-us/articles/115000357752#h_01HCMT58PN23FZWBGHTNDDRY3K

If you have already added these records, I recommend contacting your domain provider's support team to confirm the records are correct and fully propagated.`;

  const macro2 =
`I can confirm your click tracking records are configured correctly.

I will now escalate this to the Deliverability team so they can apply the click tracking domain to your account.`;

  const macro3 =
`I can confirm your DMARC record is present:

${getDmarcForMacro(runState)}`;

  return [
    { title: 'Missing DNS records', body: macro1 },
    { title: 'Click tracking confirmed', body: macro2 },
    { title: 'DMARC confirmed', body: macro3 }
  ];
}

function renderCnxMacros(runState) {
  const container = document.getElementById('macrosResults');
  if (!container) return;

  container.innerHTML = '';

  const macros = buildMacroTexts(runState);

  macros.forEach((m, idx) => {
    const card = document.createElement('div');
    card.className = 'result-section';

    const copyId = `macroCopyBtn_${idx}`;
    card.innerHTML = `
      <div class="result-row">
        <strong class="macro-title">${escapeHtml(m.title)}</strong>
        <button id="${copyId}" class="small-btn copy" type="button">Copy</button>
      </div>
      <div class="macro-body">${escapeHtml(m.body)}</div>
    `;

    container.appendChild(card);

    const btn = document.getElementById(copyId);
    btn.addEventListener('click', async () => {
      const ok = await copyTextToClipboard(m.body);
      if (!ok) return;

      const original = btn.textContent;
      btn.textContent = 'Copied';
      setTimeout(() => { btn.textContent = original; }, 1200);
    });
  });
}

/* -------------------------
   DNS fetch + helpers
-------------------------- */
async function checkRecord(domain, type) {
  // Backwards-compatible helper: Google DNS remains the primary resolver.
  return checkRecordGoogle(domain, type);
}

async function checkRecordWithCrossCheck(domain, type, options = {}) {
  const [google, cloudflare] = await Promise.all([
    checkRecordGoogle(domain, type),
    checkRecordCloudflare(domain, type)
  ]);

  const predicate = typeof options.txtPredicate === 'function' ? options.txtPredicate : null;
  const mismatch = didResolversDisagree(type, google.answers, cloudflare.answers, predicate);

  if (mismatch) {
    recordResolverMismatch(domain, type, google.answers, cloudflare.answers, predicate);
  }

  return google;
}

async function checkRecordGoogle(domain, type) {
  try {
    const cacheBust = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const url = new URL('https://dns.google/resolve');
    url.searchParams.set('name', domain);
    url.searchParams.set('type', type);
    url.searchParams.set('_cb', cacheBust);

    const response = await fetch(url.toString(), {
      cache: 'no-store'
    });

    const data = await response.json();
    if (data && Array.isArray(data.Answer) && data.Answer.length > 0) {
      return { found: true, answers: data.Answer };
    }
  } catch (e) {
    console.error(e);
  }

  return { found: false, answers: [] };
}

async function checkRecordCloudflare(domain, type) {
  try {
    const cacheBust = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const url = new URL('https://cloudflare-dns.com/dns-query');
    url.searchParams.set('name', domain);
    url.searchParams.set('type', type);
    url.searchParams.set('ct', 'application/dns-json');
    url.searchParams.set('_cb', cacheBust);

    const response = await fetch(url.toString(), {
      cache: 'no-store',
      headers: {
        accept: 'application/dns-json'
      }
    });

    const data = await response.json();
    if (data && Array.isArray(data.Answer) && data.Answer.length > 0) {
      return { found: true, answers: data.Answer };
    }
  } catch (e) {
    console.error(e);
  }

  return { found: false, answers: [] };
}

function didResolversDisagree(type, googleAnswers, cloudflareAnswers, txtPredicate) {
  const g = buildComparableAnswerSet(type, googleAnswers, txtPredicate);
  const c = buildComparableAnswerSet(type, cloudflareAnswers, txtPredicate);

  if (g.length === 0 && c.length === 0) return false;
  if (g.length !== c.length) return true;

  for (let i = 0; i < g.length; i++) {
    if (g[i] !== c[i]) return true;
  }

  return false;
}

function buildComparableAnswerSet(type, answers, txtPredicate) {
  const raw = Array.isArray(answers) ? answers : [];

  let values = raw
    .map(a => (a && a.data ? a.data : ''))
    .filter(Boolean)
    .map(v => (type === 'TXT' ? stripQuotes(v) : normalizeDomain(stripTrailingDot(v))));

  if (type === 'TXT' && typeof txtPredicate === 'function') {
    values = values.filter(txtPredicate);
  }

  const uniq = [...new Set(values)];
  uniq.sort();
  return uniq;
}

function recordResolverMismatch(domain, type, googleAnswers, cloudflareAnswers, txtPredicate) {
  if (!CURRENT_RUN || !Array.isArray(CURRENT_RUN.resolverMismatches)) return;

  const key = `${type}::${domain}`;
  if (CURRENT_RUN.resolverMismatches.some(m => m.key === key)) return;

  const g = buildComparableAnswerSet(type, googleAnswers, txtPredicate);
  const c = buildComparableAnswerSet(type, cloudflareAnswers, txtPredicate);

  CURRENT_RUN.resolverMismatches.push({
    key,
    domain,
    type,
    google: g,
    cloudflare: c
  });
}

function renderResolverCheckBanner(runState) {
  const el = document.getElementById('resolverCheck');
  if (!el) return;

  if (!runState || !runState.resolverMismatches || runState.resolverMismatches.length === 0) {
    el.textContent = '';
    el.classList.add('hidden');
    el.removeAttribute('style');
    return;
  }

  const items = runState.resolverMismatches.map(m => `${m.type} ${m.domain}`).join(', ');

  el.textContent = `Propagation check: Google DNS and Cloudflare DNS returned different results for ${runState.resolverMismatches.length} lookup(s): ${items}. DNS changes may still be propagating. Try again in a few minutes.`;
  el.classList.remove('hidden');

  el.style.background = '#fff3cd';
  el.style.color = '#856404';
  el.style.border = '1px solid #ffeeba';
  el.style.borderRadius = '5px';
  el.style.padding = '8px 10px';
  el.style.fontSize = '12px';
  el.style.marginBottom = '10px';
}

function normalizeDomain(input) {
  return (input || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/\.+$/, '');
}

function stripTrailingDot(value) {
  return (value || '').toString().replace(/\.+$/, '');
}

function stripQuotes(value) {
  return (value || '').toString().replace(/^"+|"+$/g, '');
}

function toRelativeName(host, rootDomain) {
  const h = normalizeDomain(host);
  const r = normalizeDomain(rootDomain);
  if (!h || !r) return host;

  if (h === r) return '@';
  if (h.endsWith(`.${r}`)) return h.slice(0, -(r.length + 1));
  return h;
}

async function ensurePublicSuffixList() {
  if (PSL_STATE.loaded) return true;
  if (PSL_STATE.loadingPromise) return PSL_STATE.loadingPromise;

  PSL_STATE.loadingPromise = (async () => {
    try {
      const url = chrome.runtime.getURL('public_suffix_list.dat');
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);

      if (!res.ok) throw new Error(`Failed to load PSL: ${res.status}`);
      const text = await res.text();
      parsePublicSuffixList(text);
      PSL_STATE.loaded = true;
      return true;
    } catch (e) {
      console.warn('Public Suffix List could not be loaded. Falling back to heuristic root domain parsing.', e);
      PSL_STATE.loaded = false;
      return false;
    }
  })();

  return PSL_STATE.loadingPromise;
}

function parsePublicSuffixList(text) {
  PSL_STATE.normalRules = new Set();
  PSL_STATE.wildcardRules = new Set();
  PSL_STATE.exceptionRules = new Set();

  (text || '').split(/\r?\n/).forEach((rawLine) => {
    const line = (rawLine || '').trim();
    if (!line || line.startsWith('//')) return;

    if (line.startsWith('!')) {
      PSL_STATE.exceptionRules.add(line.slice(1));
      return;
    }

    if (line.startsWith('*.')) {
      // Store wildcard base without '*.' so we can match labels like "foo.<base>".
      PSL_STATE.wildcardRules.add(line.slice(2));
      return;
    }

    PSL_STATE.normalRules.add(line);
  });
}

function getRootDomain(fullDomain) {
  const domain = normalizeDomain(fullDomain);
  if (!domain) return '';

  // Prefer PSL-based parsing when available.
  if (PSL_STATE.loaded) {
    const registrable = getRegistrableDomainFromPsl(domain);
    if (registrable) return registrable;
  }

  // Fallback heuristic (only used if PSL fails to load).
  return heuristicRootDomain(domain);
}

function heuristicRootDomain(domain) {
  const parts = (domain || '').split('.').filter(Boolean);
  if (parts.length >= 2) {
    const secondLast = parts[parts.length - 2];
    const commonSLDs = ['co', 'com', 'org', 'net', 'gov'];
    if (commonSLDs.includes(secondLast) && parts.length >= 3) {
      return parts.slice(-3).join('.');
    }
    return parts.slice(-2).join('.');
  }
  return domain;
}

function getRegistrableDomainFromPsl(domain) {
  const labels = (domain || '').split('.').filter(Boolean);
  if (labels.length <= 1) return domain;

  // 1) Exception rules (longest match wins)
  for (let i = 0; i < labels.length; i++) {
    const suffix = labels.slice(i).join('.');
    if (PSL_STATE.exceptionRules.has(suffix)) {
      // For an exception rule (e.g. !city.kawasaki.jp), the registrable domain is the exception itself.
      return suffix;
    }
  }

  // 2) Find the longest matching rule among normal and wildcard rules.
  // Default public suffix is the TLD (1 label).
  let publicSuffixLabelCount = 1;

  for (let i = 0; i < labels.length; i++) {
    const suffix = labels.slice(i).join('.');

    if (PSL_STATE.normalRules.has(suffix)) {
      publicSuffixLabelCount = Math.max(publicSuffixLabelCount, labels.length - i);
    }

    // Wildcard rules: if "*.base" exists, then "label.base" is a public suffix.
    if (i < labels.length - 1) {
      const wildcardBase = labels.slice(i + 1).join('.');
      if (PSL_STATE.wildcardRules.has(wildcardBase)) {
        publicSuffixLabelCount = Math.max(publicSuffixLabelCount, labels.length - i);
      }
    }
  }

  // Registrable domain is one label longer than the public suffix.
  if (labels.length <= publicSuffixLabelCount) return domain;
  return labels.slice(labels.length - (publicSuffixLabelCount + 1)).join('.');
}

/* -------------------------
   UI helpers
-------------------------- */
function renderSummaryCard(containerId, label, status, value, badgeClass) {
  const container = document.getElementById(containerId);
  const row = document.createElement('div');
  row.className = 'result-section';
  row.innerHTML = `
    <div class="result-row">
      <strong>${label}</strong>
      <span class="status-badge ${badgeClass}">${status}</span>
    </div>
    <span class="record-value" title="${escapeHtml(value)}">${escapeHtml(value)}</span>
  `;
  container.appendChild(row);
}

function renderRecordCard(containerId, label, status, type, name, value, badgeClass) {
  const container = document.getElementById(containerId);

  const row = document.createElement('div');
  row.className = 'result-section';

  row.innerHTML = `
    <div class="result-row">
      <strong>${label}</strong>
      <span class="status-badge ${badgeClass}">${status}</span>
    </div>
    <div class="dns-grid">
      <div class="dns-head">Type</div>
      <div class="dns-head">Name</div>
      <div class="dns-head">Value</div>

      <div class="dns-mono" title="${escapeHtml(type)}">${escapeHtml(type)}</div>
      <div class="dns-mono" title="${escapeHtml(name)}">${escapeHtml(name)}</div>
      <div class="dns-wrap" title="${escapeHtml(value)}">${escapeHtml(value)}</div>
    </div>
  `;
  container.appendChild(row);
}

function renderInfoNote(containerId, message) {
  const container = document.getElementById(containerId);
  const noteRow = document.createElement('div');
  noteRow.style.cssText = 'background: #e3f2fd; color: #0d47a1; padding: 8px; border-radius: 4px; font-size: 12px; margin-bottom: 8px; border: 1px solid #bbdefb;';
  noteRow.innerHTML = message;
  container.appendChild(noteRow);
}

function escapeHtml(str) {
  return (str || '').toString()
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

/* -------------------------
   Last checked + clear
-------------------------- */
function renderLastChecked(dateObj) {
  const el = document.getElementById('lastChecked');
  el.textContent = `Last checked: ${dateObj.toLocaleString()}`;
  el.classList.remove('hidden');
}

function clearData() {
  document.getElementById('sendingDomain').value = '';
  document.getElementById('trackingDomain').value = '';
  chrome.storage.local.clear();

  clearResults();
  hideResults();
  hideLoading();

  const last = document.getElementById('lastChecked');
  last.textContent = '';
  last.classList.add('hidden');

  const resolverCheck = document.getElementById('resolverCheck');
  if (resolverCheck) {
    resolverCheck.textContent = '';
    resolverCheck.classList.add('hidden');
    resolverCheck.removeAttribute('style');
  }

  CURRENT_RUN = null;

  // Reset macros back to placeholder DMARC
  renderCnxMacros(null);
}

function clearResults() {
  document.getElementById('summaryResults').innerHTML = '';
  document.getElementById('sendingResults').innerHTML = '';
  document.getElementById('rootResults').innerHTML = '';
  document.getElementById('dmarcResults').innerHTML = '';
  document.getElementById('trackingResults').innerHTML = '';
}

function showLoading() {
  document.getElementById('loading').classList.remove('hidden');
}

function hideLoading() {
  document.getElementById('loading').classList.add('hidden');
}

function showResults() {
  document.getElementById('resultsArea').classList.remove('hidden');
  const summaryArea = document.getElementById('summaryArea');
  if (summaryArea) summaryArea.classList.remove('hidden');
}

function hideResults() {
  document.getElementById('resultsArea').classList.add('hidden');
  const summaryArea = document.getElementById('summaryArea');
  if (summaryArea) summaryArea.classList.add('hidden');
}

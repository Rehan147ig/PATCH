/* apimigrate Enterprise dashboard — reactive SPA logic */

const $ = (sel) => document.querySelector(sel);

// ---- Navigation ----
document.querySelectorAll('.nav-link').forEach((link) => {
  link.addEventListener('click', (e) => {
    e.preventDefault();
    document.querySelectorAll('.nav-link').forEach((l) => l.classList.remove('active'));
    link.classList.add('active');
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    const view = link.dataset.view;
    const el = document.getElementById(view);
    if (el) el.classList.add('active');
  });
});

// ---- Overview ----
async function loadOverview() {
  try {
    const res = await fetch('/api/overview');
    const data = await res.json();
    $('#stat-vendors').textContent = data.vendorsTracked ?? 0;
    $('#stat-drifts').textContent = data.activeDrifts ?? 0;
    $('#stat-remediated').textContent = data.autoRemediated ?? 0;
    $('#stat-files').textContent = data.affectedFiles ?? 0;

    const spec = data.riskSpectrum ?? { low: 0, medium: 0, high: 0 };
    const total = Math.max(1, spec.low + spec.medium + spec.high);
    $('#risk-low').style.width = (spec.low / total) * 100 + '%';
    $('#risk-medium').style.width = (spec.medium / total) * 100 + '%';
    $('#risk-high').style.width = (spec.high / total) * 100 + '%';
    $('#count-low').textContent = spec.low;
    $('#count-medium').textContent = spec.medium;
    $('#count-high').textContent = spec.high;

    const body = $('#drift-body');
    body.innerHTML = '';
    for (const r of data.reports ?? []) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escapeHtml(r.vendor)}</td>
        <td>${escapeHtml(r.title)}</td>
        <td><span class="pill ${r.severity}">${r.severity}</span></td>
        <td>${r.hits}</td>`;
      body.appendChild(tr);
    }
    if ((data.reports ?? []).length === 0) {
      body.innerHTML = '<tr><td colspan="4" class="muted">No scans yet — run one in Live Scan.</td></tr>';
    }
  } catch (err) {
    $('#stat-drifts').textContent = 'ERR';
    console.error('overview failed', err);
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- Live Scan ----
let lastReports = [];

$('#scan-btn').addEventListener('click', async () => {
  const repoDir = $('#repo-dir').value.trim();
  if (!repoDir) {
    $('#scan-results').innerHTML = '<p class="muted">Enter a repo directory first.</p>';
    return;
  }
  const services = $('#services').value.split(',').map((s) => s.trim()).filter(Boolean);

  const btn = $('#scan-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Scanning…';

  try {
    const res = await fetch('/api/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoDir, services }),
    });
    const data = await res.json();
    lastReports = data.reports ?? [];
    renderScanResults(data);
    if (res.ok) {
      $('#repo-dir').value = '';
      await loadOverview();
    }
  } catch (err) {
    $('#scan-results').innerHTML = `<p class="muted">Scan failed: ${escapeHtml(err.message)}</p>`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Run Scan';
  }
});

function renderScanResults(data) {
  const box = $('#scan-results');
  if (!data.reports || data.reports.length === 0) {
    box.innerHTML = '<p class="muted">No affected usages found. Clean bill of health.</p>';
    return;
  }
  const summary = data.summary ?? {};
  box.innerHTML = `<p class="muted" style="margin-bottom:12px">
    ${data.reports.length} manifest(s) fired · ${summary.totalHits ?? 0} hits ·
    ${summary.autoFixable ?? 0} auto-fixable
  </p>`;

  for (const report of data.reports) {
    const header = document.createElement('div');
    header.innerHTML = `<h3 style="margin:14px 0 8px">${escapeHtml(report.manifest.vendor)} — ${escapeHtml(report.manifest.title)}</h3>`;
    box.appendChild(header);
    for (const hit of report.hits.slice(0, 15)) {
      const card = document.createElement('div');
      card.className = 'hit-card';
      const risk = hit.risk ?? 'LOW';
      card.innerHTML = `
        <div class="hit-head">
          <span class="pill ${risk.toLowerCase()}">${risk}</span>
          <span class="hit-file">${escapeHtml(hit.file)}:${hit.line}${hit.lineRange ? `–${hit.lineRange.end}` : ''}</span>
        </div>
        <div class="hit-snippet">${escapeHtml(hit.snippet)}</div>
        <div class="hit-desc">${escapeHtml(report.manifest.changes[hit.changeIndex]?.description ?? '')}</div>`;
      card.addEventListener('click', () => showDiff(report, hit));
      box.appendChild(card);
    }
  }
}

function showDiff(report, hit) {
  const change = report.manifest.changes[hit.changeIndex];
  const box = $('#diff-view');
  const from = hit.snippet;
  const to = hit.replacement ?? '⚠ manual migration required';
  const html = `<pre><span class="diff-del">- ${escapeHtml(from)}</span>\n<span class="diff-add">+ ${escapeHtml(to)}</span>\n\n${escapeHtml(change?.description ?? '')}\n${escapeHtml(change?.fix?.explain ?? '')}</pre>`;
  box.innerHTML = html;
}

// ---- Catalog ----
async function loadCatalog() {
  try {
    const res = await fetch('/api/manifests');
    const { manifests } = await res.json();
    const grid = $('#catalog-grid');
    grid.innerHTML = '';
    for (const m of manifests ?? []) {
      const card = document.createElement('div');
      card.className = 'catalog-card';
      const changeList = (m.changes ?? [])
        .slice(0, 5)
        .map((c) => `<li>${escapeHtml(c.description)}</li>`)
        .join('');
      card.innerHTML = `
        <div class="vendor">${escapeHtml(m.vendor)}</div>
        <h3>${escapeHtml(m.title)}</h3>
        <div class="catalog-meta">
          <span class="pill ${m.severity}">${m.severity}</span>
          <span>eff. ${escapeHtml(m.changedAt)}</span>
        </div>
        <ul class="catalog-changes">${changeList}</ul>`;
      grid.appendChild(card);
    }
  } catch (err) {
    $('#catalog-grid').innerHTML = `<p class="muted">Failed to load catalog: ${escapeHtml(err.message)}</p>`;
  }
}

// ---- Telemetry ----
async function loadTelemetry() {
  try {
    const res = await fetch('/api/telemetry');
    const data = await res.json();

    const sunset = $('#sunset-list');
    if ((data.approachingSunset ?? []).length === 0) {
      sunset.innerHTML = '<p class="muted">No approaching sunsets.</p>';
    } else {
      sunset.innerHTML = '';
      for (const s of data.approachingSunset) {
        const div = document.createElement('div');
        div.className = 'sunset-item';
        div.innerHTML = `<span>${escapeHtml(s.vendor)} — ${escapeHtml(s.id)}</span><span class="date">${escapeHtml(s.changedAt)}</span>`;
        sunset.appendChild(div);
      }
    }

    const rules = $('#telemetry-rules');
    rules.innerHTML = '';
    for (const r of data.rules ?? []) {
      const div = document.createElement('div');
      div.className = 'rule-item';
      const match = r.match ?? {};
      const target = match.endpoint ? `${(match.endpoint.method || '').toUpperCase()} ${match.endpoint.path}` : match.telemetry?.header ?? '';
      div.innerHTML = `<span><strong>${escapeHtml(r.vendor)}</strong> — ${escapeHtml(target)}</span><span class="muted">${escapeHtml(r.description)}</span>`;
      rules.appendChild(div);
    }
    if ((data.rules ?? []).length === 0) {
      rules.innerHTML = '<p class="muted">No telemetry rules tracked yet.</p>';
    }
  } catch (err) {
    $('#telemetry-rules').innerHTML = `<p class="muted">Failed: ${escapeHtml(err.message)}</p>`;
  }
}

// ---- Boot ----
loadOverview();
loadCatalog();
loadTelemetry();
// Refresh overview every 30s.
setInterval(loadOverview, 30000);

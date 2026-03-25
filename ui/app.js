'use strict';

let lastDashboardData = null;
let refreshInterval = 3000;

// ── Utility functions ──

function openExternal(url) { window.api.openExternal(url); }
function openConsole(url) { window.api.openConsole(url); }

function formatTokens(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

function formatCost(n) {
  if (n >= 1000) return '$' + (n / 1000).toFixed(1) + 'K';
  if (n >= 100) return '$' + Math.round(n);
  return '$' + n.toFixed(2);
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return h + 'h ' + m + 'm';
  if (m > 0) return m + 'm';
  return '<1m';
}

function shortModel(m) {
  return String(m).replace('claude-', '').replace(/-\d{8}$/, '').replace('-latest', '');
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Trend comparison helper (Item 11) ──

function trendBadge(current, previous) {
  if (previous === 0 && current === 0) return '';
  if (previous === 0) return '<span class="trend-badge up">NEW</span>';
  const pctChange = Math.round(((current - previous) / previous) * 100);
  if (pctChange > 5) return `<span class="trend-badge up">+${pctChange}%</span>`;
  if (pctChange < -5) return `<span class="trend-badge down">${pctChange}%</span>`;
  return '<span class="trend-badge flat">~0%</span>';
}

function getWeekData(dailyHistory, offset) {
  // offset=0: current week (last 7 days), offset=1: previous week (days 8-14)
  const start = offset * 7;
  const end = start + 7;
  const slice = (dailyHistory || []).slice(-(end)).slice(0, 7);
  return {
    messages: slice.reduce((s, d) => s + (d.messages || 0), 0),
    tokens: slice.reduce((s, d) => s + (d.tokens || 0), 0),
    sessions: slice.reduce((s, d) => s + (d.sessions || 0), 0),
  };
}

// ── Render functions ──

function renderErrors(errors) {
  const container = document.getElementById('errorBanner');
  if (!container) return;
  if (!errors || errors.length === 0) {
    container.style.display = 'none';
    return;
  }
  container.style.display = 'block';
  container.innerHTML = `
    <details>
      <summary>${errors.length} issue${errors.length > 1 ? 's' : ''} detected</summary>
      <ul>${errors.map(e => `<li>[${escHtml(e.source)}] ${escHtml(e.message)}</li>`).join('')}</ul>
    </details>`;
}

function renderSessions(sessions) {
  const container = document.getElementById('sessionsContainer');
  const active = sessions.filter(s => s.alive);
  const dead = sessions.filter(s => !s.alive);

  const activeEl = document.getElementById('activeCount');
  if (activeEl) activeEl.textContent = active.length + ' active';

  if (sessions.length === 0) {
    container.innerHTML = '<div class="empty-state">No CLI sessions detected</div>';
    return;
  }

  const allSessions = [...active, ...dead];
  const maxOut = Math.max(...allSessions.map(s => s.outputTokens), 1);

  let rows = '';
  for (const s of allSessions) {
    const barPct = Math.max(5, (s.outputTokens / maxOut) * 100);
    const deadClass = s.alive ? '' : ' dead';
    const modelLabel = shortModel(s.model);
    rows += `
      <div class="session-row${deadClass}">
        <div class="bar-bg" style="width:${barPct}%"></div>
        <span class="status-dot ${s.alive ? 'active' : 'dead'}"></span>
        <span class="session-project" title="${escHtml(s.cwd)}">${escHtml(s.project)}</span>
        <span class="session-model">${escHtml(modelLabel)}</span>
        <div class="session-meta">
          <span><span class="val">${formatTokens(s.outputTokens)}</span> out</span>
          <span><span class="val">${s.messageCount}</span> msg</span>
          <span>${formatDuration(s.uptime)}</span>
        </div>
      </div>`;
  }
  container.innerHTML = `<div class="session-list">${rows}</div>`;
}

function renderCompare(data) {
  const { today, month, dailyTokenHistory, dailyHistory } = data;

  // Item 11: Week-over-week trend comparison
  const thisWeek = getWeekData(dailyHistory, 0);
  const lastWeek = getWeekData(dailyHistory, 1);
  const thisWeekTok = getWeekData(dailyTokenHistory, 0);
  const lastWeekTok = getWeekData(dailyTokenHistory, 1);

  document.getElementById('compareContainer').innerHTML = `
    <div class="compare-col">
      <div class="col-title">Today</div>
      <div class="compare-row">
        <span class="label">Messages</span>
        <span class="val color-accent">${today.messages.toLocaleString()}</span>
      </div>
      <div class="compare-row">
        <span class="label">Tokens</span>
        <span class="val color-cyan">${formatTokens(today.tokens)}</span>
      </div>
      <div class="compare-row">
        <span class="label">Sessions</span>
        <span class="val">${today.sessions}</span>
      </div>
      <div class="compare-row">
        <span class="label">Tools</span>
        <span class="val">${today.tools}</span>
      </div>
      <div class="compare-cost">
        <span class="label">Est. Cost</span>
        <span class="cost-val">${formatCost(today.cost)}</span>
      </div>
    </div>
    <div class="compare-col">
      <div class="col-title">This Month</div>
      <div class="compare-row">
        <span class="label">Messages</span>
        <span class="val color-accent">${month.messages.toLocaleString()}</span>
      </div>
      <div class="compare-row">
        <span class="label">Tokens</span>
        <span class="val color-cyan">${formatTokens(month.tokens)}</span>
      </div>
      <div class="compare-row">
        <span class="label">Sessions</span>
        <span class="val">${month.sessions || 0}</span>
      </div>
      <div class="compare-row">
        <span class="label">Tools</span>
        <span class="val">${(month.tools || 0).toLocaleString()}</span>
      </div>
      <div class="compare-cost">
        <span class="label">Est. Cost</span>
        <span class="cost-val">${formatCost(month.cost)}</span>
      </div>
    </div>
  `;

  // Item 11: Render weekly trend comparison
  const trendEl = document.getElementById('weeklyTrendContainer');
  if (trendEl) {
    trendEl.innerHTML = `
      <div class="compare-grid">
        <div class="compare-col">
          <div class="col-title">This Week</div>
          <div class="compare-row">
            <span class="label">Messages ${trendBadge(thisWeek.messages, lastWeek.messages)}</span>
            <span class="val color-accent">${thisWeek.messages.toLocaleString()}</span>
          </div>
          <div class="compare-row">
            <span class="label">Tokens ${trendBadge(thisWeekTok.tokens, lastWeekTok.tokens)}</span>
            <span class="val color-cyan">${formatTokens(thisWeekTok.tokens)}</span>
          </div>
          <div class="compare-row">
            <span class="label">Sessions ${trendBadge(thisWeek.sessions, lastWeek.sessions)}</span>
            <span class="val">${thisWeek.sessions}</span>
          </div>
        </div>
        <div class="compare-col">
          <div class="col-title">Last Week</div>
          <div class="compare-row">
            <span class="label">Messages</span>
            <span class="val color-accent">${lastWeek.messages.toLocaleString()}</span>
          </div>
          <div class="compare-row">
            <span class="label">Tokens</span>
            <span class="val color-cyan">${formatTokens(lastWeekTok.tokens)}</span>
          </div>
          <div class="compare-row">
            <span class="label">Sessions</span>
            <span class="val">${lastWeek.sessions}</span>
          </div>
        </div>
      </div>`;
  }
}

function renderEfficiency(eff) {
  document.getElementById('efficiencyContainer').innerHTML = `
    <div class="eff-card">
      <div class="eff-val color-accent">${formatTokens(eff.avgTokensPerMsg)}</div>
      <div class="eff-label">Avg Tokens / Msg</div>
    </div>
    <div class="eff-card">
      <div class="eff-val color-green">${eff.cacheHitRate}%</div>
      <div class="eff-label">Cache Hit Rate</div>
    </div>
    <div class="eff-card">
      <div class="eff-val color-orange">${eff.toolsPerMsg}</div>
      <div class="eff-label">Tools / Msg</div>
    </div>
  `;
}

function renderUsageProgress(data) {
  const { today, account } = data;
  const dailyPct = Math.min(100, account.todayVsAvgPct);
  let barClass = '';
  if (dailyPct > 150) barClass = 'danger';
  else if (dailyPct > 80) barClass = 'warn';

  document.getElementById('usageProgressContainer').innerHTML = `
    <div class="progress-wrap">
      <div class="progress-header">
        <span class="progress-label">Today vs Historical Average</span>
        <span class="progress-pct">${account.todayVsAvgPct}% (avg ${formatTokens(account.avgDailyTokens)} tok/day)</span>
      </div>
      <div class="progress-bar">
        <div class="progress-fill ${barClass}" style="width: ${Math.min(100, dailyPct)}%"></div>
      </div>
    </div>
  `;
}

function renderChart(dailyTokenHistory, dailyMsgHistory) {
  const container = document.getElementById('tokenChart');
  const legend = document.getElementById('chartLegend');

  legend.innerHTML = `
    <div class="chart-legend-item">
      <div class="chart-legend-dot" style="background: var(--accent)"></div>
      Tokens
    </div>
    <div class="chart-legend-item">
      <div class="chart-legend-dot" style="background: var(--cyan)"></div>
      Messages
    </div>
  `;

  if (!dailyTokenHistory || dailyTokenHistory.length === 0) {
    container.innerHTML = '<div class="empty-state">No data</div>';
    return;
  }

  const maxTok = Math.max(...dailyTokenHistory.map(d => d.tokens), 1);
  const msgs = dailyMsgHistory || [];
  const maxMsg = Math.max(...msgs.map(d => d.messages), 1);

  let html = '';
  for (let i = 0; i < dailyTokenHistory.length; i++) {
    const d = dailyTokenHistory[i];
    const m = msgs[i] || { messages: 0 };
    const tokH = Math.max(1, (d.tokens / maxTok) * 42);
    const msgH = Math.max(1, (m.messages / maxMsg) * 14);
    const label = d.date.slice(5);
    html += `
      <div class="chart-bar-col" title="${label}: ${formatTokens(d.tokens)} tok / ${m.messages} msg">
        <div class="chart-bar-stack">
          <div class="chart-bar tokens" style="height:${tokH}px"></div>
          <div class="chart-bar msgs" style="height:${msgH}px"></div>
        </div>
        <div class="chart-bar-label">${label}</div>
      </div>`;
  }
  container.innerHTML = html;
}

function renderModelUsage(aggregate) {
  const card = document.getElementById('modelCard');
  const models = Object.entries(aggregate.modelUsage);

  if (models.length === 0) {
    card.innerHTML = '<div class="empty-state">No model data</div>';
    return;
  }

  const totals = models.map(([, u]) =>
    (u.inputTokens || 0) + (u.outputTokens || 0) + (u.cacheReadInputTokens || 0)
  );
  const maxTotal = Math.max(...totals, 1);

  let html = `
    <div class="model-bar-legend">
      <span><span class="seg-dot" style="background:var(--accent)"></span>Input</span>
      <span><span class="seg-dot" style="background:var(--orange)"></span>Output</span>
      <span><span class="seg-dot" style="background:var(--green)"></span>Cache</span>
    </div>
  `;

  for (const [model, usage] of models) {
    const name = shortModel(model);
    const inp = usage.inputTokens || 0;
    const out = usage.outputTokens || 0;
    const cache = usage.cacheReadInputTokens || 0;
    const total = inp + out + cache;
    const barW = Math.max(5, (total / maxTotal) * 100);
    const inpPct = total > 0 ? (inp / total * 100) : 0;
    const outPct = total > 0 ? (out / total * 100) : 0;
    const cachePct = total > 0 ? (cache / total * 100) : 0;
    const cacheRate = (inp + cache) > 0 ? Math.round(cache / (inp + cache) * 100) : 0;

    html += `
      <div class="model-item">
        <div class="model-item-header">
          <span class="model-name">${escHtml(name)}</span>
          <span class="model-total">${formatTokens(total)} total · ${cacheRate}% cache</span>
        </div>
        <div class="model-bar-track" style="width:${barW}%">
          <div class="model-bar-seg input" style="width:${inpPct}%"></div>
          <div class="model-bar-seg output" style="width:${outPct}%"></div>
          <div class="model-bar-seg cache" style="width:${cachePct}%"></div>
        </div>
      </div>`;
  }
  card.innerHTML = html;
}

function renderAllTime(aggregate) {
  document.getElementById('allTimeGrid').innerHTML = `
    <div class="usage-card">
      <div class="title">Total Messages</div>
      <div class="value color-cyan">${aggregate.totalMessages.toLocaleString()}</div>
      <div class="sub">${aggregate.totalSessions} sessions</div>
    </div>
    <div class="usage-card">
      <div class="title">Est. Total Cost</div>
      <div class="value color-yellow">${formatCost(aggregate.costEstimate)}</div>
      <div class="sub">based on token pricing</div>
    </div>
  `;
}

// ── Plan Usage ──
let planUsageCache = null;
let planFetching = false;

function barColor(pct) {
  if (pct >= 80) return 'red';
  if (pct >= 50) return 'orange';
  if (pct >= 25) return 'yellow';
  return 'green';
}

function renderPlanUsage(data) {
  const container = document.getElementById('planUsageContainer');

  if (!data || data.error === 'not_logged_in') {
    container.innerHTML = `
      <div class="plan-login-hint">
        Please login to claude.ai first to view usage data.
        <br>
        <button class="plan-login-btn" onclick="window.api.openConsoleLogin()">Login to Claude</button>
      </div>`;
    return;
  }

  if (data.error === 'timeout') {
    container.innerHTML = `
      <div class="plan-login-hint">
        Unable to load usage data. Please login first.
        <br>
        <button class="plan-login-btn" onclick="window.api.openConsoleLogin()">Login to Claude</button>
        <br><br>
        <button class="plan-refresh-btn" onclick="fetchPlanUsage()">Retry</button>
      </div>`;
    return;
  }

  if (data.error) {
    container.innerHTML = `<div class="plan-login-hint">Error: ${escHtml(data.error)}</div>`;
    return;
  }

  let html = '';

  for (const item of (data.limits || [])) {
    const color = barColor(item.pct);
    html += `
      <div class="plan-usage-card">
        <div class="plan-row">
          <span class="plan-label">${escHtml(item.label)}</span>
          <span class="plan-pct" style="color: var(--${color})">${item.pct}%</span>
        </div>
        <div class="plan-bar">
          <div class="plan-bar-fill ${color}" style="width: ${item.pct}%"></div>
        </div>
        <div class="plan-meta">
          <span>${escHtml(item.reset || '')}</span>
          <span>${item.pct}% used</span>
        </div>
      </div>`;
  }

  if (data.extraUsage) {
    const eu = data.extraUsage;
    const euPct = eu.limit ? Math.round((eu.spent / eu.limit) * 100) : 0;
    const euColor = barColor(euPct);
    html += `
      <div class="plan-usage-card">
        <div class="plan-row">
          <span class="plan-label">Extra Usage</span>
          <span class="plan-pct" style="color: var(--${euColor})">$${eu.spent.toFixed(2)}</span>
        </div>
        <div class="plan-bar">
          <div class="plan-bar-fill ${euColor}" style="width: ${euPct}%"></div>
        </div>
        <div class="plan-meta">
          <span>${eu.reset || ''}</span>
          <span>${eu.limit ? '$' + eu.limit.toFixed(0) + ' limit' : ''}</span>
        </div>
      </div>`;
  }

  if (!html) {
    html = `<div class="plan-login-hint">No usage data found.
      <br><button class="plan-login-btn" onclick="window.api.openConsoleLogin()">Login to Claude</button>
      <br><button class="plan-refresh-btn" style="margin-top:6px" onclick="fetchPlanUsage()">Retry</button></div>`;
  } else {
    html += `
      <div class="plan-refresh">
        <span>Last updated: ${new Date().toLocaleTimeString('zh-TW', { hour12: false })}</span>
        <button class="plan-refresh-btn" onclick="fetchPlanUsage()">Refresh</button>
      </div>`;
  }

  container.innerHTML = html;
}

async function fetchPlanUsage() {
  if (planFetching) return;
  planFetching = true;
  const container = document.getElementById('planUsageContainer');
  container.innerHTML = '<div class="plan-login-hint">Loading usage data...</div>';
  try {
    const data = await window.api.fetchPlanUsage();
    planUsageCache = data;
    renderPlanUsage(data);
  } catch (e) {
    container.innerHTML = '<div class="plan-login-hint">Failed to load usage data.</div>';
  }
  planFetching = false;
}

function renderAccount(account) {
  const card = document.getElementById('accountCard');
  if (!account || !account.email) {
    card.innerHTML = `<div class="empty-state">${t('noAccount')}</div>`;
    return;
  }

  const initial = (account.name || 'C')[0].toUpperCase();
  const isActive = account.hasExtraUsage && !account.extraUsageDisabledReason;
  const planLabel = isActive ? 'Max Active' : 'Limited';
  const planClass = isActive ? '' : 'inactive';

  const billingMap = { 'stripe_subscription': 'Pro / Max', 'api_key': 'API Key' };
  const billingDisplay = billingMap[account.billingType] || account.billingType;

  const intensityPct = Math.min(100, account.todayVsPeakPct);
  let intensityClass = 'low';
  let intensityLabel = t('low');
  if (intensityPct > 70) { intensityClass = 'high'; intensityLabel = t('high'); }
  else if (intensityPct > 40) { intensityClass = 'mid'; intensityLabel = t('mid'); }

  let subAge = '';
  if (account.subscriptionCreatedAt) {
    const subDate = new Date(account.subscriptionCreatedAt);
    const days = Math.floor((Date.now() - subDate.getTime()) / 86400000);
    subAge = String(days);
  }

  card.innerHTML = `
    <div class="account-header">
      <div class="account-avatar">${initial}</div>
      <div class="account-info">
        <div class="account-name">${escHtml(account.name)}</div>
        <div class="account-email">${escHtml(account.email)}</div>
      </div>
      <span class="account-plan-badge ${planClass}">${planLabel}</span>
    </div>
    <div class="account-metrics">
      <div class="account-metric">
        <div class="value color-accent">${billingDisplay}</div>
        <div class="label">${t('plan')}</div>
      </div>
      <div class="account-metric">
        <div class="value color-green">${subAge}</div>
        <div class="label">${t('subDays')}</div>
      </div>
      <div class="account-metric">
        <div class="value color-cyan">${escHtml(account.orgRole)}</div>
        <div class="label">${t('role')}</div>
      </div>
    </div>
    <div class="intensity-bar-wrap">
      <div class="intensity-header">
        <span class="intensity-label">${t('intensityLabel')}</span>
        <span class="intensity-value ${intensityClass === 'high' ? 'color-yellow' : ''}">${intensityPct}% · ${intensityLabel}</span>
      </div>
      <div class="intensity-bar">
        <div class="intensity-fill ${intensityClass}" style="width: ${intensityPct}%"></div>
      </div>
    </div>
    ${account.guestPassesRemaining !== null ? `
    <div class="guest-passes">
      🎟️ ${t('guestPasses')}: <span class="count">${account.guestPassesRemaining}</span>
    </div>` : ''}
  `;
}

function renderHeatmap(hourCounts, weekdayHourCounts) {
  const grid = document.getElementById('heatmapGrid');
  const labels = document.getElementById('heatmapLabels');

  if (weekdayHourCounts && weekdayHourCounts.length === 7) {
    grid.classList.remove('heatmap-flat');
    labels.classList.remove('heatmap-labels-flat');
    const allValues = weekdayHourCounts.flat();
    const max = Math.max(...allValues, 1);
    const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    let html = '';
    for (let d = 0; d < 7; d++) {
      html += '<div class="heatmap-row">';
      html += '<span class="heatmap-day">' + dayLabels[d] + '</span>';
      for (let h = 0; h < 24; h++) {
        const v = weekdayHourCounts[d][h] || 0;
        const pct = v / max;
        let cls = '';
        if (pct > 0.75) cls = 'h4';
        else if (pct > 0.5) cls = 'h3';
        else if (pct > 0.25) cls = 'h2';
        else if (pct > 0) cls = 'h1';
        html += '<div class="heatmap-cell ' + cls + '" title="' + dayLabels[d] + ' ' + h + ':00 — ' + v + ' sessions"></div>';
      }
      html += '</div>';
    }
    grid.innerHTML = html;
  } else {
    grid.classList.add('heatmap-flat');
    labels.classList.add('heatmap-labels-flat');
    if (!hourCounts || hourCounts.length === 0) {
      grid.innerHTML = '<div class="empty-state">No data</div>';
      labels.innerHTML = '';
      return;
    }
    const max = Math.max(...hourCounts, 1);
    let cells = '';
    for (let h = 0; h < 24; h++) {
      const v = hourCounts[h] || 0;
      const pct = v / max;
      let cls = '';
      if (pct > 0.75) cls = 'h4';
      else if (pct > 0.5) cls = 'h3';
      else if (pct > 0.25) cls = 'h2';
      else if (pct > 0) cls = 'h1';
      cells += '<div class="heatmap-cell ' + cls + '" title="' + h + ':00 — ' + v + ' sessions"></div>';
    }
    grid.innerHTML = cells;
  }

  let lbls = '';
  for (let h = 0; h < 24; h += 3) { lbls += '<span>' + h + '</span>'; }
  labels.innerHTML = lbls;
}

function renderRecords(data) {
  const grid = document.getElementById('recordsGrid');
  const firstDate = data.firstSessionDate ? new Date(data.firstSessionDate).toLocaleDateString() : '—';
  const totalDays = data.firstSessionDate
    ? Math.floor((Date.now() - new Date(data.firstSessionDate).getTime()) / 86400000)
    : 0;
  const longest = data.longestSession;
  const longestDur = longest ? formatDuration(longest.duration) : '—';
  const longestMsgs = longest ? longest.messageCount : 0;

  grid.innerHTML = `
    <div class="record-item">
      <div class="rec-val color-accent">${firstDate}</div>
      <div class="rec-label">First Session</div>
    </div>
    <div class="record-item">
      <div class="rec-val color-green">${totalDays} d</div>
      <div class="rec-label">Days Using</div>
    </div>
    <div class="record-item">
      <div class="rec-val color-cyan">${data.numStartups || 0}</div>
      <div class="rec-label">Startups</div>
    </div>
    <div class="record-item">
      <div class="rec-val color-yellow">${longestDur}</div>
      <div class="rec-label">Longest Session</div>
    </div>
    <div class="record-item">
      <div class="rec-val color-accent">${longestMsgs.toLocaleString()}</div>
      <div class="rec-label">Msgs in Longest</div>
    </div>
    <div class="record-item">
      <div class="rec-val color-orange">${data.webSearches || 0}</div>
      <div class="rec-label">Web Searches</div>
    </div>
  `;
}

function renderProjects(projectStats) {
  const container = document.getElementById('projectTable');
  if (!projectStats || projectStats.length === 0) {
    container.innerHTML = '<div class="empty-state">No project data</div>';
    return;
  }
  const top = projectStats.slice(0, 10);
  let rows = `
    <div class="project-table-row header">
      <span class="proj-name">Project</span>
      <span class="proj-cost">Cost</span>
      <span class="proj-lines">+/-</span>
    </div>`;
  for (const p of top) {
    rows += `
      <div class="project-table-row">
        <span class="proj-name" title="${escHtml(p.name)}">${escHtml(p.name)}</span>
        <span class="proj-cost">${formatCost(p.cost)}</span>
        <span class="proj-lines"><span class="added">+${p.linesAdded.toLocaleString()}</span> <span class="removed">-${p.linesRemoved.toLocaleString()}</span></span>
      </div>`;
  }
  container.innerHTML = `<div class="project-table">${rows}</div>`;
}

function renderDesktop(desktopInfo) {
  const container = document.getElementById('desktopCard');
  if (desktopInfo && desktopInfo.installed) {
    container.innerHTML = `
      <div class="desktop-card">
        <div class="desktop-icon">🖥</div>
        <div class="desktop-info">
          <div class="dt-name">Claude Desktop</div>
          <div class="dt-ver">v${escHtml(desktopInfo.version)}</div>
        </div>
        <span class="desktop-badge">Installed</span>
      </div>`;
  } else {
    container.innerHTML = `
      <div class="desktop-card">
        <div class="desktop-icon" style="opacity:0.4">🖥</div>
        <div class="desktop-info">
          <div class="dt-name">Claude Desktop</div>
          <div class="dt-ver">Not detected</div>
        </div>
        <span class="desktop-badge not-found">Not Found</span>
      </div>`;
  }
}

function renderAllProjects(allProjects) {
  const container = document.getElementById('allProjectsContainer');
  if (!allProjects || allProjects.length === 0) {
    container.innerHTML = '<div class="empty-state">No projects found</div>';
    return;
  }
  let rows = `
    <div class="ap-row header">
      <span style="width:7px"></span>
      <span class="ap-name">Project</span>
      <span class="ap-stat">Sess</span>
      <span class="ap-stat">Msgs</span>
      <span class="ap-stat">Tokens</span>
    </div>`;
  for (const p of allProjects) {
    rows += `
    <div class="ap-row" title="${escHtml(p.path)}">
      <span class="ap-exists ${p.exists ? 'yes' : 'no'}"></span>
      <span class="ap-name">${escHtml(p.name)}</span>
      <span class="ap-stat accent">${p.sessionCount}</span>
      <span class="ap-stat">${p.messageCount.toLocaleString()}</span>
      <span class="ap-stat cyan">${formatTokens(p.totalTokens)}</span>
    </div>`;
  }
  container.innerHTML = `
    <div class="all-projects-wrap">${rows}</div>
    <div class="ap-count">${allProjects.length} projects · ${allProjects.filter(p => p.exists).length} active</div>
  `;
}

// ── i18n system ──
const LANGS = [
  { code: 'zh-TW', flag: '🇹🇼', name: '繁體中文' },
  { code: 'en',    flag: '🇺🇸', name: 'English' },
  { code: 'ja',    flag: '🇯🇵', name: '日本語' },
  { code: 'ko',    flag: '🇰🇷', name: '한국어' },
  { code: 'zh-CN', flag: '🇨🇳', name: '简体中文' },
  { code: 'de', flag: '🇩🇪', name: 'Deutsch' },
  { code: 'fr', flag: '🇫🇷', name: 'Français' },
  { code: 'es', flag: '🇪🇸', name: 'Español' },
  { code: 'pt', flag: '🇧🇷', name: 'Português' },
  { code: 'it', flag: '🇮🇹', name: 'Italiano' },
  { code: 'ru', flag: '🇷🇺', name: 'Русский' },
  { code: 'ar', flag: '🇸🇦', name: 'العربية' },
  { code: 'hi', flag: '🇮🇳', name: 'हिन्दी' },
  { code: 'th', flag: '🇹🇭', name: 'ไทย' },
  { code: 'vi', flag: '🇻🇳', name: 'Tiếng Việt' },
  { code: 'id', flag: '🇮🇩', name: 'Bahasa Indonesia' },
  { code: 'tr', flag: '🇹🇷', name: 'Türkçe' },
  { code: 'nl', flag: '🇳🇱', name: 'Nederlands' },
  { code: 'sv', flag: '🇸🇪', name: 'Svenska' },
  { code: 'pl', flag: '🇵🇱', name: 'Polski' },
  { code: 'uk', flag: '🇺🇦', name: 'Українська' },
  { code: 'ms', flag: '🇲🇾', name: 'Bahasa Melayu' },
];

let I18N = {};

async function loadLocales() {
  for (const lang of LANGS) {
    try {
      const resp = await fetch(`locales/${lang.code}.json`);
      if (resp.ok) I18N[lang.code] = await resp.json();
    } catch (_) {}
  }
}

let currentLang = localStorage.getItem('dashboard-lang') || 'zh-TW';

function t(key) { return (I18N[currentLang] || {})[key] || (I18N['en'] || {})[key] || (I18N['zh-TW'] || {})[key] || key; }

function applyLang() {
  const titleMap = {
    'sec-plan': 'planUsage', 'sec-account': 'accountTitle',
    'sec-sessions': 'sessionsTitle', 'sec-compare': 'usageCompare',
    'sec-efficiency': 'efficiency', 'sec-chart': 'dailyActivity',
    'sec-model': 'modelUsage', 'sec-alltime': 'allTime',
    'sec-links': 'quickLinks', 'sec-heatmap': 'activityByHour',
    'sec-records': 'recordsStats', 'sec-projects': 'projectBreakdown',
    'sec-desktop': 'claudeDesktop', 'sec-allprojects': 'allProjectsTitle',
    'sec-trend': 'weeklyTrend',
  };
  for (const [id, key] of Object.entries(titleMap)) {
    const el = document.getElementById(id);
    if (el) el.textContent = t(key);
  }
  const tipMap = {
    'tip-plan': ['tipPlanTitle', 'tipPlan'],
    'tip-account': ['tipAccountTitle', 'tipAccount'],
    'tip-sessions': ['tipSessionsTitle', 'tipSessions'],
    'tip-compare': ['tipCompareTitle', 'tipCompare'],
    'tip-efficiency': ['tipEfficiencyTitle', 'tipEfficiency'],
    'tip-progress': ['tipProgressTitle', 'tipProgress'],
    'tip-chart': ['tipChartTitle', 'tipChart'],
    'tip-model': ['tipModelTitle', 'tipModel'],
    'tip-alltime': ['tipAllTimeTitle', 'tipAllTime'],
    'tip-heatmap': ['tipHeatmapTitle', 'tipHeatmap'],
    'tip-records': ['tipRecordsTitle', 'tipRecords'],
    'tip-projects': ['tipProjectsTitle', 'tipProjects'],
    'tip-desktop': ['tipDesktopTitle', 'tipDesktop'],
    'tip-allprojects': ['tipAllProjectsTitle', 'tipAllProjects'],
    'tip-trend': ['tipTrendTitle', 'tipTrend'],
  };
  for (const [id, [titleKey, bodyKey]] of Object.entries(tipMap)) {
    const el = document.getElementById(id);
    if (el) { el.dataset.tipTitle = t(titleKey); el.dataset.tip = t(bodyKey); }
  }
  document.getElementById('settingsTitle').textContent = t('settings');
  document.getElementById('langSectionTitle').textContent = t('language');
  document.getElementById('aboutSectionTitle').textContent = t('about');
  const linkBtns = document.querySelectorAll('.console-btn');
  const linkKeys = ['billing', 'usageDash', 'plans', 'apiKeys'];
  const linkIcons = ['💳', '📊', '⚡', '🔑'];
  linkBtns.forEach((btn, i) => {
    if (linkKeys[i]) { btn.innerHTML = `<span class="icon">${linkIcons[i]}</span> ${t(linkKeys[i])}`; }
  });
  renderLangList();
}

// ── Changelog ──
const CHANGELOG = [
  { ver: '3.0.0', date: '2026-03-22', latest: true, changes: {
    'zh-TW': ['重構：CSS/JS/HTML 拆分為獨立檔案', '改善成本估算精度（每模型獨立計價）', '新增週趨勢比較面板', '新增 CSV 匯出格式', '修復大檔案統計遺漏問題', '新增錯誤追蹤面板', 'CLI 版本同步 Electron 功能', '可設定自動刷新間隔', 'Widget 資料增強', 'i18n 翻譯覆蓋率驗證', 'Plan Usage scraper 加速與容錯'],
    'en': ['Refactor: Split CSS/JS/HTML into separate files', 'Improved cost estimation accuracy (per-model pricing)', 'Added weekly trend comparison panel', 'Added CSV export format', 'Fixed large file statistics truncation', 'Added error tracking panel', 'CLI version synced with Electron features', 'Configurable auto-refresh interval', 'Enhanced widget data', 'i18n translation coverage verification', 'Plan Usage scraper speed & error handling improved'],
  }},
  { ver: '2.3.0', date: '2026-03-22', changes: {
    'zh-TW': ['新增 macOS Widget（Small / Medium 兩種尺寸）', '即時顯示 active sessions、今日用量、費用與效率指標', '新增訂閱用量面板 — 從 claude.ai 即時擷取配額資訊', '修復 14 天圖表與模型用量無法顯示的問題'],
    'en': ['Added macOS Widget (Small / Medium sizes)', 'Real-time display of active sessions, today usage, costs & efficiency', 'Added Plan Usage panel — live quota data from claude.ai', 'Fixed 14-day chart and model usage not rendering'],
  }},
];

function renderLangList() {
  const sel = document.getElementById('langSelect');
  sel.innerHTML = LANGS.map(l =>
    `<option value="${l.code}" ${l.code === currentLang ? 'selected' : ''}>${l.flag}  ${l.name}</option>`
  ).join('');
}

function renderChangelog() {
  const list = document.getElementById('changelogList');
  list.innerHTML = CHANGELOG.map(item => {
    const changes = item.changes[currentLang] || item.changes['en'] || [];
    return `
      <div class="changelog-item">
        <div class="changelog-ver">
          <span class="ver-tag ${item.latest ? 'latest' : ''}">${item.ver}</span>
          <span class="ver-date">${item.date}</span>
        </div>
        <div class="changelog-body">
          <ul>${changes.map(c => `<li>${c}</li>`).join('')}</ul>
        </div>
      </div>`;
  }).join('');
}

function switchLang(code) {
  currentLang = code;
  localStorage.setItem('dashboard-lang', code);
  applyLang();
  renderChangelog();
  refresh();
}

function openSettings() {
  renderLangList();
  renderChangelog();
  loadRefreshSetting();
  document.getElementById('settingsOverlay').classList.add('open');
}

function closeSettings() {
  document.getElementById('settingsOverlay').classList.remove('open');
}

// ── Item 8: Refresh interval setting ──
async function loadRefreshSetting() {
  try {
    const interval = await window.api.getRefreshInterval();
    if (interval) refreshInterval = interval;
    const sel = document.getElementById('refreshSelect');
    if (sel) sel.value = String(refreshInterval);
  } catch (_) {}
}

async function changeRefreshInterval(val) {
  refreshInterval = parseInt(val, 10) || 3000;
  try { await window.api.setRefreshInterval(refreshInterval); } catch (_) {}
  // Restart the interval
  if (window._refreshTimer) clearInterval(window._refreshTimer);
  window._refreshTimer = setInterval(refresh, refreshInterval);
}

// ── Tooltip guide system ──
const tooltip = document.getElementById('tooltip');
let tipTimer = null;

document.addEventListener('mouseover', (e) => {
  const trigger = e.target.closest('.tip-trigger');
  if (!trigger) return;
  const title = trigger.dataset.tipTitle || '';
  const text = trigger.dataset.tip || '';
  if (!text) return;
  clearTimeout(tipTimer);
  tipTimer = setTimeout(() => {
    tooltip.innerHTML = (title ? `<div class="tip-title">${title}</div>` : '') + text;
    tooltip.classList.add('visible');
    positionTooltip(e);
  }, 350);
});

document.addEventListener('mousemove', (e) => {
  if (tooltip.classList.contains('visible')) positionTooltip(e);
});

document.addEventListener('mouseout', (e) => {
  const trigger = e.target.closest('.tip-trigger');
  if (!trigger) return;
  const related = e.relatedTarget;
  if (related && trigger.contains(related)) return;
  clearTimeout(tipTimer);
  tooltip.classList.remove('visible');
});

function positionTooltip(e) {
  const pad = 12;
  const bw = document.body.clientWidth;
  const bh = document.body.clientHeight;
  let x = e.clientX + pad;
  let y = e.clientY + pad;
  if (x + 270 > bw) x = e.clientX - 270 - pad;
  if (y + tooltip.offsetHeight + pad > bh) y = e.clientY - tooltip.offsetHeight - pad;
  if (y < 4) y = 4;
  tooltip.style.left = x + 'px';
  tooltip.style.top = y + 'px';
}

// ── Item 9: Enhanced Export (JSON + CSV) ──
let exportMenuOpen = false;

function toggleExportMenu() {
  exportMenuOpen = !exportMenuOpen;
  const menu = document.getElementById('exportMenu');
  if (menu) menu.classList.toggle('open', exportMenuOpen);
}

// Close export menu on outside click
document.addEventListener('click', (e) => {
  if (!e.target.closest('.export-dropdown')) {
    exportMenuOpen = false;
    const menu = document.getElementById('exportMenu');
    if (menu) menu.classList.remove('open');
  }
});

function exportJSON() {
  if (!lastDashboardData) return;
  const exportObj = {
    exportedAt: new Date().toISOString(),
    version: '3.0.0',
    account: {
      name: lastDashboardData.account?.name,
      email: lastDashboardData.account?.email,
      plan: lastDashboardData.account?.billingType,
    },
    today: lastDashboardData.today,
    month: lastDashboardData.month,
    aggregate: lastDashboardData.aggregate,
    efficiency: lastDashboardData.efficiency,
    dailyHistory: lastDashboardData.dailyHistory,
    dailyTokenHistory: lastDashboardData.dailyTokenHistory,
    projects: lastDashboardData.allProjects?.map(p => ({
      name: p.name, sessions: p.sessionCount, messages: p.messageCount,
      tokens: p.totalTokens, lastActivity: p.lastActivity,
    })),
  };
  downloadFile(
    JSON.stringify(exportObj, null, 2),
    'claude-dashboard-' + new Date().toISOString().slice(0, 10) + '.json',
    'application/json'
  );
  toggleExportMenu();
}

function exportCSV() {
  if (!lastDashboardData) return;
  const lines = ['Date,Messages,Tokens,Sessions,Tools'];
  for (const d of (lastDashboardData.dailyHistory || [])) {
    const tokEntry = (lastDashboardData.dailyTokenHistory || []).find(t => t.date === d.date);
    lines.push(`${d.date},${d.messages},${tokEntry ? tokEntry.tokens : 0},${d.sessions},${d.tools}`);
  }

  // Add project summary
  lines.push('');
  lines.push('Project,Sessions,Messages,Tokens,Last Activity');
  for (const p of (lastDashboardData.allProjects || [])) {
    lines.push(`"${p.name}",${p.sessionCount},${p.messageCount},${p.totalTokens},${p.lastActivity || ''}`);
  }

  downloadFile(
    lines.join('\n'),
    'claude-dashboard-' + new Date().toISOString().slice(0, 10) + '.csv',
    'text/csv'
  );
  toggleExportMenu();
}

function downloadFile(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Model Switcher ──
let currentModel = 'sonnet';

async function loadCurrentModel() {
  try {
    currentModel = await window.api.getClaudeModel();
    updateModelButtons();
  } catch (_) {}
}

function updateModelButtons() {
  document.querySelectorAll('.model-btn').forEach(btn => {
    const model = btn.dataset.model;
    btn.classList.toggle('active', model === currentModel);
  });
}

async function switchModel(model) {
  if (model === currentModel) return;
  try {
    const result = await window.api.setClaudeModel(model);
    if (result.ok) {
      currentModel = model;
      updateModelButtons();
    }
  } catch (e) {
    console.error('Failed to switch model:', e);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Cloud Leaderboard System
// ═══════════════════════════════════════════════════════════════════════════

let leaderboardSettings = {
  enabled: false,
  nickname: '',
  userId: null,
  privacy: { shareToday: true, shareWeekly: true, shareMonthly: true, shareAllTime: true }
};
let leaderboardData = {};
let currentLeaderboardTab = 'today';
let firebaseInitialized = false;
let firebaseDb = null;

// DEBUG: 把 log 直接顯示在排行榜區域
const _fbLogs = [];
function _fblog(msg) {
  console.log('[FB-DEBUG] ' + msg);
  _fbLogs.push(new Date().toLocaleTimeString() + ' ' + msg);
  const el = document.getElementById('leaderboardList');
  if (el) el.innerHTML = '<pre style="font-size:10px;color:#999;white-space:pre-wrap;padding:8px">' + _fbLogs.join('\n') + '</pre>';
}

async function initLeaderboard() {
  try {
    leaderboardSettings = await window.api.getLeaderboardSettings();
    _fblog('settings: enabled=' + leaderboardSettings.enabled + ' userId=' + leaderboardSettings.userId);
    updateLeaderboardUI();

    if (leaderboardSettings.enabled && leaderboardSettings.userId) {
      _fblog('enabled=true, calling initFirebase...');
      await initFirebase();
      _fblog('calling refreshLeaderboard...');
      await refreshLeaderboard();
      _fblog('refreshLeaderboard done, data keys: ' + Object.keys(leaderboardData).join(','));
      for (const k of Object.keys(leaderboardData)) {
        _fblog('  ' + k + ': ' + (leaderboardData[k] || []).length + ' entries');
      }
    } else {
      _fblog('NOT enabled. enabled=' + leaderboardSettings.enabled + ' userId=' + leaderboardSettings.userId);
    }
  } catch (e) {
    _fblog('INIT ERROR: ' + (e.message || e));
  }
}

async function initFirebase() {
  if (firebaseInitialized) return;
  const _fblog = (msg) => { console.log('[FB-DEBUG] ' + msg); document.title = '[FB] ' + msg; };

  try {
    const config = window.FIREBASE_CONFIG;
    _fblog('step1: config=' + (config ? config.apiKey.slice(0,8) + '...' : 'NULL'));
    _fblog('step2: typeof firebase=' + typeof firebase);

    if (typeof firebase === 'undefined') {
      _fblog('FATAL: firebase SDK not loaded!');
      return;
    }

    if (!config || config.apiKey === 'YOUR_API_KEY') {
      _fblog('FATAL: config not set');
      return;
    }

    if (!firebase.apps.length) {
      firebase.initializeApp(config);
    }
    _fblog('step3: initializeApp done');

    firebaseDb = firebase.database();
    _fblog('step4: database ref ok');

    const cred = await firebase.auth().signInAnonymously();
    _fblog('step5: auth ok uid=' + cred.user.uid);

    firebaseInitialized = true;
    _fblog('step6: FULLY INITIALIZED ✅');
  } catch (e) {
    _fblog('ERROR: ' + (e.code || '') + ' ' + (e.message || e));
    console.error('[FB-DEBUG] Firebase init error:', e);
  }
}

function updateLeaderboardUI() {
  const badge = document.getElementById('leaderboardStatus');
  const optIn = document.getElementById('leaderboardOptIn');
  const content = document.getElementById('leaderboardContent');

  if (leaderboardSettings.enabled) {
    badge.textContent = 'ON';
    badge.classList.add('on');
    optIn.style.display = 'none';
    content.style.display = 'block';
  } else {
    badge.textContent = 'OFF';
    badge.classList.remove('on');
    optIn.style.display = 'block';
    content.style.display = 'none';
  }
}

function openLeaderboardSetup() {
  const modal = createLeaderboardModal(true);
  document.body.appendChild(modal);
  setTimeout(() => modal.classList.add('visible'), 10);
}

function openLeaderboardSettings() {
  const modal = createLeaderboardModal(false);
  document.body.appendChild(modal);
  setTimeout(() => modal.classList.add('visible'), 10);
}

function createLeaderboardModal(isSetup) {
  const overlay = document.createElement('div');
  overlay.className = 'lb-modal-overlay';
  overlay.id = 'leaderboardModal';

  const p = leaderboardSettings.privacy;

  overlay.innerHTML = `
    <div class="lb-modal">
      <div class="lb-modal-title">${isSetup ? 'Join Leaderboard' : 'Leaderboard Settings'}</div>

      <div class="lb-form-group">
        <label class="lb-form-label">Nickname</label>
        <input type="text" class="lb-form-input" id="lbNickname"
               value="${escHtml(leaderboardSettings.nickname)}"
               placeholder="Enter a nickname (3-20 chars)" maxlength="20">
      </div>

      <div class="lb-form-group">
        <label class="lb-form-label">Privacy - Choose what to share</label>
        <div class="lb-privacy-toggles">
          <div class="lb-toggle-row">
            <span class="lb-toggle-label">Today's tokens</span>
            <div class="lb-toggle ${p.shareToday ? 'on' : ''}" data-key="shareToday"></div>
          </div>
          <div class="lb-toggle-row">
            <span class="lb-toggle-label">Weekly tokens</span>
            <div class="lb-toggle ${p.shareWeekly ? 'on' : ''}" data-key="shareWeekly"></div>
          </div>
          <div class="lb-toggle-row">
            <span class="lb-toggle-label">Monthly cost</span>
            <div class="lb-toggle ${p.shareMonthly ? 'on' : ''}" data-key="shareMonthly"></div>
          </div>
          <div class="lb-toggle-row">
            <span class="lb-toggle-label">All-time tokens</span>
            <div class="lb-toggle ${p.shareAllTime ? 'on' : ''}" data-key="shareAllTime"></div>
          </div>
        </div>
      </div>

      <div class="lb-modal-actions">
        <button class="lb-modal-btn cancel" onclick="closeLeaderboardModal()">Cancel</button>
        ${!isSetup ? '<button class="lb-modal-btn danger" onclick="disableLeaderboard()">Disable</button>' : ''}
        <button class="lb-modal-btn save" onclick="saveLeaderboardSettings(${isSetup})">${isSetup ? 'Join' : 'Save'}</button>
      </div>
    </div>
  `;

  // Toggle handlers
  overlay.querySelectorAll('.lb-toggle').forEach(toggle => {
    toggle.addEventListener('click', () => toggle.classList.toggle('on'));
  });

  // Click outside to close
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeLeaderboardModal();
  });

  return overlay;
}

function closeLeaderboardModal() {
  const modal = document.getElementById('leaderboardModal');
  if (modal) {
    modal.classList.remove('visible');
    setTimeout(() => modal.remove(), 200);
  }
}

async function saveLeaderboardSettings(isSetup) {
  const nicknameInput = document.getElementById('lbNickname');
  const nickname = (nicknameInput.value || '').trim();

  if (nickname.length < 3 || nickname.length > 20) {
    nicknameInput.style.borderColor = 'var(--red)';
    return;
  }

  // Collect privacy settings
  const privacy = {};
  document.querySelectorAll('.lb-toggle').forEach(toggle => {
    privacy[toggle.dataset.key] = toggle.classList.contains('on');
  });

  // Generate user ID if needed
  let userId = leaderboardSettings.userId;
  if (!userId) {
    userId = await window.api.generateUserId();
  }

  // Save settings
  leaderboardSettings = {
    enabled: true,
    nickname,
    userId,
    privacy
  };

  await window.api.setLeaderboardSettings(leaderboardSettings);

  closeLeaderboardModal();
  updateLeaderboardUI();

  // Initialize Firebase and push initial data
  await initFirebase();
  await pushLeaderboardStats();
  refreshLeaderboard();
}

async function disableLeaderboard() {
  leaderboardSettings.enabled = false;
  await window.api.setLeaderboardSettings(leaderboardSettings);

  closeLeaderboardModal();
  updateLeaderboardUI();
}

function switchLeaderboardTab(category) {
  currentLeaderboardTab = category;
  document.querySelectorAll('.lb-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.cat === category);
  });
  renderLeaderboard();
}

async function refreshLeaderboard() {
  if (!firebaseInitialized || !leaderboardSettings.enabled) return;

  const listEl = document.getElementById('leaderboardList');
  listEl.innerHTML = '<div class="lb-loading">Loading...</div>';

  try {
    const categories = ['today', 'weekly', 'monthly', 'allTime'];

    for (const cat of categories) {
      const snapshot = await firebaseDb.ref(`leaderboards/${cat}`).orderByChild('score').limitToLast(10).once('value');
      const data = snapshot.val() || {};

      // Convert to sorted array (descending)
      leaderboardData[cat] = Object.entries(data)
        .map(([id, val]) => ({ id, ...val }))
        .sort((a, b) => b.score - a.score);
    }

    renderLeaderboard();

    // Update sync time
    document.getElementById('lbSyncTime').textContent = 'Last sync: ' + new Date().toLocaleTimeString('zh-TW', { hour12: false });
  } catch (e) {
    console.error('Failed to fetch leaderboard:', e);
    listEl.innerHTML = '<div class="lb-empty">Failed to load leaderboard</div>';
  }
}

function renderLeaderboard() {
  const listEl = document.getElementById('leaderboardList');
  const userEl = document.getElementById('leaderboardUser');
  const data = leaderboardData[currentLeaderboardTab] || [];

  if (data.length === 0) {
    listEl.innerHTML = '<div class="lb-empty">No data yet. Be the first! &#x1F680;</div>';
    userEl.classList.add('hidden');
    return;
  }

  const isMonthly = currentLeaderboardTab === 'monthly';
  const userId = leaderboardSettings.userId;
  let userInTop10 = false;
  const maxScore = data[0]?.score || 1;

  // Medal emojis for top 3
  const medals = ['&#x1F947;', '&#x1F948;', '&#x1F949;'];

  let html = '';
  data.slice(0, 10).forEach((entry, i) => {
    const rank = i + 1;
    const isMe = entry.id === userId;
    if (isMe) userInTop10 = true;

    const topClass = rank <= 3 ? ` top-${rank}` : '';
    const meClass = isMe ? ' me' : '';
    const scoreDisplay = isMonthly ? formatCost(entry.score) : formatTokens(entry.score);
    const pct = Math.max(8, (entry.score / maxScore) * 100);
    const rankLabel = rank <= 3 ? medals[rank - 1] : rank;

    // Bar color based on rank
    let barColor;
    if (rank === 1) barColor = 'linear-gradient(90deg, #ffd700, #ffec8b)';
    else if (rank === 2) barColor = 'linear-gradient(90deg, #b0b8c4, #d4d8e0)';
    else if (rank === 3) barColor = 'linear-gradient(90deg, #cd7f32, #daa06d)';
    else if (isMe) barColor = 'linear-gradient(90deg, var(--accent), var(--accent-light))';
    else barColor = 'linear-gradient(90deg, rgba(124,110,240,0.3), rgba(124,110,240,0.1))';

    html += `
      <div class="lb-row${topClass}${meClass}">
        <div class="lb-rank">${rankLabel}</div>
        <div class="lb-info">
          <div class="lb-nickname">${escHtml(entry.nickname || 'Anonymous')}${isMe ? '' : ''}</div>
          <div class="lb-bar-track">
            <div class="lb-bar-fill" style="width:${pct}%;background:${barColor}"></div>
          </div>
        </div>
        <div class="lb-score">${scoreDisplay}</div>
      </div>
    `;
  });

  listEl.innerHTML = html;

  // Animate bars
  requestAnimationFrame(() => {
    listEl.querySelectorAll('.lb-bar-fill').forEach((bar, i) => {
      bar.style.transition = `width 0.6s cubic-bezier(0.16,1,0.3,1) ${i * 0.05}s`;
    });
  });

  // Show user position if not in top 10
  if (!userInTop10 && userId) {
    const userEntry = data.find(e => e.id === userId);
    if (userEntry) {
      const userRank = data.findIndex(e => e.id === userId) + 1;
      const scoreDisplay = isMonthly ? formatCost(userEntry.score) : formatTokens(userEntry.score);
      const pct = Math.max(8, (userEntry.score / maxScore) * 100);
      userEl.innerHTML = `
        <div class="lb-rank">&#x2B50;</div>
        <div class="lb-info">
          <div class="lb-nickname">${escHtml(userEntry.nickname)}</div>
          <div class="lb-bar-track">
            <div class="lb-bar-fill" style="width:${pct}%;background:linear-gradient(90deg, var(--accent), var(--accent-light))"></div>
          </div>
        </div>
        <div class="lb-score">#${userRank} ${scoreDisplay}</div>
      `;
      userEl.classList.remove('hidden');
    } else {
      userEl.classList.add('hidden');
    }
  } else {
    userEl.classList.add('hidden');
  }
}

async function pushLeaderboardStats() {
  if (!firebaseInitialized || !leaderboardSettings.enabled || !lastDashboardData) return;

  const userId = leaderboardSettings.userId;
  const nickname = leaderboardSettings.nickname;
  const privacy = leaderboardSettings.privacy;
  const d = lastDashboardData;

  try {
    const updates = {};
    const now = Date.now();

    // Update user profile
    updates[`users/${userId}/nickname`] = nickname;
    updates[`users/${userId}/lastSeen`] = now;

    // Push stats based on privacy settings
    if (privacy.shareToday && d.today) {
      updates[`leaderboards/today/${userId}`] = {
        nickname,
        score: d.today.tokens || 0,
        updatedAt: now
      };
      updates[`stats/${userId}/today`] = {
        tokens: d.today.tokens || 0,
        messages: d.today.messages || 0,
        date: new Date().toISOString().slice(0, 10)
      };
    }

    if (privacy.shareWeekly && d.weekly) {
      updates[`leaderboards/weekly/${userId}`] = {
        nickname,
        score: d.weekly.tokens || 0,
        updatedAt: now
      };
      updates[`stats/${userId}/weekly`] = {
        tokens: d.weekly.tokens || 0,
        weekStart: getWeekStart()
      };
    }

    if (privacy.shareMonthly && d.monthly) {
      updates[`leaderboards/monthly/${userId}`] = {
        nickname,
        score: d.monthly.cost || 0,
        updatedAt: now
      };
      updates[`stats/${userId}/monthly`] = {
        cost: d.monthly.cost || 0,
        monthStart: new Date().toISOString().slice(0, 7)
      };
    }

    if (privacy.shareAllTime && d.aggregate) {
      updates[`leaderboards/allTime/${userId}`] = {
        nickname,
        score: d.aggregate.totalTokens || 0,
        updatedAt: now
      };
      updates[`stats/${userId}/allTime`] = {
        tokens: d.aggregate.totalTokens || 0
      };
    }

    await firebaseDb.ref().update(updates);
    console.log('Leaderboard stats pushed');
  } catch (e) {
    console.error('Failed to push leaderboard stats:', e);
  }
}

function getWeekStart() {
  const now = new Date();
  const day = now.getDay();
  const diff = now.getDate() - day + (day === 0 ? -6 : 1);
  return new Date(now.setDate(diff)).toISOString().slice(0, 10);
}

// ── Main refresh ──
async function refresh() {
  try {
    const data = await window.api.getDashboardData();
    lastDashboardData = data;
    renderErrors(data.errors);
    renderAccount(data.account);
    renderSessions(data.sessions);
    renderCompare(data);
    renderEfficiency(data.efficiency);
    renderUsageProgress(data);
    renderChart(data.dailyTokenHistory, data.dailyMsgHistory);
    renderModelUsage(data.aggregate);
    renderAllTime(data.aggregate);
    renderHeatmap(data.hourCounts, data.weekdayHourCounts);
    renderRecords(data);
    renderProjects(data.projectStats);
    renderDesktop(data.desktopInfo);
    renderAllProjects(data.allProjects);
    const refreshEl = document.getElementById('refreshTime');
    if (refreshEl) refreshEl.textContent = new Date().toLocaleTimeString('zh-TW', { hour12: false });

    // Push leaderboard stats on every refresh (if enabled)
    if (firebaseInitialized && leaderboardSettings.enabled) {
      pushLeaderboardStats();
    }

    // Trigger notification checks
    try {
      const deadSessions = data.sessions.filter(s => !s.alive).map(s => ({ pid: s.pid, project: s.project }));
      const avgDailyCost = data.account.avgDailyTokens > 0 ? data.today.cost * (data.account.avgDailyTokens / Math.max(1, data.today.tokens || 1)) : 0;
      window.api.checkNotifications({
        planUsage: planUsageCache,
        todayCost: data.today.cost,
        avgDailyCost,
        deadSessions,
      });
    } catch (_) {}
  } catch (e) {
    console.error('Refresh error:', e);
  }
}

// Theme handling
window.api.onThemeChanged((theme) => {
  document.documentElement.setAttribute('data-theme', theme);
});

// ── Splash screen dismiss ──
setTimeout(() => {
  const splash = document.getElementById('splashScreen');
  if (splash) {
    splash.classList.add('fade-out');
    setTimeout(() => splash.remove(), 500);
  }
}, 5000);

// ── Initial load + auto-refresh ──
loadLocales().then(() => {
  applyLang();
  refresh();
});
loadCurrentModel();
loadRefreshSetting();
window._refreshTimer = setInterval(refresh, refreshInterval);

// Dynamic version
(async function() {
  try {
    const appVersion = await window.api.getAppVersion();
    document.querySelectorAll('.app-version').forEach(el => { el.textContent = 'v' + appVersion; });
  } catch (_) {}
})();

// Fetch plan usage on startup (after splash)
setTimeout(() => fetchPlanUsage(), 6000);
setInterval(() => fetchPlanUsage(), 300000);

// ── Cloud Leaderboard ──
// Initialize after splash (reduced delay)
setTimeout(() => initLeaderboard(), 2000);

// Refresh leaderboard every 1 minute
setInterval(() => {
  if (leaderboardSettings.enabled) refreshLeaderboard();
}, 60000);

// Push stats every 5 minutes
setInterval(() => {
  if (leaderboardSettings.enabled && lastDashboardData) pushLeaderboardStats();
}, 300000);

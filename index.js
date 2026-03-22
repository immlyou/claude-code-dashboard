#!/usr/bin/env node
'use strict';

const blessed = require('blessed');
const contrib = require('blessed-contrib');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const STATS_FILE = path.join(CLAUDE_DIR, 'stats-cache.json');
const REFRESH_INTERVAL = 3000; // 3 seconds

// ─── Utility Functions ───────────────────────────────────────────────

function readJSON(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch { return null; }
}

function isPidRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch { return false; }
}

function formatTokens(n) {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + 'B';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function getProjectName(cwd) {
  return path.basename(cwd) || cwd;
}

function getProjectDirName(cwd) {
  return cwd.replace(/\//g, '-');
}

// ─── Session Token Parsing ───────────────────────────────────────────

function getSessionTokens(sessionId, cwd) {
  const projectDir = path.join(PROJECTS_DIR, getProjectDirName(cwd));
  const sessionFile = path.join(projectDir, `${sessionId}.jsonl`);

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheRead = 0;
  let cacheCreation = 0;
  let messageCount = 0;
  let toolCallCount = 0;
  let lastActivity = null;
  let model = 'unknown';

  try {
    const data = fs.readFileSync(sessionFile, 'utf-8');
    const lines = data.split('\n').filter(Boolean);

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'user') {
          messageCount++;
        }
        if (entry.type === 'assistant' && entry.message?.usage) {
          const u = entry.message.usage;
          inputTokens += u.input_tokens || 0;
          outputTokens += u.output_tokens || 0;
          cacheRead += u.cache_read_input_tokens || 0;
          cacheCreation += u.cache_creation_input_tokens || 0;
          if (entry.message?.model) model = entry.message.model;
        }
        if (entry.message?.content) {
          const content = entry.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'tool_use') toolCallCount++;
            }
          }
        }
        if (entry.timestamp) {
          lastActivity = new Date(entry.timestamp);
        }
      } catch { /* skip malformed lines */ }
    }
  } catch { /* file may not exist yet */ }

  return { inputTokens, outputTokens, cacheRead, cacheCreation, messageCount, toolCallCount, lastActivity, model };
}

// ─── Data Collection ─────────────────────────────────────────────────

function getActiveSessions() {
  const sessions = [];
  try {
    const files = fs.readdirSync(SESSIONS_DIR);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const pid = parseInt(path.basename(file, '.json'), 10);
      const data = readJSON(path.join(SESSIONS_DIR, file));
      if (!data) continue;

      const alive = isPidRunning(pid);
      const tokens = getSessionTokens(data.sessionId, data.cwd);
      const uptime = Date.now() - data.startedAt;

      sessions.push({
        pid,
        sessionId: data.sessionId,
        project: getProjectName(data.cwd),
        cwd: data.cwd,
        startedAt: data.startedAt,
        alive,
        uptime,
        ...tokens,
      });
    }
  } catch { /* sessions dir may not exist */ }

  // Sort: alive first, then by startedAt descending
  sessions.sort((a, b) => {
    if (a.alive !== b.alive) return a.alive ? -1 : 1;
    return b.startedAt - a.startedAt;
  });

  return sessions;
}

function getStatsCache() {
  return readJSON(STATS_FILE) || {};
}

function getUsagePercentage(stats) {
  // Claude Pro/Team plan: estimate based on daily token limits
  // Max 5 plan has ~$200/month usage cap
  // Estimate: track daily output tokens vs typical daily budget
  const today = new Date().toISOString().slice(0, 10);
  const todayActivity = stats.dailyActivity?.find(d => d.date === today);
  const todayTokens = stats.dailyModelTokens?.find(d => d.date === today);

  // Calculate total output tokens for today across all models
  let todayOutputTokens = 0;
  if (todayTokens?.tokensByModel) {
    todayOutputTokens = Object.values(todayTokens.tokensByModel).reduce((a, b) => a + b, 0);
  }

  // Calculate monthly usage from modelUsage
  const totalOutput = Object.values(stats.modelUsage || {})
    .reduce((sum, m) => sum + (m.outputTokens || 0), 0);
  const totalInput = Object.values(stats.modelUsage || {})
    .reduce((sum, m) => sum + (m.inputTokens || 0), 0);
  const totalCacheRead = Object.values(stats.modelUsage || {})
    .reduce((sum, m) => sum + (m.cacheReadInputTokens || 0), 0);
  const totalCacheCreation = Object.values(stats.modelUsage || {})
    .reduce((sum, m) => sum + (m.cacheCreationInputTokens || 0), 0);

  // Calculate cost estimate (Opus 4.6 pricing: $15/1M input, $75/1M output, cache read $1.5/1M, cache write $18.75/1M)
  const costEstimate =
    (totalInput / 1_000_000) * 15 +
    (totalOutput / 1_000_000) * 75 +
    (totalCacheRead / 1_000_000) * 1.5 +
    (totalCacheCreation / 1_000_000) * 18.75;

  // Estimate monthly budget usage (Max 5 plan ~$200/month)
  // We'll track this month's data
  const now = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const thisMonthTokens = (stats.dailyModelTokens || [])
    .filter(d => d.date.startsWith(monthStart))
    .reduce((sum, d) => {
      return sum + Object.values(d.tokensByModel || {}).reduce((a, b) => a + b, 0);
    }, 0);

  const thisMonthMessages = (stats.dailyActivity || [])
    .filter(d => d.date.startsWith(monthStart))
    .reduce((sum, d) => sum + d.messageCount, 0);

  return {
    todayMessages: todayActivity?.messageCount || 0,
    todayTokens: todayOutputTokens,
    todaySessions: todayActivity?.sessionCount || 0,
    todayToolCalls: todayActivity?.toolCallCount || 0,
    totalOutput,
    totalInput,
    totalCacheRead,
    totalCacheCreation,
    costEstimate,
    thisMonthTokens,
    thisMonthMessages,
    totalSessions: stats.totalSessions || 0,
    totalMessages: stats.totalMessages || 0,
  };
}

// ─── UI Setup ────────────────────────────────────────────────────────

const screen = blessed.screen({
  smartCSR: true,
  title: 'Claude Code CLI Dashboard',
  fullUnicode: true,
});

const grid = new contrib.grid({ rows: 12, cols: 12, screen });

// Title bar
const titleBox = grid.set(0, 0, 1, 12, blessed.box, {
  content: '{center}{bold} ⚡ CLAUDE CODE CLI DASHBOARD{/bold}{/center}',
  tags: true,
  style: {
    fg: 'white',
    bg: 'blue',
    bold: true,
  },
});

// Active Sessions Table
const sessionsTable = grid.set(1, 0, 5, 12, contrib.table, {
  keys: true,
  fg: 'white',
  selectedFg: 'white',
  selectedBg: 'blue',
  interactive: true,
  label: ' 📋 Active CLI Sessions ',
  width: '100%',
  border: { type: 'line', fg: 'cyan' },
  columnSpacing: 2,
  columnWidth: [8, 20, 10, 10, 12, 12, 10, 8, 16],
  style: {
    header: { fg: 'cyan', bold: true },
    cell: { fg: 'white' },
    border: { fg: 'cyan' },
  },
});

// Usage Gauge
const usageGauge = grid.set(6, 0, 2, 4, contrib.gauge, {
  label: ' 📊 Today Usage ',
  stroke: 'green',
  fill: 'white',
  border: { type: 'line', fg: 'cyan' },
  style: { border: { fg: 'cyan' } },
});

// Today Stats
const todayBox = grid.set(6, 4, 2, 4, blessed.box, {
  label: ' 📅 Today Stats ',
  tags: true,
  border: { type: 'line', fg: 'cyan' },
  style: {
    fg: 'white',
    border: { fg: 'cyan' },
  },
  padding: { left: 1, right: 1 },
});

// Monthly Stats
const monthBox = grid.set(6, 8, 2, 4, blessed.box, {
  label: ' 📆 This Month ',
  tags: true,
  border: { type: 'line', fg: 'cyan' },
  style: {
    fg: 'white',
    border: { fg: 'cyan' },
  },
  padding: { left: 1, right: 1 },
});

// Token Usage Sparkline (last 14 days)
const tokenSpark = grid.set(8, 0, 2, 6, contrib.sparkline, {
  label: ' 📈 Daily Token Usage (14d) ',
  tags: true,
  border: { type: 'line', fg: 'cyan' },
  style: {
    fg: 'cyan',
    border: { fg: 'cyan' },
  },
});

// Aggregate Model Usage
const modelBox = grid.set(8, 6, 2, 6, blessed.box, {
  label: ' 🤖 Aggregate Token Usage ',
  tags: true,
  border: { type: 'line', fg: 'cyan' },
  style: {
    fg: 'white',
    border: { fg: 'cyan' },
  },
  padding: { left: 1, right: 1 },
});

// Activity Log (Messages per day bar)
const activityBar = grid.set(10, 0, 2, 8, contrib.bar, {
  label: ' 📊 Daily Messages (14d) ',
  barWidth: 6,
  barSpacing: 1,
  xOffset: 0,
  maxHeight: 9,
  border: { type: 'line', fg: 'cyan' },
  style: {
    border: { fg: 'cyan' },
  },
});

// Help / Status
const helpBox = grid.set(10, 8, 2, 4, blessed.box, {
  label: ' ⌨️  Controls ',
  tags: true,
  border: { type: 'line', fg: 'cyan' },
  style: {
    fg: 'white',
    border: { fg: 'cyan' },
  },
  padding: { left: 1, right: 1 },
  content:
    '{cyan-fg}q/Esc{/}  Quit\n' +
    '{cyan-fg}r{/}      Refresh\n' +
    '{cyan-fg}↑/↓{/}    Navigate\n' +
    '{cyan-fg}Auto{/}   3s refresh',
});

// ─── Update Dashboard ────────────────────────────────────────────────

function updateDashboard() {
  const sessions = getActiveSessions();
  const stats = getStatsCache();
  const usage = getUsagePercentage(stats);

  // Update title with time
  const now = new Date();
  const timeStr = now.toLocaleTimeString('zh-TW', { hour12: false });
  titleBox.setContent(
    `{center}{bold} ⚡ CLAUDE CODE CLI DASHBOARD  |  ${timeStr}  |  ` +
    `${sessions.filter(s => s.alive).length} active sessions{/bold}{/center}`
  );

  // Update sessions table
  const tableData = sessions.map(s => [
    String(s.pid),
    s.project,
    s.alive ? '{green-fg}● ACTIVE{/}' : '{red-fg}○ DEAD{/}',
    formatDuration(s.uptime),
    formatTokens(s.inputTokens + s.cacheRead),
    formatTokens(s.outputTokens),
    String(s.messageCount),
    String(s.toolCallCount),
    s.model.replace('claude-', '').replace('-20251101', ''),
  ]);

  sessionsTable.setData({
    headers: ['PID', 'Project', 'Status', 'Uptime', 'Input Tok', 'Output Tok', 'Msgs', 'Tools', 'Model'],
    data: tableData.length > 0 ? tableData : [['', 'No sessions found', '', '', '', '', '', '', '']],
  });

  // Update usage gauge - estimate daily usage percentage
  // Assume a reasonable daily limit (e.g., ~50 messages for heavy use tracking)
  const dailyMessageLimit = 200; // rough estimate for visibility
  const dailyPct = Math.min(100, Math.round((usage.todayMessages / dailyMessageLimit) * 100));
  usageGauge.setPercent(dailyPct);

  // Update today stats
  todayBox.setContent(
    `{bold}Messages:{/}  {yellow-fg}${usage.todayMessages.toLocaleString()}{/}\n` +
    `{bold}Tokens:{/}    {yellow-fg}${formatTokens(usage.todayTokens)}{/}\n` +
    `{bold}Sessions:{/}  {yellow-fg}${usage.todaySessions}{/}\n` +
    `{bold}Tools:{/}     {yellow-fg}${usage.todayToolCalls}{/}`
  );

  // Update monthly stats
  monthBox.setContent(
    `{bold}Messages:{/}  {green-fg}${usage.thisMonthMessages.toLocaleString()}{/}\n` +
    `{bold}Tokens:{/}    {green-fg}${formatTokens(usage.thisMonthTokens)}{/}\n` +
    `{bold}Total Sess:{/} {green-fg}${usage.totalSessions}{/}\n` +
    `{bold}All Time:{/}   {green-fg}${usage.totalMessages.toLocaleString()}{/} msgs`
  );

  // Update sparkline (last 14 days token usage)
  const last14 = (stats.dailyModelTokens || []).slice(-14);
  const sparkData = last14.map(d =>
    Object.values(d.tokensByModel || {}).reduce((a, b) => a + b, 0)
  );
  const sparkLabels = last14.map(d => d.date.slice(5)); // MM-DD
  if (sparkData.length > 0) {
    tokenSpark.setData(sparkLabels, sparkData);
  }

  // Update model usage box
  const lines = [];
  for (const [model, data] of Object.entries(stats.modelUsage || {})) {
    const name = model.replace('claude-', '').replace('-20251101', '');
    lines.push(`{bold}{cyan-fg}${name}{/}`);
    lines.push(`  In: ${formatTokens(data.inputTokens)}  Out: ${formatTokens(data.outputTokens)}`);
    lines.push(`  Cache R: ${formatTokens(data.cacheReadInputTokens)}  W: ${formatTokens(data.cacheCreationInputTokens)}`);
  }
  lines.push(`\n{bold}Est. Cost:{/} {yellow-fg}$${usage.costEstimate.toFixed(2)}{/}`);
  modelBox.setContent(lines.join('\n'));

  // Update activity bar (last 14 days messages)
  const last14Activity = (stats.dailyActivity || []).slice(-14);
  const barTitles = last14Activity.map(d => d.date.slice(5));
  const barData = last14Activity.map(d => d.messageCount);
  if (barData.length > 0) {
    activityBar.setData({ titles: barTitles, data: barData });
  }

  screen.render();
}

// ─── Key Bindings ────────────────────────────────────────────────────

screen.key(['escape', 'q', 'C-c'], () => {
  return process.exit(0);
});

screen.key(['r'], () => {
  updateDashboard();
});

// ─── Start ───────────────────────────────────────────────────────────

updateDashboard();
setInterval(updateDashboard, REFRESH_INTERVAL);

screen.render();

#!/usr/bin/env node
'use strict';

const blessed = require('blessed');
const contrib = require('blessed-contrib');
const path = require('path');
const { collect } = require('./collector');

const REFRESH_INTERVAL = 3000; // 3 seconds

// ─── Display Helpers ────────────────────────────────────────────────

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
const sessionsTable = grid.set(1, 0, 4, 12, contrib.table, {
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
const usageGauge = grid.set(5, 0, 2, 3, contrib.gauge, {
  label: ' 📊 Today Usage ',
  stroke: 'green',
  fill: 'white',
  border: { type: 'line', fg: 'cyan' },
  style: { border: { fg: 'cyan' } },
});

// Today Stats
const todayBox = grid.set(5, 3, 2, 3, blessed.box, {
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
const monthBox = grid.set(5, 6, 2, 3, blessed.box, {
  label: ' 📆 This Month ',
  tags: true,
  border: { type: 'line', fg: 'cyan' },
  style: {
    fg: 'white',
    border: { fg: 'cyan' },
  },
  padding: { left: 1, right: 1 },
});

// Efficiency Metrics
const efficiencyBox = grid.set(5, 9, 2, 3, blessed.box, {
  label: ' ⚙️  Efficiency ',
  tags: true,
  border: { type: 'line', fg: 'cyan' },
  style: {
    fg: 'white',
    border: { fg: 'cyan' },
  },
  padding: { left: 1, right: 1 },
});

// Token Usage Sparkline (last 14 days)
const tokenSpark = grid.set(7, 0, 2, 6, contrib.sparkline, {
  label: ' 📈 Daily Token Usage (14d) ',
  tags: true,
  border: { type: 'line', fg: 'cyan' },
  style: {
    fg: 'cyan',
    border: { fg: 'cyan' },
  },
});

// Aggregate Model Usage
const modelBox = grid.set(7, 6, 2, 6, blessed.box, {
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
const activityBar = grid.set(9, 0, 2, 6, contrib.bar, {
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

// Records
const recordsBox = grid.set(9, 6, 2, 3, blessed.box, {
  label: ' 🏆 Records ',
  tags: true,
  border: { type: 'line', fg: 'cyan' },
  style: {
    fg: 'white',
    border: { fg: 'cyan' },
  },
  padding: { left: 1, right: 1 },
});

// Projects & Help
const helpBox = grid.set(9, 9, 2, 3, blessed.box, {
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

// Projects count bar at bottom
const projectsBox = grid.set(11, 0, 1, 12, blessed.box, {
  tags: true,
  style: {
    fg: 'white',
    bg: 'blue',
  },
});

// ─── Update Dashboard ────────────────────────────────────────────────

function updateDashboard() {
  const data = collect();

  // Update title with time
  const now = new Date();
  const timeStr = now.toLocaleTimeString('zh-TW', { hour12: false });
  const aliveCount = data.sessions.filter(s => s.alive).length;
  titleBox.setContent(
    `{center}{bold} ⚡ CLAUDE CODE CLI DASHBOARD  |  ${timeStr}  |  ` +
    `${aliveCount} active sessions{/bold}{/center}`
  );

  // Update sessions table
  const tableData = data.sessions.map(s => [
    String(s.pid),
    getProjectName(s.cwd),
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

  // Update usage gauge
  const dailyMessageLimit = 200;
  const dailyPct = Math.min(100, Math.round((data.today.messages / dailyMessageLimit) * 100));
  usageGauge.setPercent(dailyPct);

  // Update today stats
  todayBox.setContent(
    `{bold}Messages:{/}  {yellow-fg}${data.today.messages.toLocaleString()}{/}\n` +
    `{bold}Tokens:{/}    {yellow-fg}${formatTokens(data.today.tokens)}{/}\n` +
    `{bold}Sessions:{/}  {yellow-fg}${data.today.sessions}{/}\n` +
    `{bold}Tools:{/}     {yellow-fg}${data.today.tools}{/}\n` +
    `{bold}Est Cost:{/}  {yellow-fg}$${data.today.cost.toFixed(2)}{/}`
  );

  // Update monthly stats
  monthBox.setContent(
    `{bold}Messages:{/}  {green-fg}${data.month.messages.toLocaleString()}{/}\n` +
    `{bold}Tokens:{/}    {green-fg}${formatTokens(data.month.tokens)}{/}\n` +
    `{bold}Sessions:{/}  {green-fg}${data.month.sessions}{/}\n` +
    `{bold}Tools:{/}     {green-fg}${data.month.tools.toLocaleString()}{/}\n` +
    `{bold}Cost:{/}      {green-fg}$${data.month.cost.toFixed(2)}{/}`
  );

  // Update efficiency metrics
  efficiencyBox.setContent(
    `{bold}Tok/Msg:{/}   {magenta-fg}${formatTokens(data.efficiency.avgTokensPerMsg)}{/}\n` +
    `{bold}Cache Hit:{/} {magenta-fg}${data.efficiency.cacheHitRate}%{/}\n` +
    `{bold}Tools/Msg:{/} {magenta-fg}${data.efficiency.toolsPerMsg}{/}\n` +
    `{bold}Total Tools:{/}{magenta-fg}${data.efficiency.totalTools.toLocaleString()}{/}`
  );

  // Update sparkline (last 14 days token usage)
  const sparkData = data.dailyTokenHistory.map(d => d.tokens);
  const sparkLabels = data.dailyTokenHistory.map(d => d.date.slice(5));
  if (sparkData.length > 0) {
    tokenSpark.setData(sparkLabels, sparkData);
  }

  // Update model usage box
  const lines = [];
  for (const [model, mData] of Object.entries(data.aggregate.modelUsage)) {
    const name = model.replace('claude-', '').replace('-20251101', '');
    lines.push(`{bold}{cyan-fg}${name}{/}`);
    lines.push(`  In: ${formatTokens(mData.inputTokens)}  Out: ${formatTokens(mData.outputTokens)}`);
    lines.push(`  Cache R: ${formatTokens(mData.cacheReadInputTokens)}  W: ${formatTokens(mData.cacheCreationInputTokens)}`);
  }
  lines.push(`\n{bold}Est. Cost:{/} {yellow-fg}$${data.aggregate.costEstimate.toFixed(2)}{/}`);
  modelBox.setContent(lines.join('\n'));

  // Update activity bar (last 14 days messages)
  const barTitles = data.dailyHistory.map(d => d.date.slice(5));
  const barData = data.dailyHistory.map(d => d.messages);
  if (barData.length > 0) {
    activityBar.setData({ titles: barTitles, data: barData });
  }

  // Update records box
  const longestStr = data.longestSession
    ? formatDuration(data.longestSession)
    : 'N/A';
  const firstDate = data.firstSessionDate
    ? data.firstSessionDate.slice(0, 10)
    : 'N/A';
  recordsBox.setContent(
    `{bold}First Use:{/}  {white-fg}${firstDate}{/}\n` +
    `{bold}Startups:{/}   {white-fg}${data.numStartups.toLocaleString()}{/}\n` +
    `{bold}Longest:{/}    {white-fg}${longestStr}{/}\n` +
    `{bold}Searches:{/}   {white-fg}${data.webSearches.toLocaleString()}{/}`
  );

  // Update projects bar
  const projectCount = data.allProjects ? data.allProjects.length : 0;
  projectsBox.setContent(
    `{center} 📁 ${projectCount} project${projectCount !== 1 ? 's' : ''} tracked  |  ` +
    `All Time: ${data.aggregate.totalSessions} sessions, ${data.aggregate.totalMessages.toLocaleString()} messages  |  ` +
    `Est. Total Cost: $${data.aggregate.costEstimate.toFixed(2)}{/center}`
  );

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

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const STATS_FILE = path.join(CLAUDE_DIR, 'stats-cache.json');
const CLAUDE_JSON = path.join(os.homedir(), '.claude.json');

function readJSON(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); }
  catch { return null; }
}

function isPidRunning(pid) {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

function getProjectDirName(cwd) {
  return cwd.replace(/\//g, '-');
}

function getSessionTokens(sessionId, cwd) {
  const projectDir = path.join(PROJECTS_DIR, getProjectDirName(cwd));
  const sessionFile = path.join(projectDir, `${sessionId}.jsonl`);

  let inputTokens = 0, outputTokens = 0, cacheRead = 0, cacheCreation = 0;
  let messageCount = 0, toolCallCount = 0, lastActivity = null, model = 'unknown';

  try {
    const data = fs.readFileSync(sessionFile, 'utf-8');
    const lines = data.split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'user') messageCount++;
        if (entry.type === 'assistant' && entry.message?.usage) {
          const u = entry.message.usage;
          inputTokens += u.input_tokens || 0;
          outputTokens += u.output_tokens || 0;
          cacheRead += u.cache_read_input_tokens || 0;
          cacheCreation += u.cache_creation_input_tokens || 0;
          if (entry.message?.model) model = entry.message.model;
        }
        if (entry.message?.content && Array.isArray(entry.message.content)) {
          for (const block of entry.message.content) {
            if (block.type === 'tool_use') toolCallCount++;
          }
        }
        if (entry.timestamp) lastActivity = entry.timestamp;
      } catch { /* skip */ }
    }
  } catch { /* file may not exist */ }

  return { inputTokens, outputTokens, cacheRead, cacheCreation, messageCount, toolCallCount, lastActivity, model };
}

/**
 * Scan ~/.claude/projects/ to build a full list of all Claude projects on this machine.
 * For each project: count sessions, sum tokens, find last activity date.
 */
function scanAllProjects() {
  const projects = [];
  try {
    const dirs = fs.readdirSync(PROJECTS_DIR);
    for (const dir of dirs) {
      const dirPath = path.join(PROJECTS_DIR, dir);
      if (!fs.statSync(dirPath).isDirectory()) continue;

      // Decode project path from dir name: -Users-imchris-foo → /Users/imchris/foo
      const projectPath = dir.replace(/^-/, '/').replace(/-/g, '/');
      const projectName = projectPath.split('/').filter(Boolean).pop() || dir;

      let sessionCount = 0;
      let totalInput = 0, totalOutput = 0, totalCacheRead = 0;
      let messageCount = 0, toolCallCount = 0;
      let lastActivity = null;
      let models = new Set();

      try {
        const files = fs.readdirSync(dirPath);
        for (const f of files) {
          if (!f.endsWith('.jsonl')) continue;
          sessionCount++;

          // Read only last 200 lines for speed (tail of file)
          try {
            const filePath = path.join(dirPath, f);
            const stat = fs.statSync(filePath);
            const fileSize = stat.size;

            // For large files, only read last 64KB
            let content;
            if (fileSize > 65536) {
              const buf = Buffer.alloc(65536);
              const fd = fs.openSync(filePath, 'r');
              fs.readSync(fd, buf, 0, 65536, fileSize - 65536);
              fs.closeSync(fd);
              content = buf.toString('utf-8');
              // Skip first partial line
              const firstNewline = content.indexOf('\n');
              if (firstNewline >= 0) content = content.slice(firstNewline + 1);
            } else {
              content = fs.readFileSync(filePath, 'utf-8');
            }

            const lines = content.split('\n').filter(Boolean);
            for (const line of lines) {
              try {
                const entry = JSON.parse(line);
                if (entry.type === 'user') messageCount++;
                if (entry.type === 'assistant' && entry.message?.usage) {
                  const u = entry.message.usage;
                  totalInput += u.input_tokens || 0;
                  totalOutput += u.output_tokens || 0;
                  totalCacheRead += u.cache_read_input_tokens || 0;
                  if (entry.message?.model) models.add(entry.message.model);
                }
                if (entry.message?.content && Array.isArray(entry.message.content)) {
                  for (const block of entry.message.content) {
                    if (block.type === 'tool_use') toolCallCount++;
                  }
                }
                if (entry.timestamp && (!lastActivity || entry.timestamp > lastActivity)) {
                  lastActivity = entry.timestamp;
                }
              } catch { /* skip bad line */ }
            }
          } catch { /* skip unreadable file */ }
        }
      } catch { /* skip unreadable dir */ }

      if (sessionCount > 0) {
        projects.push({
          name: projectName,
          path: projectPath,
          sessionCount,
          messageCount,
          toolCallCount,
          totalInput,
          totalOutput,
          totalCacheRead,
          totalTokens: totalInput + totalOutput + totalCacheRead,
          models: [...models].map(m => m.replace('claude-', '').replace(/-\d{8}$/, '').replace('-latest', '')),
          lastActivity,
          exists: fs.existsSync(projectPath),
        });
      }
    }
  } catch { /* projects dir doesn't exist */ }

  // Sort by last activity (most recent first)
  projects.sort((a, b) => {
    if (!a.lastActivity) return 1;
    if (!b.lastActivity) return -1;
    return b.lastActivity.localeCompare(a.lastActivity);
  });

  return projects;
}

function collect() {
  // Active sessions
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
      sessions.push({
        pid,
        sessionId: data.sessionId,
        project: path.basename(data.cwd),
        cwd: data.cwd,
        startedAt: data.startedAt,
        alive,
        uptime: Date.now() - data.startedAt,
        ...tokens,
      });
    }
  } catch { /* */ }
  sessions.sort((a, b) => {
    if (a.alive !== b.alive) return a.alive ? -1 : 1;
    return b.startedAt - a.startedAt;
  });

  // Stats
  const stats = readJSON(STATS_FILE) || {};
  const today = new Date().toISOString().slice(0, 10);
  const now = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  const todayActivity = (stats.dailyActivity || []).find(d => d.date === today) || {};
  const todayTokenEntry = (stats.dailyModelTokens || []).find(d => d.date === today);
  let todayTokens = 0;
  if (todayTokenEntry?.tokensByModel) {
    todayTokens = Object.values(todayTokenEntry.tokensByModel).reduce((a, b) => a + b, 0);
  }

  const thisMonthTokens = (stats.dailyModelTokens || [])
    .filter(d => d.date.startsWith(monthStart))
    .reduce((sum, d) => sum + Object.values(d.tokensByModel || {}).reduce((a, b) => a + b, 0), 0);
  const thisMonthMessages = (stats.dailyActivity || [])
    .filter(d => d.date.startsWith(monthStart))
    .reduce((sum, d) => sum + d.messageCount, 0);

  // Cost estimate
  const totalOutput = Object.values(stats.modelUsage || {}).reduce((s, m) => s + (m.outputTokens || 0), 0);
  const totalInput = Object.values(stats.modelUsage || {}).reduce((s, m) => s + (m.inputTokens || 0), 0);
  const totalCacheRead = Object.values(stats.modelUsage || {}).reduce((s, m) => s + (m.cacheReadInputTokens || 0), 0);
  const totalCacheCreation = Object.values(stats.modelUsage || {}).reduce((s, m) => s + (m.cacheCreationInputTokens || 0), 0);
  const costEstimate =
    (totalInput / 1e6) * 15 + (totalOutput / 1e6) * 75 +
    (totalCacheRead / 1e6) * 1.5 + (totalCacheCreation / 1e6) * 18.75;

  // Daily history (last 14 days)
  const dailyHistory = (stats.dailyActivity || []).slice(-14).map(d => ({
    date: d.date,
    messages: d.messageCount,
    sessions: d.sessionCount,
    tools: d.toolCallCount,
  }));
  const dailyTokenHistory = (stats.dailyModelTokens || []).slice(-14).map(d => ({
    date: d.date,
    tokens: Object.values(d.tokensByModel || {}).reduce((a, b) => a + b, 0),
  }));

  // Claude Max account info
  const claudeJson = readJSON(CLAUDE_JSON) || {};
  const oauthAccount = claudeJson.oauthAccount || {};
  const passesCache = claudeJson.passesEligibilityCache || {};
  const orgUuid = oauthAccount.organizationUuid || '';
  const passesInfo = passesCache[orgUuid] || {};

  // Calculate daily usage intensity (% of your historical average)
  const allDailyTokens = (stats.dailyModelTokens || []).map(d =>
    Object.values(d.tokensByModel || {}).reduce((a, b) => a + b, 0)
  );
  const avgDailyTokens = allDailyTokens.length > 0
    ? allDailyTokens.reduce((a, b) => a + b, 0) / allDailyTokens.length
    : 1;
  const peakDailyTokens = allDailyTokens.length > 0
    ? Math.max(...allDailyTokens)
    : 1;

  const account = {
    name: oauthAccount.displayName || 'Unknown',
    email: oauthAccount.emailAddress || '',
    orgName: oauthAccount.organizationName || '',
    orgRole: oauthAccount.organizationRole || '',
    billingType: oauthAccount.billingType || '',
    hasExtraUsage: oauthAccount.hasExtraUsageEnabled || false,
    extraUsageDisabledReason: claudeJson.cachedExtraUsageDisabledReason || null,
    accountCreatedAt: oauthAccount.accountCreatedAt || '',
    subscriptionCreatedAt: oauthAccount.subscriptionCreatedAt || '',
    guestPassesRemaining: passesInfo.remaining_passes ?? null,
    referralCode: passesInfo.referral_code_details?.code || null,
    // Usage intensity
    todayVsAvgPct: avgDailyTokens > 0 ? Math.round((todayTokens / avgDailyTokens) * 100) : 0,
    todayVsPeakPct: peakDailyTokens > 0 ? Math.round((todayTokens / peakDailyTokens) * 100) : 0,
    avgDailyTokens: Math.round(avgDailyTokens),
    peakDailyTokens,
  };

  // Today cost estimate
  let todayInput = 0, todayOutput = 0, todayCacheRead = 0, todayCacheCreation = 0;
  if (todayTokenEntry?.tokensByModel) {
    // Approximate split using aggregate ratios
    const ratioIn = totalInput / Math.max(1, totalInput + totalOutput);
    const ratioOut = totalOutput / Math.max(1, totalInput + totalOutput);
    const ratioCR = totalCacheRead / Math.max(1, totalInput + totalOutput);
    const ratioCW = totalCacheCreation / Math.max(1, totalInput + totalOutput);
    const todayTotal = Object.values(todayTokenEntry.tokensByModel).reduce((a, b) => a + b, 0);
    todayInput = todayTotal * ratioIn;
    todayOutput = todayTotal * ratioOut;
    todayCacheRead = todayTotal * ratioCR;
    todayCacheCreation = todayTotal * ratioCW;
  }
  const todayCost =
    (todayInput / 1e6) * 15 + (todayOutput / 1e6) * 75 +
    (todayCacheRead / 1e6) * 1.5 + (todayCacheCreation / 1e6) * 18.75;

  // Month cost estimate
  const monthInput = thisMonthTokens * (totalInput / Math.max(1, totalInput + totalOutput));
  const monthOutput = thisMonthTokens * (totalOutput / Math.max(1, totalInput + totalOutput));
  const monthCR = thisMonthTokens * (totalCacheRead / Math.max(1, totalInput + totalOutput));
  const monthCW = thisMonthTokens * (totalCacheCreation / Math.max(1, totalInput + totalOutput));
  const monthCost =
    (monthInput / 1e6) * 15 + (monthOutput / 1e6) * 75 +
    (monthCR / 1e6) * 1.5 + (monthCW / 1e6) * 18.75;

  // Efficiency metrics
  const totalMsgs = stats.totalMessages || 1;
  const avgTokensPerMsg = Math.round((totalInput + totalOutput) / totalMsgs);
  const cacheHitRate = (totalInput + totalCacheRead) > 0
    ? Math.round((totalCacheRead / (totalInput + totalCacheRead)) * 100)
    : 0;
  const totalTools = (stats.dailyActivity || []).reduce((s, d) => s + (d.toolCallCount || 0), 0);
  const toolsPerMsg = totalMsgs > 0 ? (totalTools / totalMsgs).toFixed(1) : '0';

  // Daily message history for dual chart
  const dailyMsgHistory = (stats.dailyActivity || []).slice(-14).map(d => ({
    date: d.date,
    messages: d.messageCount || 0,
  }));

  // Hour of day activity distribution
  const hourCounts = stats.hourCounts || new Array(24).fill(0);

  // Longest session record
  const longestSession = stats.longestSession || null;

  // First session date
  const firstSessionDate = stats.firstSessionDate || null;

  // Number of CLI startups
  const numStartups = claudeJson.numStartups || 0;

  // Total web searches across all models
  const webSearches = Object.values(stats.modelUsage || {}).reduce(
    (s, m) => s + (m.webSearchRequests || 0), 0
  );

  // Per-project stats from .claude.json
  const projectStats = [];
  const projectsMap = claudeJson.projects || {};
  for (const [projPath, proj] of Object.entries(projectsMap)) {
    if (proj.lastCost != null && proj.lastCost > 0) {
      projectStats.push({
        name: projPath.split('/').filter(Boolean).pop() || projPath,
        cost: proj.lastCost || 0,
        linesAdded: proj.lastLinesAdded || 0,
        linesRemoved: proj.lastLinesRemoved || 0,
        webSearches: proj.lastTotalWebSearchRequests || 0,
      });
    }
  }
  projectStats.sort((a, b) => b.cost - a.cost);

  // All projects scan
  const allProjects = scanAllProjects();

  // Claude Desktop info
  let desktopInfo = null;
  try {
    const desktopConfigPath = path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'config.json');
    const desktopConfig = readJSON(desktopConfigPath);
    if (desktopConfig) {
      let appVersion = 'unknown';
      try {
        const sysInfoPath = path.join(os.homedir(), 'Library', 'Logs', 'Claude', 'system-info.txt');
        const sysInfo = fs.readFileSync(sysInfoPath, 'utf-8');
        const verMatch = sysInfo.match(/App Version:\s*(.+)/);
        if (verMatch) appVersion = verMatch[1].trim();
      } catch {}
      desktopInfo = {
        installed: true,
        version: appVersion,
      };
    }
  } catch {}

  return {
    sessions,
    today: {
      messages: todayActivity.messageCount || 0,
      tokens: todayTokens,
      sessions: todayActivity.sessionCount || 0,
      tools: todayActivity.toolCallCount || 0,
      cost: todayCost,
    },
    month: {
      tokens: thisMonthTokens,
      messages: thisMonthMessages,
      cost: monthCost,
    },
    aggregate: {
      totalSessions: stats.totalSessions || 0,
      totalMessages: stats.totalMessages || 0,
      costEstimate,
      modelUsage: stats.modelUsage || {},
    },
    efficiency: {
      avgTokensPerMsg,
      cacheHitRate,
      toolsPerMsg,
      totalTools,
    },
    account,
    dailyHistory,
    dailyTokenHistory,
    dailyMsgHistory,
    hourCounts,
    longestSession,
    firstSessionDate,
    numStartups,
    webSearches,
    projectStats,
    desktopInfo,
    allProjects,
    timestamp: Date.now(),
  };
}

module.exports = { collect };

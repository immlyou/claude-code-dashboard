'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const STATS_FILE = path.join(CLAUDE_DIR, 'stats-cache.json');
const CLAUDE_JSON = path.join(os.homedir(), '.claude.json');

const MODEL_PRICING = {
  // per million tokens [input, output, cache_read, cache_write]
  'opus':   [15, 75, 1.5, 18.75],
  'sonnet': [3, 15, 0.3, 3.75],
  'haiku':  [0.25, 1.25, 0.025, 0.3125],
};

function getModelPricing(modelName) {
  const name = modelName.toLowerCase();
  if (name.includes('opus')) return MODEL_PRICING.opus;
  if (name.includes('haiku')) return MODEL_PRICING.haiku;
  return MODEL_PRICING.sonnet; // default to sonnet
}

// Cache for scanAllProjects
let projectsCache = null;
let projectsCacheTime = 0;
const fileStatsCache = new Map();
const PROJECTS_CACHE_TTL = 30000; // 30 seconds

// Cache for the merged per-LOCAL-date buckets built alongside scanAllProjects.
// Map<date, { messageCount, toolCallCount, tokensByModel, hourCounts, sessionIds: Set<string> }>
let dateBucketsCache = new Map();

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

// Format a Date using the machine's LOCAL timezone as YYYY-MM-DD (never UTC).
function localDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
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
function scanFileForStats(filePath) {
  let totalInput = 0, totalOutput = 0, totalCacheRead = 0;
  let messageCount = 0, toolCallCount = 0;
  let lastActivity = null;
  const models = new Set();

  // Per-LOCAL-date buckets: date -> { messageCount, toolCallCount, tokensByModel, hourCounts }
  const dailyBuckets = {};
  function getBucket(date) {
    let b = dailyBuckets[date];
    if (!b) {
      b = { messageCount: 0, toolCallCount: 0, tokensByModel: {}, hourCounts: new Array(24).fill(0) };
      dailyBuckets[date] = b;
    }
    return b;
  }

  // Dedup assistant messages by message.id(+requestId): streaming/log replay can write
  // the same assistant message (and its usage + tool_use blocks) more than once.
  const seenAssistantKeys = new Set();
  const seenToolUseIds = new Set();

  // Full scan — results are cached by mtime in scanAllProjects, so this only runs once per file change
  const content = fs.readFileSync(filePath, 'utf-8');

  const lines = content.split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);

      let entryDate = null, entryHour = null;
      if (entry.timestamp) {
        const d = new Date(entry.timestamp);
        if (!isNaN(d.getTime())) {
          entryDate = localDateStr(d);
          entryHour = d.getHours();
        }
      }

      if (entry.type === 'user') {
        messageCount++;
        if (entryDate) {
          const b = getBucket(entryDate);
          b.messageCount++;
          if (entryHour !== null) b.hourCounts[entryHour]++;
        }
      }

      let isDuplicateAssistant = false;
      if (entry.type === 'assistant' && entry.message?.id) {
        const key = entry.message.id + '|' + (entry.requestId || '');
        if (seenAssistantKeys.has(key)) isDuplicateAssistant = true;
        else seenAssistantKeys.add(key);
      }

      if (entry.type === 'assistant' && entry.message?.usage && !isDuplicateAssistant) {
        const u = entry.message.usage;
        const inputT = u.input_tokens || 0;
        const outputT = u.output_tokens || 0;
        const cacheReadT = u.cache_read_input_tokens || 0;
        const cacheCreationT = u.cache_creation_input_tokens || 0;
        totalInput += inputT;
        totalOutput += outputT;
        totalCacheRead += cacheReadT;
        if (entry.message?.model) models.add(entry.message.model);
        if (entryDate) {
          const b = getBucket(entryDate);
          const model = entry.message.model || 'unknown';
          b.tokensByModel[model] = (b.tokensByModel[model] || 0) + inputT + outputT + cacheReadT + cacheCreationT;
        }
      }

      // A single assistant turn is often split across lines sharing message.id (thinking / text /
      // tool_use), so dedup tool calls per block id rather than per message.
      if (entry.message?.content && Array.isArray(entry.message.content)) {
        let toolsInEntry = 0;
        for (const block of entry.message.content) {
          if (block.type !== 'tool_use') continue;
          if (block.id) {
            if (seenToolUseIds.has(block.id)) continue;
            seenToolUseIds.add(block.id);
          }
          toolsInEntry++;
        }
        if (toolsInEntry > 0) {
          toolCallCount += toolsInEntry;
          if (entryDate) getBucket(entryDate).toolCallCount += toolsInEntry;
        }
      }

      if (entry.timestamp && (!lastActivity || entry.timestamp > lastActivity)) {
        lastActivity = entry.timestamp;
      }
    } catch { /* skip bad line */ }
  }

  return { totalInput, totalOutput, totalCacheRead, messageCount, toolCallCount, lastActivity, models: [...models], bytesScanned: content.length, dailyBuckets };
}

function getFileStats(filePath) {
  const mtimeMs = fs.statSync(filePath).mtimeMs;
  const cached = fileStatsCache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.stats;
  const stats = scanFileForStats(filePath);
  fileStatsCache.set(filePath, { mtimeMs, bytesScanned: stats.bytesScanned, stats });
  return stats;
}

// Recursively lists subagent conversation logs; skips workflow journal.jsonl and other files.
function findSubagentLogs(dir) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...findSubagentLogs(p));
    else if (e.isFile() && e.name.startsWith('agent-') && e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

function scanAllProjects() {
  const now = Date.now();
  if (projectsCache && (now - projectsCacheTime) < PROJECTS_CACHE_TTL) {
    return projectsCache;
  }

  const projects = [];
  const freshDateBuckets = new Map();

  // Subagent logs contribute usage (tokens, tool calls) only: their "user" entries are the
  // parent's prompts/tool results, not the person's messages, and they aren't separate sessions.
  function mergeFileBucketsIntoDate(sessionId, fileDailyBuckets, isSubagent = false) {
    for (const [date, bucket] of Object.entries(fileDailyBuckets || {})) {
      let agg = freshDateBuckets.get(date);
      if (!agg) {
        agg = { messageCount: 0, toolCallCount: 0, tokensByModel: {}, hourCounts: new Array(24).fill(0), sessionIds: new Set() };
        freshDateBuckets.set(date, agg);
      }
      agg.toolCallCount += bucket.toolCallCount;
      if (!isSubagent) {
        agg.messageCount += bucket.messageCount;
        agg.sessionIds.add(sessionId);
        for (let h = 0; h < 24; h++) agg.hourCounts[h] += bucket.hourCounts[h];
      }
      for (const [model, tok] of Object.entries(bucket.tokensByModel)) {
        agg.tokensByModel[model] = (agg.tokensByModel[model] || 0) + tok;
      }
    }
  }

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

      const addFile = (filePath, sessionId, isSubagent) => {
        try {
          const fileStats = getFileStats(filePath);
          totalInput += fileStats.totalInput;
          totalOutput += fileStats.totalOutput;
          totalCacheRead += fileStats.totalCacheRead;
          if (!isSubagent) messageCount += fileStats.messageCount;
          toolCallCount += fileStats.toolCallCount;
          for (const m of fileStats.models) models.add(m);
          if (fileStats.lastActivity && (!lastActivity || fileStats.lastActivity > lastActivity)) {
            lastActivity = fileStats.lastActivity;
          }
          mergeFileBucketsIntoDate(sessionId, fileStats.dailyBuckets, isSubagent);
        } catch { /* skip unreadable file */ }
      };

      try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const e of entries) {
          if (e.isFile() && e.name.endsWith('.jsonl')) {
            sessionCount++;
            addFile(path.join(dirPath, e.name), path.basename(e.name, '.jsonl'), false);
          } else if (e.isDirectory()) {
            // <sessionId>/subagents/**/agent-*.jsonl (Agent tool and workflow subagents)
            for (const subFile of findSubagentLogs(path.join(dirPath, e.name, 'subagents'))) {
              addFile(subFile, e.name, true);
            }
          }
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

  projectsCache = projects;
  projectsCacheTime = now;
  dateBucketsCache = freshDateBuckets;
  return projects;
}

// Ensures scanAllProjects() has run within its TTL (which also populates dateBucketsCache),
// then returns the merged per-LOCAL-date buckets built from ~/.claude/projects/*.jsonl.
function getDateBuckets() {
  scanAllProjects();
  return dateBucketsCache;
}

function collect() {
  const errors = [];

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
  } catch(e) { errors.push({ source: 'sessionReading', message: e.message }); }

  // Dead session cleanup: remove stale session files older than 24 hours
  let cleanedUp = 0;
  const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
  for (const s of sessions) {
    if (!s.alive) {
      try {
        const sessionFilePath = path.join(SESSIONS_DIR, `${s.pid}.json`);
        const stat = fs.statSync(sessionFilePath);
        if (Date.now() - stat.mtimeMs > TWENTY_FOUR_HOURS) {
          fs.unlinkSync(sessionFilePath);
          cleanedUp++;
        }
      } catch { /* ignore */ }
    }
  }
  // Remove cleaned-up sessions from the list
  const activeSessions = cleanedUp > 0
    ? sessions.filter(s => {
        if (!s.alive) {
          try { fs.statSync(path.join(SESSIONS_DIR, `${s.pid}.json`)); return true; }
          catch { return false; }
        }
        return true;
      })
    : sessions;

  activeSessions.sort((a, b) => {
    if (a.alive !== b.alive) return a.alive ? -1 : 1;
    return b.startedAt - a.startedAt;
  });

  // Stats
  let stats = {};
  try { stats = JSON.parse(fs.readFileSync(STATS_FILE, 'utf-8')); }
  catch(e) { errors.push({ source: 'statsReading', message: e.message }); }
  const today = localDateStr(new Date());
  const now = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  // Date-based stats (today/month/history) come from the JSONL conversation logs, which are
  // the real source of truth — stats-cache.json can go stale (its collector may stop running).
  // Merge rule: for a given date, prefer the JSONL-derived bucket when present, else fall back
  // to the stats-cache entry for that date.
  let dateBuckets = new Map();
  try { dateBuckets = getDateBuckets(); }
  catch(e) { errors.push({ source: 'dateBuckets', message: e.message }); }

  const cacheDailyActivityByDate = new Map((stats.dailyActivity || []).map(d => [d.date, d]));
  const cacheDailyTokensByDate = new Map((stats.dailyModelTokens || []).map(d => [d.date, d]));
  const allKnownDates = new Set([
    ...cacheDailyActivityByDate.keys(),
    ...cacheDailyTokensByDate.keys(),
    ...dateBuckets.keys(),
  ]);
  const sortedDates = [...allKnownDates].sort();

  const mergedDailyActivity = [];
  const mergedDailyModelTokens = [];
  for (const date of sortedDates) {
    const jsonlBucket = dateBuckets.get(date);
    if (jsonlBucket) {
      mergedDailyActivity.push({
        date,
        messageCount: jsonlBucket.messageCount,
        sessionCount: jsonlBucket.sessionIds.size,
        toolCallCount: jsonlBucket.toolCallCount,
      });
      mergedDailyModelTokens.push({ date, tokensByModel: jsonlBucket.tokensByModel });
    } else {
      const cacheAct = cacheDailyActivityByDate.get(date);
      if (cacheAct) mergedDailyActivity.push(cacheAct);
      const cacheTok = cacheDailyTokensByDate.get(date);
      if (cacheTok) mergedDailyModelTokens.push(cacheTok);
    }
  }

  const todayActivity = mergedDailyActivity.find(d => d.date === today) || {};
  const todayTokenEntry = mergedDailyModelTokens.find(d => d.date === today);
  let todayTokens = 0;
  if (todayTokenEntry?.tokensByModel) {
    todayTokens = Object.values(todayTokenEntry.tokensByModel).reduce((a, b) => a + b, 0);
  }

  const thisMonthTokens = mergedDailyModelTokens
    .filter(d => d.date.startsWith(monthStart))
    .reduce((sum, d) => sum + Object.values(d.tokensByModel || {}).reduce((a, b) => a + b, 0), 0);
  const thisMonthMessages = mergedDailyActivity
    .filter(d => d.date.startsWith(monthStart))
    .reduce((sum, d) => sum + d.messageCount, 0);

  // Cost estimate (per-model pricing)
  const totalOutput = Object.values(stats.modelUsage || {}).reduce((s, m) => s + (m.outputTokens || 0), 0);
  const totalInput = Object.values(stats.modelUsage || {}).reduce((s, m) => s + (m.inputTokens || 0), 0);
  const totalCacheRead = Object.values(stats.modelUsage || {}).reduce((s, m) => s + (m.cacheReadInputTokens || 0), 0);
  const totalCacheCreation = Object.values(stats.modelUsage || {}).reduce((s, m) => s + (m.cacheCreationInputTokens || 0), 0);
  let costEstimate = 0;
  for (const [modelName, m] of Object.entries(stats.modelUsage || {})) {
    const [pIn, pOut, pCR, pCW] = getModelPricing(modelName);
    costEstimate +=
      ((m.inputTokens || 0) / 1e6) * pIn +
      ((m.outputTokens || 0) / 1e6) * pOut +
      ((m.cacheReadInputTokens || 0) / 1e6) * pCR +
      ((m.cacheCreationInputTokens || 0) / 1e6) * pCW;
  }

  // Daily history (last 14 days)
  const dailyHistory = mergedDailyActivity.slice(-14).map(d => ({
    date: d.date,
    messages: d.messageCount,
    sessions: d.sessionCount,
    tools: d.toolCallCount,
  }));
  const dailyTokenHistory = mergedDailyModelTokens.slice(-14).map(d => ({
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
  const allDailyTokens = mergedDailyModelTokens.map(d =>
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
    billingType: oauthAccount.billingType || (oauthAccount.hasExtraUsageEnabled ? 'max' : (oauthAccount.organizationRole ? 'pro' : 'free')),
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

  // Today cost estimate (per-model with assumed token type split)
  // Use fixed ratios: 30% input, 50% output, 15% cache_read, 5% cache_write
  const RATIO_IN = 0.30, RATIO_OUT = 0.50, RATIO_CR = 0.15, RATIO_CW = 0.05;
  let todayCost = 0;
  if (todayTokenEntry?.tokensByModel) {
    for (const [modelName, tokens] of Object.entries(todayTokenEntry.tokensByModel)) {
      const [pIn, pOut, pCR, pCW] = getModelPricing(modelName);
      todayCost +=
        (tokens * RATIO_IN / 1e6) * pIn +
        (tokens * RATIO_OUT / 1e6) * pOut +
        (tokens * RATIO_CR / 1e6) * pCR +
        (tokens * RATIO_CW / 1e6) * pCW;
    }
  }

  // Month cost estimate (per-model with assumed token type split)
  let monthCost = 0;
  for (const d of mergedDailyModelTokens.filter(d => d.date.startsWith(monthStart))) {
    for (const [modelName, tokens] of Object.entries(d.tokensByModel || {})) {
      const [pIn, pOut, pCR, pCW] = getModelPricing(modelName);
      monthCost +=
        (tokens * RATIO_IN / 1e6) * pIn +
        (tokens * RATIO_OUT / 1e6) * pOut +
        (tokens * RATIO_CR / 1e6) * pCR +
        (tokens * RATIO_CW / 1e6) * pCW;
    }
  }

  // Efficiency metrics
  const totalMsgs = stats.totalMessages || 1;
  const avgTokensPerMsg = Math.round((totalInput + totalOutput) / totalMsgs);
  const cacheHitRate = (totalInput + totalCacheRead) > 0
    ? Math.round((totalCacheRead / (totalInput + totalCacheRead)) * 100)
    : 0;
  const totalTools = mergedDailyActivity.reduce((s, d) => s + (d.toolCallCount || 0), 0);
  const toolsPerMsg = totalMsgs > 0 ? (totalTools / totalMsgs).toFixed(1) : '0';

  // Daily message history for dual chart
  const dailyMsgHistory = mergedDailyActivity.slice(-14).map(d => ({
    date: d.date,
    messages: d.messageCount || 0,
  }));

  // Month sessions and tools
  const thisMonthSessions = mergedDailyActivity
    .filter(d => d.date.startsWith(monthStart))
    .reduce((sum, d) => sum + (d.sessionCount || 0), 0);
  const thisMonthTools = mergedDailyActivity
    .filter(d => d.date.startsWith(monthStart))
    .reduce((sum, d) => sum + (d.toolCallCount || 0), 0);

  // Hour of day activity distribution
  // stats.hourCounts may be an object { "0": n, "1": n, ... } or an array
  let hourCounts;
  if (Array.isArray(stats.hourCounts)) {
    hourCounts = stats.hourCounts;
  } else if (stats.hourCounts && typeof stats.hourCounts === 'object') {
    hourCounts = new Array(24).fill(0);
    for (const [h, count] of Object.entries(stats.hourCounts)) {
      hourCounts[parseInt(h, 10)] = count;
    }
  } else {
    hourCounts = new Array(24).fill(0);
  }

  // Fold in JSONL-derived hour counts for dates after stats-cache's lastComputedDate — those
  // dates can't already be represented in stats.hourCounts, so this can't double count them.
  const lastComputedDate = stats.lastComputedDate || '';
  for (const [date, bucket] of dateBuckets) {
    if (!lastComputedDate || date > lastComputedDate) {
      for (let h = 0; h < 24; h++) hourCounts[h] += bucket.hourCounts[h];
    }
  }

  // Weekday x Hour heatmap (7 days x 24 hours)
  // weekdayHourCounts[dayOfWeek][hour] where 0=Sunday, 6=Saturday
  const weekdayHourCounts = Array.from({ length: 7 }, () => new Array(24).fill(0));
  if (stats.weekdayHourCounts) {
    // Use stored data if available
    for (let d = 0; d < 7; d++) {
      for (let h = 0; h < 24; h++) {
        weekdayHourCounts[d][h] = (stats.weekdayHourCounts[d] && stats.weekdayHourCounts[d][h]) || 0;
      }
    }
  } else {
    // Derive from dailyActivity: for each day entry, figure out the day-of-week
    // and distribute its message count across hours proportional to hourCounts
    const totalHourActivity = hourCounts.reduce((a, b) => a + b, 0) || 1;
    for (const d of mergedDailyActivity) {
      const dayDate = new Date(d.date + 'T12:00:00');
      const dow = dayDate.getDay(); // 0=Sunday
      const msgs = d.messageCount || 0;
      for (let h = 0; h < 24; h++) {
        weekdayHourCounts[dow][h] += Math.round(msgs * (hourCounts[h] / totalHourActivity));
      }
    }
  }

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
  let allProjects = [];
  try {
    allProjects = scanAllProjects();
  } catch(e) { errors.push({ source: 'scanAllProjects', message: e.message }); }

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
      } catch(e) { errors.push({ source: 'desktopVersion', message: e.message }); }
      desktopInfo = {
        installed: true,
        version: appVersion,
      };
    }
  } catch(e) { errors.push({ source: 'desktopInfo', message: e.message }); }

  return {
    sessions: activeSessions,
    cleanedUp,
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
      sessions: thisMonthSessions,
      tools: thisMonthTools,
      cost: monthCost,
    },
    aggregate: {
      totalSessions: stats.totalSessions || 0,
      totalMessages: stats.totalMessages || 0,
      totalTokens: totalInput + totalOutput + totalCacheRead + totalCacheCreation,
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
    weekdayHourCounts,
    longestSession,
    firstSessionDate,
    numStartups,
    webSearches,
    projectStats,
    desktopInfo,
    allProjects,
    errors,
    timestamp: Date.now(),
  };
}

module.exports = { collect };

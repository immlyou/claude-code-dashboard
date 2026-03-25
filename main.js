const { app, nativeImage, ipcMain, nativeTheme, Menu, BrowserWindow, session, Notification } = require('electron');
const { menubar } = require('menubar');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { buildPNG, drawCampfire, TOTAL_FRAMES } = require('./icon-draw');

// ─── Settings persistence ──────────────────────────────────────────
const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'dashboard-settings.json');
const DEFAULT_REFRESH_INTERVAL = 3000;

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function saveSettings(settings) {
  try {
    const dir = path.dirname(SETTINGS_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf-8');
  } catch (e) {
    console.error('Failed to save settings:', e.message);
  }
}

/**
 * Pre-render all animation frames for the tray campfire icon.
 * 64x64 @2x → 32pt icon in the menu bar (bigger & clearer).
 */
function buildFrames() {
  const frames = [];
  for (let i = 0; i < TOTAL_FRAMES; i++) {
    const canvas = drawCampfire(64, i, { showBackground: false });
    const pngBuf = buildPNG(64, 64, canvas.buf);
    frames.push(nativeImage.createFromBuffer(pngBuf, { scaleFactor: 2.0 }));
  }
  return frames;
}

let animFrames = null;
let animIndex = 0;
let animTimer = null;

function startTrayAnimation(tray) {
  if (!animFrames) animFrames = buildFrames();
  // Mark all frames as non-template so macOS shows full color
  for (const f of animFrames) f.setTemplateImage(false);
  animIndex = 0;
  if (animTimer) clearInterval(animTimer);
  animTimer = setInterval(() => {
    animIndex = (animIndex + 1) % TOTAL_FRAMES;
    try { tray.setImage(animFrames[animIndex]); } catch (_) {}
  }, 150); // ~6.7 fps — smooth enough, not too CPU-heavy
}

// ─── App ────────────────────────────────────────────────────────────

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.whenReady().then(() => {
    // Use first frame as initial icon
    if (!animFrames) animFrames = buildFrames();
    const icon = animFrames[0];

    const mb = menubar({
      index: `file://${path.join(__dirname, 'ui', 'index.html')}`,
      icon,
      preloadWindow: true,
      browserWindow: {
        width: 520,
        height: 680,
        resizable: false,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          preload: path.join(__dirname, 'preload.js'),
        },
        skipTaskbar: true,
        vibrancy: 'under-window',
        visualEffectState: 'active',
        transparent: true,
        backgroundColor: '#00000000',
      },
      showDockIcon: false,
    });

    mb.on('ready', () => {
      console.log('✅ Claude Dashboard ready — look for the campfire in your menu bar!');
      startTrayAnimation(mb.tray);

      // Re-apply animation icon after menubar show/hide to prevent reset
      mb.on('after-show', () => {
        if (animFrames) {
          try { mb.tray.setImage(animFrames[animIndex]); } catch (_) {}
        }
      });
      mb.on('after-hide', () => {
        if (animFrames) {
          try { mb.tray.setImage(animFrames[animIndex]); } catch (_) {}
        }
      });

      // Right-click menu
      const contextMenu = Menu.buildFromTemplate([
        { label: 'Open Dashboard', click: () => mb.showWindow() },
        { type: 'separator' },
        { label: 'Quit Dashboard', click: () => app.quit() },
      ]);
      mb.tray.on('right-click', () => mb.tray.popUpContextMenu(contextMenu));

      // Sync theme
      const sendTheme = () => {
        if (mb.window) {
          mb.window.webContents.send(
            'theme-changed',
            nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
          );
        }
      };
      mb.on('after-show', sendTheme);
      nativeTheme.on('updated', sendTheme);
    });

    // ── Notification System ──
    let lastNotifications = {};

    function notify(id, title, body) {
      // Debounce: don't send same notification within 30 minutes
      const now = Date.now();
      if (lastNotifications[id] && (now - lastNotifications[id]) < 1800000) return;
      lastNotifications[id] = now;

      const notif = new Notification({ title, body, silent: false });
      notif.show();
    }

    ipcMain.handle('check-notifications', async (_, data) => {
      // 1. Plan usage > 80%
      if (data.planUsage) {
        for (const limit of (data.planUsage.limits || [])) {
          if (limit.pct >= 80) {
            notify(`plan-${limit.label}`, 'Claude Usage Alert', `${limit.label} is at ${limit.pct}% usage`);
          }
        }
      }

      // 2. Today cost > 2x historical average
      if (data.todayCost > 0 && data.avgDailyCost > 0 && data.todayCost > data.avgDailyCost * 2) {
        notify('high-cost', 'High Usage Today', `Today's estimated cost ($${data.todayCost.toFixed(2)}) is over 2x your daily average`);
      }

      // 3. Session crashed (dead session that was recently alive)
      if (data.deadSessions && data.deadSessions.length > 0) {
        for (const s of data.deadSessions) {
          notify(`dead-${s.pid}`, 'Session Ended', `Claude session in ${s.project} has ended`);
        }
      }

      return { ok: true };
    });

    ipcMain.handle('get-app-version', () => {
      return app.getVersion();  // reads from package.json automatically
    });

    ipcMain.handle('get-dashboard-data', async () => {
      const collector = require('./collector');
      return collector.collect();
    });

    // ── Configurable Refresh Interval ──
    ipcMain.handle('set-refresh-interval', async (_, interval) => {
      const ms = Math.max(1000, Math.min(60000, Number(interval) || DEFAULT_REFRESH_INTERVAL));
      const settings = loadSettings();
      settings.refreshInterval = ms;
      saveSettings(settings);
      return { ok: true, interval: ms };
    });

    ipcMain.handle('get-refresh-interval', async () => {
      const settings = loadSettings();
      return settings.refreshInterval || DEFAULT_REFRESH_INTERVAL;
    });

    // ── Claude Model Switcher ──
    const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');

    ipcMain.handle('get-claude-model', async () => {
      try {
        const settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf-8'));
        return settings.model || 'sonnet';
      } catch {
        return 'sonnet';
      }
    });

    ipcMain.handle('set-claude-model', async (_, model) => {
      try {
        let settings = {};
        try {
          settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf-8'));
        } catch {}
        settings.model = model;
        fs.writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf-8');
        return { ok: true, model };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    });

    // ── Cloud Leaderboard System ──
    const crypto = require('crypto');

    ipcMain.handle('get-leaderboard-settings', async () => {
      const settings = loadSettings();
      return settings.leaderboard || {
        enabled: false,
        nickname: '',
        userId: null,
        privacy: {
          shareToday: true,
          shareWeekly: true,
          shareMonthly: true,
          shareAllTime: true
        }
      };
    });

    ipcMain.handle('set-leaderboard-settings', async (_, leaderboardSettings) => {
      const settings = loadSettings();
      settings.leaderboard = { ...settings.leaderboard, ...leaderboardSettings };
      saveSettings(settings);
      return { ok: true };
    });

    ipcMain.handle('generate-user-id', async () => {
      const settings = loadSettings();
      if (!settings.leaderboard?.userId) {
        const machineId = os.hostname() + os.userInfo().username + Date.now();
        const userId = crypto.createHash('sha256').update(machineId).digest('hex').slice(0, 20);
        settings.leaderboard = settings.leaderboard || {};
        settings.leaderboard.userId = userId;
        saveSettings(settings);
      }
      return settings.leaderboard.userId;
    });

    // ── Plan Usage Scraper ──
    let scraperWin = null;
    let scrapeResolved = false;

    ipcMain.handle('fetch-plan-usage', async () => {
      return new Promise((resolve) => {
        scrapeResolved = false;

        function done(data) {
          if (scrapeResolved) return;
          scrapeResolved = true;
          clearTimeout(timeout);
          if (scraperWin && !scraperWin.isDestroyed()) scraperWin.close();
          scraperWin = null;
          resolve(data);
        }

        const timeout = setTimeout(() => done({ error: 'timeout' }), 30000);

        scraperWin = new BrowserWindow({
          width: 1200,
          height: 900,
          show: false,
          webPreferences: {
            session: session.fromPartition('persist:anthropic-console'),
            nodeIntegration: false,
            contextIsolation: true,
          },
        });

        const scrapeJS = `
          (function() {
            const allText = document.body.innerText;
            const result = { limits: [], extraUsage: null, url: location.href };
            const lines = allText.split(/\\n/).map(l => l.trim()).filter(Boolean);
            let currentLabel = '';
            let currentReset = '';

            for (let i = 0; i < lines.length; i++) {
              const line = lines[i];

              if (/current session/i.test(line)) currentLabel = 'Current Session';
              else if (/all model/i.test(line)) currentLabel = 'All Models (Weekly)';
              else if (/sonnet/i.test(line) && !currentLabel) currentLabel = 'Sonnet (Weekly)';
              else if (/opus/i.test(line) && !currentLabel) currentLabel = 'Opus (Weekly)';
              else if (/extra usage/i.test(line)) currentLabel = 'Extra Usage';

              const resetMatch = line.match(/Resets?\\s+(.+)/i);
              if (resetMatch) currentReset = resetMatch[0];

              const pctMatch = line.match(/(\\d+)%\\s*used/i);
              if (pctMatch && currentLabel) {
                result.limits.push({
                  label: currentLabel,
                  pct: parseInt(pctMatch[1]),
                  reset: currentReset,
                });
                currentLabel = '';
                currentReset = '';
              }

              const dollarMatch = line.match(/\\$(\\d+\\.\\d{2})\\s*spent/i);
              if (dollarMatch) {
                result.extraUsage = result.extraUsage || {};
                result.extraUsage.spent = parseFloat(dollarMatch[1]);
                result.extraUsage.reset = currentReset;
              }

              if (/monthly spend limit/i.test(line)) {
                const nearby = lines.slice(Math.max(0, i-3), i+3).join(' ');
                const valM = nearby.match(/\\$(\\d+(?:\\.\\d{2})?)/);
                if (valM && result.extraUsage) {
                  result.extraUsage.limit = parseFloat(valM[1]);
                }
              }
            }

            return result;
          })();
        `;

        async function tryScrape(retriesLeft) {
          if (scrapeResolved || !scraperWin || scraperWin.isDestroyed()) return;
          try {
            const url = scraperWin.webContents.getURL();
            if (url.includes('/login') || url.includes('/oauth') || url.includes('/auth')) {
              return done({ error: 'not_logged_in' });
            }

            const data = await scraperWin.webContents.executeJavaScript(scrapeJS);

            // Retry if no data was found and retries remain
            if ((!data.limits || data.limits.length === 0) && !data.extraUsage && retriesLeft > 0) {
              setTimeout(() => tryScrape(retriesLeft - 1), 2000);
              return;
            }

            done(data);
          } catch (e) {
            if (retriesLeft > 0) {
              setTimeout(() => tryScrape(retriesLeft - 1), 2000);
            } else {
              done({ error: e.message });
            }
          }
        }

        // Detect load failures early
        scraperWin.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
          done({ error: `Load failed (${errorCode}): ${errorDescription}`, url: validatedURL });
        });

        // Only scrape once after first load completes
        let scraped = false;
        scraperWin.webContents.on('did-finish-load', () => {
          if (scraped) return;
          scraped = true;
          setTimeout(() => tryScrape(2), 4000);
        });

        scraperWin.loadURL('https://claude.ai/settings/usage').catch((err) => {
          done({ error: `Navigation error: ${err.message}` });
        });
        scraperWin.on('closed', () => { scraperWin = null; });
      });
    });

    ipcMain.handle('open-console-login', async () => {
      const win = new BrowserWindow({
        width: 1100,
        height: 750,
        title: 'Login to Claude',
        webPreferences: {
          session: session.fromPartition('persist:anthropic-console'),
          nodeIntegration: false,
          contextIsolation: true,
        },
        titleBarStyle: 'hiddenInset',
        trafficLightPosition: { x: 12, y: 12 },
        backgroundColor: '#1a1a2e',
      });
      win.loadURL('https://claude.ai/login');
    });

    // ── Embedded Console Window ──
    let consoleWin = null;
    const consoleSes = session.fromPartition('persist:anthropic-console');

    ipcMain.handle('open-console', async (_, url) => {
      if (consoleWin && !consoleWin.isDestroyed()) {
        consoleWin.loadURL(url);
        consoleWin.show();
        consoleWin.focus();
        return;
      }
      consoleWin = new BrowserWindow({
        width: 1100,
        height: 750,
        title: 'Anthropic Console',
        webPreferences: {
          session: consoleSes,
          nodeIntegration: false,
          contextIsolation: true,
        },
        titleBarStyle: 'hiddenInset',
        trafficLightPosition: { x: 12, y: 12 },
        backgroundColor: '#1a1a2e',
      });
      consoleWin.loadURL(url);
      consoleWin.on('closed', () => { consoleWin = null; });
    });
  });

  app.on('window-all-closed', (e) => e.preventDefault());
}

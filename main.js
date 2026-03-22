const { app, nativeImage, ipcMain, nativeTheme, Menu, BrowserWindow, session } = require('electron');
const { menubar } = require('menubar');
const path = require('path');
const { buildPNG, drawCampfire, TOTAL_FRAMES } = require('./icon-draw');

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
          nodeIntegration: true,
          contextIsolation: false,
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

    ipcMain.handle('get-dashboard-data', async () => {
      const collector = require('./collector');
      const data = collector.collect();

      // Write widget data for macOS WidgetKit
      try {
        const fs = require('fs');
        const os = require('os');
        const widgetData = {
          activeSessions: data.sessions.filter(s => s.alive).length,
          todayMessages: data.today.messages,
          todayTokens: data.today.tokens,
          todayCost: data.today.cost,
          monthCost: data.month.cost,
          totalCost: data.aggregate.costEstimate,
          plan: data.account.billingType || '',
          userName: data.account.name || '',
          cacheHitRate: data.efficiency.cacheHitRate,
          avgTokensPerMsg: data.efficiency.avgTokensPerMsg,
          timestamp: Date.now(),
        };
        fs.writeFileSync(
          path.join(os.homedir(), '.claude', 'widget-data.json'),
          JSON.stringify(widgetData, null, 2),
          'utf-8'
        );
      } catch (_) {}

      return data;
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

        async function tryScrape() {
          if (scrapeResolved || !scraperWin || scraperWin.isDestroyed()) return;
          try {
            const url = scraperWin.webContents.getURL();
            if (url.includes('/login') || url.includes('/oauth') || url.includes('/auth')) {
              return done({ error: 'not_logged_in' });
            }

            const data = await scraperWin.webContents.executeJavaScript(`
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
            `);
            done(data);
          } catch (e) {
            done({ error: e.message });
          }
        }

        // Only scrape once after first load completes
        let scraped = false;
        scraperWin.webContents.on('did-finish-load', () => {
          if (scraped) return;
          scraped = true;
          setTimeout(() => tryScrape(), 8000);
        });

        scraperWin.loadURL('https://claude.ai/settings/usage');
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

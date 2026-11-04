const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');

let currentPanel = undefined;
let statusBarItem = undefined;
let lastTriggerTime = 0;

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  // 1. Create Bottom Status Bar Button
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.text = '$(terminal) Claude Quota: OK';
  statusBarItem.tooltip = 'Click to launch Claude ASCII Screensaver (Ctrl+Alt+S)';
  statusBarItem.command = 'claudeSaver.startWebview';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // 2. Register Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeSaver.startWebview', () => {
      triggerScreensaver(context, { resetTime: '', mode: getPreferredMode(), forceTarget: 'vscode-webview' });
    }),
    vscode.commands.registerCommand('claudeSaver.startExternalKiosk', () => {
      triggerScreensaver(context, { resetTime: '', mode: getPreferredMode(), forceTarget: 'external-kiosk' });
    }),
    vscode.commands.registerCommand('claudeSaver.simulateRateLimit', () => {
      const fakeReset = new Date(Date.now() + 2 * 60 * 60 * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      onRateLimitDetected(context, `Simulated 429: Rate limit reached. Resets at ${fakeReset}`);
    })
  );

  // 3. Watch VS Code Terminal / Output documents for 429 or rate limit strings
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      const scheme = event.document.uri.scheme;
      // Inspect output channels, debug consoles, and logs without slowing down code files
      if (scheme === 'output' || scheme === 'vscode-terminal' || event.document.fileName.includes('claude')) {
        for (const change of event.contentChanges) {
          if (change.text && isRateLimitText(change.text)) {
            onRateLimitDetected(context, change.text);
            break;
          }
        }
      }
    })
  );

  // 4. Watch ~/.claude/ trigger file or logs (bridges seamlessly with Claude Code extension)
  setupClaudeFileWatcher(context);
}

function getPreferredMode() {
  return vscode.workspace.getConfiguration('claudeSaver').get('defaultMode', '3');
}

function isRateLimitText(text) {
  return /(?:rate_limit_error|status[:\s]+429|reached your limit|5-hour limit|quota exceeded|resets at \d{1,2})/i.test(text);
}

function extractResetTime(text) {
  const match = text.match(/(?:until|at|resets at)\s+([0-9]{1,2}(?::[0-9]{2})?\s*(?:AM|PM)?)/i);
  return match ? match[1].trim() : '';
}

function onRateLimitDetected(context, rawText) {
  const now = Date.now();
  // Debounce: prevent re-triggering within 15 seconds
  if (now - lastTriggerTime < 15000) return;
  lastTriggerTime = now;

  const resetTime = extractResetTime(rawText);
  statusBarItem.text = `$(flame) Claude 429 (${resetTime || 'LIM'})`;
  statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');

  triggerScreensaver(context, {
    resetTime,
    mode: getPreferredMode()
  });
}

function triggerScreensaver(context, options = {}) {
  const config = vscode.workspace.getConfiguration('claudeSaver');
  const target = options.forceTarget || config.get('launchTarget', 'vscode-webview');
  const resetTime = options.resetTime || '';
  const mode = options.mode || '3';

  if (target === 'vscode-webview' || target === 'both') {
    openWebviewScreensaver(context, resetTime, mode);
  }
  if (target === 'external-kiosk' || target === 'both') {
    openExternalKiosk(context, resetTime, mode);
  }
}

// Runs a workbench command, returning false instead of throwing if this VS Code version lacks it
async function runCommand(command) {
  try {
    await vscode.commands.executeCommand(command);
    return true;
  } catch {
    return false;
  }
}

function openWebviewScreensaver(context, resetTime, mode) {
  const config = vscode.workspace.getConfiguration('claudeSaver');
  const useZen = config.get('autoFullscreenZenMode', true);

  if (currentPanel) {
    currentPanel.reveal(vscode.ViewColumn.One);
  } else {
    currentPanel = vscode.window.createWebviewPanel(
      'claudeAsciiScreensaver',
      resetTime ? `🚨 CLAUDE LIMIT (Resets ${resetTime})` : '🚨 CLAUDE LIMIT REACHED',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    // Group count when we maximized; if our group gets removed on close, VS Code un-maximizes by itself
    let maximizedGroupCount = 0;

    if (useZen) {
      (async () => {
        await runCommand('workbench.action.toggleZenMode');
        // Zen mode leaves the secondary sidebar and other editor groups visible, so hide them too
        await runCommand('workbench.action.closeAuxiliaryBar');
        if (vscode.window.tabGroups.all.length > 1 && await runCommand('workbench.action.toggleMaximizeEditorGroup')) {
          maximizedGroupCount = vscode.window.tabGroups.all.length;
        }
      })();
    }

    currentPanel.onDidDispose(async () => {
      currentPanel = undefined;
      statusBarItem.text = '$(terminal) Claude Quota: OK';
      statusBarItem.backgroundColor = undefined;
      if (useZen) {
        if (maximizedGroupCount && vscode.window.tabGroups.all.length === maximizedGroupCount) {
          await runCommand('workbench.action.toggleMaximizeEditorGroup');
        }
        await runCommand('workbench.action.toggleZenMode');
      }
    }, null, context.subscriptions);
  }

  const htmlPath = path.join(context.extensionPath, 'claude_limit_screensaver.html');
  if (!fs.existsSync(htmlPath)) {
    currentPanel.webview.html = `<body style="background:#000;color:#ff7b39;font-family:monospace;padding:2rem;">
      <h2>Missing claude_limit_screensaver.html</h2>
      <p>Copy your <b>claude_limit_screensaver.html</b> file into:</p>
      <pre>${htmlPath}</pre>
    </body>`;
    return;
  }

  let htmlContent = fs.readFileSync(htmlPath, 'utf8');

  // Inject initial mode and real reset time right before </body>
  const bootstrapScript = `
    <script>
      window.addEventListener('DOMContentLoaded', () => {
        const resetStr = ${JSON.stringify(resetTime)};
        const initialMode = ${JSON.stringify(mode)};
        if (initialMode) {
          setTimeout(() => {
            window.dispatchEvent(new KeyboardEvent('keydown', { key: String(initialMode) }));
          }, 150);
        }
        if (resetStr) {
          document.title = "CLAUDE LIMIT - RESETS AT " + resetStr;
        }
      });
    </script>
  `;

  htmlContent = htmlContent.replace('</body>', `${bootstrapScript}\n</body>`);
  currentPanel.webview.html = htmlContent;
}

function openExternalKiosk(context, resetTime, mode) {
  const htmlPath = path.join(context.extensionPath, 'claude_limit_screensaver.html').replace(/\\/g, '/');
  const fileUrl = `file:///${htmlPath}?reset=${encodeURIComponent(resetTime)}&mode=${encodeURIComponent(mode)}`;
  const tempProfile = path.join(os.tmpdir(), 'ClaudeSaverVSCode');
  exec(`start "" msedge.exe --kiosk "${fileUrl}" --edge-kiosk-type=fullscreen --user-data-dir="${tempProfile}"`);
}

function setupClaudeFileWatcher(context) {
  const claudeDir = path.join(os.homedir(), '.claude');
  const triggerFile = path.join(claudeDir, 'rate_limit_trigger.txt');

  if (!fs.existsSync(claudeDir)) return;

  // Watch for a trigger file if using Claude Code hooks
  fs.watch(claudeDir, (eventType, filename) => {
    if (filename === 'rate_limit_trigger.txt' && fs.existsSync(triggerFile)) {
      try {
        const content = fs.readFileSync(triggerFile, 'utf8');
        onRateLimitDetected(context, content || '429 rate_limit_error');
      } catch (_) {}
    }
  });
}

function deactivate() {}

module.exports = { activate, deactivate };
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const http = require('http');
const net = require('net');
const { spawn, execSync } = require('child_process');

const SCRIPT_DIR = __dirname;
const EXISTING_SCRIPT = path.join(SCRIPT_DIR, 'gensynautorun.js');
const LOG_FILE = path.join(SCRIPT_DIR, 'gensyn-debug.log');
const DELPHI_URL = 'https://delphi.gensyn.ai/';
const GMAIL_URL = 'https://mail.google.com/mail/#inbox';
const OTP_SUBJECT_RE = /(\d{6}) is your login code for Gensyn Testnet/i;
const DEFAULT_WINDOWS_DEBUG_HOST = '127.0.0.1';
const DEFAULT_WINDOWS_DEBUG_PORT = 9222;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args
    .map((arg) => {
      if (arg instanceof Error) return arg.stack || arg.message;
      if (typeof arg === 'string') return arg;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(' ')}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, `${line}\n`);
  } catch {}
}

function clearLogFile() {
  try {
    fs.writeFileSync(LOG_FILE, '');
  } catch {}
}

function isWsl() {
  if (process.platform !== 'linux') return false;
  if (process.env.WSL_DISTRO_NAME) return true;
  try {
    return fs.readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft');
  } catch {
    return false;
  }
}

function resolveChromeConfig() {
  const envChromePath = process.env.CHROME_PATH;
  const envUserDataDir = process.env.CHROME_USER_DATA_DIR;

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return {
      mode: 'windows-cdp',
      chromePath:
        envChromePath ||
        path.join(process.env['PROGRAMFILES'] || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      userDataDir: envUserDataDir || path.join(localAppData, 'Google', 'Chrome', 'User Data'),
    };
  }

  if (isWsl()) {
    const winUser = process.env.WINDOWS_USER || process.env.WIN_USERNAME || process.env.USERNAME || 'user';
    return {
      mode: 'windows-cdp',
      chromePath: envChromePath || '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
      userDataDir:
        envUserDataDir || `/mnt/c/Users/${winUser}/AppData/Local/Google/Chrome/User Data`,
    };
  }

  return {
    mode: 'linux-persistent',
    chromePath: envChromePath || '/usr/bin/google-chrome',
    userDataDir: envUserDataDir || path.join(os.homedir(), '.config', 'google-chrome'),
  };
}

const CHROME = resolveChromeConfig();

function uniqueByDirName(profiles) {
  const seen = new Set();
  return profiles.filter((profile) => {
    if (seen.has(profile.dirName)) return false;
    seen.add(profile.dirName);
    return true;
  });
}

function createPrompt() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return {
    ask(question) {
      return new Promise((resolve) => rl.question(question, (answer) => resolve(answer.trim())));
    },
    close() {
      rl.close();
    },
  };
}

function killChromeWindowsBestEffort() {
  if (CHROME.mode !== 'windows-cdp') return;
  const commands = process.platform === 'win32'
    ? ['taskkill /F /IM chrome.exe /T']
    : [
        'cmd.exe /c taskkill /F /IM chrome.exe /T',
        'powershell.exe -NoProfile -Command "Stop-Process -Name chrome -Force -ErrorAction SilentlyContinue"',
      ];

  for (const command of commands) {
    try {
      execSync(command, { stdio: 'ignore' });
      log('Issued Chrome kill command:', command);
      return;
    } catch {}
  }
}

function readChromeLocalState() {
  const localStatePath = path.join(CHROME.userDataDir, 'Local State');
  if (!fs.existsSync(localStatePath)) return {};

  try {
    return JSON.parse(fs.readFileSync(localStatePath, 'utf8'));
  } catch (err) {
    log('Could not parse Chrome Local State:', err.message);
    return {};
  }
}

function getChromeProfiles() {
  if (!fs.existsSync(CHROME.userDataDir)) {
    throw new Error(`Chrome user data directory not found: ${CHROME.userDataDir}`);
  }

  const localState = readChromeLocalState();
  const infoCache = localState?.profile?.info_cache || {};

  const dirs = fs
    .readdirSync(CHROME.userDataDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => name === 'Default' || /^Profile \d+$/.test(name));

  const profiles = dirs.map((dirName) => {
    const info = infoCache[dirName] || {};
    return {
      dirName,
      displayName: info.name || dirName,
      userName: info.user_name || '',
    };
  });

  profiles.sort((a, b) => {
    if (a.dirName === 'Default') return -1;
    if (b.dirName === 'Default') return 1;
    return a.dirName.localeCompare(b.dirName, undefined, { numeric: true, sensitivity: 'base' });
  });

  return profiles;
}

function parseProfileSelection(input, profiles) {
  const selected = [];
  const chunks = input
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

  for (const chunk of chunks) {
    const rangeMatch = chunk.match(/^(\d+)\s*-\s*(\d+)$/);
    if (rangeMatch) {
      let start = Number.parseInt(rangeMatch[1], 10);
      let end = Number.parseInt(rangeMatch[2], 10);
      if (start > end) [start, end] = [end, start];
      for (let i = start; i <= end; i++) {
        if (i < 1 || i > profiles.length) throw new Error(`Profile number out of range: ${i}`);
        selected.push(profiles[i - 1]);
      }
      continue;
    }

    const byNumber = Number.parseInt(chunk, 10);
    if (Number.isInteger(byNumber) && String(byNumber) === chunk) {
      if (byNumber < 1 || byNumber > profiles.length) {
        throw new Error(`Profile number out of range: ${byNumber}`);
      }
      selected.push(profiles[byNumber - 1]);
      continue;
    }

    const normalized = chunk.toLowerCase();
    const matched = profiles.find((profile) =>
      [profile.displayName, profile.dirName, profile.userName]
        .filter(Boolean)
        .some((value) => value.toLowerCase() === normalized)
    );
    if (!matched) throw new Error(`Profile not found: ${chunk}`);
    selected.push(matched);
  }

  return uniqueByDirName(selected);
}

async function promptForChromeProfiles() {
  const profiles = getChromeProfiles();
  if (!profiles.length) throw new Error(`No Chrome profiles found in ${CHROME.userDataDir}`);

  console.log('\nAvailable Chrome profiles:');
  profiles.forEach((profile, index) => {
    const bits = [profile.displayName];
    if (profile.userName && profile.userName !== profile.displayName) bits.push(profile.userName);
    bits.push(profile.dirName);
    console.log(`  ${index + 1}. ${bits.join(' — ')}`);
  });

  const prompt = createPrompt();
  try {
    let count;
    while (true) {
      const countAnswer = await prompt.ask('\nHow many profiles do you want to run? ');
      const parsed = Number.parseInt(countAnswer, 10);
      if (Number.isInteger(parsed) && parsed >= 1 && parsed <= profiles.length) {
        count = parsed;
        break;
      }
      console.log(`Enter a number between 1 and ${profiles.length}.`);
    }

    while (true) {
      const answer = await prompt.ask('Enter profile numbers/names (examples: 1,2,3 or 1-5,7-9): ');
      if (!answer) continue;
      try {
        const selected = parseProfileSelection(answer, profiles);
        if (selected.length !== count) {
          console.log(`You selected ${selected.length} profile(s), but asked for ${count}. Try again.`);
          continue;
        }
        return selected;
      } catch (err) {
        console.log(err.message);
      }
    }
  } finally {
    prompt.close();
  }
}

function attachPageLogging(page, label) {
  page.on('console', (msg) => log(`[${label}] console.${msg.type()}:`, msg.text()));
  page.on('pageerror', (err) => log(`[${label}] pageerror:`, err));
  page.on('requestfailed', (req) => {
    const failure = req.failure();
    log(`[${label}] requestfailed:`, req.url(), failure?.errorText || 'unknown');
  });
}

function attachContextLogging(context, prefix) {
  for (const page of context.pages()) attachPageLogging(page, `${prefix}:page`);
  context.on('page', (page) => {
    log(`[${prefix}] new page:`, page.url() || 'about:blank');
    attachPageLogging(page, `${prefix}:page`);
  });
}

async function extractLoggedInGmailAddress(gmailPage) {
  log('Navigating Gmail tab to:', GMAIL_URL);
  await gmailPage.goto(GMAIL_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await gmailPage.waitForTimeout(6000);

  const accountAnchor = gmailPage.locator('a[aria-label*="@"], [aria-label*="Google Account"], img[alt*="Google Account"]').first();
  if (await accountAnchor.count()) {
    const label =
      (await accountAnchor.getAttribute('aria-label').catch(() => null)) ||
      (await accountAnchor.evaluate((el) => el.closest('a,button')?.getAttribute('aria-label') || '').catch(() => ''));
    const match = (label || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    if (match) return match[0];
  }

  const bodyText = await gmailPage.locator('body').innerText().catch(() => '');
  const bodyMatch = bodyText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  if (bodyMatch) return bodyMatch[0];

  throw new Error('Could not determine signed-in Gmail address. Gmail may not be logged in in this Chrome profile.');
}

async function openDelphiLogin(delphiPage) {
  log('Navigating Delphi tab to:', DELPHI_URL);
  await delphiPage.goto(DELPHI_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await delphiPage.waitForTimeout(5000);

  const connectBtn = delphiPage.getByRole('button', { name: /connect wallet/i }).first();
  await connectBtn.waitFor({ state: 'visible', timeout: 30000 });
  await connectBtn.click();

  const emailInput = delphiPage.getByPlaceholder(/email/i).first();
  await emailInput.waitFor({ state: 'visible', timeout: 30000 });
  return emailInput;
}

async function requestOtp(delphiPage, email) {
  const emailInput = await openDelphiLogin(delphiPage);
  await emailInput.fill(email);

  const continueBtn = delphiPage.getByRole('button', { name: /^continue$/i }).first();
  await continueBtn.click();

  await delphiPage.getByText(/enter verification code/i).waitFor({ state: 'visible', timeout: 30000 });
}

async function getNewestOtpFromInbox(gmailPage, timeoutMs = 180000) {
  log('Refreshing Gmail inbox for OTP');
  await gmailPage.goto(GMAIL_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await gmailPage.waitForTimeout(6000);

  const refreshButton = gmailPage.getByRole('button', { name: /refresh/i }).first();
  const inboxTab = gmailPage.getByRole('link', { name: /inbox/i }).first();

  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      if (await inboxTab.count()) await inboxTab.click().catch(() => {});
      if (await refreshButton.count()) await refreshButton.click().catch(() => {});
    } catch {}

    await sleep(3000);

    const rows = gmailPage.locator('tr, [role="row"]');
    const rowCount = await rows.count().catch(() => 0);
    for (let i = 0; i < Math.min(rowCount, 12); i++) {
      const rowText = await rows.nth(i).innerText().catch(() => '');
      const match = rowText.match(OTP_SUBJECT_RE);
      if (match) return match[1];
    }

    const bodyText = await gmailPage.locator('body').innerText().catch(() => '');
    const directMatch = bodyText.match(/\b(\d{6})\b is your login code for Gensyn Testnet/i);
    if (directMatch) return directMatch[1];

    log('OTP not found yet, continuing to poll...');
  }

  throw new Error('OTP email did not appear in Gmail in time.');
}

async function submitOtp(delphiPage, otp) {
  const inputs = delphiPage.locator('input[aria-label*="One time password input"]');
  const count = await inputs.count();
  if (count >= 6) {
    for (let i = 0; i < 6; i++) await inputs.nth(i).fill(otp[i]);
  } else {
    const firstInput = delphiPage.locator('input').first();
    if (await firstInput.count()) await firstInput.fill(otp);
    else await delphiPage.keyboard.type(otp, { delay: 50 });
  }

  await delphiPage
    .locator('text=/0x[a-fA-F0-9]{4}\.\.\.[a-fA-F0-9]{4}/')
    .waitFor({ state: 'visible', timeout: 30000 });
}

async function runExistingAutomation(delphiPage) {
  if (!fs.existsSync(EXISTING_SCRIPT)) {
    log('Existing script not found, skipping handoff:', EXISTING_SCRIPT);
    return;
  }

  const code = fs.readFileSync(EXISTING_SCRIPT, 'utf8');
  await delphiPage.evaluate(code);
}

function waitForPort(host, port, timeoutMs) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.createConnection({ host, port });
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() - started >= timeoutMs) {
          reject(new Error(`Timed out waiting for ${host}:${port}`));
        } else {
          setTimeout(attempt, 500);
        }
      });
    };
    attempt();
  });
}

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(raw));
          } catch (err) {
            reject(err);
          }
        });
      })
      .on('error', reject);
  });
}

async function launchWindowsChromeAndConnect(selectedProfile) {
  const host = DEFAULT_WINDOWS_DEBUG_HOST;
  const port = Number(process.env.CHROME_DEBUG_PORT || DEFAULT_WINDOWS_DEBUG_PORT);

  killChromeWindowsBestEffort();
  await sleep(1500);

  const chromeArgs = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${CHROME.userDataDir}`,
    `--profile-directory=${selectedProfile.dirName}`,
    '--start-maximized',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
  ];

  log('Launching real Chrome profile via CDP attach');
  log('Chrome path:', CHROME.chromePath);
  log('Chrome user data dir:', CHROME.userDataDir);
  log('Chrome profile directory:', selectedProfile.dirName);
  log('Chrome debug endpoint:', `${host}:${port}`);

  const child = spawn(CHROME.chromePath, chromeArgs, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();

  await waitForPort(host, port, 30000);
  const versionInfo = await httpGetJson(`http://${host}:${port}/json/version`);
  log('DevTools browser endpoint:', versionInfo.webSocketDebuggerUrl || 'missing');

  const browser = await chromium.connectOverCDP(`http://${host}:${port}`);
  const context = browser.contexts()[0] || (await browser.newContext());
  attachContextLogging(context, `profile:${selectedProfile.dirName}`);
  return { browser, context };
}

async function launchLinuxPersistentContext(selectedProfile) {
  log('Launching Chrome via Playwright persistent context');
  log('Chrome path:', CHROME.chromePath);
  log('Chrome user data dir:', CHROME.userDataDir);
  log('Chrome profile directory:', selectedProfile.dirName);

  const context = await chromium.launchPersistentContext(CHROME.userDataDir, {
    headless: false,
    executablePath: CHROME.chromePath,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      '--start-maximized',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      `--profile-directory=${selectedProfile.dirName}`,
    ],
    viewport: null,
    timeout: 120000,
  });
  attachContextLogging(context, `profile:${selectedProfile.dirName}`);
  return { browser: null, context };
}

async function openOrReuseTabs(context) {
  let pages = context.pages();
  if (!pages.length) pages = [await context.newPage()];

  const gmailPage = pages[0];
  await gmailPage.bringToFront().catch(() => {});

  const delphiPage = await context.newPage();
  return { gmailPage, delphiPage };
}

async function runWorkflowForProfile(selectedProfile, shouldRunMain, index, total) {
  log(`\n[${index}/${total}] Launching workflow for profile`);
  log('Name:', selectedProfile.displayName);
  if (selectedProfile.userName) log('Account:', selectedProfile.userName);
  log('Directory:', selectedProfile.dirName);
  log('Mode:', CHROME.mode);

  let browser;
  let context;
  try {
    ({ browser, context } = CHROME.mode === 'windows-cdp'
      ? await launchWindowsChromeAndConnect(selectedProfile)
      : await launchLinuxPersistentContext(selectedProfile));

    const { gmailPage, delphiPage } = await openOrReuseTabs(context);

    const email = await extractLoggedInGmailAddress(gmailPage);
    log(`[${index}/${total}] Using Gmail account:`, email);

    await requestOtp(delphiPage, email);
    log(`[${index}/${total}] Requested OTP from Delphi.`);

    const otp = await getNewestOtpFromInbox(gmailPage);
    log(`[${index}/${total}] OTP found:`, otp);

    await submitOtp(delphiPage, otp);
    log(`[${index}/${total}] Logged into Delphi successfully.`);

    if (shouldRunMain) {
      log(`[${index}/${total}] Running existing Delphi automation script...`);
      await runExistingAutomation(delphiPage);
    } else {
      log(`[${index}/${total}] Login bootstrap complete. Delphi tab is ready.`);
    }

    return { profile: selectedProfile, ok: true };
  } catch (err) {
    log(`[${index}/${total}] Bootstrap failed for ${selectedProfile.displayName}:`, err);
    log('Debug log saved to:', LOG_FILE);
    return { profile: selectedProfile, ok: false, error: err.message };
  } finally {
    if (browser && CHROME.mode === 'windows-cdp') {
      await browser.close().catch(() => {});
    }
  }
}

async function main() {
  clearLogFile();
  log('=== SCRIPT STARTED ===');
  log('Resolved Chrome config:', CHROME);
  log('Debug log file:', LOG_FILE);

  const shouldRunMain = process.argv.includes('--run-main');
  const selectedProfiles = await promptForChromeProfiles();

  log('Selected profiles:', selectedProfiles.map((profile) => `${profile.displayName} (${profile.dirName})`).join(', '));

  console.log('\nSelected profiles:');
  selectedProfiles.forEach((profile, idx) => {
    console.log(`  ${idx + 1}. ${profile.displayName} (${profile.dirName})`);
  });

  console.log('\nThis script runs profiles one-by-one for reliability with real Chrome profiles.');
  console.log(`Debug log: ${LOG_FILE}`);

  const results = [];
  for (let i = 0; i < selectedProfiles.length; i++) {
    const result = await runWorkflowForProfile(selectedProfiles[i], shouldRunMain, i + 1, selectedProfiles.length);
    results.push(result);
  }

  console.log('\nBatch summary:');
  for (const result of results) {
    if (result.ok) {
      console.log(`  ✅ ${result.profile.displayName} (${result.profile.dirName})`);
    } else {
      console.log(`  ❌ ${result.profile.displayName} (${result.profile.dirName}) — ${result.error}`);
    }
  }

  log('=== SCRIPT FINISHED ===');
}

main().catch((err) => {
  log('Fatal error:', err);
  process.exit(1);
});

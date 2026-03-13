const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

const CHROME_PATH = '/usr/bin/google-chrome';
const CHROME_USER_DATA_DIR = path.join(os.homedir(), '.config', 'google-chrome');
const DELPHI_URL = 'https://delphi.gensyn.ai/';
const GMAIL_URL = 'https://mail.google.com/mail/u/0/#inbox';
const SCRIPT_DIR = __dirname;
const EXISTING_SCRIPT = path.join(SCRIPT_DIR, 'gensynautorun.js');
const OTP_SUBJECT_RE = /(\d{6}) is your login code for Gensyn Testnet/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

function readChromeLocalState() {
  const localStatePath = path.join(CHROME_USER_DATA_DIR, 'Local State');
  if (!fs.existsSync(localStatePath)) return {};

  try {
    return JSON.parse(fs.readFileSync(localStatePath, 'utf8'));
  } catch (err) {
    console.warn('Could not parse Chrome Local State:', err.message);
    return {};
  }
}

function getChromeProfiles() {
  if (!fs.existsSync(CHROME_USER_DATA_DIR)) {
    throw new Error(`Chrome user data directory not found: ${CHROME_USER_DATA_DIR}`);
  }

  const localState = readChromeLocalState();
  const infoCache = localState?.profile?.info_cache || {};

  const dirs = fs
    .readdirSync(CHROME_USER_DATA_DIR, { withFileTypes: true })
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

async function promptForChromeProfile() {
  const profiles = getChromeProfiles();
  if (!profiles.length) throw new Error(`No Chrome profiles found in ${CHROME_USER_DATA_DIR}`);

  console.log('\nAvailable Chrome profiles:');
  profiles.forEach((profile, index) => {
    const bits = [profile.displayName];
    if (profile.userName && profile.userName !== profile.displayName) bits.push(profile.userName);
    bits.push(profile.dirName);
    console.log(`  ${index + 1}. ${bits.join(' — ')}`);
  });

  const prompt = createPrompt();
  try {
    while (true) {
      const answer = await prompt.ask('\nType Chrome profile number or name: ');
      if (!answer) continue;

      const byNumber = Number.parseInt(answer, 10);
      if (Number.isInteger(byNumber) && byNumber >= 1 && byNumber <= profiles.length) {
        return profiles[byNumber - 1];
      }

      const normalized = answer.toLowerCase();
      const matched = profiles.find((profile) =>
        [profile.displayName, profile.dirName, profile.userName]
          .filter(Boolean)
          .some((value) => value.toLowerCase() === normalized)
      );
      if (matched) return matched;

      console.log('Profile not found. Enter the exact name shown above, or a number from the list.');
    }
  } finally {
    prompt.close();
  }
}

async function extractLoggedInGmailAddress(gmailPage) {
  await gmailPage.goto(GMAIL_URL, { waitUntil: 'domcontentloaded' });
  await gmailPage.waitForLoadState('networkidle').catch(() => {});

  const direct = gmailPage.locator('a[aria-label*="Google Account:"] img, button[aria-label*="Google Account:"]').first();
  if (await direct.count()) {
    const label =
      (await direct.getAttribute('aria-label')) ||
      (await direct.evaluate((el) => el.closest('button,a')?.getAttribute('aria-label') || ''));
    const match = label.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    if (match) return match[0];
  }

  const bodyText = await gmailPage.locator('body').innerText().catch(() => '');
  const bodyMatch = bodyText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  if (bodyMatch) return bodyMatch[0];

  throw new Error('Could not determine signed-in Gmail address. Open Gmail in the selected Chrome profile first.');
}

async function openDelphiLogin(delphiPage) {
  await delphiPage.goto(DELPHI_URL, { waitUntil: 'domcontentloaded' });
  await delphiPage.waitForLoadState('networkidle').catch(() => {});

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

async function getNewestOtpFromInbox(gmailPage, timeoutMs = 120000) {
  await gmailPage.goto(GMAIL_URL, { waitUntil: 'domcontentloaded' });
  await gmailPage.waitForLoadState('networkidle').catch(() => {});

  const refreshButton = gmailPage.getByRole('button', { name: /refresh/i }).first();
  const inboxTab = gmailPage.getByRole('link', { name: /inbox/i }).first();

  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      if (await inboxTab.count()) await inboxTab.click().catch(() => {});
      if (await refreshButton.count()) await refreshButton.click().catch(() => {});
    } catch {}

    await sleep(2500);

    const bodyText = await gmailPage.locator('body').innerText().catch(() => '');
    const directMatch = bodyText.match(/\b(\d{6})\b is your login code for Gensyn Testnet/i);
    if (directMatch) return directMatch[1];

    const subjectRow = gmailPage.locator('tr, [role="row"]').filter({ hasText: /is your login code for Gensyn Testnet/i }).first();
    if (await subjectRow.count()) {
      const rowText = await subjectRow.innerText().catch(() => '');
      const rowMatch = rowText.match(OTP_SUBJECT_RE);
      if (rowMatch) return rowMatch[1];
    }
  }

  throw new Error('OTP email did not appear in Gmail in time.');
}

async function submitOtp(delphiPage, otp) {
  const inputs = delphiPage.locator('input[aria-label*="One time password input"]');
  const count = await inputs.count();
  if (count >= 6) {
    for (let i = 0; i < 6; i++) {
      await inputs.nth(i).fill(otp[i]);
    }
  } else {
    await delphiPage.keyboard.type(otp, { delay: 50 });
  }

  await delphiPage.locator('text=/0x[a-fA-F0-9]{4}\.\.\.[a-fA-F0-9]{4}/').waitFor({ state: 'visible', timeout: 30000 });
}

async function runExistingAutomation(delphiPage) {
  if (!fs.existsSync(EXISTING_SCRIPT)) {
    console.log('Existing script not found, skipping handoff:', EXISTING_SCRIPT);
    return;
  }

  const code = fs.readFileSync(EXISTING_SCRIPT, 'utf8');
  await delphiPage.evaluate(code);
}

async function main() {
  const shouldRunMain = process.argv.includes('--run-main');
  const selectedProfile = await promptForChromeProfile();

  console.log('\nLaunching Chrome with profile:');
  console.log(`  Name: ${selectedProfile.displayName}`);
  if (selectedProfile.userName) console.log(`  Account: ${selectedProfile.userName}`);
  console.log(`  Directory: ${selectedProfile.dirName}`);
  console.log(`  User data dir: ${CHROME_USER_DATA_DIR}`);

  const context = await chromium.launchPersistentContext(CHROME_USER_DATA_DIR, {
    headless: false,
    executablePath: CHROME_PATH,
    args: ['--start-maximized', `--profile-directory=${selectedProfile.dirName}`],
    viewport: null,
  });

  let gmailPage = context.pages().find((p) => p.url().includes('mail.google.com'));
  if (!gmailPage) gmailPage = await context.newPage();

  let delphiPage = context.pages().find((p) => p.url().includes('delphi.gensyn.ai'));
  if (!delphiPage) delphiPage = await context.newPage();

  try {
    const email = await extractLoggedInGmailAddress(gmailPage);
    console.log('Using Gmail account:', email);

    await requestOtp(delphiPage, email);
    console.log('Requested OTP from Delphi.');

    const otp = await getNewestOtpFromInbox(gmailPage);
    console.log('OTP found:', otp);

    await submitOtp(delphiPage, otp);
    console.log('Logged into Delphi successfully.');

    if (shouldRunMain) {
      console.log('Running existing Delphi automation script...');
      await runExistingAutomation(delphiPage);
    } else {
      console.log('Login bootstrap complete. Delphi tab is ready.');
    }
  } catch (err) {
    console.error('Bootstrap failed:', err.message);
    console.error('Chrome profile kept open for inspection.');
    return;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

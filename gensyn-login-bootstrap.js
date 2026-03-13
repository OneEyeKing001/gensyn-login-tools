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
        if (i < 1 || i > profiles.length) {
          throw new Error(`Profile number out of range: ${i}`);
        }
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
    if (!matched) {
      throw new Error(`Profile not found: ${chunk}`);
    }
    selected.push(matched);
  }

  return uniqueByDirName(selected);
}

async function promptForChromeProfiles() {
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
      const answer = await prompt.ask(
        'Enter profile numbers/names (examples: 1,2,3 or 1-5,7-9): '
      );
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

async function runWorkflowForProfile(selectedProfile, shouldRunMain, index, total) {
  console.log(`\n[${index}/${total}] Launching Chrome with profile:`);
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
    console.log(`[${index}/${total}] Using Gmail account:`, email);

    await requestOtp(delphiPage, email);
    console.log(`[${index}/${total}] Requested OTP from Delphi.`);

    const otp = await getNewestOtpFromInbox(gmailPage);
    console.log(`[${index}/${total}] OTP found:`, otp);

    await submitOtp(delphiPage, otp);
    console.log(`[${index}/${total}] Logged into Delphi successfully.`);

    if (shouldRunMain) {
      console.log(`[${index}/${total}] Running existing Delphi automation script...`);
      await runExistingAutomation(delphiPage);
    } else {
      console.log(`[${index}/${total}] Login bootstrap complete. Delphi tab is ready.`);
    }

    return { profile: selectedProfile, ok: true };
  } catch (err) {
    console.error(`[${index}/${total}] Bootstrap failed for ${selectedProfile.displayName}:`, err.message);
    console.error('Chrome profile kept open for inspection.');
    return { profile: selectedProfile, ok: false, error: err.message };
  }
}

async function main() {
  const shouldRunMain = process.argv.includes('--run-main');
  const selectedProfiles = await promptForChromeProfiles();

  console.log('\nSelected profiles:');
  selectedProfiles.forEach((profile, idx) => {
    console.log(`  ${idx + 1}. ${profile.displayName} (${profile.dirName})`);
  });

  console.log(
    '\nNote: with real Chrome profiles, running many persistent sessions truly in parallel can hit Chrome profile locks. This script will process the selected profiles in batch order for reliability.'
  );

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
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

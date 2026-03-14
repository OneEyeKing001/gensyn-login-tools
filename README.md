# gensyn-login-tools

Small helper repo for logging into **Gensyn Delphi** with your **existing Google Chrome profile**, reading the OTP from **Gmail**, and optionally running a follow-up in-page automation script.

## What is included

- `gensyn-login-bootstrap.js`
  - detects Chrome profiles from your real Chrome user-data directory
  - asks how many profiles you want to run
  - accepts profile selection by **number, name, comma list, or ranges**
  - examples: `1,2,3,6` or `1-5,7-9`
  - opens Delphi + Gmail
  - reads the logged-in Gmail address from each selected profile
  - requests the OTP on Delphi
  - finds the newest Gensyn OTP mail in Gmail
  - submits the OTP into Delphi
  - optionally runs `gensynautorun.js`
  - writes detailed debug logs to `gensyn-debug.log`

- `gensynautorun.js`
  - browser-page script executed inside the Delphi tab
  - claims faucet/test tokens
  - goes to Active Market
  - opens the top Buy flow
  - calculates shares from wallet balance
  - submits purchase flow
  - checks My Activity for success

## Supported environments

### Windows
Uses your real Chrome profile by launching Chrome directly with remote debugging and then attaching with Playwright.

Expected default paths:

- Chrome executable:
  - `C:\Program Files\Google\Chrome\Application\chrome.exe`
- Chrome user data:
  - `C:\Users\<you>\AppData\Local\Google\Chrome\User Data`

### WSL
Also supported for a Windows Chrome install.

Expected default paths:

- Chrome executable:
  - `/mnt/c/Program Files/Google/Chrome/Application/chrome.exe`
- Chrome user data:
  - `/mnt/c/Users/<WindowsUser>/AppData/Local/Google/Chrome/User Data`

If auto-detection picks the wrong Windows username, set one of these before running:

```bash
export WINDOWS_USER=user
```

or override directly:

```bash
export CHROME_PATH="/mnt/c/Program Files/Google/Chrome/Application/chrome.exe"
export CHROME_USER_DATA_DIR="/mnt/c/Users/user/AppData/Local/Google/Chrome/User Data"
```

### Linux
Uses Playwright persistent context mode against the local Linux Chrome profile.

Expected default paths:

- Chrome executable:
  - `/usr/bin/google-chrome`
- Chrome user data:
  - `~/.config/google-chrome`

## Installation

Clone the repo:

```bash
git clone https://github.com/OneEyeKing001/gensyn-login-tools.git
cd gensyn-login-tools
```

Install dependency:

```bash
npm install
```

## Running

### Login only

```bash
node gensyn-login-bootstrap.js
```

or

```bash
npm start
```

### Login + run the follow-up automation

```bash
node gensyn-login-bootstrap.js --run-main
```

or

```bash
npm run start:run-main
```

## How profile selection works

On start, the script reads your normal Chrome profiles from your detected Chrome user-data root.

Then it prints a numbered list like:

```text
Available Chrome profiles:
  1. Person 1 — mymail@gmail.com — Default
  2. Work — work@gmail.com — Profile 1
  3. Testing — test@gmail.com — Profile 2
```

Next it asks how many profiles you want to run.

After that, you can enter:

- single numbers: `1`
- comma-separated lists: `1,2,3`
- ranges: `1-5`
- mixed ranges/lists: `1-3,6,8-10`
- exact profile names / Chrome directory names if needed

The number of selected profiles must match the count you entered.

## Logging / debugging

The script writes a debug log file in the same folder:

```text
gensyn-debug.log
```

It includes:

- resolved Chrome mode and paths
- launch steps
- navigation steps
- page console output
- request failures
- page errors
- OTP polling status

If the run gets stuck, check `gensyn-debug.log` first.

## Important note about Chrome profiles

Chrome profiles are often **locked** when already open in a normal Chrome window.

This script therefore processes selected profiles in a **batch, one after another**, while keeping each profile window available for inspection during the run.

If the script fails to launch or attach cleanly:

1. close all normal Chrome windows first
2. run the script again
3. choose the desired profile(s)
4. inspect `gensyn-debug.log`

## Default behavior

- visible Chrome window (`headless: false`)
- reuses your real Chrome user-data directory
- keeps browser/profile open on failure for inspection where possible
- `gensynautorun.js` is loaded from the **same folder** as the bootstrap script
- Gmail URL is no longer pinned to `/u/0/`
- avoids Gmail `networkidle` waits that can hang forever

## File layout

```text
gensyn-login-tools/
├── gensyn-login-bootstrap.js
├── gensynautorun.js
├── gensyn-debug.log
├── package.json
├── .gitignore
└── README.md
```

## Troubleshooting

### Could not determine signed-in Gmail address
Open Gmail manually in the selected Chrome profile first and make sure you are fully signed in.

### OTP email did not appear in Gmail in time
- check that Delphi actually sent the OTP
- check Spam/Updates/Promotions if Gmail changed inbox placement
- confirm the OTP subject/body still contains:
  - `is your login code for Gensyn Testnet`

### Script opens wrong account/profile
Pick a different profile name/number when prompted.

### WSL path is wrong
Set:

```bash
export WINDOWS_USER=user
```

or explicitly set `CHROME_USER_DATA_DIR`.

### Existing script not found
This only matters when using `--run-main`. Make sure `gensynautorun.js` is in the same folder as `gensyn-login-bootstrap.js`.

## Security / caution

This tooling uses your real local Chrome profile and Gmail session. Treat the machine as trusted. Do not run random modified copies of this repo without checking the code first.

## Recommended Git workflow

Useful commands:

```bash
git status
git log --oneline --decorate --graph -20
git diff
git checkout <old-commit> -- gensyn-login-bootstrap.js
```

That makes it easy to compare or restore older working versions when a new change breaks something.

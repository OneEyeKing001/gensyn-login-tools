# gensyn-login-tools

Small helper repo for logging into **Gensyn Delphi** with your **existing Google Chrome profile**, reading the OTP from **Gmail**, and optionally running a follow-up in-page automation script.

## What is included

- `gensyn-login-bootstrap.js`
  - launches Chrome with a profile you choose
  - asks for your Chrome profile by **number or name**
  - opens Delphi + Gmail
  - reads the logged-in Gmail address from that profile
  - requests the OTP on Delphi
  - finds the newest Gensyn OTP mail in Gmail
  - submits the OTP into Delphi
  - optionally runs `gensynautorun.js`

- `gensynautorun.js`
  - browser-page script executed inside the Delphi tab
  - claims faucet/test tokens
  - goes to Active Market
  - opens the top Buy flow
  - calculates shares from wallet balance
  - submits purchase flow
  - checks My Activity for success

## Prerequisites

- Linux machine
- Google Chrome installed at:
  - `/usr/bin/google-chrome`
- Node.js installed
- A Chrome profile already signed into:
  - Gmail
- Access to:
  - `https://delphi.gensyn.ai/`
  - `https://mail.google.com/`

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

On start, the script reads your normal Chrome profiles from:

```text
~/.config/google-chrome
```

Then it prints a numbered list like:

```text
Available Chrome profiles:
  1. Person 1 — mymail@gmail.com — Default
  2. Work — work@gmail.com — Profile 1
```

You can type either:

- the **number** (`1`, `2`, `3`)
- the **profile display name**
- the **Chrome directory name** (`Default`, `Profile 1`, etc.)

## Important note about Chrome profiles

Chrome profiles are often **locked** when already open in a normal Chrome window.

If the script fails to launch or attach cleanly:

1. close all normal Chrome windows first
2. run the script again
3. choose the desired profile

## Default behavior

- visible Chrome window (`headless: false`)
- reuses your real Chrome user-data directory
- keeps browser open on failure for inspection
- `gensynautorun.js` is loaded from the **same folder** as the bootstrap script

## File layout

```text
gensyn-login-tools/
├── gensyn-login-bootstrap.js
├── gensynautorun.js
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

### Existing script not found
This only matters when using `--run-main`. Make sure `gensynautorun.js` is in the same folder as `gensyn-login-bootstrap.js`.

### Script opens wrong account/profile
Pick a different profile name/number when prompted.

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

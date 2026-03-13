(async function runDelphiAutomationV3() {
  const STEP_DELAY_MS = 2000;
  const AFTER_FAUCET_MS = 2000;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const text = (el) => (el?.innerText || el?.textContent || "").replace(/\s+/g, " ").trim();
  const all = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const find = (sel, re, root = document) => all(sel, root).find((el) => re.test(text(el)));

  let abort = false;
  let skipRequested = false;
  let currentStepName = "init";

  let badge = document.getElementById("delphi-bot-badge");
  if (!badge) {
    badge = document.createElement("div");
    badge.id = "delphi-bot-badge";
    badge.style.cssText =
      "position:fixed;top:12px;right:12px;z-index:999999;padding:10px 12px;background:#111;color:#fff;border:1px solid #444;border-radius:10px;font:12px/1.4 ui-monospace,monospace;max-width:470px;box-shadow:0 6px 18px rgba(0,0,0,.35)";
    badge.innerHTML =
      '<div id="delphi-bot-text" style="white-space:pre-wrap;margin-bottom:8px">Starting...</div>' +
      '<div style="display:flex;gap:6px">' +
      '<button id="delphi-bot-stop" style="padding:4px 8px;border:1px solid #666;background:#2d2d2d;color:#fff;border-radius:6px;cursor:pointer">Stop</button>' +
      '<button id="delphi-bot-skip" style="padding:4px 8px;border:1px solid #666;background:#3a2d1d;color:#fff;border-radius:6px;cursor:pointer">Skip Step</button>' +
      "</div>";
    document.body.appendChild(badge);
  }

  const badgeText = badge.querySelector("#delphi-bot-text");
  const stopBtn = badge.querySelector("#delphi-bot-stop");
  const skipBtn = badge.querySelector("#delphi-bot-skip");

  if (stopBtn) {
    stopBtn.disabled = false;
    stopBtn.textContent = "Stop";
    stopBtn.onclick = () => {
      abort = true;
      stopBtn.disabled = true;
      stopBtn.textContent = "Stopping...";
    };
  }

  if (skipBtn) {
    skipBtn.disabled = false;
    skipBtn.textContent = "Skip Step";
    skipBtn.onclick = () => {
      skipRequested = true;
      skipBtn.textContent = "Skipping...";
    };
  }

  const setBadge = (msg, color = "#111") => {
    if (badgeText) badgeText.textContent = msg;
    badge.style.background = color;
  };

  const markStep = (name, msg) => {
    currentStepName = name;
    skipRequested = false;
    if (skipBtn) skipBtn.textContent = "Skip Step";
    setBadge(msg || name, "#111");
  };

  const ensureNotAborted = () => {
    if (abort) throw new Error("Stopped by user");
  };

  const ensureNotSkipped = () => {
    if (skipRequested) throw new Error(`Step skipped by user: ${currentStepName}`);
  };

  const waitFor = async (fn, timeout = 30000, interval = 250, err = "timeout") => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      ensureNotAborted();
      ensureNotSkipped();
      const v = fn();
      if (v) return v;
      await sleep(interval);
    }
    throw new Error(err);
  };

  const click = (el) => {
    if (!el) return false;
    el.click();
    return true;
  };

  const gotoViaNav = async (labelRe, pathRe, timeoutMs = 20000) => {
    if (pathRe.test(location.pathname)) return true;
    const link = all("a").find((a) => labelRe.test(text(a)));
    if (!link) throw new Error(`Nav link not found: ${labelRe}`);
    link.click();
    await waitFor(() => pathRe.test(location.pathname), timeoutMs, 250, `Navigation failed: ${labelRe}`);
    return true;
  };

  const isWalletDropdownOpen = () =>
    /test balance|disconnect|get \$?test tokens/i.test((document.body.innerText || "").replace(/\s+/g, " "));

  const getWalletArrow = () => {
    const summary = all("summary").find((s) => /0x[a-f0-9]{4}\.\.\.[a-f0-9]{4}/i.test(text(s)));
    if (!summary) return null;
    const exact = summary.querySelector('span[role="button"][tabindex="0"]');
    if (exact) return exact;
    const spans = summary.querySelectorAll("span");
    return spans.length ? spans[spans.length - 1] : null;
  };

  const closeWalletDropdown = async () => {
    const arrow = getWalletArrow();
    if (arrow) arrow.click();
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: 16, clientY: 16, view: window }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(250);
  };

  const openWalletDropdown = async () => {
    await waitFor(() => getWalletArrow(), 15000, 200, "wallet arrow not found");

    for (let i = 1; i <= 20; i++) {
      ensureNotAborted();
      ensureNotSkipped();
      setBadge(`Step 1/6\nOpen wallet + claim faucet\nOpening wallet dropdown (try ${i}/20)`, "#111");

      const arrow = getWalletArrow();
      if (!arrow) throw new Error("wallet arrow not found");

      arrow.click();
      arrow.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      arrow.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
      await sleep(220);

      if (isWalletDropdownOpen()) return true;

      arrow.click();
      await sleep(280);

      if (isWalletDropdownOpen()) return true;

      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await sleep(120);
    }
    return false;
  };

  const parseWallet = () => {
    const m = text(document.body).match(/wallet balance:\s*([0-9.]+)/i);
    return m ? parseFloat(m[1]) : NaN;
  };

  const parseCurrentPrice = () => {
    const m = text(document.body).match(/current price[^0-9]*([0-9.]+)/i);
    return m ? parseFloat(m[1]) : NaN;
  };

  const typeSharesRobust = async (value) => {
    const input =
      document.querySelector('input[placeholder*="SHARES" i], input[type="number"], [role="spinbutton"]') ||
      document.querySelector("input");

    if (!input) throw new Error("Shares input not found");

    const target = Number(value).toFixed(2);
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;

    for (let attempt = 1; attempt <= 4; attempt++) {
      input.focus();
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true }));
      if (nativeSetter) nativeSetter.call(input, "");
      else input.value = "";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await sleep(60);

      if (nativeSetter) nativeSetter.call(input, target);
      else input.value = target;

      input.dispatchEvent(new InputEvent("input", { bubbles: true, data: target, inputType: "insertText" }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new Event("blur", { bubbles: true }));
      await sleep(140);

      const now = String(input.value || "").trim();
      if (now === target) return;
    }

    throw new Error(`Share typing mismatch. expected ${target}, got ${input.value}`);
  };

  try {
    if (!/delphi\.gensyn\.ai/.test(location.host)) throw new Error("Open Delphi first");

    markStep("faucet", "Step 1/6\nOpen wallet + claim faucet");
    try {
      const opened = await openWalletDropdown();
      if (!opened) throw new Error("wallet dropdown not open");

      const faucetBtn = find("button", /get \$?test tokens/i);
      if (!faucetBtn) throw new Error("faucet button not found");
      click(faucetBtn);

      await waitFor(
        () => /tokens received from faucet|✓\s*get \$?test tokens|already claimed/i.test(text(document.body)),
        25000,
        500,
        "faucet confirmation not seen"
      );

      setBadge("✅ Faucet claimed/confirmed\nClosing wallet dropdown...", "#1f2937");
      await closeWalletDropdown();
      await sleep(AFTER_FAUCET_MS);
    } catch (e) {
      if ((e.message || "").includes("Step skipped by user")) {
        setBadge("⏭️ Faucet step skipped by user", "#3a2d1d");
        await closeWalletDropdown();
        await sleep(500);
      } else {
        throw e;
      }
    }

    markStep("active", "Step 2/6\nGo to Active Market");
    await gotoViaNav(/active market/i, /\/market\/active/);
    await sleep(600);

    markStep("open-buy", "Step 3/6\nOpen top BUY");
    const topBuy = await waitFor(
      () => all('a[href*="/buy"]').find((a) => /buy for/i.test(text(a))),
      20000,
      250,
      "top BUY link not found"
    );
    click(topBuy);

    await waitFor(
      () => document.querySelector('input[placeholder*="SHARES" i],input[type="number"],[role="spinbutton"]'),
      25000,
      250,
      "buy form not loaded"
    );
    await sleep(STEP_DELAY_MS);

    markStep("type-shares", "Step 4/6\nCompute and type exact shares");
    const wallet = parseWallet();
    const price = parseCurrentPrice();
    if (!isFinite(wallet) || wallet <= 0) throw new Error("wallet parse failed");
    if (!isFinite(price) || price <= 0) throw new Error("current price parse failed");

    const target = wallet * 0.95;
    const sharesStr = (target / price).toFixed(2);
    await typeSharesRobust(sharesStr);

    const reviewBtn = await waitFor(() => {
      const b = find("button,a", /review purchase/i);
      return b && !b.disabled ? b : null;
    }, 12000, 250, "Review Purchase not enabled");

    setBadge(
      `Step 4 done\nwallet=${wallet.toFixed(2)} target95=${target.toFixed(4)}\nprice=${price.toFixed(4)} shares=${sharesStr}`,
      "#1f2937"
    );
    await sleep(STEP_DELAY_MS);

    markStep("submit", "Step 5/6\nSubmit purchase");
    click(reviewBtn);
    await sleep(700);

    const confirmBtn = find("button,a", /^confirm$|confirm purchase/i);
    if (confirmBtn) click(confirmBtn);

    for (let i = 0; i < 3; i++) {
      ensureNotAborted();
      ensureNotSkipped();
      document.body.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, clientX: 24, clientY: 24, view: window })
      );
      await sleep(500);
      const retry = find("button,a", /purchase|confirm|buy/i);
      if (retry) click(retry);
      await sleep(1000);
    }

    await sleep(STEP_DELAY_MS);

    markStep("verify", "Step 6/6\nGo to My Activity and verify");
    await gotoViaNav(/my activity/i, /\/account/);
    await sleep(900);

    const success = await waitFor(
      () => all("h1,h2,h3,div,p,span,li").map(text).find((t) => /purchased .* stake/i.test(t)),
      45000,
      700,
      "No purchase found in activity"
    );

    setBadge(`✅ RUN COMPLETE\n${success}`, "#0b3d2e");
    alert("Gensyn Delphi automation: RUN COMPLETE ✅");
  } catch (e) {
    if ((e.message || "").includes("Stopped by user")) {
      setBadge("Stopped safely by user", "#0b3d2e");
      return;
    }
    setBadge(`❌ ${e.message}`, "#4a1d1d");
    alert("Gensyn Delphi automation error: " + e.message);
  }
})();

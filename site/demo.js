/*
 * Screen Break — landing page demo.
 *
 * Three jobs: run the break demo on request, keep the live preview in step with
 * the colour picker and the quote field, and remember the theme choice.
 *
 * No dependencies and no build step, matching the app itself.
 */
(function () {
  "use strict";

  // ------------------------------------------------------------------ theme
  //
  // Ported from `src/lib/theme.ts`, which is unit-tested in
  // `src/lib/theme.test.ts`. Kept deliberately identical so the colour picker
  // here behaves exactly as the app's does — in particular it compares real
  // contrast ratios rather than thresholding luminance, which is what gets
  // mid-tone backgrounds right.
  //
  // NOTE: if the contrast rule ever changes, change it in both places. The app
  // cannot import from `site/`, and a build step to share ~40 lines of pure
  // maths would cost more than it saves.

  var LIGHT_TEXT = { r: 244, g: 244, b: 246 };
  var DARK_TEXT = { r: 16, g: 16, b: 20 };
  var FALLBACK_BACKGROUND = "#101014";

  function parseHex(hex) {
    if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return null;
    return {
      r: parseInt(hex.slice(1, 3), 16),
      g: parseInt(hex.slice(3, 5), 16),
      b: parseInt(hex.slice(5, 7), 16),
    };
  }

  function toHex(rgb) {
    function pair(n) {
      var v = Math.round(Math.min(255, Math.max(0, n))).toString(16);
      return v.length === 1 ? "0" + v : v;
    }
    return "#" + pair(rgb.r) + pair(rgb.g) + pair(rgb.b);
  }

  // Proper sRGB gamma expansion, not a channel average — averaging badly
  // misjudges saturated colours.
  function relativeLuminance(rgb) {
    function channel(raw) {
      var v = raw / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    }
    return (
      0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b)
    );
  }

  function contrastRatio(a, b) {
    var la = relativeLuminance(a);
    var lb = relativeLuminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  function foregroundFor(background) {
    var bg = parseHex(background) || parseHex(FALLBACK_BACKGROUND);
    return toHex(
      contrastRatio(bg, LIGHT_TEXT) >= contrastRatio(bg, DARK_TEXT)
        ? LIGHT_TEXT
        : DARK_TEXT,
    );
  }

  function mutedForegroundFor(background, weight) {
    var w = typeof weight === "number" ? weight : 0.65;
    var bg = parseHex(background) || parseHex(FALLBACK_BACKGROUND);
    var fg = parseHex(foregroundFor(background));
    return toHex({
      r: bg.r + (fg.r - bg.r) * w,
      g: bg.g + (fg.g - bg.g) * w,
      b: bg.b + (fg.b - bg.b) * w,
    });
  }

  // ------------------------------------------------------------------ setup

  var root = document.documentElement;
  var overlay = document.getElementById("overlay");
  var overlayHeading = document.getElementById("overlay-heading");
  var overlayCountdown = document.getElementById("overlay-countdown");
  var previewHeading = document.getElementById("preview-heading");
  var colourInput = document.getElementById("colour");
  var quoteInput = document.getElementById("quote");
  var contrastOut = document.getElementById("contrast");
  var demoButton = document.getElementById("demo");
  var themeToggle = document.getElementById("theme-toggle");
  var themeToggleText = document.getElementById("theme-toggle-text");

  var PREROLL_SECONDS = 5;
  var BREAK_MS = 10000;
  var THEME_KEY = "screen-break:theme";

  function formatCountdown(ms) {
    var total = Math.max(0, Math.ceil(ms / 1000));
    var minutes = Math.floor(total / 60);
    var seconds = total % 60;
    return (
      (minutes < 10 ? "0" : "") + minutes + ":" + (seconds < 10 ? "0" : "") + seconds
    );
  }

  // ------------------------------------------------------------ appearance

  function applyTheme() {
    var background = colourInput.value;
    var fg = foregroundFor(background);
    var muted = mutedForegroundFor(background);

    root.style.setProperty("--break-bg", background);
    root.style.setProperty("--break-fg", fg);
    root.style.setProperty("--break-fg-muted", muted);

    var bg = parseHex(background);
    if (bg && contrastOut) {
      contrastOut.textContent =
        "contrast " + contrastRatio(bg, parseHex(fg)).toFixed(1) + ":1";
    }
  }

  function applyQuote() {
    var text = quoteInput.value.trim();
    [previewHeading, overlayHeading].forEach(function (el) {
      if (!el) return;
      if (text) {
        el.textContent = text;
        el.classList.add("break__heading--quote");
      } else {
        el.textContent = "Take a break";
        el.classList.remove("break__heading--quote");
      }
    });
  }

  colourInput.addEventListener("input", applyTheme);
  quoteInput.addEventListener("input", applyQuote);

  Array.prototype.forEach.call(
    document.querySelectorAll(".swatch"),
    function (swatch) {
      swatch.addEventListener("click", function () {
        colourInput.value = swatch.getAttribute("data-colour");
        applyTheme();
      });
    },
  );

  applyTheme();
  applyQuote();

  // ------------------------------------------------------- break takeover

  var breakTimer = null;
  var breakTick = null;
  var lastFocused = null;

  function closeBreak() {
    if (overlay.hidden) return;
    window.clearTimeout(breakTimer);
    window.clearInterval(breakTick);
    overlay.hidden = true;
    overlay.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
    document.body.classList.remove("demo-active");
    document.removeEventListener("keydown", onBreakKey, true);
    overlay.removeEventListener("click", closeBreak);

    // Put focus back where it came from, rather than dumping it at the top.
    if (lastFocused && typeof lastFocused.focus === "function") {
      lastFocused.focus();
    }
  }

  function onBreakKey(event) {
    // Esc is the app's documented escape hatch, but on a web page any key
    // should get you out — nobody should feel stuck on someone's landing page.
    event.preventDefault();
    closeBreak();
  }

  function openBreak() {
    if (!overlay.hidden) return;
    lastFocused = document.activeElement;
    overlay.hidden = false;
    overlay.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    // Hides the theme toggle, which would otherwise float over the break.
    document.body.classList.add("demo-active");
    overlay.setAttribute("tabindex", "-1");
    overlay.focus();

    var endsAt = Date.now() + BREAK_MS;
    overlayCountdown.textContent = formatCountdown(BREAK_MS);
    breakTick = window.setInterval(function () {
      overlayCountdown.textContent = formatCountdown(endsAt - Date.now());
    }, 250);
    breakTimer = window.setTimeout(closeBreak, BREAK_MS);

    document.addEventListener("keydown", onBreakKey, true);
    overlay.addEventListener("click", closeBreak);
  }

  // ------------------------------------------------------------- pre-roll
  //
  // Nothing fires unattended any more. The demo is opt-in, and the short
  // countdown runs on the button itself so it is obvious what is coming.
  // That also removes the need for the old safeguards — no once-per-visit
  // tracking, no in-viewport check, no reduced-motion opt-out — because an
  // explicit click is consent.

  var prerollTick = null;
  var prerollRemaining = 0;

  function resetButton() {
    window.clearInterval(prerollTick);
    prerollTick = null;
    demoButton.textContent = demoButton.getAttribute("data-idle");
  }

  function startPreroll() {
    prerollRemaining = PREROLL_SECONDS;
    demoButton.textContent = "Demo (" + prerollRemaining + "s)";
    prerollTick = window.setInterval(function () {
      prerollRemaining -= 1;
      if (prerollRemaining > 0) {
        demoButton.textContent = "Demo (" + prerollRemaining + "s)";
        return;
      }
      resetButton();
      openBreak();
    }, 1000);
  }

  demoButton.addEventListener("click", function () {
    // A second click during the countdown cancels it, so starting the demo is
    // never a commitment.
    if (prerollTick) {
      resetButton();
      return;
    }
    startPreroll();
  });

  // ---------------------------------------------------------------- theme

  // Light is the default, so the absence of the attribute means light and
  // dark is the opt-in.
  function isDarkTheme() {
    return document.documentElement.dataset.theme === "dark";
  }

  function applyThemeLabel() {
    var dark = isDarkTheme();
    // The control offers the mode you are not in.
    themeToggleText.textContent = dark ? "Light" : "Dark";
    themeToggle.setAttribute(
      "aria-label",
      dark ? "Switch to light theme" : "Switch to dark theme",
    );
  }

  themeToggle.addEventListener("click", function () {
    var dark = isDarkTheme();
    if (dark) {
      delete document.documentElement.dataset.theme;
    } else {
      document.documentElement.dataset.theme = "dark";
    }
    try {
      window.localStorage.setItem(THEME_KEY, dark ? "light" : "dark");
    } catch (e) {
      /* Storage can be blocked; the choice simply will not persist. */
    }
    applyThemeLabel();
  });

  applyThemeLabel();
})();

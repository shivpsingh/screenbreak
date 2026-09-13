/*
 * Screen Break — landing page demo.
 *
 * Two jobs: run the break takeover once per visit, and keep the live preview in
 * step with the colour picker and the quote field.
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
  var ticker = document.getElementById("ticker");
  var tickerLabel = document.getElementById("ticker-label");
  var tickerValue = document.getElementById("ticker-value");
  var fireButton = document.getElementById("fire-now");
  var hero = document.getElementById("hero");

  var reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  var HERO_COUNTDOWN_MS = 8000;
  var BREAK_MS = 10000;
  var SESSION_KEY = "screen-break:demo-shown";

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
    document.removeEventListener("keydown", onBreakKey, true);
    overlay.removeEventListener("click", closeBreak);

    // Put focus back where it came from, rather than dumping it at the top.
    if (lastFocused && typeof lastFocused.focus === "function") {
      lastFocused.focus();
    }
    setTickerDone();
  }

  function onBreakKey(event) {
    // Esc is the app's documented escape hatch, but on a web page any key
    // should get you out — nobody should feel stuck on someone's landing page.
    event.preventDefault();
    closeBreak();
  }

  function openBreak() {
    if (!overlay.hidden) return;
    try {
      window.sessionStorage.setItem(SESSION_KEY, "1");
    } catch (e) {
      /* Private browsing can refuse storage; the demo still works, it just
         may fire again on the next page load. */
    }

    lastFocused = document.activeElement;
    overlay.hidden = false;
    overlay.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
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

  // ------------------------------------------------------- hero countdown

  var heroDeadline = null;
  var heroTick = null;
  var heroInView = true;

  function setTickerDone() {
    window.clearInterval(heroTick);
    heroTick = null;
    heroDeadline = null;
    ticker.setAttribute("data-state", "done");
    tickerLabel.textContent = "Demo break";
    tickerValue.textContent = "done";
    fireButton.textContent = "Show me again";
  }

  function startHeroCountdown() {
    heroDeadline = Date.now() + HERO_COUNTDOWN_MS;
    tickerValue.textContent = formatCountdown(HERO_COUNTDOWN_MS);
    heroTick = window.setInterval(function () {
      var remaining = heroDeadline - Date.now();
      tickerValue.textContent = formatCountdown(remaining);
      if (remaining > 0) return;

      // Only interrupt someone who is actually looking at the hero. Firing a
      // fullscreen takeover while they are reading further down the page would
      // be indefensible.
      if (!heroInView) {
        setTickerDone();
        return;
      }
      window.clearInterval(heroTick);
      heroTick = null;
      openBreak();
    }, 250);
  }

  // Explicit request always works, and is the only path under reduced motion.
  fireButton.addEventListener("click", function () {
    if (heroTick) {
      window.clearInterval(heroTick);
      heroTick = null;
    }
    openBreak();
  });

  if ("IntersectionObserver" in window && hero) {
    new IntersectionObserver(
      function (entries) {
        heroInView = entries[0].isIntersecting;
      },
      { threshold: 0.4 },
    ).observe(hero);
  }

  var alreadyShown = false;
  try {
    alreadyShown = window.sessionStorage.getItem(SESSION_KEY) === "1";
  } catch (e) {
    /* Storage unavailable; treat as not yet shown. */
  }

  if (reducedMotion.matches) {
    // No takeover at all. The inline preview in "Make it yours" is the static
    // equivalent, so nothing is lost beyond the surprise.
    ticker.setAttribute("data-state", "done");
    tickerLabel.textContent = "Demo break";
    tickerValue.textContent = "on request";
  } else if (alreadyShown) {
    // Once per visit. Reloading should not mean being interrupted again.
    setTickerDone();
  } else {
    startHeroCountdown();
  }
})();

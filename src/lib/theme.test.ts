import { describe, expect, it } from "vitest";

import {
  breakThemeVariables,
  contrastRatio,
  FALLBACK_BACKGROUND,
  fontStackFor,
  foregroundFor,
  mutedForegroundFor,
  parseHex,
  relativeLuminance,
  toHex,
} from "./theme";
import { FONT_OPTIONS } from "../types/settings";

describe("parseHex", () => {
  it("parses six-digit hex in either case", () => {
    expect(parseHex("#000000")).toEqual({ r: 0, g: 0, b: 0 });
    expect(parseHex("#ffffff")).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseHex("#FFFFFF")).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseHex("#1a2b3c")).toEqual({ r: 26, g: 43, b: 60 });
  });

  it("rejects anything that is not six-digit hex", () => {
    for (const raw of ["", "#", "#fff", "101014", "#10101", "#1010144", "#gggggg", "red"]) {
      expect(parseHex(raw)).toBeNull();
    }
  });
});

describe("toHex", () => {
  it("round-trips through parseHex", () => {
    for (const hex of ["#000000", "#ffffff", "#101014", "#7f3fbf"]) {
      expect(toHex(parseHex(hex)!)).toBe(hex);
    }
  });

  it("clamps and rounds out-of-range channels", () => {
    expect(toHex({ r: -20, g: 300, b: 127.6 })).toBe("#00ff80");
  });
});

describe("relativeLuminance", () => {
  it("spans the full range for black and white", () => {
    expect(relativeLuminance({ r: 0, g: 0, b: 0 })).toBeCloseTo(0, 5);
    expect(relativeLuminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(1, 5);
  });

  it("weights green far above blue, unlike a naive channel average", () => {
    const green = relativeLuminance({ r: 0, g: 255, b: 0 });
    const blue = relativeLuminance({ r: 0, g: 0, b: 255 });
    expect(green).toBeGreaterThan(blue * 5);
  });
});

describe("contrastRatio", () => {
  it("gives 21:1 for black on white and 1:1 for a colour on itself", () => {
    const black = { r: 0, g: 0, b: 0 };
    const white = { r: 255, g: 255, b: 255 };
    expect(contrastRatio(black, white)).toBeCloseTo(21, 1);
    expect(contrastRatio(black, black)).toBeCloseTo(1, 5);
  });

  it("is symmetric", () => {
    const a = { r: 12, g: 90, b: 200 };
    const b = { r: 240, g: 230, b: 210 };
    expect(contrastRatio(a, b)).toBeCloseTo(contrastRatio(b, a), 10);
  });
});

describe("foregroundFor", () => {
  it("uses light text on dark backgrounds", () => {
    for (const bg of ["#000000", "#101014", "#1b2a4a", "#3a0a0a"]) {
      expect(foregroundFor(bg)).toBe("#f4f4f6");
    }
  });

  it("uses dark text on light backgrounds", () => {
    for (const bg of ["#ffffff", "#f5f0e0", "#cfe8ff", "#ffe08a"]) {
      expect(foregroundFor(bg)).toBe("#101014");
    }
  });

  it("always picks whichever option actually has more contrast", () => {
    // Sweep the greys, including the awkward mid-tones where a naive
    // luminance threshold picks the less readable option.
    for (let v = 0; v <= 255; v += 5) {
      const bg = toHex({ r: v, g: v, b: v });
      const chosen = parseHex(foregroundFor(bg))!;
      const rejected = parseHex(foregroundFor(bg) === "#f4f4f6" ? "#101014" : "#f4f4f6")!;
      const bgRgb = parseHex(bg)!;
      expect(contrastRatio(bgRgb, chosen)).toBeGreaterThanOrEqual(
        contrastRatio(bgRgb, rejected),
      );
    }
  });

  it("never returns text below the WCAG AA large-text ratio of 3:1", () => {
    // Large text is what the break screen uses throughout.
    for (let v = 0; v <= 255; v += 3) {
      const bg = toHex({ r: v, g: v, b: v });
      const ratio = contrastRatio(parseHex(bg)!, parseHex(foregroundFor(bg))!);
      expect(ratio).toBeGreaterThanOrEqual(3);
    }
  });

  it("falls back to the default background for unparseable input", () => {
    expect(foregroundFor("nonsense")).toBe(foregroundFor(FALLBACK_BACKGROUND));
  });
});

describe("mutedForegroundFor", () => {
  it("sits between the background and the foreground", () => {
    const bg = "#101014";
    const muted = parseHex(mutedForegroundFor(bg))!;
    const bgLum = relativeLuminance(parseHex(bg)!);
    const fgLum = relativeLuminance(parseHex(foregroundFor(bg))!);
    const mutedLum = relativeLuminance(muted);
    expect(mutedLum).toBeGreaterThan(bgLum);
    expect(mutedLum).toBeLessThan(fgLum);
  });

  it("stays readable on a light background too, not just a dark one", () => {
    const bg = "#f5f0e0";
    const ratio = contrastRatio(parseHex(bg)!, parseHex(mutedForegroundFor(bg))!);
    expect(ratio).toBeGreaterThan(2.5);
  });

  it("reaches the background at weight 0 and the foreground at weight 1", () => {
    expect(mutedForegroundFor("#101014", 0)).toBe("#101014");
    expect(mutedForegroundFor("#101014", 1)).toBe(foregroundFor("#101014"));
  });
});

describe("fontStackFor", () => {
  it("gives every offered option a non-empty stack ending in a generic family", () => {
    for (const { value } of FONT_OPTIONS) {
      const stack = fontStackFor(value);
      expect(stack.length).toBeGreaterThan(0);
      expect(stack).toMatch(/(monospace|serif|sans-serif)$/);
    }
  });

  it("puts the bundled Ubuntu Mono first but keeps a fallback", () => {
    const stack = fontStackFor("ubuntuMono");
    expect(stack.startsWith('"Ubuntu Mono"')).toBe(true);
    expect(stack).toMatch(/monospace$/);
  });
});

describe("breakThemeVariables", () => {
  it("emits every custom property the stylesheet reads", () => {
    const vars = breakThemeVariables("#101014", "ubuntuMono");
    expect(Object.keys(vars).sort()).toEqual([
      "--break-bg",
      "--break-fg",
      "--break-fg-muted",
      "--break-font",
    ]);
  });

  it("normalises the colour and derives a readable foreground", () => {
    const vars = breakThemeVariables("#F5F0E0", "serif");
    expect(vars["--break-bg"]).toBe("#f5f0e0");
    expect(vars["--break-fg"]).toBe("#101014");
    expect(vars["--break-font"]).toMatch(/Georgia/);
  });

  it("substitutes the default background when the stored colour is unusable", () => {
    const vars = breakThemeVariables("octarine", "system");
    expect(vars["--break-bg"]).toBe(FALLBACK_BACKGROUND);
    expect(vars["--break-fg"]).toBe("#f4f4f6");
  });
});

# Distribution

Getting from a local build to a release people can install. For the design see
[architecture.md](architecture.md); for development setup see
[development.md](development.md).

---

Everything below describes work that is **not yet done**. The repo
currently produces unsigned local artifacts and has no release automation. This
is the checklist to get from here to a release people can install.

| Area | Status |
|---|---|
| Bundling (dmg / msi / nsis / deb / rpm / AppImage) | Configured (`bundle.targets: "all"`) |
| macOS code signing + notarization | **Not configured** |
| Windows Authenticode signing | **Not configured** |
| Linux package signing / repos | **Not configured** |
| Auto-updates | **Not configured** (no updater plugin) |
| CI release pipeline | **Not configured** (template below) |
| LICENSE file | **Missing — blocking** |

## Before the first public release

These are project prerequisites rather than build steps, and the first one is a
hard blocker:

- **Add a `LICENSE` file.** There is none. Without an explicit licence the
  default is "all rights reserved", so nobody may legally redistribute the app
  or the source — which makes an open-source release meaningless. Pick a licence
  before tagging anything.
- **Ship the third-party notices.** Ubuntu Mono is vendored under the Ubuntu
  Font Licence 1.0 at `src/assets/fonts/LICENCE.txt`. That licence requires the
  notice to travel with the font, so it must be included in distributed
  binaries, not just in the repo. Rust and npm dependency licences should be
  collected too (`cargo about` / `license-checker` can generate the list).
- **Change the bundle identifier.** `com.screenbreak.app` is a placeholder.
  Use a domain you actually control. It is the app's permanent identity to
  macOS and Windows *and* it determines the settings directory, so changing it
  after release orphans every existing user's `settings.json` and `quotes.json`.
- **Replace the icons.** `src-tauri/icons/` still holds the default Tauri
  artwork from the project template.
- **Add the usual community files.** None are present: `CHANGELOG.md`,
  `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, and issue/PR
  templates under `.github/`.

## Version numbers

The version is declared in **three** places and they must agree — `tauri build`
flags a mismatch, and ships an `--ignore-version-mismatches` escape hatch that
you should not need:

- `package.json`
- `src-tauri/Cargo.toml` (and therefore `Cargo.lock`)
- `src-tauri/tauri.conf.json`

You can cut this to two by **deleting `version` from `tauri.conf.json`**, which
makes Tauri inherit the version from `Cargo.toml`.

## Release checklist

```bash
pnpm typecheck && pnpm test && pnpm test:rust   # 1. everything green
# 2. bump the version in the places listed above
# 3. write the CHANGELOG entry
git commit -am "Release v0.2.0"
git tag -a v0.2.0 -m "v0.2.0"                   # 4. annotated tag
git push origin main --follow-tags              # 5. triggers CI, if configured
```

Then, for each platform (natively or via CI — see *Cross-compilation*):

```bash
pnpm tauri build
```

6. **Publish checksums** alongside the binaries so users can verify downloads.
   This is the only integrity signal Linux users get, since the packages are
   unsigned:

   ```bash
   cd src-tauri/target/release/bundle
   find . -type f \( -name '*.dmg' -o -name '*.msi' -o -name '*.exe' \
     -o -name '*.deb' -o -name '*.rpm' -o -name '*.AppImage' \) \
     -exec shasum -a 256 {} + > SHA256SUMS
   ```

7. Attach every artifact plus `SHA256SUMS` to the release.

---

## macOS

**Prerequisites**

```bash
xcode-select --install
rustup target add aarch64-apple-darwin x86_64-apple-darwin   # for universal
```

**Build**

```bash
pnpm tauri build                                   # host arch only
pnpm tauri build --target universal-apple-darwin   # Apple Silicon + Intel
```

Produces `Screen Break.app` and a `.dmg`.

**Signing and notarization.** Without both, Gatekeeper blocks the app on other
people's machines — they have to right-click → Open and accept a warning, which
is not an acceptable install experience. You need a paid Apple Developer account
and a **Developer ID Application** certificate.

Signing reads these:

| Variable | Purpose |
|---|---|
| `APPLE_SIGNING_IDENTITY` | Name of the certificate identity in the keychain |
| `APPLE_CERTIFICATE` | Base64-encoded `.p12`, for CI where there is no keychain |
| `APPLE_CERTIFICATE_PASSWORD` | Password for that `.p12` |

Notarization then needs **one** of two authentication sets — they are
alternatives, not a single list:

| App Store Connect API (preferred for CI) | Apple ID |
|---|---|
| `APPLE_API_ISSUER` | `APPLE_ID` |
| `APPLE_API_KEY` (the Key ID) | `APPLE_PASSWORD` (an *app-specific* password) |
| `APPLE_API_KEY_PATH` (path to the `.p8`) | `APPLE_TEAM_ID` |

There is **no separate notarize command** — set the variables and re-run
`pnpm tauri build`; the bundler signs, uploads, waits, and staples the ticket.
First-time notarization can take hours, so `--skip-stapling` exists to avoid
blocking the build; stapling is worth having on later runs because it lets
Gatekeeper verify offline.

`hardenedRuntime` already **defaults to `true`**, which notarization requires,
so no config change is needed. The app needs no special entitlements as written,
so no `entitlements` file is required either. `minimumSystemVersion` defaults to
`10.13`; raise it via `bundle.macOS.minimumSystemVersion` if you want to
guarantee a newer baseline.

## Windows

**Prerequisites** — Microsoft C++ Build Tools, and the WebView2 runtime (already
present on Windows 11 and current Windows 10). For MSI output you also need the
**VBSCRIPT** optional Windows feature enabled.

**Build**

```powershell
pnpm tauri build                      # both installers
pnpm tauri build --bundles nsis       # just the NSIS installer
```

Produces an **MSI** (WiX) and an **NSIS** installer. Note the MSI **can only be
built on Windows** — WiX is Windows-only.

**Authenticode signing.** Unsigned installers trigger a SmartScreen warning and
visibly deter installs. Unlike macOS this is configured in
`src-tauri/tauri.conf.json` under `bundle.windows`, not purely by environment:

```json
{
  "bundle": {
    "windows": {
      "certificateThumbprint": "YOUR_CERT_THUMBPRINT",
      "digestAlgorithm": "sha256",
      "timestampUrl": "http://timestamp.digicert.com"
    }
  }
}
```

Always set `timestampUrl` — a timestamped signature stays valid after the
certificate expires.

For a cloud HSM or Azure Trusted Signing (which is how most projects meet the
current key-storage requirements without holding a physical token), use
`signCommand` instead, where `%1` is the file being signed:

```json
{ "bundle": { "windows": { "signCommand": "relic sign --file %1 --key azure --config relic.conf" } } }
```

Azure-backed options additionally need `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` and
`AZURE_CLIENT_SECRET` in the environment.

**WebView2 delivery** — `bundle.windows.webviewInstallMode.type` controls what
happens on a machine without the runtime. The default is fine for a small
utility; the others trade installer size for offline reliability:

| Value | Added installer size |
|---|---|
| `downloadBootstrapper` (default) | ~0 MB, needs a network at install time |
| `embedBootstrapper` | ~1.8 MB |
| `offlineInstaller` | ~127 MB |
| `fixedVersion` | ~180 MB, pins the runtime version |
| `skip` | none; the app breaks if the runtime is absent |

**ARM64** — the app compiles natively, but MSI on ARM64 needs the Visual Studio
ARM64 build tools, and the NSIS installer binary itself is x86 (it runs under
emulation; the installed app is still native).

## Linux

**Prerequisites**

```bash
# Debian / Ubuntu
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev

# Fedora
sudo dnf install webkit2gtk4.1-devel openssl-devel curl wget file \
  libappindicator-gtk3-devel librsvg2-devel libxdo-devel

# Arch
sudo pacman -S webkit2gtk-4.1 base-devel curl wget file openssl \
  appmenu-gtk-module libappindicator-gtk3 librsvg xdotool
```

`libayatana-appindicator3-dev` is what makes the tray icon possible.

**Build** produces `.deb`, `.rpm` and an AppImage. Tauri automatically declares
the `.deb` runtime dependencies, including `libappindicator3-1` because this app
uses a tray — so tray support is handled without extra config.

**Build on the oldest distribution you intend to support.** glibc is only
forward-compatible: a binary built against a newer glibc will not start on an
older system. **Ubuntu 22.04 / Debian 12** is the practical baseline, being the
oldest release that ships `libwebkit2gtk-4.1-dev`. This is why the CI matrix
below pins `ubuntu-22.04` rather than using `ubuntu-latest`.

**AppImage caveats** — it bundles WebKit and friends, taking the artifact from
a few MB to 70 MB+. ARM AppImages **can only be built on ARM hardware**;
`linuxdeploy` cannot cross-compile them.

There is no Linux equivalent of Gatekeeper, so nothing needs signing to install
— but publish `SHA256SUMS`, and sign the release with GPG if you want verifiable
provenance. Getting into distro repositories (Flathub, AUR, PPAs) is a separate
effort per channel and is not covered here.

## Cross-compilation

**Build each platform on that platform.** Tauri links against native system
libraries and platform toolchains, so cross-compiling is not meaningfully
supported. A CI matrix is the intended answer.

The narrow exceptions, none of which are recommended here:

- Windows NSIS from Linux/macOS via
  `tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc`. Officially
  described as a last resort, and signing a cross-compiled installer needs an
  external tool.
- **MSI: Windows only.** **ARM AppImage: ARM only.**

## CI release pipeline

The template below is **not committed** — there is no `.github/` directory, and
a live workflow without the secrets configured would just fail on every tag.
Save it as `.github/workflows/release.yml` when you are ready to wire up
signing.

Note the two deliberate choices: `ubuntu-22.04` is pinned for the glibc baseline,
and macOS is built as two separate per-architecture jobs, which is what
`tauri-action` recommends over a single universal build.

The template runs the test suite inside every matrix job, which is four
redundant runs. That is deliberate for a starting point — no artifact gets
published without tests passing on that machine — but the obvious optimisation
is to split testing into one job that the release jobs depend on.

```yaml
name: Release
on:
  push:
    tags: ['v*']

jobs:
  release:
    permissions:
      contents: write
    strategy:
      fail-fast: false
      matrix:
        include:
          - platform: macos-latest
            args: --target aarch64-apple-darwin
          - platform: macos-latest
            args: --target x86_64-apple-darwin
          - platform: ubuntu-22.04     # glibc baseline, not ubuntu-latest
            args: ''
          - platform: windows-latest
            args: ''
    runs-on: ${{ matrix.platform }}
    steps:
      - uses: actions/checkout@v4

      - name: Install Linux build dependencies
        if: matrix.platform == 'ubuntu-22.04'
        run: |
          sudo apt-get update
          sudo apt-get install -y libwebkit2gtk-4.1-dev build-essential curl \
            wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev

      - uses: dtolnay/rust-toolchain@stable
        with:
          targets: ${{ matrix.platform == 'macos-latest' && 'aarch64-apple-darwin,x86_64-apple-darwin' || '' }}

      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck && pnpm test && pnpm test:rust

      - uses: tauri-apps/tauri-action@v1
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          # macOS signing + notarization. Signing vars are passed as job env,
          # not as action inputs.
          APPLE_SIGNING_IDENTITY: ${{ secrets.APPLE_SIGNING_IDENTITY }}
          APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE }}
          APPLE_CERTIFICATE_PASSWORD: ${{ secrets.APPLE_CERTIFICATE_PASSWORD }}
          APPLE_API_ISSUER: ${{ secrets.APPLE_API_ISSUER }}
          APPLE_API_KEY: ${{ secrets.APPLE_API_KEY }}
          APPLE_API_KEY_PATH: ${{ secrets.APPLE_API_KEY_PATH }}
        with:
          tagName: ${{ github.ref_name }}
          releaseName: 'Screen Break ${{ github.ref_name }}'
          releaseDraft: true
          args: ${{ matrix.args }}
```

## Auto-updates

Not configured, and deliberately out of scope for the MVP — the app has no
network code at all, which is part of the point. Enabling it later would need:

1. `tauri-plugin-updater` (Rust) and `@tauri-apps/plugin-updater` (npm).
2. A signing keypair: `pnpm tauri signer generate -w ~/.tauri/screen-break.key`.
3. `"createUpdaterArtifacts": true` in `tauri.conf.json` — **required**, or no
   update bundles or signatures are produced at all.
4. `plugins.updater.pubkey` and `plugins.updater.endpoints`.
5. `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` in CI.

Note that this would introduce the app's first outbound network request, so it
should be a documented, ideally opt-in change rather than a silent one.

---

# Store listing · English (en-US)

> Paste into Partner Center → Store listings → **English (United States)**.

## Display name (45 chars)

```
Mirror Fastlane
```

## Short description (132 chars)

```
Rewrite GitHub release downloads to a working mirror, with the source labelled on the page. On-demand probing only, no telemetry.
```

(116 chars)

## Detailed description (10000 chars)

```
Mirror Fastlane fixes one specific problem: GitHub release downloads that crawl at a few KB/s — or drop entirely — depending on where you are. It does exactly one thing: rewrite the download link you clicked to a mirror that actually works, and show you which host is serving the file.

HOW IT WORKS

1. You click a download link on a GitHub release page. The extension rewrites the request to the fastest mirror, based on its own speed tests.
2. A small "mirror" badge appears next to the link; hover it to see which host will serve you.
3. On click, a toast in the corner tells you which mirror was used.
4. If a mirror starts failing, the next probe round demotes it and promotes a working one.

QUIET BY DEFAULT

- Probing is on-demand: speed tests only run when you open a GitHub page, so mirror bandwidth is not burned in the background.
- Optional active-hours window (e.g. 20:00–02:00). Outside it, nothing is probed and nothing is rewritten — everything falls back to the origin.
- Remote mirror list is off by default; you opt in and supply the URL.
- All configuration stays in your browser. No account, no cloud, no sync.

BRING YOUR OWN MIRRORS

Add, remove, authorise and test mirrors individually. Authorisation only affects speed testing — rewriting itself does not need host access to the mirror. Source code and the built-in mirror list are both on GitHub.

OPTIONAL DOWNLOAD VERIFICATION

If you care whether the bytes you got are the bytes that were published, enable hash verification. On download the extension writes the asset's official SHA-256 (from api.github.com) into a small task file, and a companion local script compares it after the download finishes, then raises a system notification. The script also re-queries GitHub by asset id, so a tampered task file cannot vouch for itself.

This part is entirely optional. The script is not bundled with the extension — download it from the repository and read it first.

WHAT IT DOES NOT DO

- It is not a proxy, VPN, or traffic relay. Your IP is unchanged.
- It does not cache, upload, or collect anything. No telemetry, no analytics.
- It does not touch requests made outside the browser (for example, a link you paste into a download manager).
- It does not read your downloaded files. With verification enabled it only writes a few-dozen-byte task file.

WHO IT IS FOR

People who pull releases and source archives from GitHub regularly; people who want to know whether a file was swapped; people who would rather not run a full-tunnel proxy just to fetch a zip.

MIT licensed. Source, issues and privacy policy are on GitHub.
```

## Category

- Primary: **Developer tools**
- Secondary (if allowed): **Productivity**

## Links

| Field | Value |
|---|---|
| Privacy policy URL | `https://github.com/morangsu/mirror-fastlane/blob/main/privacy.md` |
| Website / support URL | `https://github.com/morangsu/mirror-fastlane` |
| Issues | `https://github.com/morangsu/mirror-fastlane/issues` |
| Support email | (your own address) |

## Search terms (max 7, each ≤30 chars)

```
github mirror
github download
download accelerator
mirror redirect
sha256 verify
checksum
developer tools
```

## Screenshot captions

| File | Caption |
|---|---|
| `01-overview.png` | One switch, live rule status and the mirror list |
| `02-probe-window.png` | Probing: on-demand or scheduled, with active hours |
| `03-hash.png` | Optional hash verification via a local script |
| `04-verify.png` | Verify page: fetch the official digest, compare locally |

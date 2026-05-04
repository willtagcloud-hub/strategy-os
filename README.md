# Strategy OS — Affiliate PWA Decks

Six password-protected HTML slide decks covering vertical playbooks for an
affiliate / media-buying portfolio (Visa, GLP-1, Supplements, Loans,
Insurance, Real Estate).

The published site is encrypted client-side and gated by a password.

## How it works

- Source decks live in `presentations/` (plain HTML).
- A Node build script encrypts each HTML file with **AES-256-GCM**, using a key
  derived from the site password via **PBKDF2-SHA256 (600,000 iterations)**.
- Output lives in `dist/` and is what GitHub Pages serves.
- Visitors see a password prompt on first load; after correct entry the
  derived session is cached in `sessionStorage` for cross-deck navigation.

## Local build

```bash
SITE_PASSWORD="your-password" node build/encrypt.mjs
```

Or on Windows PowerShell:

```powershell
$env:SITE_PASSWORD="your-password"; node build/encrypt.mjs
```

This generates the `dist/` folder ready for static hosting.

## Deploy

A GitHub Actions workflow builds `dist/` and publishes to GitHub Pages on
every push to `main`. The site password is provided through the
`SITE_PASSWORD` repository secret.

## Local preview

```bash
npx serve dist
```

Or open `dist/index.html` directly. The first load asks for the password.

## Layout

```
presentations/      Plain HTML source decks
build/              Encryption tooling
dist/               Build output (encrypted, ready to publish)
.github/workflows/  CI/CD pipeline for GitHub Pages
```

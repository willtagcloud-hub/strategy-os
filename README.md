# Strategy OS — Affiliate PWA Decks

Six password-protected HTML slide decks covering vertical playbooks for an
affiliate / media-buying portfolio (Visa, GLP-1, Supplements, Loans,
Insurance, Real Estate).

The published site is encrypted client-side and gated by a password.

## How it works

- Source decks live in `presentations/` (plain HTML).
- A Node build script encrypts each HTML file with **AES-256-GCM**, using a key
  derived from the site password via **PBKDF2-SHA256 (600,000 iterations)**.
- Output lives in `docs/` and is what GitHub Pages serves (configured to publish from `main` branch `/docs` folder).
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

This generates the `docs/` folder ready for static hosting.

## Deploy

GitHub Pages is configured to serve the `docs/` folder of the `main` branch.
Re-run the encryption build locally and push to deploy a new version.

## Local preview

```bash
npx serve docs
```

Or open `docs/index.html` directly. The first load asks for the password.

## Layout

```
presentations/  Plain HTML source decks
build/          Encryption tooling
docs/           Build output (encrypted, served by GitHub Pages)
```

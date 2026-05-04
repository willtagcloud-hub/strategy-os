// Encrypts HTML files for static, password-gated GitHub Pages delivery.
// AES-256-GCM with PBKDF2-SHA256 (600k iterations) key derivation.

import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "presentations");
const OUT = path.join(ROOT, "dist");
const TEMPLATE_PATH = path.join(__dirname, "template.html");

const ITERATIONS = 600_000;
const KEY_LEN = 32; // 256 bits
const SALT_LEN = 16;
const IV_LEN = 12; // GCM standard

function getPassword() {
  const fromEnv = process.env.SITE_PASSWORD;
  const fromArg = process.argv.find(a => a.startsWith("--password="));
  const pwd = fromArg ? fromArg.split("=")[1] : fromEnv;
  if (!pwd) {
    console.error("Set SITE_PASSWORD env var or pass --password=...");
    process.exit(1);
  }
  return pwd;
}

function deriveKey(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(password, salt, ITERATIONS, KEY_LEN, "sha256", (err, key) => {
      if (err) reject(err); else resolve(key);
    });
  });
}

async function encryptText(plaintext, password) {
  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const key = await deriveKey(password, salt);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Concatenate ciphertext + tag (matches WebCrypto AES-GCM output format)
  const combined = Buffer.concat([ciphertext, tag]);
  return {
    v: 1,
    alg: "AES-256-GCM",
    kdf: "PBKDF2-SHA256",
    iter: ITERATIONS,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    ct: combined.toString("base64"),
  };
}

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

async function copyAssetsAndCryptoLib() {
  const distAssets = path.join(OUT, "assets");
  await ensureDir(distAssets);
  const srcAssets = path.join(SRC, "assets");
  for (const f of await fs.readdir(srcAssets)) {
    await fs.copyFile(path.join(srcAssets, f), path.join(distAssets, f));
  }
  // Add browser-side crypto helper
  const cryptoJs = `
window.StrategyCrypto = (function () {
  const ITERATIONS = ${ITERATIONS};
  const KEY_LEN = ${KEY_LEN * 8};

  function b64ToBuf(b64) {
    const bin = atob(b64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    return buf.buffer;
  }

  async function deriveKey(password, saltBuf) {
    const enc = new TextEncoder();
    const baseKey = await crypto.subtle.importKey(
      "raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]
    );
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: saltBuf, iterations: ITERATIONS, hash: "SHA-256" },
      baseKey,
      { name: "AES-GCM", length: KEY_LEN },
      false,
      ["decrypt"]
    );
  }

  async function decrypt(payload, password) {
    if (!payload || payload.alg !== "AES-256-GCM") {
      throw new Error("Bad payload");
    }
    const salt = b64ToBuf(payload.salt);
    const iv = b64ToBuf(payload.iv);
    const ct = b64ToBuf(payload.ct);
    const key = await deriveKey(password, salt);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv }, key, ct);
    return new TextDecoder().decode(plain);
  }

  return { decrypt: decrypt };
})();
`;
  await fs.writeFile(path.join(distAssets, "crypto.js"), cryptoJs.trim() + "\n", "utf8");
}

async function processFile(srcFile, password, template) {
  const rel = path.relative(SRC, srcFile);
  const outFile = path.join(OUT, rel);
  await ensureDir(path.dirname(outFile));

  const html = await fs.readFile(srcFile, "utf8");
  const titleMatch = html.match(/<title>([^<]*)<\/title>/i);
  const title = titleMatch ? titleMatch[1] : "Strategy OS";

  // Compute relative prefix from outFile back to dist root for assets
  const depth = path.dirname(rel).split(path.sep).filter(p => p && p !== ".").length;
  const assetsPrefix = depth === 0 ? "./" : "../".repeat(depth);

  const payload = await encryptText(html, password);
  const wrapped = template
    .replace(/__TITLE__/g, escapeHtml(title))
    .replace(/__ASSETS_PREFIX__/g, assetsPrefix)
    .replace(/__PAYLOAD__/g, JSON.stringify(payload));

  await fs.writeFile(outFile, wrapped, "utf8");
  console.log("Encrypted:", rel);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

async function walkHtmlFiles(dir) {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "assets") continue;
      out.push(...await walkHtmlFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".html")) {
      out.push(full);
    }
  }
  return out;
}

async function writeNoJekyll() {
  await fs.writeFile(path.join(OUT, ".nojekyll"), "", "utf8");
}

async function main() {
  const password = getPassword();
  console.log("Source:", SRC);
  console.log("Output:", OUT);

  await fs.rm(OUT, { recursive: true, force: true });
  await ensureDir(OUT);
  await copyAssetsAndCryptoLib();
  await writeNoJekyll();

  const template = await fs.readFile(TEMPLATE_PATH, "utf8");
  const files = await walkHtmlFiles(SRC);
  for (const f of files) {
    await processFile(f, password, template);
  }
  console.log(`\nDone. ${files.length} files encrypted.`);
}

main().catch(err => { console.error(err); process.exit(1); });

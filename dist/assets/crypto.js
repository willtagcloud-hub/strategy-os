window.StrategyCrypto = (function () {
  const ITERATIONS = 600000;
  const KEY_LEN = 256;

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

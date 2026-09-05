// 密码哈希：使用 Web Crypto（SHA-256），在 Cloudflare Workers 与 Node 22 中均可用。
// 哈希算法与 server.js（node:crypto sha256）输出完全一致：
//   hash = sha256(salt + '::' + password)
// 因此迁移时把旧 data.json 的 salt/passwordHash 直接写入 D1 meta 即可，admin 密码继续有效。

const enc = new TextEncoder();

export async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(String(str)));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function hashPassword(password, salt) {
  return sha256Hex(String(salt) + '::' + String(password));
}

export function newSalt() {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function newId(prefix) {
  const u = (crypto.randomUUID && crypto.randomUUID()) || Math.random().toString(36).slice(2);
  return prefix + '_' + u;
}

import { Context } from "hono";
import { deleteCookie, getCookie } from "hono/cookie";
import { AppBindings } from "../env";

export const encrypt = async (tokenContent: string, secret: string) => {
  const encoder = new TextEncoder()

  const rawKey = Uint8Array.from(atob(secret), c => c.charCodeAt(0));

  const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt'])

  const iv = crypto.getRandomValues(new Uint8Array(12));

  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(tokenContent)
  );

  return {
    iv: btoa(String.fromCharCode(...iv)),
    data: btoa(String.fromCharCode(...new Uint8Array(ciphertext))),
  };
}

export const decrypt = async (encrypted: Awaited<ReturnType<typeof encrypt>>, secret: string) => {
  const decoder = new TextDecoder();

  const rawKey = Uint8Array.from(atob(secret), c => c.charCodeAt(0));

  const key = await crypto.subtle.importKey(
    "raw",
    rawKey,
    { name: "AES-GCM" },
    false,
    ["decrypt"]
  );

  const iv = Uint8Array.from(atob(encrypted.iv), c => c.charCodeAt(0));
  const data = Uint8Array.from(atob(encrypted.data), c => c.charCodeAt(0));

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    data
  );

  return decoder.decode(decrypted);
}

export const getSession = async (c: Context<{ Bindings: AppBindings }>) => {
  const token = getCookie(c, 'starspect_session') || c.req.header('Authorization')?.split(' ')[1] || null

  if (!token) {
    return null
  }
  const [iv, data] = token.split('.')

  const decrypted = await decrypt({ iv, data }, c.env.SESSION_SECRET)

  const [uuid, login, expiresAt] = decrypted.split(':')

  if (new Date(Number(expiresAt)) < new Date() || !uuid || !login || (await c.env.sessions.get(token)) !== expiresAt) {
    await c.env.sessions.delete(token)
    deleteCookie(c, 'starspect_session')
    return null
  }

  return { uuid, login, expiresAt: new Date(Number(expiresAt)) }
}

export const isLoggedIn = async (c: Context<{ Bindings: AppBindings }>) => {
  const session = await getSession(c)
  return session !== null
}

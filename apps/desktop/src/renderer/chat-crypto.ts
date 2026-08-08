const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function isChatKey(value: string | null): value is string {
  return typeof value === "string" && value.length >= 32;
}

export async function encryptChatMessage(keyValue: string, content: string): Promise<{ ciphertext: string; nonce: string }> {
  const key = await crypto.subtle.importKey("raw", base64UrlToBytes(keyValue) as unknown as ArrayBuffer, { name: "AES-GCM" }, false, ["encrypt"]);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce as unknown as ArrayBuffer }, key, encoder.encode(content));
  return { ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)), nonce: bytesToBase64Url(nonce) };
}

export async function decryptChatMessage(keyValue: string, ciphertext: string, nonceValue: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", base64UrlToBytes(keyValue) as unknown as ArrayBuffer, { name: "AES-GCM" }, false, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64UrlToBytes(nonceValue) as unknown as ArrayBuffer }, key, base64UrlToBytes(ciphertext) as unknown as ArrayBuffer);
  return decoder.decode(plaintext);
}

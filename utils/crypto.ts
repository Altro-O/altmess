import CryptoJS from 'crypto-js';

function generateSecureKey(): string {
  if (typeof window !== 'undefined' && window.crypto && window.crypto.getRandomValues) {
    const bytes = new Uint8Array(32);
    window.crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

const SECRET_KEY = typeof window !== 'undefined'
  ? (localStorage.getItem('encryption_key') || (() => {
      const key = generateSecureKey();
      localStorage.setItem('encryption_key', key);
      return key;
    })())
  : generateSecureKey();

export function encryptMessage(text: string, key: string = SECRET_KEY): string {
  try {
    const encrypted = CryptoJS.AES.encrypt(text, key).toString();
    return encrypted;
  } catch (error) {
    console.error('Encryption error:', error);
    return text;
  }
}

export function decryptMessage(encryptedText: string, key: string = SECRET_KEY): string {
  try {
    const decrypted = CryptoJS.AES.decrypt(encryptedText, key).toString(CryptoJS.enc.Utf8);
    return decrypted;
  } catch (error) {
    console.error('Decryption error:', error);
    return encryptedText;
  }
}

export function generatePrivateKey(): string {
  return generateSecureKey();
}

export function hashPassword(password: string): string {
  return CryptoJS.SHA256(password).toString();
}

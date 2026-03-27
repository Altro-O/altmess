import CryptoJS from 'crypto-js';

// Ключ шифрования (в реальном приложении должен быть более безопасным)
const SECRET_KEY = typeof window !== 'undefined' ? localStorage.getItem('encryption_key') || generateKey() : generateKey();

function generateKey(): string {
  // В реальном приложении используйте более надежный метод генерации ключа
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

if (typeof window !== 'undefined' && !localStorage.getItem('encryption_key')) {
  localStorage.setItem('encryption_key', SECRET_KEY);
}

export function encryptMessage(text: string, key: string = SECRET_KEY): string {
  try {
    const encrypted = CryptoJS.AES.encrypt(text, key).toString();
    return encrypted;
  } catch (error) {
    console.error('Ошибка шифрования:', error);
    return text; // Возвращаем не зашифрованный текст в случае ошибки
  }
}

export function decryptMessage(encryptedText: string, key: string = SECRET_KEY): string {
  try {
    const decrypted = CryptoJS.AES.decrypt(encryptedText, key).toString(CryptoJS.enc.Utf8);
    return decrypted;
  } catch (error) {
    console.error('Ошибка расшифровки:', error);
    return encryptedText; // Возвращаем зашифрованный текст в случае ошибки
  }
}

export function generatePrivateKey(): string {
  // Генерация приватного ключа для сквозного шифрования
  return btoa(Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15));
}

export function hashPassword(password: string): string {
  // Простое хеширование пароля (в реальном приложении используйте bcrypt или аналог)
  return CryptoJS.SHA256(password).toString();
}
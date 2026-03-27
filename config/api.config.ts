// Конфигурация API для интеграции с Node.js сервером

export const API_CONFIG = {
  // Базовый URL для REST API
  BASE_URL: process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:8080/api',
  
  // WebSocket URL для чата
  WEBSOCKET_URL: process.env.NEXT_PUBLIC_WEBSOCKET_URL || 'ws://localhost:8080/ws',
  
  // Endpoint для регистрации
  REGISTER_ENDPOINT: '/auth/register',
  
  // Endpoint для входа
  LOGIN_ENDPOINT: '/auth/login',
  
  // Endpoint для получения списка контактов
  CONTACTS_ENDPOINT: '/users/contacts',
  
  // Endpoint для получения истории сообщений
  MESSAGES_HISTORY_ENDPOINT: '/messages/history',
};

export default API_CONFIG;
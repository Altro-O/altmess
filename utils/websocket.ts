// Клиентский WebSocket для чата
import API_CONFIG from '@/config/api.config';

class ChatWebSocket {
  private socket: WebSocket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectInterval = 3000;

  constructor(
    private onMessage: (data: any) => void,
    private token?: string
  ) {}

  connect() {
    try {
      // Получаем URL из конфига и добавляем токен для аутентификации
      const url = this.token 
        ? `${API_CONFIG.WEBSOCKET_URL}?token=${this.token}`
        : API_CONFIG.WEBSOCKET_URL;
        
      this.socket = new WebSocket(url);
      
      this.socket.onopen = () => {
        console.log('Соединение с чат-сервером установлено');
        this.reconnectAttempts = 0; // Сбросить счетчик попыток переподключения
        
        // Отправляем сообщение аутентификации если токен предоставлен
        if (this.token) {
          this.authenticate();
        }
      };

      this.socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          this.onMessage(data);
        } catch (error) {
          console.error('Ошибка при обработке сообщения:', error);
        }
      };

      this.socket.onclose = () => {
        console.log('Соединение с чат-сервером закрыто');
        this.attemptReconnect();
      };

      this.socket.onerror = (error) => {
        console.error('Ошибка WebSocket:', error);
      };
    } catch (error) {
      console.error('Ошибка подключения к WebSocket:', error);
      this.attemptReconnect();
    }
  }

  private authenticate() {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({
        type: 'AUTH',
        payload: { token: this.token }
      }));
    }
  }

  send(data: any) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(data));
    } else {
      console.warn('WebSocket недоступен для отправки сообщения');
    }
  }

  close() {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }

  private attemptReconnect() {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      console.log(`Попытка переподключения... (${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
      
      setTimeout(() => {
        this.connect();
      }, this.reconnectInterval);
    } else {
      console.error('Достигнуто максимальное количество попыток переподключения');
    }
  }
}

export default ChatWebSocket;
'use client';

import { useEffect, useMemo, useState } from 'react';
import { useAuth } from './AuthProvider';
import { apiFetch } from '../utils/api';
import styles from '../styles/notificationPrompt.module.css';

interface NotificationConfigResponse {
  supported: boolean;
  vapidPublicKey: string;
}

function urlBase64ToUint8Array(value: string) {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  const output = new Uint8Array(raw.length);

  for (let index = 0; index < raw.length; index += 1) {
    output[index] = raw.charCodeAt(index);
  }

  return output;
}

export default function NotificationManager() {
  const { isAuthenticated } = useAuth();
  const [supported, setSupported] = useState(false);
  const [permission, setPermission] = useState<'default' | 'denied' | 'granted'>('default');
  const [isDismissed, setIsDismissed] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');

  const canUseNotifications = useMemo(
    () => typeof window !== 'undefined' && 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window,
    [],
  );

  useEffect(() => {
    if (!canUseNotifications) {
      return;
    }

    setPermission(Notification.permission);
  }, [canUseNotifications]);

  useEffect(() => {
    if (!isAuthenticated || !canUseNotifications) {
      return;
    }

    let cancelled = false;

    const setup = async () => {
      try {
        const config = await apiFetch<NotificationConfigResponse>('/api/notifications/config');
        if (cancelled) {
          return;
        }

        setSupported(config.supported && !!config.vapidPublicKey);
        if (!config.supported || !config.vapidPublicKey) {
          return;
        }

        const registration = await navigator.serviceWorker.register('/service-worker.js');

        if (Notification.permission !== 'granted') {
          return;
        }

        const existing = await registration.pushManager.getSubscription();
        const subscription = existing || await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(config.vapidPublicKey),
        });

        await apiFetch('/api/notifications/subscribe', {
          method: 'POST',
          body: JSON.stringify({ subscription: subscription.toJSON() }),
        });
      } catch (nextError) {
        if (!cancelled) {
          setError(nextError instanceof Error ? nextError.message : 'Не удалось настроить уведомления');
        }
      }
    };

    setup();

    return () => {
      cancelled = true;
    };
  }, [canUseNotifications, isAuthenticated]);

  const enableNotifications = async () => {
    if (!canUseNotifications) {
      return;
    }

    setIsSubmitting(true);
    setError('');

    try {
      const config = await apiFetch<NotificationConfigResponse>('/api/notifications/config');
      if (!config.supported || !config.vapidPublicKey) {
        throw new Error('Push-уведомления еще не настроены на сервере');
      }

      const nextPermission = await Notification.requestPermission();
      setPermission(nextPermission);

      if (nextPermission !== 'granted') {
        return;
      }

      const registration = await navigator.serviceWorker.register('/service-worker.js');
      const existing = await registration.pushManager.getSubscription();
      const subscription = existing || await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(config.vapidPublicKey),
      });

      await apiFetch('/api/notifications/subscribe', {
        method: 'POST',
        body: JSON.stringify({ subscription: subscription.toJSON() }),
      });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Не удалось включить уведомления');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!isAuthenticated || !supported || permission === 'granted' || permission === 'denied' || isDismissed) {
    return null;
  }

  return (
    <div className={styles.prompt}>
      <div>
        <strong className={styles.title}>Включите уведомления</strong>
        <p className={styles.text}>Так новые сообщения и звонки будут приходить, даже когда чат свернут. На iPhone push работает после установки сайта на домашний экран.</p>
        {error ? <p className={styles.error}>{error}</p> : null}
      </div>
      <div className={styles.actions}>
        <button type="button" className={styles.mutedButton} onClick={() => setIsDismissed(true)}>Позже</button>
        <button type="button" className={styles.button} onClick={enableNotifications} disabled={isSubmitting}>
          {isSubmitting ? 'Подключаем...' : 'Включить'}
        </button>
      </div>
    </div>
  );
}

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { io, type Socket } from 'socket.io-client';
import { useAuth } from '@/components/AuthProvider';
import VideoCall, { type CallSession } from '@/components/VideoCall';
import { apiFetch, type ChatMessage, type Contact } from '@/utils/api';
import styles from '@/styles/chat.module.css';

function upsertMessage(messages: ChatMessage[], nextMessage: ChatMessage) {
  const existing = messages.find((message) => message.id === nextMessage.id);

  if (!existing) {
    return [...messages, nextMessage].sort(
      (first, second) => new Date(first.createdAt).getTime() - new Date(second.createdAt).getTime(),
    );
  }

  return messages.map((message) => (message.id === nextMessage.id ? nextMessage : message));
}

function patchMessageStatus(messages: ChatMessage[], patch: Partial<ChatMessage> & { id: string }) {
  return messages.map((message) => (message.id === patch.id ? { ...message, ...patch } : message));
}

function getMessagePreview(message?: ChatMessage | null) {
  if (!message) {
    return 'Начните диалог';
  }

  return message.content.length > 36 ? `${message.content.slice(0, 36)}...` : message.content;
}

function getOwnStatusText(message: ChatMessage) {
  if (message.status === 'read') return 'Прочитано';
  if (message.status === 'delivered') return 'Доставлено';
  return 'Отправлено';
}

export default function ChatPage() {
  const router = useRouter();
  const { isAuthenticated, isLoading, token, user } = useAuth();
  const [sidebarItems, setSidebarItems] = useState<Contact[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [activeContactId, setActiveContactId] = useState<string | null>(null);
  const [pageError, setPageError] = useState('');
  const [iceServers, setIceServers] = useState<RTCIceServer[]>([
    { urls: ['stun:stun.l.google.com:19302'] },
    { urls: ['stun:stun1.l.google.com:19302'] },
  ]);
  const [callSession, setCallSession] = useState<CallSession | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const activeContactRef = useRef<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  const loadSidebar = useCallback(async () => {
    if (!token) {
      return;
    }

    const endpoint = searchQuery.trim()
      ? `/api/users/search?q=${encodeURIComponent(searchQuery.trim())}`
      : '/api/dialogs';
    const response = await apiFetch<{ dialogs?: Contact[]; users?: Contact[] }>(endpoint, { token });
    const nextItems = response.dialogs || response.users || [];
    setSidebarItems(nextItems);
    setActiveContactId((prev) => prev ?? nextItems[0]?.id ?? null);
  }, [searchQuery, token]);

  useEffect(() => {
    activeContactRef.current = activeContactId;
  }, [activeContactId]);

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.replace('/');
    }
  }, [isAuthenticated, isLoading, router]);

  useEffect(() => {
    if (!token || !user) {
      return;
    }

    let isMounted = true;

    const bootstrap = async () => {
      try {
        const rtcResponse = await apiFetch<{ iceServers: RTCIceServer[] }>('/api/rtc/config', { token });
        if (!isMounted) {
          return;
        }

        setIceServers(rtcResponse.iceServers);
        await loadSidebar();

        const socket = io({ auth: { token } });
        socketRef.current = socket;

        socket.on('connect_error', () => {
          setPageError('Не удалось подключиться к realtime-серверу');
        });

        socket.on('presence:sync', (presenceList: Array<{ id: string; online: boolean }>) => {
          setSidebarItems((prev) =>
            prev.map((contact) => {
              const presence = presenceList.find((entry) => entry.id === contact.id);
              return presence ? { ...contact, online: presence.online } : contact;
            }),
          );
        });

        socket.on('presence:update', ({ id, online }: { id: string; online: boolean }) => {
          setSidebarItems((prev) => prev.map((contact) => (contact.id === id ? { ...contact, online } : contact)));
        });

        socket.on('message:new', (message: ChatMessage) => {
          const currentContactId = activeContactRef.current;
          const partnerId = message.senderId === user.id ? message.recipientId : message.senderId;

          setSidebarItems((prev) => {
            const existing = prev.find((contact) => contact.id === partnerId);
            if (!existing) {
              return prev;
            }

            const nextContact = {
              ...existing,
              lastMessage: message,
              unreadCount:
                message.senderId !== user.id && partnerId !== currentContactId
                  ? (existing.unreadCount || 0) + 1
                  : 0,
            };

            return [nextContact, ...prev.filter((contact) => contact.id !== partnerId)];
          });

          if (partnerId === currentContactId) {
            setMessages((prev) => upsertMessage(prev, message));

            if (message.senderId !== user.id) {
              socket.emit('conversation:read', { contactId: partnerId });
            }
          }
        });

        socket.on(
          'message:status',
          (patch: { id: string; status: 'sent' | 'delivered' | 'read'; deliveredAt: string | null; readAt: string | null }) => {
            setMessages((prev) => patchMessageStatus(prev, patch));
            setSidebarItems((prev) =>
              prev.map((contact) =>
                contact.lastMessage?.id === patch.id
                  ? { ...contact, lastMessage: { ...contact.lastMessage, ...patch } }
                  : contact,
              ),
            );
          },
        );

        socket.on(
          'call:incoming',
          ({ callId, mode, fromUser }: { callId: string; mode: 'audio' | 'video'; fromUser: Contact }) => {
            setCallSession({
              callId,
              peerUserId: fromUser.id,
              peerName: fromUser.username,
              mode,
              initiator: false,
            });
          },
        );
      } catch (error) {
        setPageError(error instanceof Error ? error.message : 'Не удалось загрузить чат');
      }
    };

    bootstrap();

    return () => {
      isMounted = false;
      socketRef.current?.disconnect();
      socketRef.current = null;
    };
  }, [loadSidebar, token, user]);

  useEffect(() => {
    loadSidebar().catch((error) => {
      setPageError(error instanceof Error ? error.message : 'Не удалось загрузить контакты');
    });
  }, [loadSidebar]);

  useEffect(() => {
    if (!activeContactId || !token) {
      setMessages([]);
      return;
    }

    apiFetch<{ messages: ChatMessage[] }>(`/api/messages?contactId=${activeContactId}`, { token })
      .then((response) => {
        setMessages(response.messages);
        setSidebarItems((prev) =>
          prev.map((contact) => (contact.id === activeContactId ? { ...contact, unreadCount: 0 } : contact)),
        );
        socketRef.current?.emit('conversation:read', { contactId: activeContactId });
      })
      .catch((error) => setPageError(error instanceof Error ? error.message : 'Не удалось загрузить сообщения'));
  }, [activeContactId, token]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const activeContact = useMemo(
    () => sidebarItems.find((contact) => contact.id === activeContactId) ?? null,
    [activeContactId, sidebarItems],
  );

  const sendMessage = (event: React.FormEvent) => {
    event.preventDefault();

    if (!socketRef.current || !activeContact || !inputText.trim()) {
      return;
    }

    const content = inputText.trim();
    socketRef.current.emit(
      'message:send',
      { recipientId: activeContact.id, content },
      (response: { ok: boolean; error?: string; message?: ChatMessage }) => {
        if (!response.ok || !response.message) {
          setPageError(response.error || 'Не удалось отправить сообщение');
          return;
        }

        setMessages((prev) => upsertMessage(prev, response.message!));
        setSidebarItems((prev) => {
          const existing = prev.find((contact) => contact.id === activeContact.id);
          if (!existing) {
            return prev;
          }

          return [
            { ...existing, lastMessage: response.message, unreadCount: 0 },
            ...prev.filter((contact) => contact.id !== activeContact.id),
          ];
        });
        setInputText('');
      },
    );
  };

  const startCall = (mode: 'audio' | 'video') => {
    if (!socketRef.current || !activeContact) {
      return;
    }

    socketRef.current.emit(
      'call:start',
      { toUserId: activeContact.id, mode },
      (response: { ok: boolean; callId?: string; error?: string }) => {
        if (!response.ok || !response.callId) {
          setPageError(response.error || 'Не удалось начать звонок');
          return;
        }

        setCallSession({
          callId: response.callId,
          peerUserId: activeContact.id,
          peerName: activeContact.username,
          mode,
          initiator: true,
        });
      },
    );
  };

  if (isLoading || !user) {
    return null;
  }

  return (
    <>
      <div className={styles.chatPage}>
        <aside className={styles.sidebar}>
          <div className={styles.sidebarHeader}>
            <h1 className={styles.sidebarTitle}>Диалоги</h1>
            <p className={styles.sidebarText}>Ищи пользователей, следи за unread и продолжай разговор с любого устройства.</p>
          </div>

          <input
            type="text"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            className={styles.searchInput}
            placeholder="Поиск по логину или email"
          />

          <div className={styles.contactList}>
            {sidebarItems.map((contact) => (
              <button
                key={contact.id}
                type="button"
                className={`${styles.contact} ${activeContactId === contact.id ? styles.contactActive : ''}`}
                onClick={() => setActiveContactId(contact.id)}
              >
                <span className={contact.online ? styles.avatar : styles.avatarAlt}>
                  {contact.username.slice(0, 2).toUpperCase()}
                </span>
                <span className={styles.contactMeta}>
                  <span className={styles.contactNameRow}>
                    <span className={styles.contactName}>{contact.username}</span>
                    {contact.unreadCount ? <span className={styles.unreadBadge}>{contact.unreadCount}</span> : null}
                  </span>
                  <span className={styles.contactPreview}>{contact.lastMessage ? getMessagePreview(contact.lastMessage) : contact.email}</span>
                </span>
              </button>
            ))}
          </div>
        </aside>

        <section className={styles.panel}>
          {activeContact ? (
            <>
              <div className={styles.panelHeader}>
                <div>
                  <h2 className={styles.panelTitle}>Чат с {activeContact.username}</h2>
                  <p className={styles.panelText}>{activeContact.online ? 'Сейчас в сети' : activeContact.email}</p>
                </div>
                <div className={styles.headerActions}>
                  <button type="button" className={styles.secondaryButton} onClick={() => startCall('audio')}>Аудио</button>
                  <button type="button" className={styles.composerButton} onClick={() => startCall('video')}>Видео</button>
                </div>
              </div>

              <div className={styles.messageArea}>
                <div className={styles.messageStack}>
                  {messages.map((message) => {
                    const ownMessage = message.senderId === user.id;

                    return (
                      <div key={message.id} className={ownMessage ? styles.messageRowOwn : styles.messageRowPeer}>
                        <div className={ownMessage ? styles.messageBubbleOwn : styles.messageBubblePeer}>
                          <p className={styles.messageContent}>{message.content}</p>
                          <div className={ownMessage ? styles.messageMetaOwn : styles.messageMetaPeer}>
                            <p className={ownMessage ? styles.messageTimeOwn : styles.messageTimePeer}>
                              {new Date(message.createdAt).toLocaleTimeString([], {
                                hour: '2-digit',
                                minute: '2-digit',
                              })}
                            </p>
                            {ownMessage ? <p className={styles.messageStatus}>{getOwnStatusText(message)}</p> : null}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  <div ref={messagesEndRef} />
                </div>
              </div>

              <div className={styles.composer}>
                {pageError ? <div className={styles.inlineError}>{pageError}</div> : null}
                <form onSubmit={sendMessage} className={styles.composerForm}>
                  <input
                    type="text"
                    value={inputText}
                    onChange={(event) => setInputText(event.target.value)}
                    placeholder="Введите сообщение..."
                    className={styles.composerInput}
                  />
                  <button type="submit" className={styles.composerButton}>Отправить</button>
                </form>
              </div>
            </>
          ) : (
            <div className={styles.empty}>
              <div className={styles.emptyCard}>
                <div className={styles.emptyIcon}>*</div>
                <h3 className={styles.emptyTitle}>Пока нет диалогов</h3>
                <p className={styles.emptyText}>Зарегистрируйте второго пользователя на этом сервере или найдите его через поиск.</p>
              </div>
            </div>
          )}
        </section>
      </div>

      {callSession && socketRef.current ? (
        <VideoCall
          socket={socketRef.current}
          call={callSession}
          iceServers={iceServers}
          onClose={() => setCallSession(null)}
        />
      ) : null}
    </>
  );
}

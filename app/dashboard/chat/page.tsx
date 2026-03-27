'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { io, type Socket } from 'socket.io-client';
import { useAuth } from '../../../components/AuthProvider';
import VideoCall, { type CallSession } from '../../../components/VideoCall';
import { apiFetch, type ChatMessage, type Contact } from '../../../utils/api';
import styles from '../../../styles/chat.module.css';

const MOBILE_BREAKPOINT = 960;
const READ_VISIBILITY_THRESHOLD = 0.8;

function upsertMessage(messages: ChatMessage[], nextMessage: ChatMessage) {
  const existing = messages.find((message) => message.id === nextMessage.id);
  if (!existing) {
    return [...messages, nextMessage].sort(
      (first, second) => new Date(first.createdAt).getTime() - new Date(second.createdAt).getTime(),
    );
  }

  return messages.map((message) => (message.id === nextMessage.id ? nextMessage : message));
}

function getMessagePreview(message?: ChatMessage | null) {
  if (!message) {
    return 'Начните диалог';
  }

  return message.content.length > 42 ? `${message.content.slice(0, 42)}...` : message.content;
}

function getOwnStatusText(message: ChatMessage) {
  if (message.status === 'read') return 'Прочитано';
  if (message.status === 'delivered') return 'Доставлено';
  return 'Отправлено';
}

function getPresenceText(contact: Contact | null) {
  if (!contact) {
    return '';
  }

  if (contact.online) {
    return contact.bio ? `В сети - ${contact.bio}` : 'В сети сейчас';
  }

  if (contact.lastSeenAt) {
    return `Был(а) в сети ${new Date(contact.lastSeenAt).toLocaleString([], {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })}`;
  }

  return contact.bio || contact.email;
}

function getAvatarLabel(contact: Contact) {
  return (contact.displayName || contact.username).slice(0, 2).toUpperCase();
}

export default function ChatPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { isAuthenticated, isLoading, token, user } = useAuth();
  const [sidebarItems, setSidebarItems] = useState<Contact[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [activeContactId, setActiveContactId] = useState<string | null>(null);
  const [pageError, setPageError] = useState('');
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');
  const [actionMessageId, setActionMessageId] = useState<string | null>(null);
  const [isMobileLayout, setIsMobileLayout] = useState(false);
  const [showMobileChat, setShowMobileChat] = useState(false);
  const [iceServers, setIceServers] = useState<RTCIceServer[]>([
    { urls: ['stun:stun.l.google.com:19302'] },
    { urls: ['stun:stun1.l.google.com:19302'] },
  ]);
  const [callSession, setCallSession] = useState<CallSession | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const activeContactRef = useRef<string | null>(null);
  const messageAreaRef = useRef<HTMLDivElement | null>(null);
  const messageNodeMapRef = useRef(new Map<string, HTMLDivElement>());
  const pendingReadIdsRef = useRef(new Set<string>());
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestedContactId = searchParams?.get('contactId') || null;
  const currentUserId = user?.id || null;

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
    setActiveContactId((prev) => {
      if (prev && nextItems.some((item) => item.id === prev)) {
        return prev;
      }

      if (requestedContactId && nextItems.some((item) => item.id === requestedContactId)) {
        return requestedContactId;
      }

      return null;
    });
  }, [requestedContactId, searchQuery, token]);

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

    let alive = true;
    const syncVisibility = () => {
      socketRef.current?.emit('client:visibility', { visible: document.visibilityState === 'visible' });
    };

    const bootstrap = async () => {
      try {
        const rtcResponse = await apiFetch<{ iceServers: RTCIceServer[] }>('/api/rtc/config', { token });
        if (!alive) {
          return;
        }

        setIceServers(rtcResponse.iceServers);

        const socket = io({ auth: { token } });
        socketRef.current = socket;

        socket.on('connect', syncVisibility);
        document.addEventListener('visibilitychange', syncVisibility);
        window.addEventListener('focus', syncVisibility);
        window.addEventListener('blur', syncVisibility);

        socket.on('connect_error', () => {
          setPageError('Не удалось подключиться к realtime-серверу');
        });

        socket.on('presence:sync', (presenceList: Array<{ id: string; online: boolean; lastSeenAt: string | null }>) => {
          setSidebarItems((prev) =>
            prev.map((contact) => {
              const presence = presenceList.find((entry) => entry.id === contact.id);
              return presence ? { ...contact, online: presence.online, lastSeenAt: presence.lastSeenAt } : contact;
            }),
          );
        });

        socket.on('presence:update', ({ id, online, lastSeenAt }: { id: string; online: boolean; lastSeenAt: string | null }) => {
          setSidebarItems((prev) =>
            prev.map((contact) => (contact.id === id ? { ...contact, online, lastSeenAt } : contact)),
          );
        });

        socket.on('message:new', (message: ChatMessage) => {
          const currentContactId = activeContactRef.current;
          const partnerId = message.senderId === currentUserId ? message.recipientId : message.senderId;

          if (message.recipientId === currentUserId) {
            socket.emit('message:delivered', { messageIds: [message.id] });
          }

          setSidebarItems((prev) => {
            const existing = prev.find((contact) => contact.id === partnerId);
            if (!existing) {
              return prev;
            }

             const nextContact = {
               ...existing,
               lastMessage: message,
                unreadCount: message.senderId !== currentUserId ? (existing.unreadCount || 0) + 1 : 0,
              };

            return [nextContact, ...prev.filter((contact) => contact.id !== partnerId)];
          });

          if (partnerId === currentContactId) {
            setMessages((prev) => upsertMessage(prev, message));
          }
        });

        socket.on('message:status', (patch: Partial<ChatMessage> & { id: string }) => {
          setMessages((prev) => prev.map((message) => (message.id === patch.id ? { ...message, ...patch } : message)));
          setSidebarItems((prev) =>
            prev.map((contact) =>
              contact.id === patch.senderId && patch.recipientId === currentUserId && patch.status === 'read'
                ? {
                    ...contact,
                    unreadCount: Math.max(0, (contact.unreadCount || 0) - 1),
                    lastMessage: contact.lastMessage?.id === patch.id ? { ...contact.lastMessage, ...patch } : contact.lastMessage,
                  }
                : contact.lastMessage?.id === patch.id
                  ? { ...contact, lastMessage: { ...contact.lastMessage, ...patch } }
                  : contact,
            ),
          );
        });

        socket.on('message:update', (message: ChatMessage) => {
          setMessages((prev) => upsertMessage(prev, message));
          setSidebarItems((prev) =>
            prev.map((contact) =>
              contact.lastMessage?.id === message.id ? { ...contact, lastMessage: message } : contact,
            ),
          );
        });

        socket.on('call:incoming', ({ callId, mode, fromUser }: { callId: string; mode: 'audio' | 'video'; fromUser: Contact }) => {
          setCallSession({
            callId,
            peerUserId: fromUser.id,
            peerName: fromUser.displayName || fromUser.username,
            mode,
            initiator: false,
          });
        });
      } catch (error) {
        setPageError(error instanceof Error ? error.message : 'Не удалось загрузить чат');
      }
    };

    bootstrap();

    return () => {
      alive = false;
      document.removeEventListener('visibilitychange', syncVisibility);
      window.removeEventListener('focus', syncVisibility);
      window.removeEventListener('blur', syncVisibility);
      socketRef.current?.disconnect();
      socketRef.current = null;
    };
  }, [currentUserId, router, token, user]);

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

        const undeliveredIncomingIds = response.messages
          .filter((message) => message.senderId === activeContactId && message.recipientId === currentUserId && !message.deliveredAt)
          .map((message) => message.id);

        if (undeliveredIncomingIds.length > 0) {
          socketRef.current?.emit('message:delivered', { messageIds: undeliveredIncomingIds });
        }
      })
      .catch((error) => setPageError(error instanceof Error ? error.message : 'Не удалось загрузить сообщения'));
  }, [activeContactId, currentUserId, token]);

  useEffect(() => {
    if (!requestedContactId || !sidebarItems.some((contact) => contact.id === requestedContactId)) {
      return;
    }

    setActiveContactId(requestedContactId);
    if (isMobileLayout) {
      setShowMobileChat(true);
    }
  }, [isMobileLayout, requestedContactId, sidebarItems]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const registerMessageNode = useCallback((messageId: string, node: HTMLDivElement | null) => {
    if (node) {
      messageNodeMapRef.current.set(messageId, node);
      return;
    }

    messageNodeMapRef.current.delete(messageId);
    pendingReadIdsRef.current.delete(messageId);
  }, []);

  useEffect(() => {
    if (!socketRef.current || !activeContactId || document.visibilityState !== 'visible') {
      return;
    }

    if (isMobileLayout && !showMobileChat) {
      return;
    }

    const unreadIncoming = messages.filter(
      (message) => message.senderId === activeContactId && message.recipientId === currentUserId && !message.readAt,
    );

    if (unreadIncoming.length === 0) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const visibleIds = entries
          .filter((entry) => entry.isIntersecting && entry.intersectionRatio >= READ_VISIBILITY_THRESHOLD)
          .map((entry) => entry.target.getAttribute('data-message-id'))
          .filter((value): value is string => Boolean(value))
          .filter((messageId) => !pendingReadIdsRef.current.has(messageId));

        if (visibleIds.length === 0) {
          return;
        }

        visibleIds.forEach((messageId) => pendingReadIdsRef.current.add(messageId));
        socketRef.current?.emit(
          'conversation:read',
          { contactId: activeContactId, messageIds: visibleIds },
          (response: { ok: boolean; messageIds?: string[] }) => {
            const acknowledgedIds = response?.messageIds || [];

            acknowledgedIds.forEach((messageId) => pendingReadIdsRef.current.delete(messageId));

            if (!response?.ok || acknowledgedIds.length === 0) {
              visibleIds.forEach((messageId) => pendingReadIdsRef.current.delete(messageId));
              return;
            }

            setMessages((prev) =>
              prev.map((message) =>
                acknowledgedIds.includes(message.id)
                  ? {
                      ...message,
                      status: 'read',
                      deliveredAt: message.deliveredAt || new Date().toISOString(),
                      readAt: message.readAt || new Date().toISOString(),
                    }
                  : message,
              ),
            );

            setSidebarItems((prev) =>
              prev.map((contact) =>
                contact.id === activeContactId
                  ? { ...contact, unreadCount: Math.max(0, (contact.unreadCount || 0) - acknowledgedIds.length) }
                  : contact,
              ),
            );
          },
        );
      },
      {
        root: messageAreaRef.current,
        threshold: [READ_VISIBILITY_THRESHOLD],
      },
    );

    unreadIncoming.forEach((message) => {
      const node = messageNodeMapRef.current.get(message.id);
      if (node) {
        observer.observe(node);
      }
    });

    return () => observer.disconnect();
  }, [activeContactId, currentUserId, isMobileLayout, messages, showMobileChat]);

  useEffect(() => {
    const syncViewport = () => {
      const nextIsMobile = window.innerWidth <= MOBILE_BREAKPOINT;
      setIsMobileLayout(nextIsMobile);

      if (!nextIsMobile) {
        setShowMobileChat(false);
      }
    };

    syncViewport();
    window.addEventListener('resize', syncViewport);
    return () => window.removeEventListener('resize', syncViewport);
  }, []);

  useEffect(() => {
    const handleClose = () => setActionMessageId(null);
    window.addEventListener('click', handleClose);
    return () => window.removeEventListener('click', handleClose);
  }, []);

  const activeContact = useMemo(
    () => sidebarItems.find((contact) => contact.id === activeContactId) ?? null,
    [activeContactId, sidebarItems],
  );

  const handleSelectContact = (contactId: string) => {
    setActiveContactId(contactId);
    if (isMobileLayout) {
      setShowMobileChat(true);
    }
  };

  const submitMessage = (event: React.FormEvent) => {
    event.preventDefault();
    if (!socketRef.current || !activeContact || !inputText.trim()) {
      return;
    }

    const content = inputText.trim();
    socketRef.current.emit('message:send', { recipientId: activeContact.id, content }, (response: { ok: boolean; error?: string; message?: ChatMessage }) => {
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

        return [{ ...existing, lastMessage: response.message, unreadCount: 0 }, ...prev.filter((contact) => contact.id !== activeContact.id)];
      });
      setInputText('');
    });
  };

  const submitEdit = (messageId: string) => {
    if (!socketRef.current || !editingText.trim()) {
      return;
    }

    socketRef.current.emit('message:edit', { messageId, content: editingText }, (response: { ok: boolean; error?: string; message?: ChatMessage }) => {
      if (!response.ok || !response.message) {
        setPageError(response.error || 'Не удалось изменить сообщение');
        return;
      }

      setMessages((prev) => upsertMessage(prev, response.message!));
      setEditingMessageId(null);
      setEditingText('');
    });
  };

  const deleteMessage = (messageId: string) => {
    if (!socketRef.current) {
      return;
    }

    socketRef.current.emit('message:delete', { messageId }, (response: { ok: boolean; error?: string; message?: ChatMessage }) => {
      if (!response.ok || !response.message) {
        setPageError(response.error || 'Не удалось удалить сообщение');
        return;
      }

      setMessages((prev) => upsertMessage(prev, response.message!));
      setSidebarItems((prev) => prev.map((contact) => (contact.lastMessage?.id === messageId ? { ...contact, lastMessage: response.message } : contact)));
      setActionMessageId(null);
    });
  };

  const openMessageActions = (messageId: string) => {
    setActionMessageId(messageId);
  };

  const startLongPress = (messageId: string) => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
    }

    longPressTimerRef.current = setTimeout(() => {
      setActionMessageId(messageId);
    }, 450);
  };

  const stopLongPress = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  const startCall = (mode: 'audio' | 'video') => {
    if (!socketRef.current || !activeContact) {
      return;
    }

    socketRef.current.emit('call:start', { toUserId: activeContact.id, mode }, (response: { ok: boolean; callId?: string; error?: string }) => {
      if (!response.ok || !response.callId) {
        setPageError(response.error || 'Не удалось начать звонок');
        return;
      }

      setCallSession({
        callId: response.callId,
        peerUserId: activeContact.id,
        peerName: activeContact.displayName || activeContact.username,
        mode,
        initiator: true,
      });
    });
  };

  if (isLoading || !user) {
    return null;
  }

  return (
    <>
      <div className={styles.chatPage}>
        <aside className={`${styles.sidebar} ${showMobileChat ? styles.sidebarHiddenMobile : ''}`}>
          <div className={styles.sidebarHeader}>
            <h1 className={styles.sidebarTitle}>Диалоги</h1>
            <p className={styles.sidebarText}>Список чатов теперь закреплен отдельно и не исчезает при длинной переписке.</p>
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
              <button key={contact.id} type="button" className={`${styles.contact} ${activeContactId === contact.id ? styles.contactActive : ''}`} onClick={() => handleSelectContact(contact.id)}>
                <span className={`${styles.avatar} ${styles[`avatar_${contact.avatarColor || 'ocean'}`]}`}>
                  {contact.avatarUrl ? <img src={contact.avatarUrl} alt={contact.displayName || contact.username} className={styles.avatarImage} /> : getAvatarLabel(contact)}
                </span>
                <span className={styles.contactMeta}>
                  <span className={styles.contactNameRow}>
                    <span className={styles.contactName}>{contact.displayName || contact.username}</span>
                    {contact.unreadCount ? <span className={styles.unreadBadge}>{contact.unreadCount}</span> : null}
                  </span>
                  <span className={styles.contactPreview}>{contact.lastMessage ? getMessagePreview(contact.lastMessage) : (contact.bio || contact.email)}</span>
                </span>
              </button>
            ))}
          </div>
        </aside>

        <section className={`${styles.panel} ${showMobileChat ? styles.panelVisibleMobile : styles.panelHiddenMobile}`}>
          {activeContact ? (
            <>
              <div className={styles.panelHeader}>
                <div className={styles.panelIdentity}>
                  {isMobileLayout ? (
                    <button type="button" className={styles.backButton} onClick={() => setShowMobileChat(false)}>
                      ←
                    </button>
                  ) : null}
                  <span className={`${styles.headerAvatar} ${styles[`avatar_${activeContact.avatarColor || 'ocean'}`]}`}>
                    {activeContact.avatarUrl ? <img src={activeContact.avatarUrl} alt={activeContact.displayName || activeContact.username} className={styles.avatarImage} /> : getAvatarLabel(activeContact)}
                  </span>
                  <div>
                    <h2 className={styles.panelTitle}>Чат с {activeContact.displayName || activeContact.username}</h2>
                    <p className={styles.panelText}>{getPresenceText(activeContact)}</p>
                  </div>
                </div>
                <div className={styles.headerActions}>
                  <button type="button" className={styles.secondaryButton} onClick={() => startCall('audio')}>Аудио</button>
                  <button type="button" className={styles.composerButton} onClick={() => startCall('video')}>Видео</button>
                </div>
              </div>

              <div ref={messageAreaRef} className={styles.messageArea}>
                <div className={styles.messageStack}>
                  {messages.map((message) => {
                    const ownMessage = message.senderId === user.id;
                    const isEditing = editingMessageId === message.id;

                    return (
                      <div key={message.id} className={ownMessage ? styles.messageRowOwn : styles.messageRowPeer}>
                        <div
                          ref={ownMessage ? undefined : (node) => registerMessageNode(message.id, node)}
                          data-message-id={message.id}
                          className={ownMessage ? styles.messageBubbleOwn : styles.messageBubblePeer}
                          onContextMenu={(event) => {
                            if (!ownMessage || message.deletedAt) {
                              return;
                            }

                            event.preventDefault();
                            event.stopPropagation();
                            openMessageActions(message.id);
                          }}
                          onTouchStart={() => {
                            if (!ownMessage || message.deletedAt) {
                              return;
                            }

                            startLongPress(message.id);
                          }}
                          onTouchEnd={stopLongPress}
                          onTouchMove={stopLongPress}
                        >
                          {isEditing ? (
                            <div className={styles.editBox}>
                              <textarea value={editingText} onChange={(event) => setEditingText(event.target.value)} className={styles.editInput} rows={3} />
                              <div className={styles.editActions}>
                                <button type="button" className={styles.smallButton} onClick={() => submitEdit(message.id)}>Сохранить</button>
                                <button type="button" className={styles.smallMutedButton} onClick={() => { setEditingMessageId(null); setEditingText(''); }}>Отмена</button>
                              </div>
                            </div>
                          ) : (
                            <>
                              <p className={`${styles.messageContent} ${message.deletedAt ? styles.messageDeleted : ''}`}>{message.content}</p>
                              <div className={ownMessage ? styles.messageMetaOwn : styles.messageMetaPeer}>
                                <p className={ownMessage ? styles.messageTimeOwn : styles.messageTimePeer}>
                                  {new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                </p>
                                {message.updatedAt && !message.deletedAt ? <p className={ownMessage ? styles.messageEditedOwn : styles.messageEditedPeer}>изменено</p> : null}
                                {ownMessage ? <p className={styles.messageStatus}>{getOwnStatusText(message)}</p> : null}
                              </div>
                              {ownMessage && !message.deletedAt && actionMessageId === message.id ? (
                                <div className={styles.messageTools} onClick={(event) => event.stopPropagation()}>
                                  <button type="button" className={styles.messageTool} onClick={() => { setEditingMessageId(message.id); setEditingText(message.content); setActionMessageId(null); }}>Изменить</button>
                                  <button type="button" className={styles.messageToolDanger} onClick={() => deleteMessage(message.id)}>Удалить</button>
                                </div>
                              ) : null}
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
                  <div ref={messagesEndRef} />
                </div>
              </div>

              <div className={styles.composer}>
                {pageError ? <div className={styles.inlineError}>{pageError}</div> : null}
                <form onSubmit={submitMessage} className={styles.composerForm}>
                  <input type="text" value={inputText} onChange={(event) => setInputText(event.target.value)} placeholder="Введите сообщение..." className={styles.composerInput} />
                  <button type="submit" className={styles.composerButton}>Отправить</button>
                </form>
              </div>
            </>
          ) : (
            <div className={styles.empty}>
              <div className={styles.emptyCard}>
                <div className={styles.emptyIcon}>*</div>
                <h3 className={styles.emptyTitle}>Пока нет диалогов</h3>
                <p className={styles.emptyText}>Найдите пользователя через поиск или дождитесь нового сообщения.</p>
              </div>
            </div>
          )}
        </section>
      </div>

      {callSession && socketRef.current ? <VideoCall socket={socketRef.current} call={callSession} iceServers={iceServers} onClose={() => setCallSession(null)} /> : null}
    </>
  );
}

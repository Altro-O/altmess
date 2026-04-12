'use client';

import { useCallback, useEffect, useRef, useState, useDeferredValue, useMemo } from 'react';
import type { Socket } from 'socket.io-client';
import { type ChatMessage, type Contact, type MessagesPage, apiFetch } from '../utils/api';

const READ_VISIBILITY_THRESHOLD = 0.8;
const MESSAGES_PAGE_SIZE = 40;

function isGroupContact(contactId?: string | null) {
  return String(contactId || '').startsWith('group:');
}

function upsertMessage(messages: ChatMessage[], nextMessage: ChatMessage) {
  const existing = messages.find((message) => message.id === nextMessage.id);
  if (!existing) {
    return [...messages, nextMessage].sort(
      (first, second) => new Date(first.createdAt).getTime() - new Date(second.createdAt).getTime(),
    );
  }

  return messages.map((message) => (message.id === nextMessage.id ? nextMessage : message));
}

function sortPinnedMessages(items: ChatMessage[]) {
  return [...items].sort((first, second) => String(second.pinnedAt || '').localeCompare(String(first.pinnedAt || '')));
}

function getMessageTargetId(message: ChatMessage, currentUserId?: string | null) {
  return message.groupId ? `group:${message.groupId}` : (message.senderId === currentUserId ? message.recipientId : message.senderId);
}

function getMessageSearchValue(message: ChatMessage) {
  if (message.kind === 'file') {
    return [message.content, message.attachment?.fileName || '', message.attachment?.mimeType || ''].join(' ').toLowerCase();
  }

  return [message.content, message.replyTo?.content || '', message.replyTo?.quote || ''].join(' ').toLowerCase();
}

export interface UseMessagesParams {
  socketRef: React.RefObject<Socket | null>;
  token: string | null;
  currentUserId: string | null;
  activeContactId: string | null;
  pinnedChatIds: string[];
  setPageError: (error: string) => void;
  setSidebarItems: React.Dispatch<React.SetStateAction<Contact[]>>;
}

export function useMessages({
  socketRef,
  token,
  currentUserId,
  activeContactId,
  pinnedChatIds,
  setPageError,
  setSidebarItems,
}: UseMessagesParams) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pinnedMessages, setPinnedMessages] = useState<ChatMessage[]>([]);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [nextMessagesCursor, setNextMessagesCursor] = useState<string | null>(null);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const [isLoadingOlderMessages, setIsLoadingOlderMessages] = useState(false);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');
  const [messageSearchQuery, setMessageSearchQuery] = useState('');
  const [showMessageSearch, setShowMessageSearch] = useState(false);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const [jumpTargetMessageId, setJumpTargetMessageId] = useState<string | null>(null);
  const [actionMessageId, setActionMessageId] = useState<string | null>(null);

  const messagesOwnerContactRef = useRef<string | null>(null);
  const messagesCacheRef = useRef(new Map<string, { messages: ChatMessage[]; pinnedMessages: ChatMessage[]; hasMore: boolean; nextCursor: string | null }>());
  const messageAreaRef = useRef<HTMLDivElement | null>(null);
  const messageNodeMapRef = useRef(new Map<string, HTMLDivElement>());
  const pendingReadIdsRef = useRef(new Set<string>());
  const activeMessagesRequestRef = useRef(0);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activeContactIdRef = useRef(activeContactId);
  activeContactIdRef.current = activeContactId;

  useEffect(() => {
    activeContactIdRef.current = activeContactId;
  }, [activeContactId]);

  useEffect(() => {
    if (!activeContactId || messagesOwnerContactRef.current !== activeContactId) {
      return;
    }

    messagesCacheRef.current.set(activeContactId, {
      messages,
      pinnedMessages,
      hasMore: hasMoreMessages,
      nextCursor: nextMessagesCursor,
    });
  }, [activeContactId, hasMoreMessages, messages, nextMessagesCursor, pinnedMessages]);

  const loadMessagesPage = useCallback(async (contactId: string, options?: { beforeMessageId?: string; appendOlder?: boolean; requestId?: number }) => {
    if (!token) {
      return;
    }

    const params = new URLSearchParams({
      contactId,
      limit: String(MESSAGES_PAGE_SIZE),
    });

    if (options?.beforeMessageId) {
      params.set('beforeMessageId', options.beforeMessageId);
    }

    const response = await apiFetch<MessagesPage>(`/api/messages?${params.toString()}`);

    if (!options?.appendOlder && options?.requestId && options.requestId !== activeMessagesRequestRef.current) {
      return;
    }

    if (options?.appendOlder) {
      messagesOwnerContactRef.current = contactId;
      setMessages((prev) => [...response.messages, ...prev.filter((message) => !response.messages.some((older) => older.id === message.id))]);
    } else {
      messagesOwnerContactRef.current = contactId;
      setMessages(response.messages);
      setSidebarItems((prev) =>
        prev.map((contact) =>
          contact.id === contactId && !isGroupContact(contactId)
            ? { ...contact, unreadCount: 0 }
            : contact,
        ),
      );
    }

    setPinnedMessages(sortPinnedMessages(response.pinnedMessages || []));
    setHasMoreMessages(response.hasMore);
    setNextMessagesCursor(response.nextCursor);

    if (!options?.appendOlder && !isGroupContact(contactId)) {
      const undeliveredIncomingIds = response.messages
        .filter((message) => message.senderId === contactId && message.recipientId === currentUserId && !message.deliveredAt)
        .map((message) => message.id);

      if (undeliveredIncomingIds.length > 0) {
        socketRef.current?.emit('message:delivered', { messageIds: undeliveredIncomingIds });
      }
    }
  }, [currentUserId, socketRef, token, setSidebarItems]);

  useEffect(() => {
    if (!activeContactId || !token) {
      messagesOwnerContactRef.current = null;
      setMessages([]);
      setPinnedMessages([]);
      setHasMoreMessages(false);
      setNextMessagesCursor(null);
      return;
    }

    const cachedPage = messagesCacheRef.current.get(activeContactId);

    if (cachedPage) {
      messagesOwnerContactRef.current = activeContactId;
      setMessages(cachedPage.messages);
      setPinnedMessages(cachedPage.pinnedMessages);
      setHasMoreMessages(cachedPage.hasMore);
      setNextMessagesCursor(cachedPage.nextCursor);
    } else {
      messagesOwnerContactRef.current = activeContactId;
      setMessages([]);
      setPinnedMessages([]);
      setHasMoreMessages(false);
      setNextMessagesCursor(null);
    }

    pendingReadIdsRef.current.clear();
    setIsLoadingMessages(true);
    setSidebarItems((prev) =>
      prev.map((contact) =>
        contact.id === activeContactId && !isGroupContact(activeContactId)
          ? { ...contact, unreadCount: 0 }
          : contact,
      ),
    );

    const requestId = activeMessagesRequestRef.current + 1;
    activeMessagesRequestRef.current = requestId;

    loadMessagesPage(activeContactId, { requestId })
      .catch((error) => setPageError(error instanceof Error ? error.message : 'Не удалось загрузить сообщения'))
      .finally(() => {
        if (activeMessagesRequestRef.current === requestId) {
          setIsLoadingMessages(false);
        }
      });
  }, [activeContactId, loadMessagesPage, token, setSidebarItems]);

  const registerMessageNode = useCallback((messageId: string, node: HTMLDivElement | null) => {
    if (node) {
      messageNodeMapRef.current.set(messageId, node);
      return;
    }

    messageNodeMapRef.current.delete(messageId);
    pendingReadIdsRef.current.delete(messageId);
  }, []);

  useEffect(() => {
    if (!socketRef.current || !activeContactId || document.visibilityState !== 'visible' || isGroupContact(activeContactId)) {
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
  }, [activeContactId, currentUserId, messages, setSidebarItems, socketRef]);

  const loadOlderMessages = useCallback(async () => {
    if (!activeContactId || !nextMessagesCursor || isLoadingOlderMessages) {
      return;
    }

    const area = messageAreaRef.current;
    const previousScrollHeight = area?.scrollHeight || 0;
    setIsLoadingOlderMessages(true);

    try {
      await loadMessagesPage(activeContactId, { beforeMessageId: nextMessagesCursor, appendOlder: true });
      requestAnimationFrame(() => {
        if (!area) {
          return;
        }

        const nextScrollHeight = area.scrollHeight;
        area.scrollTop += nextScrollHeight - previousScrollHeight;
      });
    } catch (error) {
      setPageError(error instanceof Error ? error.message : 'Не удалось загрузить старые сообщения');
    } finally {
      setIsLoadingOlderMessages(false);
    }
  }, [activeContactId, isLoadingOlderMessages, loadMessagesPage, nextMessagesCursor]);

  const jumpToMessage = (messageId: string) => {
    setJumpTargetMessageId(messageId);
    setHighlightedMessageId(messageId);
    if (highlightTimerRef.current) {
      clearTimeout(highlightTimerRef.current);
    }

    highlightTimerRef.current = setTimeout(() => {
      setHighlightedMessageId(null);
      highlightTimerRef.current = null;
    }, 1800);
  };

  const toggleReaction = (messageId: string, emoji: string) => {
    if (!socketRef.current) {
      return;
    }

    socketRef.current.emit('message:react', { messageId, emoji }, (response: { ok: boolean; error?: string; message?: ChatMessage }) => {
      if (!response.ok || !response.message) {
        setPageError(response.error || 'Не удалось обновить реакцию');
        return;
      }

      setMessages((prev) => upsertMessage(prev, response.message!));
    });
  };

  const togglePinnedMessage = (message: ChatMessage) => {
    if (!socketRef.current) {
      return;
    }

    socketRef.current.emit('message:pin', { messageId: message.id, pinned: !message.pinnedAt }, (response: { ok: boolean; error?: string; message?: ChatMessage }) => {
      if (!response.ok || !response.message) {
        setPageError(response.error || 'Не удалось обновить закреп');
        return;
      }

      setMessages((prev) => upsertMessage(prev, response.message!));
      setPinnedMessages((prev) => {
        const withoutCurrent = prev.filter((entry) => entry.id !== response.message!.id);
        if (!response.message!.pinnedAt || response.message!.deletedAt) {
          return withoutCurrent;
        }

        return sortPinnedMessages([...withoutCurrent, response.message!]);
      });
      setActionMessageId(null);
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

  const handleIncomingMessage = useCallback((message: ChatMessage) => {
    const partnerId = getMessageTargetId(message, currentUserId);

    if (!message.groupId && message.recipientId === currentUserId) {
      socketRef.current?.emit('message:delivered', { messageIds: [message.id] });
    }

    setSidebarItems((prev) => {
      const existing = prev.find((contact) => contact.id === partnerId);
      if (!existing) {
        return prev;
      }

      return [
        {
          ...existing,
          lastMessage: message,
          unreadCount: message.groupId ? (existing.unreadCount || 0) : (message.senderId !== currentUserId ? (existing.unreadCount || 0) + 1 : 0),
        },
        ...prev.filter((contact) => contact.id !== partnerId),
      ];
    });

    if (partnerId === activeContactIdRef.current) {
      setMessages((prev) => upsertMessage(prev, message));
    }
  }, [currentUserId, setSidebarItems, socketRef]);

  const handleMessageStatus = useCallback((patch: Partial<ChatMessage> & { id: string }) => {
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
  }, [currentUserId, setSidebarItems]);

  const handleMessageUpdate = useCallback((message: ChatMessage) => {
    setMessages((prev) => upsertMessage(prev, message));
    setPinnedMessages((prev) => {
      const withoutCurrent = prev.filter((entry) => entry.id !== message.id);
      if (!message.pinnedAt || message.deletedAt) {
        return withoutCurrent;
      }

      return sortPinnedMessages([...withoutCurrent, message]);
    });
    setSidebarItems((prev) => prev.map((contact) => (contact.lastMessage?.id === message.id ? { ...contact, lastMessage: message } : contact)));
  }, [setSidebarItems]);

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

  const deferredMessageSearchQuery = useDeferredValue(messageSearchQuery);

  const visibleMessages = useMemo(() => {
    const query = deferredMessageSearchQuery.trim().toLowerCase();
    if (!query) {
      return messages;
    }

    return messages.filter((message) => getMessageSearchValue(message).includes(query));
  }, [deferredMessageSearchQuery, messages]);

  const galleryImages = useMemo(
    () => messages.filter((message) => message.kind === 'file' && message.attachment?.mimeType?.startsWith('image/') && !message.attachment?.isSticker && !(message.attachment && message.attachment.storageStatus && message.attachment.storageStatus !== 'ready') && !message.deletedAt),
    [messages],
  );

  useEffect(() => {
    const handleClose = () => setActionMessageId(null);
    window.addEventListener('click', handleClose);
    return () => window.removeEventListener('click', handleClose);
  }, []);

  useEffect(() => () => {
    if (highlightTimerRef.current) {
      clearTimeout(highlightTimerRef.current);
    }
  }, []);

  return {
    messages,
    setMessages,
    pinnedMessages,
    setPinnedMessages,
    hasMoreMessages,
    nextMessagesCursor,
    isLoadingMessages,
    isLoadingOlderMessages,
    editingMessageId,
    setEditingMessageId,
    editingText,
    setEditingText,
    messageSearchQuery,
    setMessageSearchQuery,
    showMessageSearch,
    setShowMessageSearch,
    highlightedMessageId,
    jumpTargetMessageId,
    setJumpTargetMessageId,
    actionMessageId,
    setActionMessageId,
    messageAreaRef,
    messagesEndRef,
    registerMessageNode,
    loadOlderMessages,
    jumpToMessage,
    toggleReaction,
    togglePinnedMessage,
    submitEdit,
    deleteMessage,
    openMessageActions,
    startLongPress,
    stopLongPress,
    visibleMessages,
    galleryImages,
    handleIncomingMessage,
    handleMessageStatus,
    handleMessageUpdate,
    loadMessagesPage,
  };
}

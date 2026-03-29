'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { io, type Socket } from 'socket.io-client';
import { useAuth } from '../../../components/AuthProvider';
import UserAvatar from '../../../components/UserAvatar';
import VideoCall, { type CallSession } from '../../../components/VideoCall';
import { apiFetch, type ChatMessage, type Contact } from '../../../utils/api';
import styles from '../../../styles/chat.module.css';

const MOBILE_BREAKPOINT = 960;
const READ_VISIBILITY_THRESHOLD = 0.8;
const EMOJI_OPTIONS = ['❤️', '👍', '😂', '🔥', '😍', '😮', '😢', '🙏', '👏', '🎉', '🤝', '💯', '😎', '🤔', '👀', '👌'];
const MAX_IMAGE_DIMENSION = 1600;
const MAX_FILE_BYTES = 12 * 1024 * 1024;
const STICKER_PACKS = [
  {
    key: 'meownicorn',
    title: 'Meownicorn',
    items: Array.from({ length: 42 }, (_, index) => `/stickers/meownicorn/${String(index + 1).padStart(3, '0')}.webp`),
  },
  {
    key: 'flork',
    title: 'Flork',
    items: Array.from({ length: 64 }, (_, index) => `/stickers/flork/${String(index + 1).padStart(3, '0')}.webp`),
  },
] as const;

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

  if (message.kind === 'call') {
    return message.content;
  }

  if (message.kind === 'voice') {
    return 'Голосовое сообщение';
  }

  if (message.kind === 'file') {
    if (message.attachment?.isSticker) {
      return 'Стикер';
    }

    return message.attachment?.mimeType?.startsWith('image/') ? 'Фото' : `Файл: ${message.attachment?.fileName || message.content}`;
  }

  return message.content.length > 42 ? `${message.content.slice(0, 42)}...` : message.content;
}

function getReplySnippet(message?: ChatMessage['replyTo'] | null) {
  if (!message) {
    return '';
  }

  if (message.quote?.trim()) {
    return message.quote.length > 84 ? `${message.quote.slice(0, 84)}...` : message.quote;
  }

  if (message.kind === 'voice') {
    return 'Голосовое сообщение';
  }

  return message.content.length > 52 ? `${message.content.slice(0, 52)}...` : message.content;
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

function getFileBadgeLabel(fileName: string, mimeType?: string) {
  const extension = fileName.split('.').pop()?.trim().toUpperCase();

  if (extension && extension.length <= 5) {
    return extension;
  }

  if (mimeType?.startsWith('audio/')) {
    return 'AUDIO';
  }

  if (mimeType?.startsWith('video/')) {
    return 'VIDEO';
  }

  if (mimeType?.includes('pdf')) {
    return 'PDF';
  }

  return 'FILE';
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
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showStickerPicker, setShowStickerPicker] = useState(false);
  const [replyMessage, setReplyMessage] = useState<ChatMessage | null>(null);
  const [replyQuote, setReplyQuote] = useState('');
  const [quoteDraft, setQuoteDraft] = useState('');
  const [selectedQuoteText, setSelectedQuoteText] = useState('');
  const [showQuoteEditor, setShowQuoteEditor] = useState(false);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const [iceServers, setIceServers] = useState<RTCIceServer[]>([
    { urls: ['stun:stun.l.google.com:19302'] },
    { urls: ['stun:stun1.l.google.com:19302'] },
  ]);
  const [callSession, setCallSession] = useState<CallSession | null>(null);
  const [callOverlayVisible, setCallOverlayVisible] = useState(true);
  const [isRecordingVoice, setIsRecordingVoice] = useState(false);
  const [voiceSeconds, setVoiceSeconds] = useState(0);
  const [isUploadingFile, setIsUploadingFile] = useState(false);
  const [previewImage, setPreviewImage] = useState<{ src: string; name: string } | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const activeContactRef = useRef<string | null>(null);
  const messageAreaRef = useRef<HTMLDivElement | null>(null);
  const messageNodeMapRef = useRef(new Map<string, HTMLDivElement>());
  const pendingReadIdsRef = useRef(new Set<string>());
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const voiceStreamRef = useRef<MediaStream | null>(null);
  const voiceChunksRef = useRef<Blob[]>([]);
  const voiceTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const quoteSelectionRef = useRef<HTMLDivElement | null>(null);
  const requestedContactId = searchParams?.get('contactId') || null;
  const currentUserId = user?.id || null;
  const actionMessage = actionMessageId ? messages.find((message) => message.id === actionMessageId) || null : null;

  const formatFileSize = (sizeBytes: number) => {
    if (sizeBytes < 1024) {
      return `${sizeBytes} B`;
    }

    if (sizeBytes < 1024 * 1024) {
      return `${(sizeBytes / 1024).toFixed(1)} KB`;
    }

    return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const fileToDataUrl = (file: File) => new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
        return;
      }

      reject(new Error('Не удалось прочитать файл'));
    };
    reader.onerror = () => reject(new Error('Не удалось прочитать файл'));
    reader.readAsDataURL(file);
  });

  const compressImageFile = async (file: File) => {
    const sourceUrl = await fileToDataUrl(file);
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const nextImage = new Image();
      nextImage.onload = () => resolve(nextImage);
      nextImage.onerror = () => reject(new Error('Не удалось обработать изображение'));
      nextImage.src = sourceUrl;
    });

    const ratio = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.width * ratio));
    canvas.height = Math.max(1, Math.round(image.height * ratio));
    const context = canvas.getContext('2d');

    if (!context) {
      throw new Error('Не удалось подготовить изображение');
    }

    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((nextBlob) => {
        if (nextBlob) {
          resolve(nextBlob);
          return;
        }

        reject(new Error('Не удалось подготовить изображение'));
      }, 'image/jpeg', 0.82);
    });

    return {
      blob,
      mimeType: 'image/jpeg',
      sizeBytes: blob.size,
    };
  };

  const uploadAttachment = async (file: File) => {
    if (!token) {
      throw new Error('Сессия недействительна');
    }

    const preparedFile = file.type.startsWith('image/')
      ? await compressImageFile(file)
      : {
          blob: file,
          mimeType: file.type || 'application/octet-stream',
          sizeBytes: file.size,
        };

    const uploadName = file.type.startsWith('image/')
      ? `${file.name.replace(/\.[^.]+$/, '') || 'image'}.jpg`
      : file.name;

    const response = await fetch('/api/uploads', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': preparedFile.mimeType,
        'X-File-Name': encodeURIComponent(uploadName),
        'X-File-Size': String(preparedFile.sizeBytes),
      },
      body: preparedFile.blob,
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.attachment) {
      throw new Error(data.error || 'Не удалось загрузить файл');
    }

    return data.attachment as NonNullable<ChatMessage['attachment']>;
  };

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
    const closeActiveCall = ({ callId }: { callId: string }) => {
      setCallSession((prev) => (prev?.callId === callId ? null : prev));
      setCallOverlayVisible(true);
    };

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
          setCallOverlayVisible(true);
        });

        socket.on('call:ended', closeActiveCall);
        socket.on('call:rejected', closeActiveCall);
        socket.on('call:missed', closeActiveCall);
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
        socketRef.current?.off('call:ended', closeActiveCall);
        socketRef.current?.off('call:rejected', closeActiveCall);
        socketRef.current?.off('call:missed', closeActiveCall);
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

  useEffect(() => () => {
    if (highlightTimerRef.current) {
      clearTimeout(highlightTimerRef.current);
    }

    if (voiceTimerRef.current) {
      clearInterval(voiceTimerRef.current);
    }

    voiceStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaRecorderRef.current = null;
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
    socketRef.current.emit('message:send', { recipientId: activeContact.id, content, replyToMessageId: replyMessage?.id, replyQuote }, (response: { ok: boolean; error?: string; message?: ChatMessage }) => {
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
      setReplyMessage(null);
      setReplyQuote('');
      setQuoteDraft('');
      setSelectedQuoteText('');
      setShowQuoteEditor(false);
      setShowEmojiPicker(false);
      if (composerTextareaRef.current) {
        composerTextareaRef.current.style.height = '0px';
      }
    });
  };

  useEffect(() => {
    const textarea = composerTextareaRef.current;
    if (!textarea) {
      return;
    }

    textarea.style.height = '0px';
    const nextHeight = Math.min(textarea.scrollHeight, 144);
    textarea.style.height = `${Math.max(56, nextHeight)}px`;
    textarea.style.overflowY = textarea.scrollHeight > 144 ? 'auto' : 'hidden';
  }, [inputText]);

  useEffect(() => {
    if (!showQuoteEditor) {
      setSelectedQuoteText('');
      return;
    }

    const updateSelectedQuote = () => {
      const selection = typeof window !== 'undefined' ? window.getSelection() : null;
      const nextSelection = selection && quoteSelectionRef.current?.contains(selection.anchorNode)
        ? selection.toString().trim()
        : '';

      setSelectedQuoteText(nextSelection);
    };

    document.addEventListener('selectionchange', updateSelectedQuote);
    return () => document.removeEventListener('selectionchange', updateSelectedQuote);
  }, [showQuoteEditor]);

  const handleComposerKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submitMessage(event);
    }
  };

  const beginReply = (message: ChatMessage) => {
    setReplyMessage(message);
    setReplyQuote('');
    setQuoteDraft(message.kind === 'text' ? message.content : '');
    setSelectedQuoteText('');
    setShowQuoteEditor(false);
    setActionMessageId(null);
  };

  const openQuoteEditor = () => {
    if (!replyMessage || replyMessage.kind !== 'text' || replyMessage.deletedAt) {
      return;
    }

    setQuoteDraft(replyQuote || replyMessage.content);
    setSelectedQuoteText(replyQuote || '');
    setShowQuoteEditor(true);
  };

  const applyQuoteSelection = () => {
    const nextQuote = (selectedQuoteText || quoteDraft).trim().slice(0, 280);
    setReplyQuote(nextQuote);
    setSelectedQuoteText(nextQuote);
    setShowQuoteEditor(false);
  };

  const beginQuote = (message: ChatMessage) => {
    beginReply(message);
    if (message.kind !== 'text' || message.deletedAt) {
      return;
    }

    setQuoteDraft(message.content);
    setSelectedQuoteText('');
    setShowQuoteEditor(true);
  };

  const clearReply = () => {
    setReplyMessage(null);
    setReplyQuote('');
    setQuoteDraft('');
    setSelectedQuoteText('');
    setShowQuoteEditor(false);
  };

  const appendEmoji = (emoji: string) => {
    setInputText((prev) => `${prev}${emoji}`);
    setShowEmojiPicker(false);
  };

  const jumpToMessage = (messageId: string) => {
    const target = messageNodeMapRef.current.get(messageId);
    if (!target) {
      return;
    }

    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
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

  const stopVoiceRecording = async () => {
    const recorder = mediaRecorderRef.current;
    if (!recorder) {
      return;
    }

    const result = await new Promise<{ audioUrl: string; durationSeconds: number } | null>((resolve) => {
      recorder.onstop = () => {
        const blob = new Blob(voiceChunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        voiceChunksRef.current = [];

        const reader = new FileReader();
        reader.onloadend = () => {
          resolve(typeof reader.result === 'string' ? { audioUrl: reader.result, durationSeconds: voiceSeconds } : null);
        };
        reader.readAsDataURL(blob);
      };

      recorder.stop();
    });

    voiceStreamRef.current?.getTracks().forEach((track) => track.stop());
    voiceStreamRef.current = null;
    mediaRecorderRef.current = null;
    if (voiceTimerRef.current) {
      clearInterval(voiceTimerRef.current);
      voiceTimerRef.current = null;
    }
    setIsRecordingVoice(false);

    if (!result || !socketRef.current || !activeContact) {
      setVoiceSeconds(0);
      return;
    }

    socketRef.current.emit(
      'message:send',
      {
        recipientId: activeContact.id,
        kind: 'voice',
        voice: result,
        replyToMessageId: replyMessage?.id,
        replyQuote,
      },
      (response: { ok: boolean; error?: string; message?: ChatMessage }) => {
        if (!response.ok || !response.message) {
          setPageError(response.error || 'Не удалось отправить голосовое сообщение');
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
        setReplyMessage(null);
        setReplyQuote('');
        setQuoteDraft('');
        setSelectedQuoteText('');
        setShowQuoteEditor(false);
        setVoiceSeconds(0);
      },
    );
  };

  const startVoiceRecording = async () => {
    if (isRecordingVoice) {
      await stopVoiceRecording();
      return;
    }

    if (typeof window === 'undefined' || !window.MediaRecorder) {
      setPageError('Голосовые сообщения не поддерживаются этим браузером');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      voiceStreamRef.current = stream;
      mediaRecorderRef.current = recorder;
      voiceChunksRef.current = [];
      setVoiceSeconds(0);
      setIsRecordingVoice(true);

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          voiceChunksRef.current.push(event.data);
        }
      };

      recorder.start();
      voiceTimerRef.current = setInterval(() => {
        setVoiceSeconds((prev) => prev + 1);
      }, 1000);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : 'Не удалось включить запись голоса');
    }
  };

  const sendFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';

    if (!file || !socketRef.current || !activeContact) {
      return;
    }

    if (file.size > MAX_FILE_BYTES) {
      setPageError('Файл слишком большой. Пока лимит 12 MB');
      return;
    }

    setIsUploadingFile(true);
    setPageError('');
    try {
      const uploadedAttachment = await uploadAttachment(file);

      socketRef.current.emit(
        'message:send',
        {
          recipientId: activeContact.id,
          kind: 'file',
          attachment: uploadedAttachment,
          replyToMessageId: replyMessage?.id,
          replyQuote,
        },
        (response: { ok: boolean; error?: string; message?: ChatMessage }) => {
          if (!response.ok || !response.message) {
            setPageError(response.error || 'Не удалось отправить файл');
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
          setReplyMessage(null);
          setReplyQuote('');
          setQuoteDraft('');
          setSelectedQuoteText('');
          setShowQuoteEditor(false);
        },
      );
    } catch (error) {
      setPageError(error instanceof Error ? error.message : 'Не удалось отправить файл');
    } finally {
      setIsUploadingFile(false);
    }
  };

  const openFilePicker = () => {
    fileInputRef.current?.click();
  };

  const sendSticker = (packKey: string, fileUrl: string) => {
    if (!socketRef.current || !activeContact) {
      return;
    }

    const fileName = fileUrl.split('/').pop() || 'sticker.webp';
    socketRef.current.emit(
      'message:send',
      {
        recipientId: activeContact.id,
        kind: 'file',
        attachment: {
          fileName,
          mimeType: 'image/webp',
          sizeBytes: 0,
          fileUrl,
          isSticker: true,
          packKey,
        },
        replyToMessageId: replyMessage?.id,
        replyQuote,
      },
      (response: { ok: boolean; error?: string; message?: ChatMessage }) => {
        if (!response.ok || !response.message) {
          setPageError(response.error || 'Не удалось отправить стикер');
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
        setReplyMessage(null);
        setReplyQuote('');
        setQuoteDraft('');
        setSelectedQuoteText('');
        setShowQuoteEditor(false);
        setShowStickerPicker(false);
      },
    );
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

  const requestCallMediaAccess = async (mode: 'audio' | 'video') => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      throw new Error('Браузер не поддерживает доступ к микрофону/камере');
    }

    let stream: MediaStream | null = null;

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
        video: mode === 'video',
      });
    } catch (error) {
      if (mode === 'video') {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: 1,
          },
          video: false,
        });
      } else {
        throw error;
      }
    }

    const hasAudioTrack = stream.getAudioTracks().length > 0;
    stream.getTracks().forEach((track) => track.stop());

    if (!hasAudioTrack) {
      throw new Error('Не удалось получить доступ к микрофону');
    }
  };

  const startCall = async (mode: 'audio' | 'video') => {
    if (!socketRef.current || !activeContact) {
      return;
    }

    try {
      await requestCallMediaAccess(mode);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : 'Нужен доступ к микрофону и камере для звонка');
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
      setCallOverlayVisible(true);
    });
  };

  const handleCloseCall = useCallback(() => {
    setCallSession(null);
    setCallOverlayVisible(true);
  }, []);

  const handleMinimizeCall = useCallback(() => {
    setCallOverlayVisible(false);
  }, []);

  const handleRestoreCall = useCallback(() => {
    setCallOverlayVisible(true);
  }, []);

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
                <UserAvatar
                  avatarUrl={contact.avatarUrl}
                  alt={contact.displayName || contact.username}
                  fallback={getAvatarLabel(contact)}
                  className={`${styles.avatar} ${styles[`avatar_${contact.avatarColor || 'ocean'}`]}`}
                  imageClassName={styles.avatarImage}
                />
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
                  <UserAvatar
                    avatarUrl={activeContact.avatarUrl}
                    alt={activeContact.displayName || activeContact.username}
                    fallback={getAvatarLabel(activeContact)}
                    className={`${styles.headerAvatar} ${styles[`avatar_${activeContact.avatarColor || 'ocean'}`]}`}
                    imageClassName={styles.avatarImage}
                  />
                  <div>
                    <h2 className={styles.panelTitle}>Чат с {activeContact.displayName || activeContact.username}</h2>
                    <p className={styles.panelText}>{getPresenceText(activeContact)}</p>
                  </div>
                </div>
                <div className={styles.headerActions}>
                  <button type="button" className={styles.headerIconButton} onClick={() => startCall('audio')} aria-label="Аудиозвонок" title="Аудиозвонок">
                    <svg viewBox="0 0 24 24" aria-hidden="true" className={styles.iconSvg}><path d="M6.6 10.8c1.6 3.1 3.5 5 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.24c1.08.36 2.24.54 3.46.54a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1C10.52 21 3 13.48 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.22.18 2.38.54 3.46a1 1 0 0 1-.24 1l-2.2 2.34Z" fill="currentColor"/></svg>
                  </button>
                  <button type="button" className={styles.headerVideoButton} onClick={() => startCall('video')} aria-label="Видеозвонок" title="Видеозвонок">
                    <svg viewBox="0 0 24 24" aria-hidden="true" className={styles.iconSvg}><path d="M14 7a2 2 0 0 1 2 2v1.38l3.55-2.37A1 1 0 0 1 21 8.84v6.32a1 1 0 0 1-1.45.83L16 13.62V15a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h9Z" fill="currentColor"/></svg>
                  </button>
                </div>
              </div>

              <div ref={messageAreaRef} className={styles.messageArea}>
                <div className={styles.messageStack}>
                  {messages.map((message) => {
                    const ownMessage = message.senderId === user.id;
                    const isEditing = editingMessageId === message.id;
                    const isCallEvent = message.kind === 'call';
                    const isVoiceMessage = message.kind === 'voice';
                    const isFileMessage = message.kind === 'file';
                    const isImageMessage = isFileMessage && !!message.attachment?.mimeType?.startsWith('image/');
                    const isStickerMessage = isFileMessage && !!message.attachment?.isSticker;
                    const isPhotoMessage = isImageMessage && !isStickerMessage;
                    const hasQuickActionButton = ownMessage && !message.deletedAt && !isCallEvent && isFileMessage;
                    const fileBadgeLabel = message.attachment
                      ? getFileBadgeLabel(message.attachment.fileName, message.attachment.mimeType)
                      : 'FILE';

                    return (
                      <div key={message.id} className={isCallEvent ? styles.messageRowSystem : ownMessage ? styles.messageRowOwn : styles.messageRowPeer}>
                        <div
                          ref={ownMessage ? undefined : (node) => registerMessageNode(message.id, node)}
                          data-message-id={message.id}
                          className={`${isCallEvent ? styles.messageBubbleSystem : ownMessage ? styles.messageBubbleOwn : styles.messageBubblePeer} ${isPhotoMessage ? styles.messageBubbleMedia : ''} ${highlightedMessageId === message.id ? styles.messageBubbleHighlighted : ''}`}
                          onContextMenu={(event) => {
                            if (message.deletedAt || isCallEvent) {
                              return;
                            }

                            event.preventDefault();
                            event.stopPropagation();
                            openMessageActions(message.id);
                          }}
                          onTouchStart={() => {
                            if (message.deletedAt || isCallEvent) {
                              return;
                            }

                            startLongPress(message.id);
                          }}
                          onTouchEnd={stopLongPress}
                          onTouchMove={stopLongPress}
                        >
                          {hasQuickActionButton ? (
                            <button
                              type="button"
                              className={styles.messageQuickAction}
                              onClick={(event) => {
                                event.stopPropagation();
                                openMessageActions(message.id);
                              }}
                              aria-label="Действия с сообщением"
                              title="Действия"
                            >
                              <svg viewBox="0 0 24 24" aria-hidden="true" className={styles.iconSvg}><path d="M12 7a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm0 6.5A1.5 1.5 0 1 0 12 10a1.5 1.5 0 0 0 0 3.5Zm0 6.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z" fill="currentColor"/></svg>
                            </button>
                          ) : null}
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
                              {message.replyTo ? (
                                <button type="button" className={styles.replyPreview} onClick={() => jumpToMessage(message.replyTo!.id)}>
                                  <span className={styles.replyAuthor}>{message.replyTo.senderId === user.id ? 'Вы' : activeContact?.displayName || activeContact?.username}</span>
                                  <span className={styles.replyText}>{getReplySnippet(message.replyTo)}</span>
                                </button>
                              ) : null}
                              {message.deletedAt ? (
                                <p className={`${styles.messageContent} ${styles.messageDeleted}`}>{message.content}</p>
                              ) : isVoiceMessage && message.voice ? (
                                <audio controls className={styles.voicePlayer} src={message.voice.audioUrl} />
                              ) : isStickerMessage && message.attachment ? (
                                <button type="button" className={styles.stickerCard} onClick={() => setPreviewImage({ src: message.attachment!.fileUrl, name: message.attachment!.fileName })}>
                                  <img src={message.attachment.fileUrl} alt={message.attachment.fileName} className={styles.stickerImage} loading="lazy" />
                                </button>
                              ) : isImageMessage && message.attachment ? (
                                <button type="button" className={styles.imageCard} onClick={() => setPreviewImage({ src: message.attachment!.fileUrl, name: message.attachment!.fileName })}>
                                  <img src={message.attachment.fileUrl} alt={message.attachment.fileName} className={styles.imagePreview} loading="lazy" />
                                </button>
                              ) : isFileMessage && message.attachment ? (
                                <a href={message.attachment.fileUrl} download={message.attachment.fileName} target="_blank" rel="noreferrer" className={styles.fileCard}>
                                  <span className={styles.fileIcon}>{fileBadgeLabel}</span>
                                  <span className={styles.fileMeta}>
                                    <span className={styles.fileName}>{message.attachment.fileName}</span>
                                    <span className={styles.fileInfo}>{formatFileSize(message.attachment.sizeBytes)}</span>
                                  </span>
                                  <span className={styles.fileAction}>Открыть</span>
                                </a>
                              ) : (
                                <p className={styles.messageContent}>{message.content}</p>
                              )}
                              <div className={`${isCallEvent ? styles.messageMetaSystem : ownMessage ? styles.messageMetaOwn : styles.messageMetaPeer} ${isPhotoMessage ? ownMessage ? styles.messageMetaMediaOwn : styles.messageMetaMediaPeer : ''}`}>
                                <p className={isCallEvent ? styles.messageTimeSystem : ownMessage ? styles.messageTimeOwn : styles.messageTimePeer}>
                                  {new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                </p>
                                {message.updatedAt && !message.deletedAt && !isCallEvent ? <p className={ownMessage ? styles.messageEditedOwn : styles.messageEditedPeer}>изменено</p> : null}
                                {ownMessage && !isCallEvent ? <p className={styles.messageStatus}>{getOwnStatusText(message)}</p> : null}
                              </div>
                              {!isMobileLayout && !message.deletedAt && !isCallEvent && actionMessageId === message.id ? (
                                <div className={styles.messageTools} onClick={(event) => event.stopPropagation()}>
                                  <div className={styles.reactionPickerMenu}>
                                    {EMOJI_OPTIONS.map((emoji) => (
                                      <button key={emoji} type="button" className={styles.reactionMenuEmoji} onClick={() => { toggleReaction(message.id, emoji); setActionMessageId(null); }}>{emoji}</button>
                                    ))}
                                  </div>
                                  <button type="button" className={styles.messageToolPrimary} onClick={() => beginReply(message)}>Ответить</button>
                                  {message.kind === 'text' && !message.deletedAt ? <button type="button" className={styles.messageTool} onClick={() => beginQuote(message)}>Цитировать</button> : null}
                                  {ownMessage && message.kind !== 'voice' && message.kind !== 'file' ? <button type="button" className={styles.messageTool} onClick={() => { setEditingMessageId(message.id); setEditingText(message.content); setActionMessageId(null); }}>Изменить</button> : null}
                                  {ownMessage ? <button type="button" className={styles.messageToolDanger} onClick={() => deleteMessage(message.id)}>Удалить</button> : null}
                                </div>
                              ) : null}
                              {!isCallEvent ? (
                                <div className={styles.reactionRow}>
                                  {message.reactions?.map((reaction) => (
                                    <button
                                      key={reaction.emoji}
                                      type="button"
                                      className={`${styles.reactionChip} ${reaction.userIds.includes(user.id) ? styles.reactionChipActive : ''}`}
                                      onClick={() => toggleReaction(message.id, reaction.emoji)}
                                    >
                                      <span>{reaction.emoji}</span>
                                      <span>{reaction.userIds.length}</span>
                                    </button>
                                  ))}
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
                {replyMessage ? (
                  <div className={styles.replyBanner}>
                    <button type="button" className={styles.replyBannerBody} onClick={openQuoteEditor} disabled={replyMessage.kind !== 'text' || !!replyMessage.deletedAt}>
                      <strong className={styles.replyBannerTitle}>Ответ на сообщение</strong>
                      <p className={styles.replyBannerText}>{replyQuote || getMessagePreview(replyMessage)}</p>
                      {replyMessage.kind === 'text' && !replyMessage.deletedAt ? <span className={styles.replyBannerHint}>{replyQuote ? 'Нажмите, чтобы изменить цитату' : 'Нажмите, чтобы выбрать цитату'}</span> : null}
                    </button>
                    <button type="button" className={styles.replyBannerClose} onClick={clearReply}>X</button>
                  </div>
                ) : null}
                {showQuoteEditor && replyMessage?.kind === 'text' ? (
                  <div className={styles.quoteEditor}>
                    <strong className={styles.quoteEditorTitle}>Выберите фрагмент для цитаты</strong>
                    <p className={styles.quoteEditorText}>Выделите нужный кусок текста. На iPhone кнопка снизу берет уже сохраненное выделение, поэтому оно не теряется при нажатии.</p>
                    <div ref={quoteSelectionRef} className={styles.quoteEditorSelection}>
                      {quoteDraft}
                    </div>
                    <div className={styles.quoteEditorSelectionState}>
                      {selectedQuoteText ? `Выбрано: ${selectedQuoteText}` : 'Пока ничего не выбрано. Если нажать сейчас, процитируется весь текст.'}
                    </div>
                    <div className={styles.quoteEditorActions}>
                      <button type="button" className={styles.smallMutedButton} onClick={() => { setReplyQuote(''); setSelectedQuoteText(''); setShowQuoteEditor(false); }}>Отмена</button>
                      <button type="button" className={styles.smallButton} onClick={applyQuoteSelection}>Цитировать</button>
                    </div>
                  </div>
                ) : null}
                {showEmojiPicker ? (
                  <div className={styles.emojiPicker}>
                    {EMOJI_OPTIONS.map((emoji) => (
                      <button key={emoji} type="button" className={styles.emojiButton} onClick={() => appendEmoji(emoji)}>{emoji}</button>
                    ))}
                  </div>
                ) : null}
                {showStickerPicker ? (
                  <div className={styles.stickerPicker}>
                    {STICKER_PACKS.map((pack) => (
                      <div key={pack.key} className={styles.stickerPack}>
                        <strong className={styles.stickerPackTitle}>{pack.title}</strong>
                        <div className={styles.stickerGrid}>
                          {pack.items.map((fileUrl) => (
                            <button key={fileUrl} type="button" className={styles.stickerOption} onClick={() => sendSticker(pack.key, fileUrl)}>
                              <img src={fileUrl} alt={pack.title} className={styles.stickerOptionImage} loading="lazy" />
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
                <form onSubmit={submitMessage} className={styles.composerForm}>
                  <div className={styles.composerInputWrap}>
                    <textarea
                      ref={composerTextareaRef}
                      value={inputText}
                      onChange={(event) => setInputText(event.target.value)}
                      onKeyDown={handleComposerKeyDown}
                      placeholder="Введите сообщение..."
                      className={styles.composerInput}
                      rows={1}
                    />
                    <div className={styles.composerInlineActions}>
                      <button type="button" className={`${styles.inlineIconButton} ${showStickerPicker ? styles.inlineIconButtonActive : ''}`} onClick={() => { setShowStickerPicker((prev) => !prev); setShowEmojiPicker(false); }} title="Открыть стикеры">
                        <svg viewBox="0 0 24 24" aria-hidden="true" className={styles.iconSvg}><path d="M6 3h12a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3h-5.59L8 21.41A1 1 0 0 1 6.29 20.7V17H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3Zm2.75 6.75a1.25 1.25 0 1 0 0-2.5 1.25 1.25 0 0 0 0 2.5Zm6.5 0a1.25 1.25 0 1 0 0-2.5 1.25 1.25 0 0 0 0 2.5Zm-6.6 3.2a1 1 0 0 0-1.3 1.52 7 7 0 0 0 9.3 0 1 1 0 1 0-1.3-1.52 5 5 0 0 1-6.7 0Z" fill="currentColor"/></svg>
                      </button>
                      <button type="button" className={`${styles.inlineIconButton} ${showEmojiPicker ? styles.inlineIconButtonActive : ''}`} onClick={() => setShowEmojiPicker((prev) => !prev)} title="Открыть эмодзи">
                        <svg viewBox="0 0 24 24" aria-hidden="true" className={styles.iconSvg}><path d="M12 22a10 10 0 1 1 0-20 10 10 0 0 1 0 20Zm-3.5-8a1 1 0 0 0-.8 1.6 5.5 5.5 0 0 0 8.6 0A1 1 0 0 0 14.7 14a3.5 3.5 0 0 1-5.4 0 1 1 0 0 0-.8-.4ZM9 10a1.25 1.25 0 1 0 0-2.5A1.25 1.25 0 0 0 9 10Zm6 0a1.25 1.25 0 1 0 0-2.5A1.25 1.25 0 0 0 15 10Z" fill="currentColor"/></svg>
                      </button>
                      {!inputText.trim() || isRecordingVoice ? (
                        <button type="button" className={`${styles.inlineIconButton} ${isRecordingVoice ? styles.inlineIconButtonRecord : ''}`} onClick={() => startVoiceRecording()} title={isRecordingVoice ? `Остановить запись ${voiceSeconds}s` : 'Записать голосовое'}>
                          <svg viewBox="0 0 24 24" aria-hidden="true" className={styles.iconSvg}><path d="M12 15a3 3 0 0 0 3-3V7a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3Zm5-3a1 1 0 1 1 2 0 7 7 0 0 1-6 6.93V21h3a1 1 0 1 1 0 2H8a1 1 0 1 1 0-2h3v-2.07A7 7 0 0 1 5 12a1 1 0 1 1 2 0 5 5 0 1 0 10 0Z" fill="currentColor"/></svg>
                          {isRecordingVoice ? <span className={styles.inlineIconText}>{voiceSeconds}s</span> : null}
                        </button>
                      ) : null}
                    </div>
                  </div>
                  <input ref={fileInputRef} type="file" className={styles.hiddenFileInput} onChange={sendFile} accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.txt,.zip,.rar" />
                  <button type="button" className={styles.iconButton} title={isUploadingFile ? 'Загрузка...' : 'Прикрепить файл'} onClick={openFilePicker}>
                    <svg viewBox="0 0 24 24" aria-hidden="true" className={styles.iconSvg}><path d="M16.5 6.5a4.5 4.5 0 0 0-6.36 0l-5.3 5.3a3.25 3.25 0 1 0 4.6 4.6l5.47-5.47a2 2 0 1 0-2.83-2.83l-5.12 5.12a.75.75 0 0 0 1.06 1.06l4.77-4.77 1.06 1.06-4.77 4.77a2.25 2.25 0 0 1-3.18-3.18l5.12-5.12a3.5 3.5 0 1 1 4.95 4.95l-5.47 5.47a4.75 4.75 0 1 1-6.72-6.72l5.3-5.3a6 6 0 0 1 8.49 8.49l-4.95 4.95-1.06-1.06 4.95-4.95a4.5 4.5 0 0 0 0-6.36Z" fill="currentColor"/></svg>
                  </button>
                  <button type="submit" className={styles.composerButton} aria-label="Отправить сообщение" title="Отправить">
                    <svg viewBox="0 0 24 24" aria-hidden="true" className={styles.iconSvg}><path d="M3.4 11.3 18.8 4.7c1.5-.64 2.98.84 2.34 2.34L14.7 22.6c-.72 1.7-3.13 1.55-3.64-.22l-1.53-5.34-5.31-1.5c-1.8-.5-1.95-2.92-.24-3.65Zm6.95 4.08 1.27 4.44 6.09-14.2-14.2 6.1 4.46 1.26 6.3-6.3.88.88-6.3 6.3Z" fill="currentColor"/></svg>
                  </button>
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

      {callSession && socketRef.current ? (
        <VideoCall
          socket={socketRef.current}
          call={callSession}
          iceServers={iceServers}
          minimized={!callOverlayVisible}
          onMinimize={handleMinimizeCall}
          onRestore={handleRestoreCall}
          onClose={handleCloseCall}
        />
      ) : null}
      {previewImage ? (
        <button type="button" className={styles.imageLightbox} onClick={() => setPreviewImage(null)}>
          <img src={previewImage.src} alt={previewImage.name} className={styles.imageLightboxMedia} />
        </button>
      ) : null}

      {isMobileLayout && actionMessage && !actionMessage.deletedAt && actionMessage.kind !== 'call' ? (
        <div className={styles.mobileActionSheetBackdrop} onClick={() => setActionMessageId(null)}>
          <div className={styles.mobileActionSheet} onClick={(event) => event.stopPropagation()}>
            <div className={styles.mobileActionSheetHandle} />
            <div className={styles.mobileActionSheetPreview}>
              {actionMessage.replyTo ? <p className={styles.mobileActionSheetReply}>Ответ на: {getReplySnippet(actionMessage.replyTo)}</p> : null}
              <p className={styles.mobileActionSheetText}>{getMessagePreview(actionMessage)}</p>
            </div>
            <div className={styles.mobileActionSheetReactions}>
              {EMOJI_OPTIONS.map((emoji) => (
                <button key={emoji} type="button" className={styles.mobileActionSheetEmoji} onClick={() => { toggleReaction(actionMessage.id, emoji); setActionMessageId(null); }}>{emoji}</button>
              ))}
            </div>
            <div className={styles.mobileActionSheetActions}>
              <button type="button" className={styles.mobileActionSheetPrimary} onClick={() => beginReply(actionMessage)}>Ответить</button>
              {actionMessage.kind === 'text' ? <button type="button" className={styles.mobileActionSheetButton} onClick={() => beginQuote(actionMessage)}>Цитировать</button> : null}
              {actionMessage.senderId === user.id && actionMessage.kind !== 'voice' && actionMessage.kind !== 'file' ? <button type="button" className={styles.mobileActionSheetButton} onClick={() => { setEditingMessageId(actionMessage.id); setEditingText(actionMessage.content); setActionMessageId(null); }}>Изменить</button> : null}
              {actionMessage.senderId === user.id ? <button type="button" className={styles.mobileActionSheetDanger} onClick={() => deleteMessage(actionMessage.id)}>Удалить</button> : null}
              <button type="button" className={styles.mobileActionSheetCancel} onClick={() => setActionMessageId(null)}>Отмена</button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

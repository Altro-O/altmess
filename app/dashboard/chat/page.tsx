'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { io, type Socket } from 'socket.io-client';
import { useAuth } from '../../../components/AuthProvider';
import UserAvatar from '../../../components/UserAvatar';
import VideoCall, { type CallSession } from '../../../components/VideoCall';
import GroupCall, { type GroupCallSession } from '../../../components/GroupCall';
import CreateGroupModal from '../../../components/groups/CreateGroupModal';
import { apiFetch, type ChatMessage, type Contact, type GroupDetails, type MessagesPage } from '../../../utils/api';
import styles from '../../../styles/chat.module.css';

const MOBILE_BREAKPOINT = 960;
const READ_VISIBILITY_THRESHOLD = 0.8;
const EMOJI_OPTIONS = ['❤️', '👍', '😂', '🔥', '😍', '😮', '😢', '🙏', '👏', '🎉', '🤝', '💯', '😎', '🤔', '👀', '👌'];
const MAX_IMAGE_DIMENSION = 1600;
const MAX_FILE_BYTES = 12 * 1024 * 1024;
const PINNED_CHATS_KEY = 'altmess_pinned_chats';
const DRAFTS_KEY = 'altmess_dialog_drafts';
const STICKER_USAGE_KEY = 'altmess_sticker_usage';
const EMOJI_USAGE_KEY = 'altmess_emoji_usage';
const MESSAGES_PAGE_SIZE = 40;

function isGroupContact(contactId?: string | null) {
  return String(contactId || '').startsWith('group:');
}

function getMessageTargetId(message: ChatMessage, currentUserId?: string | null) {
  return message.groupId ? `group:${message.groupId}` : (message.senderId === currentUserId ? message.recipientId : message.senderId);
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

  if (contact.type === 'group') {
    return `${contact.memberIds?.length || 0} участников`;
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

function isAttachmentExpired(message: ChatMessage) {
  return Boolean(message.attachment && message.attachment.storageStatus && message.attachment.storageStatus !== 'ready');
}

function getMessageSearchValue(message: ChatMessage) {
  if (message.kind === 'file') {
    return [message.content, message.attachment?.fileName || '', message.attachment?.mimeType || ''].join(' ').toLowerCase();
  }

  return [message.content, message.replyTo?.content || '', message.replyTo?.quote || ''].join(' ').toLowerCase();
}

function sortContactsWithPins(contacts: Contact[], pinnedIds: string[]) {
  const pinnedOrder = new Map(pinnedIds.map((id, index) => [id, index]));
  return [...contacts].sort((first, second) => {
    const firstPinned = pinnedOrder.has(first.id);
    const secondPinned = pinnedOrder.has(second.id);

    if (firstPinned && secondPinned) {
      return (pinnedOrder.get(first.id) || 0) - (pinnedOrder.get(second.id) || 0);
    }

    if (firstPinned) {
      return -1;
    }

    if (secondPinned) {
      return 1;
    }

    const firstTime = first.lastMessage?.createdAt || first.createdAt || '';
    const secondTime = second.lastMessage?.createdAt || second.createdAt || '';
    return secondTime.localeCompare(firstTime);
  });
}

function getMessageDayKey(dateValue: string) {
  const date = new Date(dateValue);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function getTimelineDateLabel(dateValue: string) {
  const target = new Date(dateValue);
  const now = new Date();
  const todayKey = getMessageDayKey(now.toISOString());
  const yesterday = new Date();
  yesterday.setDate(now.getDate() - 1);
  const yesterdayKey = getMessageDayKey(yesterday.toISOString());
  const targetKey = getMessageDayKey(dateValue);

  if (targetKey === todayKey) {
    return 'Сегодня';
  }

  if (targetKey === yesterdayKey) {
    return 'Вчера';
  }

  return target.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}

function sortByUsage<T extends string>(items: T[], usage: Record<string, number>) {
  return [...items].sort((first, second) => {
    const secondCount = usage[second] || 0;
    const firstCount = usage[first] || 0;
    if (secondCount !== firstCount) {
      return secondCount - firstCount;
    }

    return items.indexOf(first) - items.indexOf(second);
  });
}

function canForwardMessage(message: ChatMessage) {
  return !message.deletedAt && message.kind !== 'call' && !(message.attachment && isAttachmentExpired(message));
}

function sortPinnedMessages(items: ChatMessage[]) {
  return [...items].sort((first, second) => String(second.pinnedAt || '').localeCompare(String(first.pinnedAt || '')));
}

function getMessageAuthorLabel(message: ChatMessage, currentUserId: string) {
  if (message.senderId === currentUserId) {
    return 'Вы';
  }

  return message.senderName || 'Участник';
}

export default function ChatPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { isAuthenticated, isLoading, token, user } = useAuth();
  const [sidebarItems, setSidebarItems] = useState<Contact[]>([]);
  const [availableContacts, setAvailableContacts] = useState<Contact[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pinnedMessages, setPinnedMessages] = useState<ChatMessage[]>([]);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [nextMessagesCursor, setNextMessagesCursor] = useState<string | null>(null);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const [isLoadingOlderMessages, setIsLoadingOlderMessages] = useState(false);
  const [inputText, setInputText] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [messageSearchQuery, setMessageSearchQuery] = useState('');
  const [showMessageSearch, setShowMessageSearch] = useState(false);
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
  const [groupCallSession, setGroupCallSession] = useState<GroupCallSession | null>(null);
  const [isRecordingVoice, setIsRecordingVoice] = useState(false);
  const [voiceSeconds, setVoiceSeconds] = useState(0);
  const [isUploadingFile, setIsUploadingFile] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<Array<{ name: string; progress: number }>>([]);
  const [previewImage, setPreviewImage] = useState<{ src: string; name: string } | null>(null);
  const [showDialogProfile, setShowDialogProfile] = useState(false);
  const [showCreateGroupModal, setShowCreateGroupModal] = useState(false);
  const [isCreatingGroup, setIsCreatingGroup] = useState(false);
  const [groupMembers, setGroupMembers] = useState<Contact[]>([]);
  const [groupAvailableContacts, setGroupAvailableContacts] = useState<Contact[]>([]);
  const [isLoadingGroupDetails, setIsLoadingGroupDetails] = useState(false);
  const [isUpdatingGroupMembers, setIsUpdatingGroupMembers] = useState(false);
  const [groupAddSearchQuery, setGroupAddSearchQuery] = useState('');
  const [pinnedChatIds, setPinnedChatIds] = useState<string[]>([]);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedMessageIds, setSelectedMessageIds] = useState<string[]>([]);
  const [showForwardPicker, setShowForwardPicker] = useState(false);
  const [isForwardingMessages, setIsForwardingMessages] = useState(false);
  const [draftsByContact, setDraftsByContact] = useState<Record<string, string>>({});
  const [isDragOver, setIsDragOver] = useState(false);
  const [showScrollToLatest, setShowScrollToLatest] = useState(false);
  const [stickerPacks, setStickerPacks] = useState<Array<{ key: string; title: string; items: string[] }>>([]);
  const [stickerUsage, setStickerUsage] = useState<Record<string, number>>({});
  const [emojiUsage, setEmojiUsage] = useState<Record<string, number>>({});
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

  const uploadAttachment = async (file: File, onProgress?: (progress: number) => void) => {
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

    return await new Promise<NonNullable<ChatMessage['attachment']>>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/uploads');
      xhr.responseType = 'json';
      xhr.timeout = 30000;
      xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      xhr.setRequestHeader('Content-Type', preparedFile.mimeType);
      xhr.setRequestHeader('X-File-Name', encodeURIComponent(uploadName));
      xhr.setRequestHeader('X-File-Size', String(preparedFile.sizeBytes));
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) {
          onProgress?.(Math.round((event.loaded / event.total) * 100));
        }
      };
      xhr.onerror = () => reject(new Error('Не удалось загрузить файл'));
      xhr.ontimeout = () => reject(new Error('Загрузка файла заняла слишком много времени'));
      xhr.onload = () => {
        const data = xhr.response && typeof xhr.response === 'object'
          ? xhr.response as { attachment?: NonNullable<ChatMessage['attachment']>; error?: string }
          : (() => {
              try {
                return JSON.parse(xhr.responseText || '{}') as { attachment?: NonNullable<ChatMessage['attachment']>; error?: string };
              } catch {
                return {};
              }
            })();

        if (xhr.status < 200 || xhr.status >= 300 || !data.attachment) {
          reject(new Error(data.error || 'Не удалось загрузить файл'));
          return;
        }

        onProgress?.(100);
        resolve(data.attachment as NonNullable<ChatMessage['attachment']>);
      };
      xhr.send(preparedFile.blob);
    });
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
    setSidebarItems(sortContactsWithPins(nextItems, pinnedChatIds));
    setActiveContactId((prev) => {
      if (prev && nextItems.some((item) => item.id === prev)) {
        return prev;
      }

      if (requestedContactId && nextItems.some((item) => item.id === requestedContactId)) {
        return requestedContactId;
      }

      return null;
    });
  }, [pinnedChatIds, requestedContactId, searchQuery, token]);

  const loadAvailableContacts = useCallback(async () => {
    if (!token) {
      return;
    }

    const response = await apiFetch<{ dialogs: Contact[] }>('/api/dialogs', { token });
    setAvailableContacts((response.dialogs || []).filter((contact) => contact.type === 'direct'));
  }, [token]);

  useEffect(() => {
    activeContactRef.current = activeContactId;
  }, [activeContactId]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    try {
      const savedPins = JSON.parse(window.localStorage.getItem(PINNED_CHATS_KEY) || '[]');
      const savedDrafts = JSON.parse(window.localStorage.getItem(DRAFTS_KEY) || '{}');
      const savedStickerUsage = JSON.parse(window.localStorage.getItem(STICKER_USAGE_KEY) || '{}');
      const savedEmojiUsage = JSON.parse(window.localStorage.getItem(EMOJI_USAGE_KEY) || '{}');
      const localPins = Array.isArray(savedPins) ? savedPins.map(String) : [];
      const serverPins = Array.isArray(user?.pinnedChatIds) ? user.pinnedChatIds.map(String) : [];
      setPinnedChatIds(serverPins.length > 0 ? serverPins : localPins);
      setDraftsByContact(savedDrafts && typeof savedDrafts === 'object' ? savedDrafts : {});
      setStickerUsage(savedStickerUsage && typeof savedStickerUsage === 'object' ? savedStickerUsage : {});
      setEmojiUsage(savedEmojiUsage && typeof savedEmojiUsage === 'object' ? savedEmojiUsage : {});
    } catch {
      setPinnedChatIds(Array.isArray(user?.pinnedChatIds) ? user.pinnedChatIds.map(String) : []);
      setDraftsByContact({});
      setStickerUsage({});
      setEmojiUsage({});
    }
  }, [user]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    window.localStorage.setItem(PINNED_CHATS_KEY, JSON.stringify(pinnedChatIds));
  }, [pinnedChatIds]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    window.localStorage.setItem(DRAFTS_KEY, JSON.stringify(draftsByContact));
  }, [draftsByContact]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    window.localStorage.setItem(STICKER_USAGE_KEY, JSON.stringify(stickerUsage));
  }, [stickerUsage]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    window.localStorage.setItem(EMOJI_USAGE_KEY, JSON.stringify(emojiUsage));
  }, [emojiUsage]);

  useEffect(() => {
    fetch('/api/stickers')
      .then((response) => response.json())
      .then((data) => setStickerPacks(Array.isArray(data?.packs) ? data.packs : []))
      .catch(() => setStickerPacks([]));
  }, []);

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

        const socket = io({
          auth: { token },
          reconnection: true,
          reconnectionAttempts: Infinity,
          reconnectionDelay: 1000,
          reconnectionDelayMax: 5000,
          timeout: 20000,
        });
        socketRef.current = socket;

        socket.on('connect', () => {
          setPageError((prev) => (prev === 'Не удалось подключиться к realtime-серверу' ? '' : prev));
          syncVisibility();
        });
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
          const partnerId = getMessageTargetId(message, currentUserId);

          if (!message.groupId && message.recipientId === currentUserId) {
            socket.emit('message:delivered', { messageIds: [message.id] });
          }

          setSidebarItems((prev) => {
            const existing = prev.find((contact) => contact.id === partnerId);
            if (!existing) {
              return prev;
            }

            return sortContactsWithPins([
              {
                ...existing,
                lastMessage: message,
                unreadCount: message.groupId ? (existing.unreadCount || 0) : (message.senderId !== currentUserId ? (existing.unreadCount || 0) + 1 : 0),
              },
              ...prev.filter((contact) => contact.id !== partnerId),
            ], pinnedChatIds);
          });

          if (partnerId === currentContactId) {
            setMessages((prev) => upsertMessage(prev, message));
          }
        });

        socket.on('message:status', (patch: Partial<ChatMessage> & { id: string }) => {
          setMessages((prev) => prev.map((message) => (message.id === patch.id ? { ...message, ...patch } : message)));
          setSidebarItems((prev) =>
            sortContactsWithPins(prev.map((contact) =>
              contact.id === patch.senderId && patch.recipientId === currentUserId && patch.status === 'read'
                ? {
                    ...contact,
                    unreadCount: Math.max(0, (contact.unreadCount || 0) - 1),
                    lastMessage: contact.lastMessage?.id === patch.id ? { ...contact.lastMessage, ...patch } : contact.lastMessage,
                  }
                : contact.lastMessage?.id === patch.id
                  ? { ...contact, lastMessage: { ...contact.lastMessage, ...patch } }
                  : contact,
            ), pinnedChatIds),
          );
        });

        socket.on('message:update', (message: ChatMessage) => {
          setMessages((prev) => upsertMessage(prev, message));
          setPinnedMessages((prev) => {
            const withoutCurrent = prev.filter((entry) => entry.id !== message.id);
            if (!message.pinnedAt || message.deletedAt) {
              return withoutCurrent;
            }

            return sortPinnedMessages([...withoutCurrent, message]);
          });
          setSidebarItems((prev) => sortContactsWithPins(prev.map((contact) => (contact.lastMessage?.id === message.id ? { ...contact, lastMessage: message } : contact)), pinnedChatIds));
        });

        socket.on('group:new', ({ group }: { group: Contact }) => {
          setSidebarItems((prev) => sortContactsWithPins([group, ...prev.filter((contact) => contact.id !== group.id)], pinnedChatIds));
        });

        socket.on('group:update', ({ group }: { group: Contact }) => {
          setSidebarItems((prev) => sortContactsWithPins(prev.map((contact) => (contact.id === group.id ? { ...contact, ...group } : contact)), pinnedChatIds));
          if (activeContactRef.current === group.id && showDialogProfile) {
            loadGroupDetails(group.id);
          }
        });

        socket.on('group:removed', ({ groupId }: { groupId: string }) => {
          const targetId = `group:${groupId}`;
          setSidebarItems((prev) => prev.filter((contact) => contact.id !== targetId));
          if (activeContactRef.current === targetId) {
            setActiveContactId(null);
            setMessages([]);
            setPinnedMessages([]);
            setShowDialogProfile(false);
          }
        });

        socket.on('call:incoming', ({ callId, mode, fromUser }: { callId: string; mode: 'audio' | 'video'; fromUser: Contact }) => {
          setCallSession({
            callId,
            peerUserId: fromUser.id,
            peerName: fromUser.displayName || fromUser.username,
            peerAvatarUrl: fromUser.avatarUrl,
            peerAvatarColor: fromUser.avatarColor,
            mode,
            initiator: false,
          });
          setCallOverlayVisible(true);
        });

        socket.on('group-call:incoming', ({ groupId, mode, title, fromUser }: { groupId: string; mode: 'audio' | 'video'; title: string; fromUser: Contact }) => {
          setGroupCallSession({
            groupId,
            mode,
            title,
            initiator: false,
            incomingFrom: fromUser,
          });
        });

        socket.on('group-call:ended', ({ groupId }: { groupId: string }) => {
          setGroupCallSession((current) => (current?.groupId === groupId ? null : current));
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
    if (!showCreateGroupModal) {
      return;
    }

    loadAvailableContacts().catch((error) => {
      setPageError(error instanceof Error ? error.message : 'Не удалось загрузить контакты для группы');
    });
  }, [loadAvailableContacts, showCreateGroupModal]);

  const loadMessagesPage = useCallback(async (contactId: string, options?: { beforeMessageId?: string; appendOlder?: boolean }) => {
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

    const response = await apiFetch<MessagesPage>(`/api/messages?${params.toString()}`, { token });

    if (options?.appendOlder) {
      setMessages((prev) => [...response.messages, ...prev.filter((message) => !response.messages.some((older) => older.id === message.id))]);
    } else {
      setMessages(response.messages);
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
  }, [currentUserId, token]);

  useEffect(() => {
    if (!activeContactId || !token) {
      setMessages([]);
      setPinnedMessages([]);
      setHasMoreMessages(false);
      setNextMessagesCursor(null);
      return;
    }

    setSelectionMode(false);
    setSelectedMessageIds([]);
    setShowForwardPicker(false);
    setIsLoadingMessages(true);

    loadMessagesPage(activeContactId)
      .catch((error) => setPageError(error instanceof Error ? error.message : 'Не удалось загрузить сообщения'))
      .finally(() => setIsLoadingMessages(false));
  }, [activeContactId, loadMessagesPage, token]);

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
    if (!activeContactId) {
      return;
    }

    setInputText((prev) => (prev.trim() ? prev : draftsByContact[activeContactId] || ''));
  }, [activeContactId, draftsByContact]);

  useEffect(() => {
    if (selectedMessageIds.length === 0) {
      setSelectionMode(false);
    }
  }, [selectedMessageIds]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    const area = messageAreaRef.current;
    if (!area) {
      return;
    }

    const handleScroll = () => {
      const distanceFromBottom = area.scrollHeight - area.scrollTop - area.clientHeight;
      setShowScrollToLatest(distanceFromBottom > 240);
    };

    handleScroll();
    area.addEventListener('scroll', handleScroll);
    return () => area.removeEventListener('scroll', handleScroll);
  }, [messages.length, activeContactId]);

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

  const selectedMessages = useMemo(
    () => messages.filter((message) => selectedMessageIds.includes(message.id)),
    [messages, selectedMessageIds],
  );

  const visibleMessages = useMemo(() => {
    const query = messageSearchQuery.trim().toLowerCase();
    if (!query) {
      return messages;
    }

    return messages.filter((message) => getMessageSearchValue(message).includes(query));
  }, [messageSearchQuery, messages]);

  const galleryImages = useMemo(
    () => messages.filter((message) => message.kind === 'file' && message.attachment?.mimeType?.startsWith('image/') && !message.attachment?.isSticker && !isAttachmentExpired(message) && !message.deletedAt),
    [messages],
  );

  const groupedGalleryImages = useMemo(() => {
    const groups = new Map<string, { label: string; items: ChatMessage[] }>();

    galleryImages.forEach((message) => {
      const key = getMessageDayKey(message.createdAt);
      const existing = groups.get(key);
      if (existing) {
        existing.items.push(message);
        return;
      }

      groups.set(key, {
        label: getTimelineDateLabel(message.createdAt),
        items: [message],
      });
    });

    return Array.from(groups.entries())
      .sort((first, second) => new Date(second[1].items[0].createdAt).getTime() - new Date(first[1].items[0].createdAt).getTime())
      .map(([key, value]) => ({ key, ...value }));
  }, [galleryImages]);

  const orderedEmojis = useMemo(() => sortByUsage(EMOJI_OPTIONS, emojiUsage), [emojiUsage]);

  const orderedStickerPacks = useMemo(() => {
    const packs = stickerPacks.map((pack) => ({
      ...pack,
      items: sortByUsage(pack.items, stickerUsage),
    }));

    const frequentlyUsedItems = packs.flatMap((pack) => pack.items).filter((item) => (stickerUsage[item] || 0) > 0).sort((first, second) => (stickerUsage[second] || 0) - (stickerUsage[first] || 0)).slice(0, 24);
    if (frequentlyUsedItems.length === 0) {
      return packs;
    }

    return [{ key: 'frequent', title: 'Часто используемые', items: Array.from(new Set(frequentlyUsedItems)) }, ...packs];
  }, [stickerPacks, stickerUsage]);

  const timelineItems = useMemo(() => {
    const items: Array<{ type: 'date'; key: string; label: string } | { type: 'message'; key: string; message: ChatMessage }> = [];
    let currentDayKey = '';

    visibleMessages.forEach((message) => {
      const dayKey = getMessageDayKey(message.createdAt);
      if (dayKey !== currentDayKey) {
        currentDayKey = dayKey;
        items.push({ type: 'date', key: `date-${dayKey}`, label: getTimelineDateLabel(message.createdAt) });
      }

      items.push({ type: 'message', key: message.id, message });
    });

    return items;
  }, [visibleMessages]);

  const isActiveChatPinned = activeContactId ? pinnedChatIds.includes(activeContactId) : false;
  const isActiveGroupChat = activeContact?.type === 'group';
  const isActiveGroupOwner = Boolean(isActiveGroupChat && user?.id && activeContact?.ownerId === user.id);
  const filteredGroupAvailableContacts = useMemo(() => {
    const query = groupAddSearchQuery.trim().toLowerCase();
    if (!query) {
      return groupAvailableContacts;
    }

    return groupAvailableContacts.filter((contact) => [contact.displayName, contact.username, contact.email, contact.bio]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(query)));
  }, [groupAddSearchQuery, groupAvailableContacts]);

  const getForwardSenderName = (message: ChatMessage) => {
    if (message.senderId === user?.id) {
      return user?.displayName || user?.username || 'Вы';
    }

    return message.senderName || activeContact?.displayName || activeContact?.username || 'Неизвестный пользователь';
  };

  const syncPinnedChats = useCallback(async (nextPins: string[]) => {
    if (!token) {
      return;
    }

    try {
      const response = await apiFetch<{ pinnedChatIds: string[] }>('/api/preferences', {
        method: 'PATCH',
        token,
        body: JSON.stringify({ pinnedChatIds: nextPins }),
      });
      setPinnedChatIds(response.pinnedChatIds);
      setSidebarItems((current) => sortContactsWithPins(current, response.pinnedChatIds));
    } catch (error) {
      setPageError(error instanceof Error ? error.message : 'Не удалось сохранить закрепы');
    }
  }, [token]);

  const createGroupChat = useCallback(async (title: string, memberIds: string[]) => {
    if (!token) {
      return;
    }

    setIsCreatingGroup(true);
    try {
      const response = await apiFetch<{ group: Contact }>('/api/groups', {
        method: 'POST',
        token,
        body: JSON.stringify({ title, memberIds }),
      });

      setSidebarItems((prev) => sortContactsWithPins([response.group, ...prev.filter((contact) => contact.id !== response.group.id)], pinnedChatIds));
      setActiveContactId(response.group.id);
      setShowCreateGroupModal(false);
      setPageError('');
    } catch (error) {
      setPageError(error instanceof Error ? error.message : 'Не удалось создать группу');
    } finally {
      setIsCreatingGroup(false);
    }
  }, [pinnedChatIds, token]);

  const loadGroupDetails = useCallback(async (groupContactId: string) => {
    if (!token || !isGroupContact(groupContactId)) {
      return;
    }

    const groupId = groupContactId.slice('group:'.length);
    setIsLoadingGroupDetails(true);

    try {
      const response = await apiFetch<GroupDetails>(`/api/groups/${groupId}`, { token });
      setGroupMembers(response.members || []);
      setGroupAvailableContacts(response.availableContacts || []);
      setSidebarItems((prev) => sortContactsWithPins(prev.map((contact) => (contact.id === response.group.id ? { ...contact, ...response.group } : contact)), pinnedChatIds));
    } catch (error) {
      setPageError(error instanceof Error ? error.message : 'Не удалось загрузить участников группы');
    } finally {
      setIsLoadingGroupDetails(false);
    }
  }, [pinnedChatIds, token]);

  const updateGroupMembers = useCallback(async (payload: { addMemberIds?: string[]; removeMemberIds?: string[] }) => {
    if (!token || !activeContactId || !isGroupContact(activeContactId)) {
      return;
    }

    setIsUpdatingGroupMembers(true);
    try {
      const response = await apiFetch<GroupDetails>(`/api/groups/${activeContactId.slice('group:'.length)}`, {
        method: 'PATCH',
        token,
        body: JSON.stringify(payload),
      });
      setGroupMembers(response.members || []);
      setGroupAvailableContacts(response.availableContacts || []);
      setSidebarItems((prev) => sortContactsWithPins(prev.map((contact) => (contact.id === response.group.id ? { ...contact, ...response.group } : contact)), pinnedChatIds));
      setPageError('');
    } catch (error) {
      setPageError(error instanceof Error ? error.message : 'Не удалось обновить группу');
    } finally {
      setIsUpdatingGroupMembers(false);
    }
  }, [activeContactId, pinnedChatIds, token]);

  const leaveGroup = useCallback(async () => {
    if (!token || !activeContact || activeContact.type !== 'group') {
      return;
    }

    try {
      await apiFetch(`/api/groups/${activeContact.id.slice('group:'.length)}/leave`, {
        method: 'POST',
        token,
      });
      setSidebarItems((prev) => prev.filter((contact) => contact.id !== activeContact.id));
      setActiveContactId(null);
      setShowDialogProfile(false);
      setMessages([]);
      setPinnedMessages([]);
      setPageError('');
    } catch (error) {
      setPageError(error instanceof Error ? error.message : 'Не удалось выйти из группы');
    }
  }, [activeContact, token]);

  const deleteGroup = useCallback(async () => {
    if (!token || !activeContact || activeContact.type !== 'group') {
      return;
    }

    try {
      await apiFetch(`/api/groups/${activeContact.id.slice('group:'.length)}`, {
        method: 'DELETE',
        token,
      });
      setSidebarItems((prev) => prev.filter((contact) => contact.id !== activeContact.id));
      setActiveContactId(null);
      setShowDialogProfile(false);
      setMessages([]);
      setPinnedMessages([]);
      setPageError('');
    } catch (error) {
      setPageError(error instanceof Error ? error.message : 'Не удалось удалить группу');
    }
  }, [activeContact, token]);

  useEffect(() => {
    const currentContact = sidebarItems.find((contact) => contact.id === activeContactId) || null;

    if (!showDialogProfile || !currentContact || currentContact.type !== 'group') {
      setGroupMembers([]);
      setGroupAvailableContacts([]);
      setGroupAddSearchQuery('');
      return;
    }

    loadGroupDetails(currentContact.id);
  }, [activeContactId, loadGroupDetails, showDialogProfile, sidebarItems]);

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

  const handleSelectContact = (contactId: string) => {
    if (activeContactId && activeContactId !== contactId) {
      setDraftsByContact((prev) => ({ ...prev, [activeContactId]: inputText }));
    }

    setActiveContactId(contactId);
    setInputText(draftsByContact[contactId] || '');
    setMessageSearchQuery('');
    setShowMessageSearch(false);
    setShowDialogProfile(false);
    if (isMobileLayout) {
      setShowMobileChat(true);
    }
  };

  const updateSidebarContact = (contactId: string, updater: (contact: Contact) => Contact) => {
    setSidebarItems((prev) => sortContactsWithPins(prev.map((contact) => (contact.id === contactId ? updater(contact) : contact)), pinnedChatIds));
  };

  const togglePinnedChat = (contactId: string) => {
    setPinnedChatIds((prev) => {
      const nextPins = prev.includes(contactId) ? prev.filter((id) => id !== contactId) : [contactId, ...prev];
      setSidebarItems((current) => sortContactsWithPins(current, nextPins));
      void syncPinnedChats(nextPins);
      return nextPins;
    });
  };

  const bumpSidebarMessage = (contactId: string, message: ChatMessage, unreadCount?: number) => {
    setSidebarItems((prev) => {
      const existing = prev.find((contact) => contact.id === contactId);
      if (!existing) {
        return prev;
      }

      return sortContactsWithPins([
        { ...existing, lastMessage: message, unreadCount: unreadCount ?? existing.unreadCount ?? 0 },
        ...prev.filter((contact) => contact.id !== contactId),
      ], pinnedChatIds);
    });
  };

  const toggleMessageSelection = (messageId: string) => {
    setSelectedMessageIds((prev) => (prev.includes(messageId) ? prev.filter((id) => id !== messageId) : [...prev, messageId]));
  };

  const clearMessageSelection = () => {
    setSelectionMode(false);
    setSelectedMessageIds([]);
    setShowForwardPicker(false);
  };

  const forwardMessagesToContact = async (contactId: string) => {
    if (!socketRef.current || selectedMessages.length === 0) {
      return;
    }

    const forwardableMessages = selectedMessages.filter(canForwardMessage);
    if (forwardableMessages.length === 0) {
      setPageError('Нет сообщений, которые можно переслать');
      return;
    }

    setIsForwardingMessages(true);

    try {
      for (const message of forwardableMessages) {
        await new Promise<void>((resolve, reject) => {
          socketRef.current?.emit('message:send', {
            recipientId: contactId,
            content: message.kind === 'text' ? message.content : undefined,
            kind: message.kind,
            voice: message.voice || undefined,
            attachment: message.attachment || undefined,
            forwardedFrom: {
              senderId: message.senderId,
              senderName: getForwardSenderName(message),
            },
          }, (response: { ok: boolean; error?: string }) => {
            if (!response?.ok) {
              reject(new Error(response?.error || 'Не удалось переслать сообщение'));
              return;
            }

            resolve();
          });
        });
      }

      clearMessageSelection();
      setPageError('');
    } catch (error) {
      setPageError(error instanceof Error ? error.message : 'Не удалось переслать сообщения');
    } finally {
      setIsForwardingMessages(false);
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
      bumpSidebarMessage(activeContact.id, response.message, 0);
      setInputText('');
      setDraftsByContact((prev) => ({ ...prev, [activeContact.id]: '' }));
      resetReplyState();
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
    setEmojiUsage((prev) => ({ ...prev, [emoji]: (prev[emoji] || 0) + 1 }));
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

  const scrollToLatest = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
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
        bumpSidebarMessage(activeContact.id, response.message, 0);
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

  const resetReplyState = () => {
    setReplyMessage(null);
    setReplyQuote('');
    setQuoteDraft('');
    setSelectedQuoteText('');
    setShowQuoteEditor(false);
  };

  const sendUploadedAttachmentMessage = (uploadedAttachment: NonNullable<ChatMessage['attachment']>) => new Promise<ChatMessage>((resolve, reject) => {
    if (!socketRef.current || !activeContact) {
      reject(new Error('Чат не выбран'));
      return;
    }

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
          reject(new Error(response.error || 'Не удалось отправить файл'));
          return;
        }

        resolve(response.message);
      },
    );
  });

  const sendFilesBatch = async (files: FileList | File[]) => {
    if (!socketRef.current || !activeContact) {
      return;
    }

    const nextFiles = Array.from(files).filter(Boolean);
    if (nextFiles.length === 0) {
      return;
    }

    const tooLargeFile = nextFiles.find((file) => file.size > MAX_FILE_BYTES);
    if (tooLargeFile) {
      setPageError(`Файл ${tooLargeFile.name} слишком большой. Пока лимит 12 MB`);
      return;
    }

    setIsUploadingFile(true);
    setPageError('');
    setUploadProgress(nextFiles.map((file) => ({ name: file.name, progress: 0 })));

    try {
      for (let index = 0; index < nextFiles.length; index += 1) {
        const file = nextFiles[index];
        const uploadedAttachment = await uploadAttachment(file, (progress) => {
          setUploadProgress((prev) => prev.map((entry, entryIndex) => (entryIndex === index ? { ...entry, progress } : entry)));
        });
        const message = await sendUploadedAttachmentMessage(uploadedAttachment);
        setMessages((prev) => upsertMessage(prev, message));
        bumpSidebarMessage(activeContact.id, message, 0);
      }

      resetReplyState();
    } catch (error) {
      setPageError(error instanceof Error ? error.message : 'Не удалось отправить файлы');
    } finally {
      setIsUploadingFile(false);
      setUploadProgress([]);
    }
  };

  const sendFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files ? Array.from(event.target.files) : [];
    event.target.value = '';

    if (files.length === 0) {
      return;
    }

    await sendFilesBatch(files);
  };

  const openFilePicker = () => {
    fileInputRef.current?.click();
  };

  const handleDropFiles = async (event: React.DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragOver(false);

    if (event.dataTransfer.files?.length) {
      await sendFilesBatch(event.dataTransfer.files);
    }
  };

  const handleDragEnter = (event: React.DragEvent<HTMLElement>) => {
    event.preventDefault();
    if (!isMobileLayout) {
      setIsDragOver(true);
    }
  };

  const handleDragLeave = (event: React.DragEvent<HTMLElement>) => {
    event.preventDefault();
    if (event.currentTarget === event.target) {
      setIsDragOver(false);
    }
  };

  const sendSticker = (packKey: string, fileUrl: string) => {
    if (!socketRef.current || !activeContact) {
      return;
    }

    const fileName = fileUrl.split('/').pop() || 'sticker.webp';
    const extension = fileName.split('.').pop()?.toLowerCase() || 'webp';
    const mimeType = extension === 'webm' ? 'video/webm' : 'image/webp';
    socketRef.current.emit(
      'message:send',
      {
        recipientId: activeContact.id,
        kind: 'file',
        attachment: {
          fileName,
          mimeType,
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
        bumpSidebarMessage(activeContact.id, response.message, 0);
        setStickerUsage((prev) => ({ ...prev, [fileUrl]: (prev[fileUrl] || 0) + 1 }));
        resetReplyState();
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
      setSidebarItems((prev) => sortContactsWithPins(prev.map((contact) => (contact.lastMessage?.id === messageId ? { ...contact, lastMessage: response.message } : contact)), pinnedChatIds));
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
        peerAvatarUrl: activeContact.avatarUrl,
        peerAvatarColor: activeContact.avatarColor,
        mode,
        initiator: true,
      });
      setCallOverlayVisible(true);
    });
  };

  const startGroupCall = async (mode: 'audio' | 'video') => {
    if (!socketRef.current || !activeContact || activeContact.type !== 'group') {
      return;
    }

    try {
      await requestCallMediaAccess(mode);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : 'Нужен доступ к микрофону и камере для звонка');
      return;
    }

    socketRef.current.emit('group-call:start', { groupId: activeContact.id.slice('group:'.length), mode }, (response: { ok: boolean; error?: string; room?: { groupId: string; title: string; mode: 'audio' | 'video' } }) => {
      if (!response.ok || !response.room) {
        setPageError(response.error || 'Не удалось начать групповой звонок');
        return;
      }

      setGroupCallSession({
        groupId: response.room.groupId,
        title: response.room.title,
        mode: response.room.mode,
        initiator: true,
        incomingFrom: null,
      });
      setPageError('');
    });
  };

  const handleCloseCall = useCallback(() => {
    setCallSession(null);
    setCallOverlayVisible(true);
  }, []);

  const handleCloseGroupCall = useCallback(() => {
    setGroupCallSession(null);
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
            <button type="button" className={styles.secondaryButton} onClick={() => setShowCreateGroupModal(true)}>Новая группа</button>
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
                    <span className={styles.contactNameWrap}>
                      {pinnedChatIds.includes(contact.id) ? <span className={styles.pinnedMark}>Закреплен</span> : null}
                      <span className={styles.contactName}>{contact.displayName || contact.username}</span>
                    </span>
                    {contact.unreadCount ? <span className={styles.unreadBadge}>{contact.unreadCount}</span> : null}
                  </span>
                  <span className={styles.contactPreview}>{contact.lastMessage ? getMessagePreview(contact.lastMessage) : (contact.bio || contact.email)}</span>
                </span>
                <span
                  role="button"
                  tabIndex={0}
                  className={styles.pinToggle}
                  onClick={(event) => {
                    event.stopPropagation();
                    togglePinnedChat(contact.id);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      event.stopPropagation();
                      togglePinnedChat(contact.id);
                    }
                  }}
                >
                  {pinnedChatIds.includes(contact.id) ? '★' : '☆'}
                </span>
              </button>
            ))}
          </div>
        </aside>

        <section className={`${styles.panel} ${showMobileChat ? styles.panelVisibleMobile : styles.panelHiddenMobile}`}>
          {activeContact ? (
            <>
              <div className={styles.panelHeader}>
                <div className={styles.panelIdentityButton} role="button" tabIndex={0} onClick={() => setShowDialogProfile(true)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setShowDialogProfile(true); } }}>
                <div className={styles.panelIdentity}>
                  {isMobileLayout ? (
                    <button type="button" className={styles.backButton} onClick={(event) => { event.stopPropagation(); setShowMobileChat(false); }}>
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
                    <h2 className={styles.panelTitle}>{activeContact.type === 'group' ? activeContact.displayName || activeContact.username : `Чат с ${activeContact.displayName || activeContact.username}`}</h2>
                    <p className={styles.panelText}>{getPresenceText(activeContact)}</p>
                  </div>
                </div>
                </div>
                <div className={styles.headerActions}>
                  <button type="button" className={styles.headerIconButton} onClick={() => setShowMessageSearch((prev) => !prev)} aria-label="Поиск по диалогу" title="Поиск по диалогу">
                    <svg viewBox="0 0 24 24" aria-hidden="true" className={styles.iconSvg}><path d="M10.5 4a6.5 6.5 0 1 0 4.03 11.6l4.43 4.44 1.04-1.04-4.44-4.43A6.5 6.5 0 0 0 10.5 4Zm0 1.5a5 5 0 1 1 0 10 5 5 0 0 1 0-10Z" fill="currentColor"/></svg>
                  </button>
                  <button type="button" className={styles.headerIconButton} onClick={() => setShowDialogProfile(true)} aria-label="Медиа и информация" title="Медиа и информация">
                    <svg viewBox="0 0 24 24" aria-hidden="true" className={styles.iconSvg}><path d="M6 4h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm0 1.5a.5.5 0 0 0-.5.5v8.12l3.35-3.35a1 1 0 0 1 1.42 0l1.73 1.73 3.15-3.15a1 1 0 0 1 1.41 0l1.94 1.94V6a.5.5 0 0 0-.5-.5H6Zm12 13a.5.5 0 0 0 .5-.5v-3.44l-2.65-2.65-3.15 3.15a1 1 0 0 1-1.41 0l-1.73-1.73-3.06 3.06V18c0 .28.22.5.5.5h12ZM9 8.25a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5Z" fill="currentColor"/></svg>
                  </button>
                  <button type="button" className={styles.headerIconButton} onClick={() => togglePinnedChat(activeContact.id)} aria-label={isActiveChatPinned ? 'Открепить чат' : 'Закрепить чат'} title={isActiveChatPinned ? 'Открепить чат' : 'Закрепить чат'}>
                    {isActiveChatPinned ? '★' : '☆'}
                  </button>
                  {!isActiveGroupChat ? <button type="button" className={styles.headerIconButton} onClick={() => startCall('audio')} aria-label="Аудиозвонок" title="Аудиозвонок">
                    <svg viewBox="0 0 24 24" aria-hidden="true" className={styles.iconSvg}><path d="M6.6 10.8c1.6 3.1 3.5 5 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.24c1.08.36 2.24.54 3.46.54a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1C10.52 21 3 13.48 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.22.18 2.38.54 3.46a1 1 0 0 1-.24 1l-2.2 2.34Z" fill="currentColor"/></svg>
                  </button> : null}
                  {!isActiveGroupChat ? <button type="button" className={styles.headerVideoButton} onClick={() => startCall('video')} aria-label="Видеозвонок" title="Видеозвонок">
                    <svg viewBox="0 0 24 24" aria-hidden="true" className={styles.iconSvg}><path d="M14 7a2 2 0 0 1 2 2v1.38l3.55-2.37A1 1 0 0 1 21 8.84v6.32a1 1 0 0 1-1.45.83L16 13.62V15a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h9Z" fill="currentColor"/></svg>
                  </button> : null}
                  {isActiveGroupChat ? <button type="button" className={styles.headerIconButton} onClick={() => startGroupCall('audio')} aria-label="Групповой аудиозвонок" title="Групповой аудиозвонок">
                    <svg viewBox="0 0 24 24" aria-hidden="true" className={styles.iconSvg}><path d="M6.6 10.8c1.6 3.1 3.5 5 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.24c1.08.36 2.24.54 3.46.54a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1C10.52 21 3 13.48 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.22.18 2.38.54 3.46a1 1 0 0 1-.24 1l-2.2 2.34Z" fill="currentColor"/></svg>
                  </button> : null}
                  {isActiveGroupChat ? <button type="button" className={styles.headerVideoButton} onClick={() => startGroupCall('video')} aria-label="Групповой видеозвонок" title="Групповой видеозвонок">
                    <svg viewBox="0 0 24 24" aria-hidden="true" className={styles.iconSvg}><path d="M14 7a2 2 0 0 1 2 2v1.38l3.55-2.37A1 1 0 0 1 21 8.84v6.32a1 1 0 0 1-1.45.83L16 13.62V15a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h9Z" fill="currentColor"/></svg>
                  </button> : null}
                </div>
              </div>

              {pinnedMessages.length > 0 ? (
                <div className={styles.dialogSearchBar}>
                  <div className={styles.replyBanner}>
                    <div className={styles.replyBannerBody} style={{ cursor: 'default' }}>
                      <strong className={styles.replyBannerTitle}>Закрепленные сообщения: {pinnedMessages.length}</strong>
                      <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
                        {pinnedMessages.slice(0, 3).map((message) => (
                          <div key={message.id} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                            <button type="button" className={styles.smallMutedButton} onClick={() => jumpToMessage(message.id)}>
                              {getMessagePreview(message)}
                            </button>
                            <button type="button" className={styles.smallMutedButton} onClick={() => togglePinnedMessage(message)}>
                              Открепить
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              ) : null}

              {showMessageSearch ? (
                <div className={styles.dialogSearchBar}>
                  <input type="text" value={messageSearchQuery} onChange={(event) => setMessageSearchQuery(event.target.value)} className={styles.dialogSearchInput} placeholder="Поиск по сообщениям, файлам и цитатам" />
                </div>
              ) : null}

              <div ref={messageAreaRef} className={`${styles.messageArea} ${isDragOver ? styles.messageAreaDragOver : ''}`} onDragEnter={handleDragEnter} onDragOver={(event) => event.preventDefault()} onDragLeave={handleDragLeave} onDrop={handleDropFiles}>
                {isDragOver ? <div className={styles.dropOverlay}>Отпустите файлы, чтобы отправить в чат</div> : null}
                <div className={styles.messageStack}>
                  {hasMoreMessages ? (
                    <div className={styles.timelineDateRow}>
                      <button type="button" className={styles.smallMutedButton} onClick={() => loadOlderMessages()} disabled={isLoadingOlderMessages || isLoadingMessages}>
                        {isLoadingOlderMessages ? 'Загружаем...' : 'Загрузить более ранние сообщения'}
                      </button>
                    </div>
                  ) : null}
                  {timelineItems.map((item) => {
                    if (item.type === 'date') {
                      return (
                        <div key={item.key} className={styles.timelineDateRow}>
                          <div className={styles.timelineDateBadge}>{item.label}</div>
                        </div>
                      );
                    }

                    const { message } = item;
                    const ownMessage = message.senderId === user.id;
                    const isEditing = editingMessageId === message.id;
                    const isCallEvent = message.kind === 'call';
                    const isVoiceMessage = message.kind === 'voice';
                    const isFileMessage = message.kind === 'file';
                    const isImageMessage = isFileMessage && !!message.attachment?.mimeType?.startsWith('image/');
                    const isStickerMessage = isFileMessage && !!message.attachment?.isSticker;
                    const isPhotoMessage = isImageMessage && !isStickerMessage;
                    const isVideoStickerMessage = isStickerMessage && !!message.attachment?.mimeType?.startsWith('video/');
                    const isExpiredAttachment = isAttachmentExpired(message);
                    const hasQuickActionButton = ownMessage && !message.deletedAt && !isCallEvent && isFileMessage;
                    const fileBadgeLabel = message.attachment
                      ? getFileBadgeLabel(message.attachment.fileName, message.attachment.mimeType)
                      : 'FILE';

                    return (
                      <div key={message.id} className={isCallEvent ? styles.messageRowSystem : ownMessage ? styles.messageRowOwn : styles.messageRowPeer}>
                        <div
                          ref={(node) => registerMessageNode(message.id, node)}
                          data-message-id={message.id}
                          className={`${isCallEvent ? styles.messageBubbleSystem : ownMessage ? styles.messageBubbleOwn : styles.messageBubblePeer} ${(isPhotoMessage || isStickerMessage) ? styles.messageBubbleMedia : ''} ${isStickerMessage ? styles.messageBubbleSticker : ''} ${highlightedMessageId === message.id ? styles.messageBubbleHighlighted : ''}`}
                          style={selectedMessageIds.includes(message.id) ? { outline: '2px solid rgba(103, 132, 255, 0.95)', outlineOffset: '2px' } : undefined}
                          onClick={() => {
                            if (selectionMode && !isCallEvent && !message.deletedAt) {
                              toggleMessageSelection(message.id);
                            }
                          }}
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
                                  <span className={styles.replyAuthor}>{message.replyTo.senderId === user.id ? 'Вы' : (message.replyTo.senderName || activeContact?.displayName || activeContact?.username)}</span>
                                  <span className={styles.replyText}>{getReplySnippet(message.replyTo)}</span>
                                </button>
                              ) : null}
                              {activeContact?.type === 'group' && !ownMessage ? <span className={styles.replyAuthor}>{getMessageAuthorLabel(message, user.id)}</span> : null}
                              {message.forwardedFrom ? (
                                <div className={styles.forwardedPreview}>
                                  <span className={styles.forwardedLabel}>Переслано от</span>
                                  <span className={styles.replyAuthor}>{message.forwardedFrom.senderName}</span>
                                </div>
                              ) : null}
                              {message.deletedAt ? (
                                <p className={`${styles.messageContent} ${styles.messageDeleted}`}>{message.content}</p>
                              ) : isVoiceMessage && message.voice ? (
                                <audio controls className={styles.voicePlayer} src={message.voice.audioUrl} />
                              ) : isExpiredAttachment ? (
                                <div className={styles.expiredAttachmentCard}>
                                  <strong className={styles.expiredAttachmentTitle}>Файл недоступен</strong>
                                  <p className={styles.expiredAttachmentText}>Старое вложение было удалено из хранилища, чтобы освободить место на сервере.</p>
                                </div>
                              ) : isStickerMessage && message.attachment ? (
                                <button type="button" className={styles.stickerCard} onClick={() => setPreviewImage({ src: message.attachment!.fileUrl, name: message.attachment!.fileName })}>
                                  {isVideoStickerMessage ? (
                                    <video src={message.attachment.fileUrl} className={styles.stickerImage} autoPlay muted loop playsInline />
                                  ) : (
                                    <img src={message.attachment.fileUrl} alt={message.attachment.fileName} className={styles.stickerImage} loading="lazy" />
                                  )}
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
                              <div className={`${isCallEvent ? styles.messageMetaSystem : ownMessage ? styles.messageMetaOwn : styles.messageMetaPeer} ${(isPhotoMessage || isStickerMessage) ? ownMessage ? styles.messageMetaMediaOwn : styles.messageMetaMediaPeer : ''}`}>
                                <p className={isCallEvent ? styles.messageTimeSystem : ownMessage ? styles.messageTimeOwn : styles.messageTimePeer}>
                                  {new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                </p>
                                {message.updatedAt && !message.deletedAt && !isCallEvent ? <p className={ownMessage ? styles.messageEditedOwn : styles.messageEditedPeer}>изменено</p> : null}
                                {ownMessage && !isCallEvent ? <p className={styles.messageStatus}>{getOwnStatusText(message)}</p> : null}
                              </div>
                              {!isMobileLayout && !message.deletedAt && !isCallEvent && actionMessageId === message.id ? (
                                <div className={styles.messageTools} onClick={(event) => event.stopPropagation()}>
                                  <div className={styles.reactionPickerMenu}>
                                    {orderedEmojis.map((emoji) => (
                                      <button key={emoji} type="button" className={styles.reactionMenuEmoji} onClick={() => { toggleReaction(message.id, emoji); setActionMessageId(null); }}>{emoji}</button>
                                    ))}
                                  </div>
                                  <button type="button" className={styles.messageToolPrimary} onClick={() => beginReply(message)}>Ответить</button>
                                  <button type="button" className={styles.messageTool} onClick={() => togglePinnedMessage(message)}>{message.pinnedAt ? 'Открепить' : 'Закрепить'}</button>
                                  <button type="button" className={styles.messageTool} onClick={() => { setSelectionMode(true); setSelectedMessageIds([message.id]); setActionMessageId(null); }}>Выбрать</button>
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
                  {visibleMessages.length === 0 && messageSearchQuery.trim() ? <div className={styles.searchEmptyState}>Ничего не найдено в этом диалоге</div> : null}
                  <div ref={messagesEndRef} />
                </div>
                {showScrollToLatest ? (
                  <button type="button" className={styles.scrollToLatestButton} onClick={scrollToLatest} aria-label="Перейти к последнему сообщению" title="К последнему сообщению">
                    ↓
                  </button>
                ) : null}
              </div>

              <div className={styles.composer}>
                {pageError ? <div className={styles.inlineError}>{pageError}</div> : null}
                {selectionMode ? (
                  <div className={styles.replyBanner}>
                    <button type="button" className={styles.replyBannerBody} onClick={() => setShowForwardPicker((prev) => !prev)}>
                      <strong className={styles.replyBannerTitle}>Выбрано: {selectedMessageIds.length}</strong>
                      <p className={styles.replyBannerText}>Нажмите, чтобы переслать выбранные сообщения</p>
                    </button>
                    <button type="button" className={styles.replyBannerClose} onClick={clearMessageSelection}>X</button>
                  </div>
                ) : null}
                {showForwardPicker && selectionMode ? (
                  <div className={styles.quoteEditor}>
                    <strong className={styles.quoteEditorTitle}>Куда переслать сообщения</strong>
                    <div className={styles.quoteEditorActions} style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                      {sidebarItems.map((contact) => (
                        <button key={contact.id} type="button" className={styles.smallMutedButton} onClick={() => forwardMessagesToContact(contact.id)} disabled={isForwardingMessages}>
                          {isForwardingMessages ? 'Пересылаем...' : `Переслать: ${contact.displayName || contact.username}`}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
                {uploadProgress.length ? (
                  <div className={styles.uploadQueue}>
                    {uploadProgress.map((entry) => (
                      <div key={entry.name} className={styles.uploadQueueItem}>
                        <div className={styles.uploadQueueMeta}>
                          <strong>{entry.name}</strong>
                          <span>{entry.progress}%</span>
                        </div>
                        <div className={styles.uploadBar}><span style={{ width: `${entry.progress}%` }} /></div>
                      </div>
                    ))}
                  </div>
                ) : null}
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
                    {orderedEmojis.map((emoji) => (
                      <button key={emoji} type="button" className={styles.emojiButton} onClick={() => appendEmoji(emoji)}>{emoji}</button>
                    ))}
                  </div>
                ) : null}
                {showStickerPicker ? (
                  <div className={styles.stickerPicker}>
                    {orderedStickerPacks.map((pack) => (
                      <div key={pack.key} className={styles.stickerPack}>
                        <strong className={styles.stickerPackTitle}>{pack.title}</strong>
                        <div className={styles.stickerGrid}>
                          {pack.items.map((fileUrl) => (
                            <button key={fileUrl} type="button" className={styles.stickerOption} onClick={() => sendSticker(pack.key, fileUrl)}>
                              {fileUrl.endsWith('.webm') ? (
                                <video src={fileUrl} className={styles.stickerOptionImage} autoPlay muted loop playsInline />
                              ) : (
                                <img src={fileUrl} alt={pack.title} className={styles.stickerOptionImage} loading="lazy" />
                              )}
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
                      onChange={(event) => {
                        const nextValue = event.target.value;
                        setInputText(nextValue);
                        if (activeContactId) {
                          setDraftsByContact((prev) => ({ ...prev, [activeContactId]: nextValue }));
                        }
                      }}
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
                  <input ref={fileInputRef} type="file" multiple className={styles.hiddenFileInput} onChange={sendFile} accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.txt,.zip,.rar" />
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
      {groupCallSession && socketRef.current ? (
        <GroupCall
          socket={socketRef.current}
          call={groupCallSession}
          currentUserId={user.id}
          iceServers={iceServers}
          onClose={handleCloseGroupCall}
        />
      ) : null}
      {previewImage ? (
        <button type="button" className={styles.imageLightbox} onClick={() => setPreviewImage(null)}>
          <img src={previewImage.src} alt={previewImage.name} className={styles.imageLightboxMedia} />
        </button>
      ) : null}

      {showCreateGroupModal ? (
        <CreateGroupModal
          contacts={availableContacts}
          isSubmitting={isCreatingGroup}
          onClose={() => setShowCreateGroupModal(false)}
          onSubmit={createGroupChat}
        />
      ) : null}

      {showDialogProfile && activeContact ? (
        <div className={styles.dialogProfileBackdrop} onClick={() => setShowDialogProfile(false)}>
          <div className={styles.dialogProfileSheet} onClick={(event) => event.stopPropagation()}>
            <div className={styles.dialogProfileHeader}>
              <UserAvatar
                avatarUrl={activeContact.avatarUrl}
                alt={activeContact.displayName || activeContact.username}
                fallback={getAvatarLabel(activeContact)}
                className={`${styles.dialogProfileAvatar} ${styles[`avatar_${activeContact.avatarColor || 'ocean'}`]}`}
                imageClassName={styles.avatarImage}
              />
              <div>
                <h3 className={styles.dialogProfileTitle}>{activeContact.displayName || activeContact.username}</h3>
                <p className={styles.dialogProfileText}>{getPresenceText(activeContact)}</p>
              </div>
            </div>
            <div className={styles.dialogProfileActions}>
              <button type="button" className={styles.secondaryButton} onClick={() => togglePinnedChat(activeContact.id)}>{isActiveChatPinned ? 'Открепить чат' : 'Закрепить чат'}</button>
              <button type="button" className={styles.secondaryButton} onClick={() => { setShowDialogProfile(false); setShowMessageSearch(true); }}>Поиск в диалоге</button>
              {activeContact.type === 'group' && !isActiveGroupOwner ? <button type="button" className={styles.secondaryButton} onClick={leaveGroup}>Выйти из группы</button> : null}
              {activeContact.type === 'group' && isActiveGroupOwner ? <button type="button" className={styles.secondaryButton} onClick={deleteGroup}>Удалить группу</button> : null}
            </div>
            {activeContact.type === 'group' ? (
              <>
                <div className={styles.galleryHeaderRow}>
                  <strong>Участники</strong>
                  <span>{groupMembers.length || activeContact.memberIds?.length || 0}</span>
                </div>
                {isLoadingGroupDetails ? <p className={styles.galleryEmpty}>Загружаем участников...</p> : null}
                {groupMembers.length ? (
                  <div className={styles.groupMemberList}>
                    {groupMembers.map((member) => (
                      <div key={member.id} className={styles.groupMemberCard}>
                        <div className={styles.groupMemberIdentity}>
                          <UserAvatar
                            avatarUrl={member.avatarUrl}
                            alt={member.displayName || member.username}
                            fallback={getAvatarLabel(member)}
                            className={`${styles.avatar} ${styles[`avatar_${member.avatarColor || 'ocean'}`]}`}
                            imageClassName={styles.avatarImage}
                          />
                          <div>
                            <div className={styles.contactName}>{member.displayName || member.username}</div>
                            <div className={styles.contactPreview}>{member.id === activeContact.ownerId ? 'Владелец группы' : (member.bio || member.email || member.username)}</div>
                          </div>
                        </div>
                        {isActiveGroupOwner && member.id !== activeContact.ownerId ? (
                          <button type="button" className={styles.smallMutedButton} onClick={() => updateGroupMembers({ removeMemberIds: [member.id] })} disabled={isUpdatingGroupMembers}>
                            Удалить
                          </button>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : null}

                {isActiveGroupOwner ? (
                  <>
                    <div className={styles.galleryHeaderRow}>
                      <strong>Добавить участников</strong>
                      <span>{filteredGroupAvailableContacts.length}</span>
                    </div>
                    <input
                      type="text"
                      value={groupAddSearchQuery}
                      onChange={(event) => setGroupAddSearchQuery(event.target.value)}
                      className={styles.dialogSearchInput}
                      placeholder="Поиск по активным диалогам"
                    />
                    {filteredGroupAvailableContacts.length ? (
                      <div className={styles.groupMemberList}>
                        {filteredGroupAvailableContacts.map((member) => (
                          <div key={member.id} className={styles.groupMemberCard}>
                            <div className={styles.groupMemberIdentity}>
                              <UserAvatar
                                avatarUrl={member.avatarUrl}
                                alt={member.displayName || member.username}
                                fallback={getAvatarLabel(member)}
                                className={`${styles.avatar} ${styles[`avatar_${member.avatarColor || 'ocean'}`]}`}
                                imageClassName={styles.avatarImage}
                              />
                              <div>
                                <div className={styles.contactName}>{member.displayName || member.username}</div>
                                <div className={styles.contactPreview}>{member.bio || member.email || member.username}</div>
                              </div>
                            </div>
                            <button type="button" className={styles.smallMutedButton} onClick={() => updateGroupMembers({ addMemberIds: [member.id] })} disabled={isUpdatingGroupMembers}>
                              Добавить
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : <p className={styles.galleryEmpty}>Нет подходящих активных диалогов для добавления.</p>}
                  </>
                ) : null}
              </>
            ) : null}
            <div className={styles.galleryHeaderRow}>
              <strong>Галерея</strong>
              <span>{galleryImages.length}</span>
            </div>
            {groupedGalleryImages.length ? (
              <div className={styles.galleryGroups}>
                {groupedGalleryImages.map((group) => (
                  <section key={group.key} className={styles.galleryGroup}>
                    <div className={styles.galleryGroupHeader}>{group.label}</div>
                    <div className={styles.galleryGrid}>
                      {group.items.map((message) => (
                        <div key={message.id} className={styles.galleryCard}>
                          <button type="button" className={styles.galleryThumb} onClick={() => setPreviewImage({ src: message.attachment!.fileUrl, name: message.attachment!.fileName })}>
                            <img src={message.attachment!.fileUrl} alt={message.attachment!.fileName} className={styles.galleryThumbImage} loading="lazy" />
                          </button>
                          <button type="button" className={styles.galleryJumpButton} onClick={() => { setShowDialogProfile(false); jumpToMessage(message.id); }}>
                            Перейти к сообщению
                          </button>
                        </div>
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            ) : <p className={styles.galleryEmpty}>Пока нет изображений в этом диалоге.</p>}
          </div>
        </div>
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
              {orderedEmojis.map((emoji) => (
                <button key={emoji} type="button" className={styles.mobileActionSheetEmoji} onClick={() => { toggleReaction(actionMessage.id, emoji); setActionMessageId(null); }}>{emoji}</button>
              ))}
            </div>
            <div className={styles.mobileActionSheetActions}>
              <button type="button" className={styles.mobileActionSheetPrimary} onClick={() => beginReply(actionMessage)}>Ответить</button>
              <button type="button" className={styles.mobileActionSheetButton} onClick={() => togglePinnedMessage(actionMessage)}>{actionMessage.pinnedAt ? 'Открепить' : 'Закрепить'}</button>
              <button type="button" className={styles.mobileActionSheetButton} onClick={() => { setSelectionMode(true); setSelectedMessageIds([actionMessage.id]); setActionMessageId(null); }}>Выбрать</button>
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

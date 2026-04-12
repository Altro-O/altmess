'use client';

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import dynamic from 'next/dynamic';
import { type Socket } from 'socket.io-client';
import { useAuth } from '../../../components/AuthProvider';
import UserAvatar from '../../../components/UserAvatar';
import { type CallSession } from '../../../components/VideoCall';
import { type GroupCallSession } from '../../../components/GroupCall';
import { useChatSocket } from '../../../hooks/useChatSocket';
import { useMessages } from '../../../hooks/useMessages';
import { useCall } from '../../../hooks/useCall';
import CreateGroupModal from '../../../components/groups/CreateGroupModal';
import ChatHeader from '../../../components/chat/ChatHeader';
import ChatSidebar from '../../../components/chat/ChatSidebar';
import MessageTimeline from '../../../components/chat/MessageTimeline';
import ChatComposer from '../../../components/chat/ChatComposer';
import MessageActionSheet from '../../../components/chat/MessageActionSheet';
import DialogProfileSheet from '../../../components/chat/DialogProfileSheet';
import { apiFetch, type ChatMessage, type Contact, type GroupDetails, type MessagesPage } from '../../../utils/api';
import styles from '../../../styles/chat.module.css';

const VideoCall = dynamic(() => import('../../../components/VideoCall'), { ssr: false });
const GroupCall = dynamic(() => import('../../../components/GroupCall'), { ssr: false });

const MOBILE_BREAKPOINT = 960;
const READ_VISIBILITY_THRESHOLD = 0.8;
const EMOJI_OPTIONS = ['❤️', '👍', '😂', '🔥', '😍', '😮', '😢', '🙏', '👏', '🎉', '🤝', '💯', '😎', '🤔', '👀', '👌'];
const MAX_IMAGE_DIMENSION = 1600;
const MAX_FILE_BYTES = 75 * 1024 * 1024;
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
  const socketRef = useRef<Socket | null>(null);
  const [sidebarItems, setSidebarItems] = useState<Contact[]>([]);
  const [availableContacts, setAvailableContacts] = useState<Contact[]>([]);
  const [inputText, setInputText] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [dialogScope, setDialogScope] = useState<'all' | 'direct' | 'group'>('all');
  const [activeContactId, setActiveContactId] = useState<string | null>(null);
  const [isMobileLayout, setIsMobileLayout] = useState(false);
  const [showMobileChat, setShowMobileChat] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showStickerPicker, setShowStickerPicker] = useState(false);
  const [mobilePickerTab, setMobilePickerTab] = useState<'emoji' | 'sticker'>('emoji');
  const [replyMessage, setReplyMessage] = useState<ChatMessage | null>(null);
  const [replyQuote, setReplyQuote] = useState('');
  const [quoteDraft, setQuoteDraft] = useState('');
  const [selectedQuoteText, setSelectedQuoteText] = useState('');
  const [showQuoteEditor, setShowQuoteEditor] = useState(false);
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
  const [stickerPacks, setStickerPacks] = useState<Array<{ key: string; title: string; items: string[] }>>([]);
  const [stickerUsage, setStickerUsage] = useState<Record<string, number>>({});
  const [emojiUsage, setEmojiUsage] = useState<Record<string, number>>({});
  const activeContactRef = useRef<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const voiceStreamRef = useRef<MediaStream | null>(null);
  const voiceChunksRef = useRef<Blob[]>([]);
  const voiceTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const quoteSelectionRef = useRef<HTMLDivElement | null>(null);
  const requestedContactId = searchParams?.get('contactId') || null;
  const currentUserId = user?.id || null;
  const [pageError, setPageError] = useState('');

  const msg = useMessages({ socketRef, token, currentUserId, activeContactId, pinnedChatIds, setPageError, setSidebarItems });

  const callHook = useCall({ socketRef, setPageError });

  const { iceServers } = useChatSocket({
    socketRef,
    token,
    user,
    currentUserId,
    activeContactId,
    setPageError,
    onMessageNew: msg.handleIncomingMessage,
    onMessageStatus: msg.handleMessageStatus,
    onMessageUpdate: msg.handleMessageUpdate,
    onPresenceSync: (list) => setSidebarItems((prev) => prev.map((c) => { const p = list.find((e) => e.id === c.id); return p ? { ...c, online: p.online, lastSeenAt: p.lastSeenAt } : c; })),
    onPresenceUpdate: ({ id, online, lastSeenAt }) => setSidebarItems((prev) => prev.map((c) => (c.id === id ? { ...c, online, lastSeenAt } : c))),
    onGroupNew: (g) => setSidebarItems((prev) => sortContactsWithPins([g, ...prev.filter((c) => c.id !== g.id)], pinnedChatIds)),
    onGroupUpdate: (g) => setSidebarItems((prev) => sortContactsWithPins(prev.map((c) => (c.id === g.id ? { ...c, ...g } : c)), pinnedChatIds)),
    onGroupRemoved: (groupId) => { const tid = `group:${groupId}`; setSidebarItems((prev) => prev.filter((c) => c.id !== tid)); if (activeContactId === tid) { setActiveContactId(null); msg.setMessages([]); msg.setPinnedMessages([]); setShowDialogProfile(false); } },
    onCallIncoming: callHook.handleCallIncoming,
    onCallEnded: callHook.handleCallEndedCallback,
    onGroupCallIncoming: callHook.handleGroupCallIncoming,
    onGroupCallEnded: callHook.handleGroupCallEndedCallback,
    loadGroupDetails: (id) => loadGroupDetails(id),
    showDialogProfile,
  });

  const messages = msg.messages;
  const setMessages = msg.setMessages;
  const pinnedMessages = msg.pinnedMessages;
  const setPinnedMessages = msg.setPinnedMessages;
  const hasMoreMessages = msg.hasMoreMessages;
  const isLoadingMessages = msg.isLoadingMessages;
  const isLoadingOlderMessages = msg.isLoadingOlderMessages;
  const editingMessageId = msg.editingMessageId;
  const setEditingMessageId = msg.setEditingMessageId;
  const editingText = msg.editingText;
  const setEditingText = msg.setEditingText;
  const messageSearchQuery = msg.messageSearchQuery;
  const setMessageSearchQuery = msg.setMessageSearchQuery;
  const showMessageSearch = msg.showMessageSearch;
  const setShowMessageSearch = msg.setShowMessageSearch;
  const highlightedMessageId = msg.highlightedMessageId;
  const jumpTargetMessageId = msg.jumpTargetMessageId;
  const setJumpTargetMessageId = msg.setJumpTargetMessageId;
  const actionMessageId = msg.actionMessageId;
  const setActionMessageId = msg.setActionMessageId;
  const messageAreaRef = msg.messageAreaRef;
  const messagesEndRef = msg.messagesEndRef;
  const registerMessageNode = msg.registerMessageNode;
  const loadOlderMessages = msg.loadOlderMessages;
  const jumpToMessage = msg.jumpToMessage;
  const toggleReaction = msg.toggleReaction;
  const togglePinnedMessage = msg.togglePinnedMessage;
  const submitEdit = msg.submitEdit;
  const deleteMessage = msg.deleteMessage;
  const openMessageActions = msg.openMessageActions;
  const startLongPress = msg.startLongPress;
  const stopLongPress = msg.stopLongPress;
  const visibleMessages = msg.visibleMessages;
  const galleryImages = msg.galleryImages;

  const callSession = callHook.callSession;
  const callOverlayVisible = callHook.callOverlayVisible;
  const groupCallSession = callHook.groupCallSession;
  const handleCloseCall = callHook.handleCloseCall;
  const handleCloseGroupCall = callHook.handleCloseGroupCall;
  const handleMinimizeCall = callHook.handleMinimizeCall;
  const handleRestoreCall = callHook.handleRestoreCall;
  const startCall = (mode: 'audio' | 'video') => callHook.startCall(mode, activeContact!);
  const startGroupCall = (mode: 'audio' | 'video') => callHook.startGroupCall(mode, activeContact!);

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
    const response = await apiFetch<{ dialogs?: Contact[]; users?: Contact[] }>(endpoint);
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

    const response = await apiFetch<{ dialogs: Contact[] }>('/api/dialogs');
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

  useEffect(() => () => {
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
  const visibleSidebarItems = useMemo(() => {
    if (dialogScope === 'direct') {
      return sidebarItems.filter((contact) => contact.type !== 'group');
    }

    if (dialogScope === 'group') {
      return sidebarItems.filter((contact) => contact.type === 'group');
    }

    return sidebarItems;
  }, [dialogScope, sidebarItems]);

  const selectedMessages = useMemo(
    () => messages.filter((message) => selectedMessageIds.includes(message.id)),
    [messages, selectedMessageIds],
  );

  const deferredMessageSearchQuery = useDeferredValue(messageSearchQuery);

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

  const showUnifiedMobilePicker = isMobileLayout && (showEmojiPicker || showStickerPicker);

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
      const response = await apiFetch<GroupDetails>(`/api/groups/${groupId}`);
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
    if (!showDialogProfile || !activeContactId || !isGroupContact(activeContactId)) {
      setGroupMembers([]);
      setGroupAvailableContacts([]);
      setGroupAddSearchQuery('');
      return;
    }

    loadGroupDetails(activeContactId);
  }, [activeContactId, loadGroupDetails, showDialogProfile]);

  const handleSelectContact = (contactId: string) => {
    if (activeContactId && activeContactId !== contactId) {
      setDraftsByContact((prev) => ({ ...prev, [activeContactId]: inputText }));
    }

    setSidebarItems((prev) =>
      prev.map((contact) =>
        contact.id === contactId && !isGroupContact(contactId)
          ? { ...contact, unreadCount: 0 }
          : contact,
      ),
    );
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

  const stopVoiceRecording = async () => {
    const recorder = mediaRecorderRef.current;
    if (!recorder) {
      return;
    }

    const result = await new Promise<{ blob: Blob; mimeType: string; durationSeconds: number } | null>((resolve) => {
      recorder.onstop = () => {
        const blob = new Blob(voiceChunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        voiceChunksRef.current = [];

        resolve({
          blob,
          mimeType: recorder.mimeType || 'audio/webm',
          durationSeconds: voiceSeconds,
        });
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

    setIsUploadingFile(true);
    setPageError('');

    let uploadedAttachment: NonNullable<ChatMessage['attachment']>;

    try {
      const voiceFile = new File([result.blob], `voice-${Date.now()}.webm`, {
        type: result.mimeType || 'audio/webm',
      });
      uploadedAttachment = await uploadAttachment(voiceFile);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : 'Не удалось загрузить голосовое сообщение');
      setIsUploadingFile(false);
      setVoiceSeconds(0);
      return;
    }

    socketRef.current.emit(
      'message:send',
      {
        recipientId: activeContact.id,
        kind: 'voice',
        voice: {
          audioUrl: uploadedAttachment.fileUrl,
          durationSeconds: result.durationSeconds,
        },
        attachment: uploadedAttachment,
        replyToMessageId: replyMessage?.id,
        replyQuote,
      },
      (response: { ok: boolean; error?: string; message?: ChatMessage }) => {
        setIsUploadingFile(false);

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
      setPageError(`Файл ${tooLargeFile.name} слишком большой. Пока лимит 75 MB`);
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

    setShowStickerPicker(false);
    setShowEmojiPicker(false);

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
      },
    );
  };

  if (isLoading || !user) {
    return null;
  }

  return (
    <>
      <div className={styles.chatPage}>
        <ChatSidebar
          sidebarItems={visibleSidebarItems}
          activeContactId={activeContactId}
          searchQuery={searchQuery}
          pinnedChatIds={pinnedChatIds}
          showMobileChat={showMobileChat}
          dialogScope={dialogScope}
          onSearchChange={setSearchQuery}
          onOpenCreateGroup={() => setShowCreateGroupModal(true)}
          onScopeChange={setDialogScope}
          onSelectContact={handleSelectContact}
          onTogglePin={togglePinnedChat}
        />

        <section className={`${styles.panel} ${showMobileChat ? styles.panelVisibleMobile : styles.panelHiddenMobile}`}>
          {activeContact ? (
            <>
              <ChatHeader
                contact={activeContact}
                isMobileLayout={isMobileLayout}
                isActiveChatPinned={isActiveChatPinned}
                isActiveGroupChat={isActiveGroupChat}
                onBack={() => setShowMobileChat(false)}
                onToggleSearch={() => setShowMessageSearch((prev) => !prev)}
                onShowProfile={() => setShowDialogProfile(true)}
                onTogglePin={() => togglePinnedChat(activeContact.id)}
                onStartDirectCall={startCall}
                onStartGroupCall={startGroupCall}
              />

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

              <MessageTimeline
                messageAreaRef={messageAreaRef}
                messagesEndRef={messagesEndRef}
                visibleMessages={visibleMessages}
                hasMoreMessages={hasMoreMessages}
                isLoadingOlderMessages={isLoadingOlderMessages}
                isLoadingMessages={isLoadingMessages}
                isDragOver={isDragOver}
                messageSearchQuery={messageSearchQuery}
                jumpToMessageId={jumpTargetMessageId}
                activeContact={activeContact}
                currentUserId={user.id}
                editingMessageId={editingMessageId}
                editingText={editingText}
                actionMessageId={actionMessageId}
                selectedMessageIds={selectedMessageIds}
                selectionMode={selectionMode}
                highlightedMessageId={highlightedMessageId}
                isMobileLayout={isMobileLayout}
                orderedEmojis={orderedEmojis}
                onLoadOlderMessages={loadOlderMessages}
                onDragEnter={handleDragEnter}
                onDragLeave={handleDragLeave}
                onDropFiles={handleDropFiles}
                onRegisterMessageNode={registerMessageNode}
                onToggleMessageSelection={toggleMessageSelection}
                onOpenMessageActions={openMessageActions}
                onStartLongPress={startLongPress}
                onStopLongPress={stopLongPress}
                onEditingTextChange={setEditingText}
                onSubmitEdit={submitEdit}
                onCancelEdit={() => { setEditingMessageId(null); setEditingText(''); }}
                onJumpToMessage={jumpToMessage}
                onJumpHandled={() => setJumpTargetMessageId(null)}
                onToggleReaction={(messageId, emoji) => { toggleReaction(messageId, emoji); setActionMessageId(null); }}
                onBeginReply={beginReply}
                onTogglePinnedMessage={togglePinnedMessage}
                onBeginQuote={beginQuote}
                onBeginEdit={(message) => { setEditingMessageId(message.id); setEditingText(message.content); setActionMessageId(null); }}
                onSelectMessageForActions={(messageId) => { setSelectionMode(true); setSelectedMessageIds([messageId]); setActionMessageId(null); }}
                onDeleteMessage={deleteMessage}
                onPreviewImage={setPreviewImage}
                getReplySnippet={getReplySnippet}
                getMessageAuthorLabel={getMessageAuthorLabel}
                getFileBadgeLabel={getFileBadgeLabel}
                getOwnStatusText={getOwnStatusText}
                formatFileSize={formatFileSize}
                isAttachmentExpired={isAttachmentExpired}
                getMessageDayKey={getMessageDayKey}
                getTimelineDateLabel={getTimelineDateLabel}
              />

              <ChatComposer
                pageError={pageError}
                selectionMode={selectionMode}
                selectedMessageIds={selectedMessageIds}
                showForwardPicker={showForwardPicker}
                sidebarItems={sidebarItems}
                isForwardingMessages={isForwardingMessages}
                uploadProgress={uploadProgress}
                replyMessage={replyMessage}
                replyQuote={replyQuote}
                showQuoteEditor={showQuoteEditor}
                quoteDraft={quoteDraft}
                selectedQuoteText={selectedQuoteText}
                showUnifiedMobilePicker={showUnifiedMobilePicker}
                mobilePickerTab={mobilePickerTab}
                orderedEmojis={orderedEmojis}
                orderedStickerPacks={orderedStickerPacks}
                isMobileLayout={isMobileLayout}
                isUploadingFile={isUploadingFile}
                showStickerPicker={showStickerPicker}
                showEmojiPicker={showEmojiPicker}
                inputText={inputText}
                isRecordingVoice={isRecordingVoice}
                voiceSeconds={voiceSeconds}
                activeContactId={activeContactId}
                getMessagePreview={getMessagePreview}
                onToggleForwardPicker={() => setShowForwardPicker((prev) => !prev)}
                onClearMessageSelection={clearMessageSelection}
                onForwardMessages={forwardMessagesToContact}
                onOpenQuoteEditor={openQuoteEditor}
                onClearReply={clearReply}
                onCancelQuoteEditor={() => { setReplyQuote(''); setSelectedQuoteText(''); setShowQuoteEditor(false); }}
                onApplyQuoteSelection={applyQuoteSelection}
                onSetMobilePickerTab={(tab) => { setMobilePickerTab(tab); setShowEmojiPicker(tab === 'emoji'); setShowStickerPicker(tab === 'sticker'); }}
                onAppendEmoji={appendEmoji}
                onSendSticker={sendSticker}
                onSubmitMessage={submitMessage}
                onInputTextChange={(nextValue) => {
                  setInputText(nextValue);
                  if (activeContactId) {
                    setDraftsByContact((prev) => ({ ...prev, [activeContactId]: nextValue }));
                  }
                }}
                onComposerKeyDown={handleComposerKeyDown}
                onOpenFilePicker={openFilePicker}
                onToggleStickerPicker={() => { setShowStickerPicker((prev) => !prev); setShowEmojiPicker(false); }}
                onToggleEmojiPicker={() => { setShowEmojiPicker((prev) => !prev); setShowStickerPicker(false); }}
                onToggleMobileUnifiedPicker={() => {
                  const opening = !(showEmojiPicker || showStickerPicker);
                  setMobilePickerTab((prev) => prev || 'emoji');
                  setShowEmojiPicker(opening ? mobilePickerTab !== 'sticker' : false);
                  setShowStickerPicker(opening ? mobilePickerTab === 'sticker' : false);
                }}
                onStartVoiceRecording={startVoiceRecording}
                fileInputRef={fileInputRef}
                composerTextareaRef={composerTextareaRef}
                quoteSelectionRef={quoteSelectionRef}
                onSendFile={sendFile}
              />
            </>
          ) : (
            <div className={styles.empty}>
            <div className={styles.emptyCard}>
              <div className={styles.emptyIcon}>*</div>
              <h3 className={styles.emptyTitle}>Здесь появятся ваши чаты</h3>
              <p className={styles.emptyText}>Начните личный диалог, создайте группу или дождитесь первого сообщения, чтобы заполнить рабочее пространство.</p>
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

      {activeContact ? (
        <DialogProfileSheet
          activeContact={activeContact}
          isActiveChatPinned={isActiveChatPinned}
          isActiveGroupOwner={isActiveGroupOwner}
          showDialogProfile={showDialogProfile}
          groupMembers={groupMembers}
          isLoadingGroupDetails={isLoadingGroupDetails}
          filteredGroupAvailableContacts={filteredGroupAvailableContacts}
          groupAddSearchQuery={groupAddSearchQuery}
          isUpdatingGroupMembers={isUpdatingGroupMembers}
          galleryImages={galleryImages}
          groupedGalleryImages={groupedGalleryImages}
          getAvatarLabel={getAvatarLabel}
          getPresenceText={getPresenceText}
          onClose={() => setShowDialogProfile(false)}
          onTogglePinnedChat={() => togglePinnedChat(activeContact.id)}
          onOpenMessageSearch={() => { setShowDialogProfile(false); setShowMessageSearch(true); }}
          onLeaveGroup={leaveGroup}
          onDeleteGroup={deleteGroup}
          onUpdateGroupAddSearchQuery={setGroupAddSearchQuery}
          onUpdateGroupMembers={updateGroupMembers}
          onPreviewImage={setPreviewImage}
          onJumpToMessage={(messageId) => { setShowDialogProfile(false); jumpToMessage(messageId); }}
        />
      ) : null}

      {isMobileLayout && actionMessage && !actionMessage.deletedAt && actionMessage.kind !== 'call' ? (
        <MessageActionSheet
          actionMessage={actionMessage}
          currentUserId={user.id}
          orderedEmojis={orderedEmojis}
          getReplySnippet={getReplySnippet}
          getMessagePreview={getMessagePreview}
          onClose={() => setActionMessageId(null)}
          onToggleReaction={(messageId, emoji) => { toggleReaction(messageId, emoji); setActionMessageId(null); }}
          onReply={(message) => { beginReply(message); setActionMessageId(null); }}
          onTogglePinned={(message) => { togglePinnedMessage(message); setActionMessageId(null); }}
          onSelect={(messageId) => { setSelectionMode(true); setSelectedMessageIds([messageId]); setActionMessageId(null); }}
          onQuote={(message) => { beginQuote(message); setActionMessageId(null); }}
          onEdit={(message) => { setEditingMessageId(message.id); setEditingText(message.content); setActionMessageId(null); }}
          onDelete={(messageId) => { deleteMessage(messageId); setActionMessageId(null); }}
        />
      ) : null}
    </>
  );
}

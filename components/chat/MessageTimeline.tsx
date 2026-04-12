'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChatMessage, Contact } from '../../utils/api';
import styles from '../../styles/chat.module.css';

const TIMELINE_OVERSCAN_PX = 900;

type TimelineItem = { type: 'date'; key: string; label: string } | { type: 'message'; key: string; message: ChatMessage };

function estimateTimelineItemHeight(item: TimelineItem) {
  if (item.type === 'date') {
    return 52;
  }

  const message = item.message;
  if (message.kind === 'call') {
    return 88;
  }

  if (message.kind === 'voice') {
    return 132;
  }

  if (message.kind === 'file' && message.attachment?.mimeType?.startsWith('image/')) {
    return message.attachment.isSticker ? 220 : 300;
  }

  if (message.kind === 'file') {
    return 144;
  }

  const contentLength = Math.max(message.content.length, message.replyTo?.content?.length || 0, message.replyTo?.quote?.length || 0);
  return Math.min(220, 96 + Math.ceil(contentLength / 42) * 22);
}

function findTimelineIndexByOffset(offsets: number[], targetOffset: number) {
  let low = 0;
  let high = offsets.length - 1;
  let result = offsets.length;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (offsets[middle] >= targetOffset) {
      result = middle;
      high = middle - 1;
    } else {
      low = middle + 1;
    }
  }

  return result;
}

interface MessageTimelineProps {
  messageAreaRef: React.RefObject<HTMLDivElement>;
  messagesEndRef: React.RefObject<HTMLDivElement>;
  visibleMessages: ChatMessage[];
  hasMoreMessages: boolean;
  isLoadingOlderMessages: boolean;
  isLoadingMessages: boolean;
  isDragOver: boolean;
  messageSearchQuery: string;
  jumpToMessageId: string | null;
  activeContact: Contact | null;
  currentUserId: string;
  editingMessageId: string | null;
  editingText: string;
  actionMessageId: string | null;
  selectedMessageIds: string[];
  selectionMode: boolean;
  highlightedMessageId: string | null;
  isMobileLayout: boolean;
  orderedEmojis: string[];
  onLoadOlderMessages: () => void;
  onDragEnter: (event: React.DragEvent<HTMLElement>) => void;
  onDragLeave: (event: React.DragEvent<HTMLElement>) => void;
  onDropFiles: (event: React.DragEvent<HTMLDivElement>) => void;
  onRegisterMessageNode: (messageId: string, node: HTMLDivElement | null) => void;
  onToggleMessageSelection: (messageId: string) => void;
  onOpenMessageActions: (messageId: string) => void;
  onStartLongPress: (messageId: string) => void;
  onStopLongPress: () => void;
  onEditingTextChange: (value: string) => void;
  onSubmitEdit: (messageId: string) => void;
  onCancelEdit: () => void;
  onJumpToMessage: (messageId: string) => void;
  onJumpHandled: () => void;
  onToggleReaction: (messageId: string, emoji: string) => void;
  onBeginReply: (message: ChatMessage) => void;
  onTogglePinnedMessage: (message: ChatMessage) => void;
  onBeginQuote: (message: ChatMessage) => void;
  onBeginEdit: (message: ChatMessage) => void;
  onSelectMessageForActions: (messageId: string) => void;
  onDeleteMessage: (messageId: string) => void;
  onPreviewImage: (payload: { src: string; name: string }) => void;
  getReplySnippet: (message?: ChatMessage['replyTo'] | null) => string;
  getMessageAuthorLabel: (message: ChatMessage, currentUserId: string) => string;
  getFileBadgeLabel: (fileName: string, mimeType?: string) => string;
  getOwnStatusText: (message: ChatMessage) => string;
  formatFileSize: (sizeBytes: number) => string;
  isAttachmentExpired: (message: ChatMessage) => boolean;
  getMessageDayKey: (dateValue: string) => string;
  getTimelineDateLabel: (dateValue: string) => string;
}

export default function MessageTimeline(props: MessageTimelineProps) {
  const {
    messageAreaRef,
    messagesEndRef,
    visibleMessages,
    hasMoreMessages,
    isLoadingOlderMessages,
    isLoadingMessages,
    isDragOver,
    messageSearchQuery,
    jumpToMessageId,
    activeContact,
    currentUserId,
    editingMessageId,
    editingText,
    actionMessageId,
    selectedMessageIds,
    selectionMode,
    highlightedMessageId,
    isMobileLayout,
    orderedEmojis,
    onLoadOlderMessages,
    onDragEnter,
    onDragLeave,
    onDropFiles,
    onRegisterMessageNode,
    onToggleMessageSelection,
    onOpenMessageActions,
    onStartLongPress,
    onStopLongPress,
    onEditingTextChange,
    onSubmitEdit,
    onCancelEdit,
    onJumpToMessage,
    onJumpHandled,
    onToggleReaction,
    onBeginReply,
    onTogglePinnedMessage,
    onBeginQuote,
    onBeginEdit,
    onSelectMessageForActions,
    onDeleteMessage,
    onPreviewImage,
    getReplySnippet,
    getMessageAuthorLabel,
    getFileBadgeLabel,
    getOwnStatusText,
    formatFileSize,
    isAttachmentExpired,
    getMessageDayKey,
    getTimelineDateLabel,
  } = props;

  const timelineHeightsRef = useRef<Map<string, number>>(new Map());
  const timelineResizeObserversRef = useRef<Map<string, ResizeObserver>>(new Map());
  const previousBoundaryIdsRef = useRef<{ firstId: string | null; lastId: string | null }>({ firstId: null, lastId: null });
  const [timelineLayoutVersion, setTimelineLayoutVersion] = useState(0);
  const [timelineViewport, setTimelineViewport] = useState({ scrollTop: 0, height: 0 });
  const [showScrollToLatest, setShowScrollToLatest] = useState(false);

  const timelineItems = useMemo(() => {
    const items: TimelineItem[] = [];
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
  }, [getMessageDayKey, getTimelineDateLabel, visibleMessages]);

  const timelineMetrics = useMemo(() => {
    let totalHeight = 0;
    const offsets: number[] = [];
    const heights: number[] = [];
    const keyToOffset = new Map<string, number>();

    timelineItems.forEach((item, index) => {
      offsets[index] = totalHeight;
      keyToOffset.set(item.key, totalHeight);
      const nextHeight = timelineHeightsRef.current.get(item.key) || estimateTimelineItemHeight(item);
      heights[index] = nextHeight;
      totalHeight += nextHeight;
    });

    return { offsets, heights, totalHeight, keyToOffset };
  }, [timelineItems, timelineLayoutVersion]);

  const virtualTimelineRange = useMemo(() => {
    if (timelineItems.length === 0) {
      return { startIndex: 0, endIndex: 0, paddingTop: 0, paddingBottom: 0 };
    }

    const startOffset = Math.max(0, timelineViewport.scrollTop - TIMELINE_OVERSCAN_PX);
    const endOffset = timelineViewport.scrollTop + timelineViewport.height + TIMELINE_OVERSCAN_PX;
    const startIndex = Math.max(0, Math.min(timelineItems.length - 1, findTimelineIndexByOffset(timelineMetrics.offsets, startOffset + 1) - 1));
    const endIndex = Math.max(startIndex + 1, Math.min(timelineItems.length, findTimelineIndexByOffset(timelineMetrics.offsets, endOffset)));
    const paddingTop = timelineMetrics.offsets[startIndex] || 0;
    const renderedHeight = timelineMetrics.heights.slice(startIndex, endIndex).reduce((sum, value) => sum + value, 0);
    const paddingBottom = Math.max(0, timelineMetrics.totalHeight - paddingTop - renderedHeight);

    return { startIndex, endIndex, paddingTop, paddingBottom };
  }, [timelineItems.length, timelineMetrics.heights, timelineMetrics.offsets, timelineMetrics.totalHeight, timelineViewport.height, timelineViewport.scrollTop]);

  const renderedTimelineItems = useMemo(
    () => timelineItems.slice(virtualTimelineRange.startIndex, virtualTimelineRange.endIndex),
    [timelineItems, virtualTimelineRange.endIndex, virtualTimelineRange.startIndex],
  );

  useEffect(() => {
    const area = messageAreaRef.current;
    if (!area) {
      return;
    }

    const handleScroll = () => {
      const distanceFromBottom = area.scrollHeight - area.scrollTop - area.clientHeight;
      setShowScrollToLatest(distanceFromBottom > 240);
      setTimelineViewport({ scrollTop: area.scrollTop, height: area.clientHeight });
    };

    handleScroll();
    area.addEventListener('scroll', handleScroll);
    return () => area.removeEventListener('scroll', handleScroll);
  }, [messageAreaRef, visibleMessages.length]);

  useEffect(() => {
    timelineHeightsRef.current.clear();
    timelineResizeObserversRef.current.forEach((observer) => observer.disconnect());
    timelineResizeObserversRef.current.clear();
    setTimelineLayoutVersion((version) => version + 1);
  }, [activeContact?.id]);

  useEffect(() => {
    const nextFirstId = visibleMessages[0]?.id || null;
    const nextLastId = visibleMessages[visibleMessages.length - 1]?.id || null;
    const previous = previousBoundaryIdsRef.current;
    const appendedLatest = previous.lastId !== nextLastId || previous.firstId === null;

    if (appendedLatest) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }

    previousBoundaryIdsRef.current = { firstId: nextFirstId, lastId: nextLastId };
  }, [messagesEndRef, visibleMessages]);

  useEffect(() => {
    if (!jumpToMessageId) {
      return;
    }

    const target = messageAreaRef.current?.querySelector(`[data-message-id="${jumpToMessageId}"]`) as HTMLDivElement | null;
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      onJumpHandled();
      return;
    }

    const area = messageAreaRef.current;
    const estimatedOffset = timelineMetrics.keyToOffset.get(jumpToMessageId);
    if (area && estimatedOffset !== undefined) {
      area.scrollTo({ top: Math.max(0, estimatedOffset - area.clientHeight / 3), behavior: 'smooth' });
    }

    const settleTimer = window.setTimeout(() => {
      const nextTarget = messageAreaRef.current?.querySelector(`[data-message-id="${jumpToMessageId}"]`) as HTMLDivElement | null;
      nextTarget?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      onJumpHandled();
    }, 180);

    return () => window.clearTimeout(settleTimer);
  }, [jumpToMessageId, messageAreaRef, onJumpHandled, timelineMetrics.keyToOffset]);

  useEffect(() => () => {
    timelineResizeObserversRef.current.forEach((observer) => observer.disconnect());
    timelineResizeObserversRef.current.clear();
  }, []);

  const registerTimelineItemNode = (itemKey: string, node: HTMLDivElement | null) => {
    const currentObserver = timelineResizeObserversRef.current.get(itemKey);
    if (currentObserver) {
      currentObserver.disconnect();
      timelineResizeObserversRef.current.delete(itemKey);
    }

    if (!node) {
      return;
    }

    const updateHeight = () => {
      const nextHeight = Math.ceil(node.getBoundingClientRect().height);
      const previousHeight = timelineHeightsRef.current.get(itemKey);
      if (previousHeight === nextHeight || nextHeight <= 0) {
        return;
      }

      timelineHeightsRef.current.set(itemKey, nextHeight);
      setTimelineLayoutVersion((version) => version + 1);
    };

    updateHeight();

    if (typeof ResizeObserver === 'undefined') {
      return;
    }

    const observer = new ResizeObserver(() => updateHeight());
    observer.observe(node);
    timelineResizeObserversRef.current.set(itemKey, observer);
  };

  const scrollToLatest = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  };

  return (
    <div ref={messageAreaRef} className={`${styles.messageArea} ${isDragOver ? styles.messageAreaDragOver : ''}`} onDragEnter={onDragEnter} onDragOver={(event) => event.preventDefault()} onDragLeave={onDragLeave} onDrop={onDropFiles}>
      {isDragOver ? <div className={styles.dropOverlay}>Отпустите файлы, чтобы отправить в чат</div> : null}
      <div className={styles.messageStack}>
        {hasMoreMessages ? (
          <div className={styles.timelineDateRow}>
            <button type="button" className={styles.smallMutedButton} onClick={onLoadOlderMessages} disabled={isLoadingOlderMessages || isLoadingMessages}>
              {isLoadingOlderMessages ? 'Загружаем...' : 'Загрузить более ранние сообщения'}
            </button>
          </div>
        ) : null}
        {virtualTimelineRange.paddingTop > 0 ? <div style={{ height: virtualTimelineRange.paddingTop }} aria-hidden="true" /> : null}
        {renderedTimelineItems.map((item) => {
          if (item.type === 'date') {
            return (
              <div key={item.key} ref={(node) => registerTimelineItemNode(item.key, node)} className={styles.timelineMeasureRow}>
                <div className={styles.timelineDateRow}>
                  <div className={styles.timelineDateBadge}>{item.label}</div>
                </div>
              </div>
            );
          }

          const { message } = item;
          const ownMessage = message.senderId === currentUserId;
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
          const fileBadgeLabel = message.attachment ? getFileBadgeLabel(message.attachment.fileName, message.attachment.mimeType) : 'FILE';

          return (
            <div key={message.id} ref={(node) => registerTimelineItemNode(item.key, node)} className={styles.timelineMeasureRow}>
              <div className={isCallEvent ? styles.messageRowSystem : ownMessage ? styles.messageRowOwn : styles.messageRowPeer}>
                <div
                  ref={(node) => onRegisterMessageNode(message.id, node)}
                  data-message-id={message.id}
                  className={`${isCallEvent ? styles.messageBubbleSystem : ownMessage ? styles.messageBubbleOwn : styles.messageBubblePeer} ${(isPhotoMessage || isStickerMessage) ? styles.messageBubbleMedia : ''} ${isStickerMessage ? styles.messageBubbleSticker : ''} ${highlightedMessageId === message.id ? styles.messageBubbleHighlighted : ''}`}
                  style={selectedMessageIds.includes(message.id) ? { outline: '2px solid rgba(103, 132, 255, 0.95)', outlineOffset: '2px' } : undefined}
                  onClick={() => {
                    if (selectionMode && !isCallEvent && !message.deletedAt) {
                      onToggleMessageSelection(message.id);
                    }
                  }}
                  onContextMenu={(event) => {
                    if (message.deletedAt || isCallEvent) {
                      return;
                    }

                    event.preventDefault();
                    event.stopPropagation();
                    onOpenMessageActions(message.id);
                  }}
                  onTouchStart={() => {
                    if (message.deletedAt || isCallEvent) {
                      return;
                    }

                    onStartLongPress(message.id);
                  }}
                  onTouchEnd={onStopLongPress}
                  onTouchMove={onStopLongPress}
                >
                  {hasQuickActionButton ? (
                    <button
                      type="button"
                      className={styles.messageQuickAction}
                      onClick={(event) => {
                        event.stopPropagation();
                        onOpenMessageActions(message.id);
                      }}
                      aria-label="Действия с сообщением"
                      title="Действия"
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true" className={styles.iconSvg}><path d="M12 7a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm0 6.5A1.5 1.5 0 1 0 12 10a1.5 1.5 0 0 0 0 3.5Zm0 6.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z" fill="currentColor"/></svg>
                    </button>
                  ) : null}
                  {isEditing ? (
                    <div className={styles.editBox}>
                      <textarea value={editingText} onChange={(event) => onEditingTextChange(event.target.value)} className={styles.editInput} rows={3} />
                      <div className={styles.editActions}>
                        <button type="button" className={styles.smallButton} onClick={() => onSubmitEdit(message.id)}>Сохранить</button>
                        <button type="button" className={styles.smallMutedButton} onClick={onCancelEdit}>Отмена</button>
                      </div>
                    </div>
                  ) : (
                    <>
                      {message.replyTo ? (
                        <button type="button" className={styles.replyPreview} onClick={() => onJumpToMessage(message.replyTo!.id)}>
                          <span className={styles.replyAuthor}>{message.replyTo.senderId === currentUserId ? 'Вы' : (message.replyTo.senderName || activeContact?.displayName || activeContact?.username)}</span>
                          <span className={styles.replyText}>{getReplySnippet(message.replyTo)}</span>
                        </button>
                      ) : null}
                      {activeContact?.type === 'group' && !ownMessage ? <span className={styles.replyAuthor}>{getMessageAuthorLabel(message, currentUserId)}</span> : null}
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
                        <button type="button" className={styles.stickerCard} onClick={() => onPreviewImage({ src: message.attachment!.fileUrl, name: message.attachment!.fileName })}>
                          {isVideoStickerMessage ? (
                            <video src={message.attachment.fileUrl} className={styles.stickerImage} autoPlay muted loop playsInline preload="metadata" />
                          ) : (
                            <img src={message.attachment.fileUrl} alt={message.attachment.fileName} className={styles.stickerImage} loading="lazy" />
                          )}
                        </button>
                      ) : isImageMessage && message.attachment ? (
                        <button type="button" className={styles.imageCard} onClick={() => onPreviewImage({ src: message.attachment!.fileUrl, name: message.attachment!.fileName })}>
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
                              <button key={emoji} type="button" className={styles.reactionMenuEmoji} onClick={() => onToggleReaction(message.id, emoji)}>{emoji}</button>
                            ))}
                          </div>
                          <button type="button" className={styles.messageToolPrimary} onClick={() => onBeginReply(message)}>Ответить</button>
                          <button type="button" className={styles.messageTool} onClick={() => onTogglePinnedMessage(message)}>{message.pinnedAt ? 'Открепить' : 'Закрепить'}</button>
                          <button type="button" className={styles.messageTool} onClick={() => onSelectMessageForActions(message.id)}>Выбрать</button>
                          {message.kind === 'text' && !message.deletedAt ? <button type="button" className={styles.messageTool} onClick={() => onBeginQuote(message)}>Цитировать</button> : null}
                          {ownMessage && message.kind !== 'voice' && message.kind !== 'file' ? <button type="button" className={styles.messageTool} onClick={() => onBeginEdit(message)}>Изменить</button> : null}
                          {ownMessage ? <button type="button" className={styles.messageToolDanger} onClick={() => onDeleteMessage(message.id)}>Удалить</button> : null}
                        </div>
                      ) : null}
                      {!isCallEvent ? (
                        <div className={styles.reactionRow}>
                          {message.reactions?.map((reaction) => (
                            <button
                              key={reaction.emoji}
                              type="button"
                              className={`${styles.reactionChip} ${reaction.userIds.includes(currentUserId) ? styles.reactionChipActive : ''}`}
                              onClick={() => onToggleReaction(message.id, reaction.emoji)}
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
            </div>
          );
        })}
        {virtualTimelineRange.paddingBottom > 0 ? <div style={{ height: virtualTimelineRange.paddingBottom }} aria-hidden="true" /> : null}
        {visibleMessages.length === 0 && messageSearchQuery.trim() ? <div className={styles.searchEmptyState}>Ничего не найдено в этом диалоге</div> : null}
        {visibleMessages.length === 0 && !messageSearchQuery.trim() && !isLoadingMessages ? (
          <div className={styles.emptyChatState}>
            <div className={styles.emptyChatIcon}>&#9993;</div>
            <h3 className={styles.emptyChatTitle}>Пока тихо</h3>
            <p className={styles.emptyChatText}>Начните диалог — отправьте сообщение, стикер или голосовое</p>
          </div>
        ) : null}
        <div ref={messagesEndRef} />
      </div>
      {showScrollToLatest ? (
        <button type="button" className={styles.scrollToLatestButton} onClick={scrollToLatest} aria-label="Перейти к последнему сообщению" title="К последнему сообщению">
          ↓
        </button>
      ) : null}
    </div>
  );
}

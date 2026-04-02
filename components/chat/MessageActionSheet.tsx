'use client';

import type { ChatMessage } from '../../utils/api';
import styles from '../../styles/chat.module.css';

interface MessageActionSheetProps {
  actionMessage: ChatMessage;
  currentUserId: string;
  orderedEmojis: string[];
  getReplySnippet: (message?: ChatMessage['replyTo'] | null) => string;
  getMessagePreview: (message?: ChatMessage | null) => string;
  onClose: () => void;
  onToggleReaction: (messageId: string, emoji: string) => void;
  onReply: (message: ChatMessage) => void;
  onTogglePinned: (message: ChatMessage) => void;
  onSelect: (messageId: string) => void;
  onQuote: (message: ChatMessage) => void;
  onEdit: (message: ChatMessage) => void;
  onDelete: (messageId: string) => void;
}

export default function MessageActionSheet({
  actionMessage,
  currentUserId,
  orderedEmojis,
  getReplySnippet,
  getMessagePreview,
  onClose,
  onToggleReaction,
  onReply,
  onTogglePinned,
  onSelect,
  onQuote,
  onEdit,
  onDelete,
}: MessageActionSheetProps) {
  return (
    <div className={styles.mobileActionSheetBackdrop} onClick={onClose}>
      <div className={styles.mobileActionSheet} onClick={(event) => event.stopPropagation()}>
        <div className={styles.mobileActionSheetHandle} />
        <div className={styles.mobileActionSheetPreview}>
          {actionMessage.replyTo ? <p className={styles.mobileActionSheetReply}>Ответ на: {getReplySnippet(actionMessage.replyTo)}</p> : null}
          <p className={styles.mobileActionSheetText}>{getMessagePreview(actionMessage)}</p>
        </div>
        <div className={styles.mobileActionSheetReactions}>
          {orderedEmojis.map((emoji) => (
            <button key={emoji} type="button" className={styles.mobileActionSheetEmoji} onClick={() => onToggleReaction(actionMessage.id, emoji)}>{emoji}</button>
          ))}
        </div>
        <div className={styles.mobileActionSheetActions}>
          <button type="button" className={styles.mobileActionSheetPrimary} onClick={() => onReply(actionMessage)}>Ответить</button>
          <button type="button" className={styles.mobileActionSheetButton} onClick={() => onTogglePinned(actionMessage)}>{actionMessage.pinnedAt ? 'Открепить' : 'Закрепить'}</button>
          <button type="button" className={styles.mobileActionSheetButton} onClick={() => onSelect(actionMessage.id)}>Выбрать</button>
          {actionMessage.kind === 'text' ? <button type="button" className={styles.mobileActionSheetButton} onClick={() => onQuote(actionMessage)}>Цитировать</button> : null}
          {actionMessage.senderId === currentUserId && actionMessage.kind !== 'voice' && actionMessage.kind !== 'file' ? <button type="button" className={styles.mobileActionSheetButton} onClick={() => onEdit(actionMessage)}>Изменить</button> : null}
          {actionMessage.senderId === currentUserId ? <button type="button" className={styles.mobileActionSheetDanger} onClick={() => onDelete(actionMessage.id)}>Удалить</button> : null}
          <button type="button" className={styles.mobileActionSheetCancel} onClick={onClose}>Отмена</button>
        </div>
      </div>
    </div>
  );
}

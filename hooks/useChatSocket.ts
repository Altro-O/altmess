'use client';

import { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { type AuthUser, type ChatMessage, type Contact, apiFetch } from '../utils/api';

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302'] },
  { urls: ['stun:stun1.l.google.com:19302'] },
];

export interface UseChatSocketParams {
  socketRef: React.RefObject<Socket | null>;
  token: string | null;
  user: AuthUser | null;
  currentUserId: string | null;
  activeContactId: string | null;
  setPageError: (error: string) => void;
  onMessageNew: (message: ChatMessage) => void;
  onMessageStatus: (patch: Partial<ChatMessage> & { id: string }) => void;
  onMessageUpdate: (message: ChatMessage) => void;
  onPresenceSync: (list: Array<{ id: string; online: boolean; lastSeenAt: string | null }>) => void;
  onPresenceUpdate: (data: { id: string; online: boolean; lastSeenAt: string | null }) => void;
  onGroupNew: (group: Contact) => void;
  onGroupUpdate: (group: Contact) => void;
  onGroupRemoved: (groupId: string) => void;
  onCallIncoming: (data: { callId: string; mode: 'audio' | 'video'; fromUser: Contact }) => void;
  onCallEnded: (data: { callId: string }) => void;
  onGroupCallIncoming: (data: { groupId: string; mode: 'audio' | 'video'; title: string; fromUser: Contact }) => void;
  onGroupCallEnded: (data: { groupId: string }) => void;
  loadGroupDetails: (groupContactId: string) => void;
  showDialogProfile: boolean;
}

export function useChatSocket({
  socketRef,
  token,
  user,
  currentUserId,
  activeContactId,
  setPageError,
  onMessageNew,
  onMessageStatus,
  onMessageUpdate,
  onPresenceSync,
  onPresenceUpdate,
  onGroupNew,
  onGroupUpdate,
  onGroupRemoved,
  onCallIncoming,
  onCallEnded,
  onGroupCallIncoming,
  onGroupCallEnded,
  loadGroupDetails,
  showDialogProfile,
}: UseChatSocketParams) {
  const [iceServers, setIceServers] = useState<RTCIceServer[]>(DEFAULT_ICE_SERVERS);
  const [pageError, setLocalPageError] = useState('');

  const callbacksRef = useRef({
    onMessageNew,
    onMessageStatus,
    onMessageUpdate,
    onPresenceSync,
    onPresenceUpdate,
    onGroupNew,
    onGroupUpdate,
    onGroupRemoved,
    onCallIncoming,
    onCallEnded,
    onGroupCallIncoming,
    onGroupCallEnded,
    loadGroupDetails,
  });

  callbacksRef.current = {
    onMessageNew,
    onMessageStatus,
    onMessageUpdate,
    onPresenceSync,
    onPresenceUpdate,
    onGroupNew,
    onGroupUpdate,
    onGroupRemoved,
    onCallIncoming,
    onCallEnded,
    onGroupCallIncoming,
    onGroupCallEnded,
    loadGroupDetails,
  };

  const activeContactIdRef = useRef(activeContactId);
  activeContactIdRef.current = activeContactId;

  const showDialogProfileRef = useRef(showDialogProfile);
  showDialogProfileRef.current = showDialogProfile;

  useEffect(() => {
    if (!token || !user) {
      return;
    }

    let alive = true;

    const closeActiveCall = ({ callId }: { callId: string }) => {
      callbacksRef.current.onCallEnded({ callId });
    };

    const syncVisibility = () => {
      socketRef.current?.emit('client:visibility', { visible: document.visibilityState === 'visible' });
    };

    const bootstrap = async () => {
      try {
        const rtcResponse = await apiFetch<{ iceServers: RTCIceServer[] }>('/api/rtc/config');
        if (!alive) {
          return;
        }

        setIceServers(rtcResponse.iceServers);

        const socket = io({
          withCredentials: true,
          reconnection: true,
          reconnectionAttempts: Infinity,
          reconnectionDelay: 1000,
          reconnectionDelayMax: 5000,
          timeout: 20000,
        });
        (socketRef as React.MutableRefObject<Socket | null>).current = socket;

        socket.on('connect', () => {
          if (pageError === 'Не удалось подключиться к realtime-серверу') {
            setLocalPageError('');
            setPageError('');
          }
          syncVisibility();
        });
        document.addEventListener('visibilitychange', syncVisibility);
        window.addEventListener('focus', syncVisibility);
        window.addEventListener('blur', syncVisibility);

        socket.on('connect_error', () => {
          setLocalPageError('Не удалось подключиться к realtime-серверу');
        });

        socket.on('presence:sync', (presenceList: Array<{ id: string; online: boolean; lastSeenAt: string | null }>) => {
          callbacksRef.current.onPresenceSync(presenceList);
        });

        socket.on('presence:update', ({ id, online, lastSeenAt }: { id: string; online: boolean; lastSeenAt: string | null }) => {
          callbacksRef.current.onPresenceUpdate({ id, online, lastSeenAt });
        });

        socket.on('message:new', (message: ChatMessage) => {
          callbacksRef.current.onMessageNew(message);
        });

        socket.on('message:status', (patch: Partial<ChatMessage> & { id: string }) => {
          callbacksRef.current.onMessageStatus(patch);
        });

        socket.on('message:update', (message: ChatMessage) => {
          callbacksRef.current.onMessageUpdate(message);
        });

        socket.on('group:new', ({ group }: { group: Contact }) => {
          callbacksRef.current.onGroupNew(group);
        });

        socket.on('group:update', ({ group }: { group: Contact }) => {
          callbacksRef.current.onGroupUpdate(group);
          if (activeContactIdRef.current === group.id && showDialogProfileRef.current) {
            callbacksRef.current.loadGroupDetails(group.id);
          }
        });

        socket.on('group:removed', ({ groupId }: { groupId: string }) => {
          callbacksRef.current.onGroupRemoved(groupId);
        });

        socket.on('call:incoming', ({ callId, mode, fromUser }: { callId: string; mode: 'audio' | 'video'; fromUser: Contact }) => {
          callbacksRef.current.onCallIncoming({ callId, mode, fromUser });
        });

        socket.on('group-call:incoming', ({ groupId, mode, title, fromUser }: { groupId: string; mode: 'audio' | 'video'; title: string; fromUser: Contact }) => {
          callbacksRef.current.onGroupCallIncoming({ groupId, mode, title, fromUser });
        });

        socket.on('group-call:ended', ({ groupId }: { groupId: string }) => {
          callbacksRef.current.onGroupCallEnded({ groupId });
        });

        socket.on('call:ended', closeActiveCall);
        socket.on('call:rejected', closeActiveCall);
        socket.on('call:missed', closeActiveCall);
      } catch (error) {
        setLocalPageError(error instanceof Error ? error.message : 'Не удалось загрузить чат');
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
      (socketRef as React.MutableRefObject<Socket | null>).current = null;
    };
  }, [currentUserId, token, user]);

  return { iceServers };
}

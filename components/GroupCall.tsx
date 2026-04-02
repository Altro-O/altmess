'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import type { Contact } from '../utils/api';
import styles from '../styles/videoCall.module.css';
import UserAvatar from './UserAvatar';

const SPEAKING_THRESHOLD = 24;
const SPEAKING_RELEASE_THRESHOLD = 18;
const DOMINANT_SPEAKER_SWITCH_RATIO = 1.35;
const DOMINANT_SPEAKER_HOLD_MS = 1800;

export interface GroupCallSession {
  groupId: string;
  title: string;
  mode: 'audio' | 'video';
  initiator: boolean;
  incomingFrom?: Contact | null;
}

interface GroupCallProps {
  socket: Socket;
  call: GroupCallSession;
  currentUserId: string;
  iceServers: RTCIceServer[];
  onClose: () => void;
}

function getFallbackLabel(user: Pick<Contact, 'displayName' | 'username'>) {
  return (user.displayName || user.username || '?').slice(0, 2).toUpperCase();
}

function ParticipantTile({
  participant,
  isFeatured,
  isPinned,
  isActiveSpeaker,
  onPin,
}: {
  participant: { id: string; label: string; stream: MediaStream | null; hasVideo: boolean; fallback: string; isSelf: boolean };
  isFeatured: boolean;
  isPinned: boolean;
  isActiveSpeaker: boolean;
  onPin: () => void;
}) {
  return (
    <div className={`${styles.groupTile} ${isFeatured ? styles.groupTileFeatured : ''} ${isActiveSpeaker ? styles.groupTileSpeaking : ''}`}>
      {participant.hasVideo && participant.stream ? (
        <video
          className={`${styles.groupVideo} ${isFeatured ? styles.groupVideoFeatured : ''}`}
          ref={(node) => {
            if (node && participant.stream) {
              node.srcObject = participant.stream;
              node.muted = participant.isSelf;
              void node.play().catch(() => null);
            }
          }}
          playsInline
          autoPlay
          muted={participant.isSelf}
        />
      ) : (
        <div className={styles.audioStageMini}>{participant.fallback}</div>
      )}
      <div className={styles.groupTileLabel}>{participant.label}</div>
      <button type="button" className={`${styles.groupTilePin} ${isPinned ? styles.groupTilePinActive : ''}`} onClick={onPin}>
        {isPinned ? 'Открепить' : 'Закрепить'}
      </button>
      {!participant.isSelf && participant.stream ? (
        <audio
          ref={(node) => {
            if (node && participant.stream) {
              node.srcObject = participant.stream;
              node.muted = false;
              void node.play().catch(() => null);
            }
          }}
          autoPlay
          playsInline
          className={styles.remoteAudio}
        />
      ) : null}
    </div>
  );
}

export default function GroupCall({ socket, call, currentUserId, iceServers, onClose }: GroupCallProps) {
  const [phase, setPhase] = useState(call.initiator ? 'connecting' : 'incoming');
  const [notice, setNotice] = useState('');
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [videoEnabled, setVideoEnabled] = useState(call.mode === 'video');
  const [videoUnavailable, setVideoUnavailable] = useState(false);
  const [participants, setParticipants] = useState<Record<string, Contact>>({});
  const [remoteStreams, setRemoteStreams] = useState<Record<string, MediaStream>>({});
  const [pinnedParticipantId, setPinnedParticipantId] = useState<string | null>(null);
  const [activeSpeakerIds, setActiveSpeakerIds] = useState<string[]>([]);
  const [dominantSpeakerId, setDominantSpeakerId] = useState<string | null>(null);
  const peerConnectionsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const localStreamRef = useRef<MediaStream | null>(null);
  const closingRef = useRef(false);
  const pendingIceCandidatesRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserMapRef = useRef<Map<string, { analyser: AnalyserNode; source: MediaStreamAudioSourceNode; data: Uint8Array<ArrayBufferLike> }>>(new Map());
  const activeSpeakerIdsRef = useRef<string[]>([]);
  const dominantSpeakerIdRef = useRef<string | null>(null);
  const switchCandidateIdRef = useRef<string | null>(null);
  const switchCandidateSinceRef = useRef<number>(0);

  const activeParticipants = useMemo(
    () => Object.entries(participants).filter(([userId]) => userId !== currentUserId),
    [currentUserId, participants],
  );
  const participantCount = activeParticipants.length + 1;
  const participantEntries = useMemo(() => {
    const selfEntry = {
      id: 'self',
      label: 'Вы',
      stream: localStream,
      hasVideo: Boolean(localStream?.getVideoTracks().length),
      isSelf: true,
      fallback: videoUnavailable ? 'Без камеры' : 'Вы',
    };

    const others = activeParticipants.map(([userId, user]) => ({
      id: userId,
      label: user.displayName || user.username,
      stream: remoteStreams[userId] || null,
      hasVideo: Boolean(remoteStreams[userId]?.getVideoTracks().length),
      isSelf: false,
      fallback: getFallbackLabel(user),
    }));

    return [selfEntry, ...others];
  }, [activeParticipants, localStream, remoteStreams, videoUnavailable]);
  const featuredParticipantId = pinnedParticipantId || dominantSpeakerId || (participantCount > 6 ? participantEntries.find((participant) => !participant.isSelf)?.id || 'self' : null);
  const featuredParticipant = featuredParticipantId ? participantEntries.find((participant) => participant.id === featuredParticipantId) || participantEntries[0] : null;
  const railParticipants = featuredParticipant ? participantEntries.filter((participant) => participant.id !== featuredParticipant.id) : [];

  const ensureAudioContext = () => {
    if (typeof window === 'undefined') {
      return null;
    }

    if (!audioContextRef.current) {
      const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextClass) {
        return null;
      }
      audioContextRef.current = new AudioContextClass();
    }

    if (audioContextRef.current.state === 'suspended') {
      audioContextRef.current.resume().catch(() => null);
    }

    return audioContextRef.current;
  };

  const attachAudioAnalyser = (participantId: string, stream: MediaStream | null) => {
    if (!stream || !stream.getAudioTracks().length || analyserMapRef.current.has(participantId)) {
      return;
    }

    const context = ensureAudioContext();
    if (!context) {
      return;
    }

    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    analyserMapRef.current.set(participantId, { analyser, source, data: new Uint8Array(analyser.frequencyBinCount) });
  };

  const detachAudioAnalyser = (participantId: string) => {
    const entry = analyserMapRef.current.get(participantId);
    if (!entry) {
      return;
    }

    entry.source.disconnect();
    analyserMapRef.current.delete(participantId);
  };

  const createLocalMedia = async () => {
    let stream: MediaStream;

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: call.mode === 'video'
          ? {
              facingMode: { ideal: 'user' },
              width: { ideal: 640, max: 960 },
              height: { ideal: 360, max: 540 },
              frameRate: { ideal: 24, max: 30 },
            }
          : false,
      });
      setVideoUnavailable(false);
    } catch (error) {
      if (call.mode !== 'video') {
        throw error;
      }

      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      setVideoUnavailable(true);
      setVideoEnabled(false);
      setNotice('Не нашли видеокамеру, доступен только аудио канал');
    }

    localStreamRef.current = stream;
    setLocalStream(stream);
    attachAudioAnalyser('self', stream);
    return stream;
  };

  const cleanupPeer = (userId: string) => {
    const connection = peerConnectionsRef.current.get(userId);
    if (connection) {
      connection.onicecandidate = null;
      connection.ontrack = null;
      connection.close();
      peerConnectionsRef.current.delete(userId);
    }
    pendingIceCandidatesRef.current.delete(userId);
    detachAudioAnalyser(userId);
    setRemoteStreams((prev) => {
      const next = { ...prev };
      delete next[userId];
      return next;
    });
  };

  const cleanupAll = () => {
    peerConnectionsRef.current.forEach((connection) => connection.close());
    peerConnectionsRef.current.clear();
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    setLocalStream(null);
    setRemoteStreams({});
    analyserMapRef.current.forEach((entry) => entry.source.disconnect());
    analyserMapRef.current.clear();
    audioContextRef.current?.close().catch(() => null);
    audioContextRef.current = null;
  };

  const ensurePeerConnection = (user: Contact) => {
    const existing = peerConnectionsRef.current.get(user.id);
    if (existing) {
      return existing;
    }

    const connection = new RTCPeerConnection({ iceServers });
    localStreamRef.current?.getTracks().forEach((track) => connection.addTrack(track, localStreamRef.current!));

    connection.onicecandidate = (event) => {
      if (!event.candidate) {
        return;
      }

      socket.emit('group-call:ice-candidate', {
        groupId: call.groupId,
        targetUserId: user.id,
        candidate: event.candidate,
      });
    };

    connection.ontrack = (event) => {
      const [stream] = event.streams;
      if (!stream) {
        return;
      }

      setRemoteStreams((prev) => ({ ...prev, [user.id]: stream }));
      attachAudioAnalyser(user.id, stream);
    };

    if (call.mode === 'video' && localStreamRef.current?.getVideoTracks().length === 0) {
      connection.addTransceiver('video', { direction: 'recvonly' });
    }

    peerConnectionsRef.current.set(user.id, connection);
    return connection;
  };

  const flushPendingIceCandidates = async (userId: string, connection: RTCPeerConnection) => {
    const pending = pendingIceCandidatesRef.current.get(userId) || [];
    if (pending.length === 0) {
      return;
    }

    for (const candidate of pending) {
      await connection.addIceCandidate(new RTCIceCandidate(candidate));
    }

    pendingIceCandidatesRef.current.delete(userId);
  };

  const createOfferForUser = async (user: Contact) => {
    const connection = ensurePeerConnection(user);
    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    socket.emit('group-call:offer', {
      groupId: call.groupId,
      targetUserId: user.id,
      offer,
    });
  };

  const joinCall = async () => {
    try {
      setNotice('Подключаем группу...');
      localStreamRef.current || await createLocalMedia();
      await new Promise<void>((resolve, reject) => {
        socket.emit('group-call:join', { groupId: call.groupId }, async (response: { ok: boolean; error?: string; room?: { participants: Contact[] } }) => {
          if (!response?.ok || !response.room) {
            reject(new Error(response?.error || 'Не удалось войти в групповой звонок'));
            return;
          }

          const participantMap = response.room.participants.reduce<Record<string, Contact>>((acc, participant) => {
            acc[participant.id] = participant;
            return acc;
          }, {});
          setParticipants((prev) => ({ ...prev, ...participantMap }));

          resolve();
        });
      });

      setPhase('active');
      setNotice('');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Не удалось подключиться к групповому звонку');
      setPhase('error');
    }
  };

  useEffect(() => {
    if (!call.initiator) {
      return;
    }

    joinCall();
  }, [call.initiator]);

  useEffect(() => {
    const handleIncomingOffer = async ({ groupId, fromUserId, offer }: { groupId: string; fromUserId: string; offer: RTCSessionDescriptionInit }) => {
      if (groupId !== call.groupId) {
        return;
      }

      const user = participants[fromUserId] || {
        id: fromUserId,
        username: 'Участник',
        displayName: 'Участник',
        email: '',
        online: false,
      };

      if (!participants[fromUserId]) {
        setParticipants((prev) => ({ ...prev, [fromUserId]: user }));
      }

      const connection = ensurePeerConnection(user);
      await connection.setRemoteDescription(new RTCSessionDescription(offer));
      await flushPendingIceCandidates(fromUserId, connection);
      const answer = await connection.createAnswer();
      await connection.setLocalDescription(answer);
      socket.emit('group-call:answer', {
        groupId: call.groupId,
        targetUserId: fromUserId,
        answer,
      });
    };

    const handleIncomingAnswer = async ({ groupId, fromUserId, answer }: { groupId: string; fromUserId: string; answer: RTCSessionDescriptionInit }) => {
      if (groupId !== call.groupId) {
        return;
      }

      const connection = peerConnectionsRef.current.get(fromUserId);
      if (!connection) {
        return;
      }

      await connection.setRemoteDescription(new RTCSessionDescription(answer));
      await flushPendingIceCandidates(fromUserId, connection);
    };

    const handleIncomingCandidate = async ({ groupId, fromUserId, candidate }: { groupId: string; fromUserId: string; candidate: RTCIceCandidateInit }) => {
      if (groupId !== call.groupId) {
        return;
      }

      const connection = peerConnectionsRef.current.get(fromUserId);
      if (!connection) {
        pendingIceCandidatesRef.current.set(fromUserId, [
          ...(pendingIceCandidatesRef.current.get(fromUserId) || []),
          candidate,
        ]);
        return;
      }

      if (!connection.remoteDescription) {
        pendingIceCandidatesRef.current.set(fromUserId, [
          ...(pendingIceCandidatesRef.current.get(fromUserId) || []),
          candidate,
        ]);
        return;
      }

      await connection.addIceCandidate(new RTCIceCandidate(candidate));
    };

    const handleUserJoined = ({ groupId, user }: { groupId: string; user: Contact }) => {
      if (groupId !== call.groupId || user.id === currentUserId) {
        return;
      }

      setParticipants((prev) => ({ ...prev, [user.id]: user }));

      if (localStreamRef.current && phase === 'active') {
        createOfferForUser(user).catch((error) => {
          console.error('Failed to create group call offer for joined user:', error);
        });
      }
    };

    const handleUserLeft = ({ groupId, userId }: { groupId: string; userId: string }) => {
      if (groupId !== call.groupId) {
        return;
      }

      cleanupPeer(userId);
      setParticipants((prev) => {
        const next = { ...prev };
        delete next[userId];
        return next;
      });
    };

    const handleEnded = ({ groupId }: { groupId: string }) => {
      if (groupId !== call.groupId) {
        return;
      }

      cleanupAll();
      onClose();
    };

    socket.on('group-call:offer', handleIncomingOffer);
    socket.on('group-call:answer', handleIncomingAnswer);
    socket.on('group-call:ice-candidate', handleIncomingCandidate);
    socket.on('group-call:user-joined', handleUserJoined);
    socket.on('group-call:user-left', handleUserLeft);
    socket.on('group-call:ended', handleEnded);

    return () => {
      socket.off('group-call:offer', handleIncomingOffer);
      socket.off('group-call:answer', handleIncomingAnswer);
      socket.off('group-call:ice-candidate', handleIncomingCandidate);
      socket.off('group-call:user-joined', handleUserJoined);
      socket.off('group-call:user-left', handleUserLeft);
      socket.off('group-call:ended', handleEnded);
    };
  }, [call.groupId, currentUserId, onClose, participants, phase, socket]);

  useEffect(() => () => {
    if (!closingRef.current) {
      socket.emit('group-call:leave', { groupId: call.groupId });
    }
    cleanupAll();
  }, [call.groupId, socket]);

  useEffect(() => {
    const interval = setInterval(() => {
      const levels = new Map<string, number>();

      analyserMapRef.current.forEach((entry, participantId) => {
        entry.analyser.getByteFrequencyData(entry.data as unknown as Uint8Array<ArrayBuffer>);
        const avg = entry.data.reduce((sum, value) => sum + value, 0) / Math.max(entry.data.length, 1);
        levels.set(participantId, avg);
      });

      const now = Date.now();
      const nextActiveSpeakerIds = Array.from(levels.entries())
        .filter(([participantId, level]) => {
          if (participantId === 'self') {
            return false;
          }

          const wasActive = activeSpeakerIdsRef.current.includes(participantId);
          return level >= SPEAKING_THRESHOLD || (wasActive && level >= SPEAKING_RELEASE_THRESHOLD);
        })
        .sort((left, right) => right[1] - left[1])
        .map(([participantId]) => participantId);

      const loudestActiveId = nextActiveSpeakerIds[0] || null;
      const loudestActiveLevel = loudestActiveId ? levels.get(loudestActiveId) || 0 : 0;
      const currentDominantId = dominantSpeakerIdRef.current;
      const currentDominantLevel = currentDominantId ? levels.get(currentDominantId) || 0 : 0;

      let nextDominantSpeakerId = currentDominantId;
      if (!currentDominantId || !nextActiveSpeakerIds.includes(currentDominantId)) {
        nextDominantSpeakerId = loudestActiveId;
        switchCandidateIdRef.current = null;
        switchCandidateSinceRef.current = 0;
      } else if (loudestActiveId && loudestActiveId !== currentDominantId && loudestActiveLevel > currentDominantLevel * DOMINANT_SPEAKER_SWITCH_RATIO) {
        if (switchCandidateIdRef.current !== loudestActiveId) {
          switchCandidateIdRef.current = loudestActiveId;
          switchCandidateSinceRef.current = now;
        } else if (now - switchCandidateSinceRef.current >= DOMINANT_SPEAKER_HOLD_MS) {
          nextDominantSpeakerId = loudestActiveId;
          switchCandidateIdRef.current = null;
          switchCandidateSinceRef.current = 0;
        }
      } else {
        switchCandidateIdRef.current = null;
        switchCandidateSinceRef.current = 0;
      }

      if (nextActiveSpeakerIds.length === 0) {
        nextDominantSpeakerId = null;
        switchCandidateIdRef.current = null;
        switchCandidateSinceRef.current = 0;
      }

      activeSpeakerIdsRef.current = nextActiveSpeakerIds;
      dominantSpeakerIdRef.current = nextDominantSpeakerId;
      setActiveSpeakerIds(nextActiveSpeakerIds);
      setDominantSpeakerId(nextDominantSpeakerId);
    }, 350);

    return () => clearInterval(interval);
  }, []);

  const leaveCall = () => {
    closingRef.current = true;
    socket.emit('group-call:leave', { groupId: call.groupId }, () => {
      cleanupAll();
      onClose();
    });
  };

  const acceptIncomingCall = async () => {
    await joinCall();
  };

  const declineIncomingCall = () => {
    onClose();
  };

  const toggleAudio = () => {
    localStreamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = !track.enabled;
      setAudioEnabled(track.enabled);
    });
  };

  const toggleVideo = () => {
    localStreamRef.current?.getVideoTracks().forEach((track) => {
      track.enabled = !track.enabled;
      setVideoEnabled(track.enabled);
    });
  };

  return (
    <div className={styles.overlay} style={{ display: 'block' }}>
      <div className={styles.backdrop} />

      {phase === 'incoming' ? (
        <div className={styles.incoming}>
          <div className={styles.incomingCard}>
            <UserAvatar
              avatarUrl={call.incomingFrom?.avatarUrl}
              alt={call.incomingFrom?.displayName || call.incomingFrom?.username || call.title}
              fallback={call.incomingFrom ? getFallbackLabel(call.incomingFrom) : call.title.slice(0, 2).toUpperCase()}
              className={`${styles.incomingAvatar} ${styles[`incomingAvatar_${call.incomingFrom?.avatarColor || 'berry'}`]}`}
              imageClassName={styles.incomingAvatarImage}
            />
            <h3 className={styles.incomingTitle}>{call.mode === 'video' ? 'Групповой видеозвонок' : 'Групповой аудиозвонок'}</h3>
            <p className={styles.incomingText}>{call.incomingFrom?.displayName || call.incomingFrom?.username} приглашает в {call.title}</p>
            <div className={styles.incomingActions}>
              <button className={styles.dangerWide} onClick={declineIncomingCall}><span className={styles.controlLabel}>Отклонить</span></button>
              <button className={styles.acceptWide} onClick={acceptIncomingCall}><span className={styles.controlLabel}>Войти</span></button>
            </div>
          </div>
        </div>
      ) : (
        <div className={styles.callScreen}>
          <div className={styles.topBar}>
            <strong>{call.title}</strong>
            <span>{call.mode === 'video' ? 'Групповой видеозвонок' : 'Групповой аудиозвонок'}</span>
            <span>Участников в звонке: {activeParticipants.length + 1}</span>
            <span>{['Вы', ...activeParticipants.map(([, user]) => user.displayName || user.username)].join(' • ')}</span>
            {activeSpeakerIds.length > 0 ? <span>Сейчас говорят: {activeSpeakerIds.map((participantId) => participantEntries.find((participant) => participant.id === participantId)?.label || 'Участник').join(', ')}</span> : null}
            {dominantSpeakerId ? <span>В фокусе: {participantEntries.find((participant) => participant.id === dominantSpeakerId)?.label || 'Участник'}</span> : null}
            {notice ? <p className={styles.notice}>{notice}</p> : null}
          </div>

          <div className={styles.groupStage}>
            {featuredParticipant ? (
              <div className={styles.groupFeaturedLayout}>
                <ParticipantTile
                  participant={featuredParticipant}
                  isFeatured
                  isPinned={pinnedParticipantId === featuredParticipant.id}
                  isActiveSpeaker={activeSpeakerIds.includes(featuredParticipant.id)}
                  onPin={() => setPinnedParticipantId((prev) => (prev === featuredParticipant.id ? null : featuredParticipant.id))}
                />
                <div className={styles.groupParticipantRail}>
                  {railParticipants.map((participant) => (
                    <ParticipantTile
                      key={participant.id}
                      participant={participant}
                      isFeatured={false}
                      isPinned={pinnedParticipantId === participant.id}
                      isActiveSpeaker={activeSpeakerIds.includes(participant.id)}
                      onPin={() => setPinnedParticipantId((prev) => (prev === participant.id ? null : participant.id))}
                    />
                  ))}
                </div>
              </div>
            ) : (
              <div className={`${styles.groupGrid} ${participantCount <= 2 ? styles.groupGridTwo : participantCount <= 4 ? styles.groupGridFour : styles.groupGridCrowded}`}>
                {participantEntries.map((participant) => (
                  <ParticipantTile
                    key={participant.id}
                    participant={participant}
                    isFeatured={false}
                    isPinned={pinnedParticipantId === participant.id}
                    isActiveSpeaker={activeSpeakerIds.includes(participant.id)}
                    onPin={() => setPinnedParticipantId((prev) => (prev === participant.id ? null : participant.id))}
                  />
                ))}
              </div>
            )}
          </div>

          <div className={styles.controls}>
            <button className={styles.controlWide} onClick={toggleAudio}><span className={styles.controlTitle}>{audioEnabled ? 'Микрофон вкл' : 'Микрофон выкл'}</span></button>
            {call.mode === 'video' ? <button className={styles.controlWide} onClick={toggleVideo}><span className={styles.controlTitle}>{videoEnabled ? 'Камера вкл' : 'Камера выкл'}</span></button> : null}
            <button className={styles.dangerWide} onClick={leaveCall}><span className={styles.controlTitle}>Выйти</span></button>
          </div>
        </div>
      )}
    </div>
  );
}

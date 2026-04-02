'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import styles from '../styles/videoCall.module.css';
import UserAvatar from './UserAvatar';

export interface CallSession {
  callId: string;
  peerUserId: string;
  peerName: string;
  peerAvatarUrl?: string;
  peerAvatarColor?: string;
  mode: 'audio' | 'video';
  initiator: boolean;
}

interface VideoCallProps {
  socket: Socket;
  call: CallSession;
  iceServers: RTCIceServer[];
  minimized?: boolean;
  onMinimize?: () => void;
  onRestore?: () => void;
  onClose: () => void;
}

export default function VideoCall({ socket, call, iceServers, onClose }: VideoCallProps) {
  const [phase, setPhase] = useState(call.initiator ? 'outgoing' : 'incoming');
  const [connectionNotice, setConnectionNotice] = useState('');
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [videoEnabled, setVideoEnabled] = useState(call.mode === 'video');
  const [videoUnavailable, setVideoUnavailable] = useState(false);
  const [cameraFacingMode, setCameraFacingMode] = useState<'user' | 'environment'>('user');
  const [isSwitchingCamera, setIsSwitchingCamera] = useState(false);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const pendingIceCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const disconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unstableConnectionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ringtoneAudioContextRef = useRef<AudioContext | null>(null);
  const ringtoneIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const ringtoneTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearUnstableConnectionTimer = () => {
    if (unstableConnectionTimerRef.current) {
      clearTimeout(unstableConnectionTimerRef.current);
      unstableConnectionTimerRef.current = null;
    }
  };

  const clearDisconnectTimer = () => {
    if (disconnectTimerRef.current) {
      clearTimeout(disconnectTimerRef.current);
      disconnectTimerRef.current = null;
    }
  };

  const scheduleReconnectTimeout = () => {
    clearDisconnectTimer();
    disconnectTimerRef.current = setTimeout(() => {
      setPhase('ended');
      closeResources();
      onClose();
    }, 45000);
  };

  const scheduleUnstableReconnect = (notice: string, restartIce = false) => {
    clearUnstableConnectionTimer();
    unstableConnectionTimerRef.current = setTimeout(() => {
      setConnectionNotice(notice);
      setPhase('connecting');
      if (restartIce) {
        peerConnectionRef.current?.restartIce?.();
      }
      scheduleReconnectTimeout();
      unstableConnectionTimerRef.current = null;
    }, 5000);
  };

  const notifyConnectionRestored = () => {
    socket.emit('call:connection-restored', { callId: call.callId }, () => null);
  };

  const stopRingtone = () => {
    if (ringtoneIntervalRef.current) {
      clearInterval(ringtoneIntervalRef.current);
      ringtoneIntervalRef.current = null;
    }

    if (ringtoneTimeoutRef.current) {
      clearTimeout(ringtoneTimeoutRef.current);
      ringtoneTimeoutRef.current = null;
    }
  };

  const playTonePattern = async (pattern: Array<{ frequency: number; duration: number; delay?: number }>) => {
    if (typeof window === 'undefined') {
      return;
    }

    const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) {
      return;
    }

    if (!ringtoneAudioContextRef.current) {
      ringtoneAudioContextRef.current = new AudioContextClass();
    }

    const context = ringtoneAudioContextRef.current;
    if (context.state === 'suspended') {
      await context.resume().catch(() => null);
    }

    let offset = 0;
    pattern.forEach((tone) => {
      offset += tone.delay || 0;

      const oscillator = context.createOscillator();
      const gainNode = context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = tone.frequency;
      gainNode.gain.setValueAtTime(0.0001, context.currentTime + offset);
      gainNode.gain.exponentialRampToValueAtTime(0.08, context.currentTime + offset + 0.02);
      gainNode.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + offset + tone.duration);
      oscillator.connect(gainNode);
      gainNode.connect(context.destination);
      oscillator.start(context.currentTime + offset);
      oscillator.stop(context.currentTime + offset + tone.duration + 0.03);
      offset += tone.duration;
    });
  };

  const startRingtone = (mode: 'incoming' | 'outgoing') => {
    stopRingtone();

    const pattern = mode === 'incoming'
      ? [{ frequency: 880, duration: 0.22 }, { frequency: 1174, duration: 0.22, delay: 0.08 }]
      : [{ frequency: 660, duration: 0.18 }, { frequency: 660, duration: 0.18, delay: 0.28 }];

    const repeatEvery = mode === 'incoming' ? 2400 : 1800;
    const kick = () => {
      playTonePattern(pattern).catch(() => null);
      if (mode === 'incoming' && typeof navigator !== 'undefined' && 'vibrate' in navigator) {
        navigator.vibrate?.([160, 120, 220]);
      }
    };

    kick();
    ringtoneTimeoutRef.current = setTimeout(() => {
      ringtoneIntervalRef.current = setInterval(kick, repeatEvery);
    }, repeatEvery);
  };

  const ensureRemotePlayback = async () => {
    try {
      await remoteVideoRef.current?.play();
      await remoteAudioRef.current?.play();
    } catch {
      return;
    }
  };

  const restoreLocalMediaIfNeeded = async () => {
    const currentStream = localStreamRef.current;
    if (!currentStream) {
      return currentStream;
    }

    const tracksEnded = currentStream.getTracks().some((track) => track.readyState === 'ended');
    if (!tracksEnded) {
      return currentStream;
    }

    const nextStream = await createLocalMedia();
    const peerConnection = peerConnectionRef.current;
    if (!peerConnection) {
      return nextStream;
    }

    nextStream.getTracks().forEach((track) => {
      const sender = peerConnection.getSenders().find((entry) => entry.track?.kind === track.kind);
      sender?.replaceTrack(track).catch(() => null);
    });

    return nextStream;
  };

  const requestConnectionRefresh = async () => {
    const peerConnection = peerConnectionRef.current;
    if (!peerConnection || call.initiator === false) {
      return;
    }

    try {
      await restoreLocalMediaIfNeeded();
      peerConnection.restartIce?.();
      if (peerConnection.signalingState !== 'stable') {
        return;
      }

      const offer = await peerConnection.createOffer({ iceRestart: true });
      await peerConnection.setLocalDescription(offer);
      socket.emit('webrtc:offer', { callId: call.callId, offer });
    } catch (error) {
      console.error('Failed to refresh call connection:', error);
    }
  };

  const getMediaConstraints = (): MediaStreamConstraints => ({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
    video: call.mode === 'video'
      ? {
          facingMode: { ideal: cameraFacingMode },
          width: { ideal: 640, max: 960 },
          height: { ideal: 360, max: 540 },
          frameRate: { ideal: 24, max: 30 },
        }
      : false,
  });

  useEffect(() => {
    setPhase(call.initiator ? 'outgoing' : 'incoming');
    setConnectionNotice('');
    setVideoEnabled(call.mode === 'video');
    setVideoUnavailable(false);
    setCameraFacingMode('user');
    clearUnstableConnectionTimer();
    clearDisconnectTimer();
  }, [call]);

  useEffect(() => {
    if (phase === 'incoming') {
      startRingtone('incoming');
      return;
    }

    if (phase === 'outgoing' || phase === 'connecting') {
      startRingtone('outgoing');
      return;
    }

    stopRingtone();
  }, [phase]);

  useEffect(() => () => {
    stopRingtone();
    clearUnstableConnectionTimer();
    ringtoneAudioContextRef.current?.close().catch(() => null);
    ringtoneAudioContextRef.current = null;
  }, []);

  useEffect(() => {
    const handleSocketDisconnect = () => {
      if (phase === 'active' || phase === 'connecting') {
        setConnectionNotice('Потеряли сеть. Пытаемся переподключить звонок...');
        setPhase('connecting');
        scheduleReconnectTimeout();
      }
    };

    const handleSocketReconnect = () => {
      setConnectionNotice('');
      clearUnstableConnectionTimer();
      clearDisconnectTimer();
    };

    const handleOffline = () => {
      if (phase === 'active' || phase === 'connecting') {
        setConnectionNotice('Интернет пропал. Ждем восстановление соединения...');
        setPhase('connecting');
        scheduleReconnectTimeout();
      }
    };

    const handleOnline = () => {
      setConnectionNotice('Соединение восстанавливается...');
      ensureRemotePlayback();
      requestConnectionRefresh().catch(() => null);
    };

    const handleVisibilityRestore = () => {
      if (document.visibilityState !== 'visible' || (phase !== 'active' && phase !== 'connecting')) {
        return;
      }

      setConnectionNotice('Возвращаем аудио и видео после паузы...');
      ensureRemotePlayback();
      restoreLocalMediaIfNeeded()
        .then(() => requestConnectionRefresh())
        .catch(() => null);
    };

    socket.on('disconnect', handleSocketDisconnect);
    socket.on('reconnect', handleSocketReconnect);
    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);
    window.addEventListener('pageshow', handleVisibilityRestore);
    document.addEventListener('visibilitychange', handleVisibilityRestore);
    window.addEventListener('focus', handleVisibilityRestore);

    return () => {
      socket.off('disconnect', handleSocketDisconnect);
      socket.off('reconnect', handleSocketReconnect);
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('pageshow', handleVisibilityRestore);
      document.removeEventListener('visibilitychange', handleVisibilityRestore);
      window.removeEventListener('focus', handleVisibilityRestore);
    };
  }, [call.callId, call.initiator, phase, socket]);

  useEffect(() => {
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = localStream;
    }
  }, [localStream]);

  useEffect(() => {
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = remoteStream;
      remoteVideoRef.current
        .play()
        .catch(() => null);
    }

    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = remoteStream;
      remoteAudioRef.current.muted = false;
      remoteAudioRef.current.volume = 1;
    }

    remoteStreamRef.current = remoteStream;
    ensureRemotePlayback();
  }, [remoteStream]);

  const closeResources = () => {
    clearDisconnectTimer();
    clearUnstableConnectionTimer();
    stopRingtone();
    peerConnectionRef.current?.close();
    peerConnectionRef.current = null;

    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    setLocalStream(null);

    remoteStreamRef.current?.getTracks().forEach((track) => track.stop());
    remoteStreamRef.current = null;
    setRemoteStream(null);
    pendingIceCandidatesRef.current = [];
  };

  useEffect(() => {
    const handleAccepted = ({ callId }: { callId: string }) => {
      if (callId !== call.callId || !call.initiator) {
        return;
      }

      startAsCaller().catch((error) => {
        console.error('Failed to start caller flow:', error);
        setPhase('error');
      });
    };

    const handleRejected = ({ callId }: { callId: string }) => {
      if (callId !== call.callId) {
        return;
      }

      setPhase('rejected');
      closeResources();
      onClose();
    };

    const handleEnded = ({ callId }: { callId: string }) => {
      if (callId !== call.callId) {
        return;
      }

      setPhase('ended');
      closeResources();
      onClose();
    };

    const handleMissed = ({ callId }: { callId: string }) => {
      if (callId !== call.callId) {
        return;
      }

      setPhase('missed');
      closeResources();
      onClose();
    };

    const handlePeerReconnecting = ({ callId }: { callId: string }) => {
      if (callId !== call.callId) {
        return;
      }

      setConnectionNotice('Слабое соединение у собеседника. Ждем переподключение...');
    };

    const handlePeerReconnected = ({ callId }: { callId: string }) => {
      if (callId !== call.callId) {
        return;
      }

      setConnectionNotice('');
      clearUnstableConnectionTimer();
      clearDisconnectTimer();
      setPhase('active');
    };

    const handleOffer = async ({ callId, offer }: { callId: string; offer: RTCSessionDescriptionInit }) => {
      if (callId !== call.callId || call.initiator) {
        return;
      }

      try {
        const stream = localStreamRef.current || (await createLocalMedia());
        const peerConnection = createPeerConnection(stream);
        await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
        while (pendingIceCandidatesRef.current.length > 0) {
          const queuedCandidate = pendingIceCandidatesRef.current.shift();
          if (queuedCandidate) {
            await peerConnection.addIceCandidate(new RTCIceCandidate(queuedCandidate));
          }
        }
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        socket.emit('webrtc:answer', { callId: call.callId, answer });
        setPhase('active');
        ensureRemotePlayback();
      } catch (error) {
        console.error('Failed to handle offer:', error);
        setPhase('error');
      }
    };

    const handleAnswer = async ({ callId, answer }: { callId: string; answer: RTCSessionDescriptionInit }) => {
      if (callId !== call.callId || !call.initiator || !peerConnectionRef.current) {
        return;
      }

      await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(answer));
      while (pendingIceCandidatesRef.current.length > 0) {
        const queuedCandidate = pendingIceCandidatesRef.current.shift();
        if (queuedCandidate) {
          await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(queuedCandidate));
        }
      }
      setPhase('active');
      ensureRemotePlayback();
    };

    const handleIceCandidate = async ({ callId, candidate }: { callId: string; candidate: RTCIceCandidateInit }) => {
      if (callId !== call.callId || !peerConnectionRef.current || !candidate) {
        return;
      }

      try {
        if (!peerConnectionRef.current.remoteDescription) {
          pendingIceCandidatesRef.current.push(candidate);
          return;
        }

        await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (error) {
        console.error('Failed to add ICE candidate:', error);
      }
    };

    socket.on('call:accepted', handleAccepted);
    socket.on('call:rejected', handleRejected);
    socket.on('call:ended', handleEnded);
    socket.on('call:missed', handleMissed);
    socket.on('call:peer-reconnecting', handlePeerReconnecting);
    socket.on('call:peer-reconnected', handlePeerReconnected);
    socket.on('webrtc:offer', handleOffer);
    socket.on('webrtc:answer', handleAnswer);
    socket.on('webrtc:ice-candidate', handleIceCandidate);

    return () => {
      socket.off('call:accepted', handleAccepted);
      socket.off('call:rejected', handleRejected);
      socket.off('call:ended', handleEnded);
      socket.off('call:missed', handleMissed);
      socket.off('call:peer-reconnecting', handlePeerReconnecting);
      socket.off('call:peer-reconnected', handlePeerReconnected);
      socket.off('webrtc:offer', handleOffer);
      socket.off('webrtc:answer', handleAnswer);
      socket.off('webrtc:ice-candidate', handleIceCandidate);
      closeResources();
    };
  }, [call, onClose, socket]);

  const createLocalMedia = async () => {
    let stream: MediaStream;

    try {
      stream = await navigator.mediaDevices.getUserMedia(getMediaConstraints());
      setVideoUnavailable(false);
    } catch (error) {
      if (call.mode !== 'video') {
        const nextError = error instanceof Error ? error : new Error('Не удалось получить доступ к микрофону');
        throw nextError;
      }

      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
        video: false,
      });
      setVideoUnavailable(true);
      setVideoEnabled(false);
    }

    localStreamRef.current = stream;
    stream.getAudioTracks().forEach((track) => {
      track.contentHint = 'speech';
    });
    stream.getVideoTracks().forEach((track) => {
      track.contentHint = 'motion';
    });
    setLocalStream(stream);
    setAudioEnabled(stream.getAudioTracks().some((track) => track.enabled));
    setVideoEnabled(stream.getVideoTracks().some((track) => track.enabled));
    return stream;
  };

  const createPeerConnection = (stream: MediaStream) => {
    if (peerConnectionRef.current) {
      return peerConnectionRef.current;
    }

    const peerConnection = new RTCPeerConnection({ iceServers });
    const incomingStream = new MediaStream();

    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('webrtc:ice-candidate', {
          callId: call.callId,
          candidate: event.candidate.toJSON(),
        });
      }
    };

    peerConnection.ontrack = (event) => {
      if (event.streams[0]) {
        event.streams[0].getTracks().forEach((track) => {
          if (!incomingStream.getTracks().some((existingTrack) => existingTrack.id === track.id)) {
            incomingStream.addTrack(track);
          }
        });
      } else if (event.track && !incomingStream.getTracks().some((existingTrack) => existingTrack.id === event.track.id)) {
        incomingStream.addTrack(event.track);
      }

      setRemoteStream(incomingStream);
      setPhase('active');
      setConnectionNotice('');
      clearUnstableConnectionTimer();
      clearDisconnectTimer();
      notifyConnectionRestored();
      ensureRemotePlayback();
    };

    peerConnection.onconnectionstatechange = () => {
      if (peerConnection.connectionState === 'connected') {
        setPhase('active');
        setConnectionNotice('');
        clearUnstableConnectionTimer();
        clearDisconnectTimer();
        notifyConnectionRestored();
      }

      if (peerConnection.connectionState === 'connecting') {
        setConnectionNotice('Соединяем или восстанавливаем звонок...');
      }

      if (peerConnection.connectionState === 'failed') {
        scheduleUnstableReconnect('Слабое соединение. Пытаемся восстановить звонок...', true);
      }

      if (peerConnection.connectionState === 'disconnected') {
        scheduleUnstableReconnect('Соединение нестабильно. Ждем восстановления...', true);
      }
    };

    peerConnection.oniceconnectionstatechange = () => {
      if (peerConnection.iceConnectionState === 'connected' || peerConnection.iceConnectionState === 'completed') {
        setConnectionNotice('');
        clearUnstableConnectionTimer();
        clearDisconnectTimer();
        notifyConnectionRestored();
      }

      if (peerConnection.iceConnectionState === 'disconnected') {
        scheduleUnstableReconnect('Слабое соединение. Пытаемся удержать звонок...');
      }

      if (peerConnection.iceConnectionState === 'failed') {
        scheduleUnstableReconnect('Не удалось быстро восстановить соединение. Пробуем переподключиться...', true);
      }
    };

    stream.getTracks().forEach((track) => peerConnection.addTrack(track, stream));

    peerConnection.getSenders().forEach((sender) => {
      if (!sender.track) {
        return;
      }

      const parameters = sender.getParameters();
      parameters.encodings = parameters.encodings || [{}];

      if (sender.track.kind === 'audio') {
        parameters.encodings[0].maxBitrate = 32000;
      }

      if (sender.track.kind === 'video') {
        parameters.encodings[0].maxBitrate = 700000;
        parameters.encodings[0].maxFramerate = 24;
      }

      sender.setParameters(parameters).catch(() => null);
    });

    if (call.mode === 'video' && stream.getVideoTracks().length === 0) {
      peerConnection.addTransceiver('video', { direction: 'recvonly' });
    }

    peerConnectionRef.current = peerConnection;
    return peerConnection;
  };

  const startAsCaller = async () => {
    setPhase('connecting');
    const stream = localStreamRef.current || (await createLocalMedia());
    const peerConnection = createPeerConnection(stream);
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    socket.emit('webrtc:offer', { callId: call.callId, offer });
  };

  const acceptCall = async () => {
    try {
      await createLocalMedia();
      await ensureRemotePlayback();
      setPhase('connecting');
      socket.emit('call:accept', { callId: call.callId });
    } catch (error) {
      console.error('Failed to access media devices:', error);
      alert(error instanceof Error ? error.message : 'Нужен доступ к микрофону и камере для звонка');
      setPhase('error');
    }
  };

  const rejectCall = () => {
    socket.emit('call:reject', { callId: call.callId });
    closeResources();
    onClose();
  };

  const endCall = () => {
    socket.emit('call:end', { callId: call.callId });
    closeResources();
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

  const switchCamera = async () => {
    if (call.mode !== 'video' || isSwitchingCamera) {
      return;
    }

    const currentStream = localStreamRef.current;
    if (!currentStream) {
      return;
    }

    try {
      setIsSwitchingCamera(true);
      const nextFacingMode = cameraFacingMode === 'user' ? 'environment' : 'user';
      const videoStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: nextFacingMode },
          width: { ideal: 640, max: 960 },
          height: { ideal: 360, max: 540 },
          frameRate: { ideal: 24, max: 30 },
        },
      });
      const nextVideoTrack = videoStream.getVideoTracks()[0];

      if (!nextVideoTrack) {
        videoStream.getTracks().forEach((track) => track.stop());
        throw new Error('Не удалось получить изображение с другой камеры');
      }

      nextVideoTrack.contentHint = 'motion';
      const peerConnection = peerConnectionRef.current;
      const videoSender = peerConnection?.getSenders().find((sender) => sender.track?.kind === 'video');
      await videoSender?.replaceTrack(nextVideoTrack);

      currentStream.getVideoTracks().forEach((track) => {
        currentStream.removeTrack(track);
        track.stop();
      });
      currentStream.addTrack(nextVideoTrack);

      const nextStream = new MediaStream([...currentStream.getAudioTracks(), nextVideoTrack]);
      localStreamRef.current = nextStream;
      setLocalStream(nextStream);
      setCameraFacingMode(nextFacingMode);
      setVideoEnabled(true);
      setVideoUnavailable(false);
      setConnectionNotice('Камера переключена');
      clearUnstableConnectionTimer();
      clearDisconnectTimer();
    } catch (error) {
      console.error('Failed to switch camera:', error);
      setConnectionNotice(error instanceof Error ? error.message : 'Не удалось переключить камеру');
    } finally {
      setIsSwitchingCamera(false);
    }
  };

  const closeOverlay = () => {
    closeResources();
    onClose();
  };

  const statusText = useMemo(() => {
    if (phase === 'incoming') return 'Входящий звонок';
    if (phase === 'outgoing') return 'Ожидаем ответ';
    if (phase === 'connecting') return 'Соединяем';
    if (phase === 'active') return call.mode === 'video' ? 'Видеозвонок активен' : 'Голосовой звонок активен';
    if (phase === 'rejected') return 'Звонок отклонен';
    if (phase === 'error') return 'Ошибка подключения';
    if (phase === 'missed') return 'Звонок пропущен';
    return 'Звонок завершен';
  }, [call.mode, phase]);

  return (
    <div className={styles.overlay} style={{ display: 'block' }}>
      <div className={styles.backdrop} />

      {phase === 'incoming' ? (
        <div className={styles.incoming}>
          <div className={styles.incomingCard}>
            <UserAvatar
              avatarUrl={call.peerAvatarUrl}
              alt={call.peerName}
              fallback={call.peerName.slice(0, 1).toUpperCase()}
              className={`${styles.incomingAvatar} ${styles[`incomingAvatar_${call.peerAvatarColor || 'ocean'}`]}`}
              imageClassName={styles.incomingAvatarImage}
            />
            <h3 className={styles.incomingTitle}>{call.mode === 'video' ? 'Видеозвонок' : 'Голосовой звонок'}</h3>
            <p className={styles.incomingText}>От {call.peerName}</p>
            <div className={styles.incomingActions}>
              <button className={styles.dangerWide} onClick={rejectCall}>
                <span className={styles.controlLabel}>Отклонить</span>
              </button>
              <button className={styles.acceptWide} onClick={acceptCall}>
                <span className={styles.controlLabel}>Ответить</span>
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className={styles.callScreen}>
          <div className={styles.topBar}>
            <strong>{call.peerName}</strong>
            <span>{statusText}</span>
            {connectionNotice ? <p className={styles.notice}>{connectionNotice}</p> : null}
          </div>

          {call.mode === 'video' ? (
            <video ref={remoteVideoRef} autoPlay playsInline className={styles.remoteVideo} />
          ) : (
            <div className={styles.audioStage}>
              <div className={styles.audioPulse}>{call.peerName.slice(0, 1).toUpperCase()}</div>
            </div>
          )}

          <audio ref={remoteAudioRef} autoPlay playsInline preload="auto" className={styles.remoteAudio} />

          <div className={styles.localCard}>
            {call.mode === 'video' ? (
              localStream?.getVideoTracks().length ? (
                <video ref={localVideoRef} autoPlay playsInline muted className={styles.localVideo} />
              ) : (
                <div className={styles.audioStageMini}>{videoUnavailable ? 'Без камеры' : 'Микрофон'}</div>
              )
            ) : (
              <div className={styles.audioStageMini}>Микрофон</div>
            )}
            <div className={styles.localBadge}>Вы</div>
          </div>

          <div className={styles.controls}>
            <button className={styles.controlWide} onClick={toggleAudio}>
              <span className={styles.controlTitle}>{audioEnabled ? 'Микрофон вкл' : 'Микрофон выкл'}</span>
            </button>
            <button className={styles.dangerWide} onClick={endCall}>
              <span className={styles.controlTitle}>Завершить</span>
            </button>
            {call.mode === 'video' ? (
              <>
                <button className={styles.controlWide} onClick={toggleVideo}>
                  <span className={styles.controlTitle}>{videoEnabled ? 'Камера вкл' : 'Камера выкл'}</span>
                </button>
                <button className={styles.controlWide} onClick={switchCamera} disabled={isSwitchingCamera || videoUnavailable}>
                  <span className={styles.controlTitle}>{isSwitchingCamera ? 'Переключаем...' : 'Сменить камеру'}</span>
                </button>
              </>
            ) : (
              <button className={styles.controlWide} onClick={closeOverlay}>
                <span className={styles.controlTitle}>Скрыть</span>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

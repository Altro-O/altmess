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

export default function VideoCall({ socket, call, iceServers, minimized = false, onMinimize, onRestore, onClose }: VideoCallProps) {
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
  const healthCheckIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mediaStatsRef = useRef({
    inboundBytes: 0,
    outboundBytes: 0,
    inboundPackets: 0,
    outboundPackets: 0,
    framesDecoded: 0,
    timestamp: 0,
  });
  const ringtoneAudioContextRef = useRef<AudioContext | null>(null);
  const ringtoneIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const ringtoneTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const minimizedCallRef = useRef<HTMLDivElement | null>(null);
  const minimizedDragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);
  const [minimizedPosition, setMinimizedPosition] = useState<{ x: number; y: number } | null>(null);

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

  const clearHealthCheckInterval = () => {
    if (healthCheckIntervalRef.current) {
      clearInterval(healthCheckIntervalRef.current);
      healthCheckIntervalRef.current = null;
    }
  };

  const inspectMediaTraffic = async () => {
    const peerConnection = peerConnectionRef.current;
    if (!peerConnection) {
      return false;
    }

    try {
      const stats = await peerConnection.getStats();
      let inboundBytes = 0;
      let outboundBytes = 0;
      let inboundPackets = 0;
      let outboundPackets = 0;
      let framesDecoded = 0;

      stats.forEach((report) => {
        if (report.type === 'inbound-rtp' && !report.isRemote) {
          inboundBytes += report.bytesReceived || 0;
          inboundPackets += report.packetsReceived || 0;
          framesDecoded += report.framesDecoded || 0;
        }

        if (report.type === 'outbound-rtp' && !report.isRemote) {
          outboundBytes += report.bytesSent || 0;
          outboundPackets += report.packetsSent || 0;
        }
      });

      const previous = mediaStatsRef.current;
      const hasTraffic =
        inboundBytes > previous.inboundBytes ||
        outboundBytes > previous.outboundBytes ||
        inboundPackets > previous.inboundPackets ||
        outboundPackets > previous.outboundPackets ||
        framesDecoded > previous.framesDecoded;

      mediaStatsRef.current = {
        inboundBytes,
        outboundBytes,
        inboundPackets,
        outboundPackets,
        framesDecoded,
        timestamp: Date.now(),
      };

      return hasTraffic;
    } catch {
      return false;
    }
  };

  const markConnectionHealthy = () => {
    setPhase('active');
    setConnectionNotice('');
    clearUnstableConnectionTimer();
    clearDisconnectTimer();
    notifyConnectionRestored();
  };

  const startHealthCheckLoop = () => {
    clearHealthCheckInterval();
    healthCheckIntervalRef.current = setInterval(() => {
      inspectMediaTraffic()
        .then((hasTraffic) => {
          if (hasTraffic) {
            markConnectionHealthy();
          }
        })
        .catch(() => null);
    }, 3000);
  };

  const scheduleReconnectTimeout = () => {
    clearDisconnectTimer();
    disconnectTimerRef.current = setTimeout(async () => {
      const hasTraffic = await inspectMediaTraffic();
      if (hasTraffic) {
        markConnectionHealthy();
        return;
      }

      if (socket.connected) {
        socket.emit('call:end', { callId: call.callId });
      }
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
    clearHealthCheckInterval();
    ringtoneAudioContextRef.current?.close().catch(() => null);
    ringtoneAudioContextRef.current = null;
  }, []);

  useEffect(() => {
    const handleSocketDisconnect = () => {
      if (phase === 'active' || phase === 'connecting') {
        setConnectionNotice('Потеряли сеть. Пытаемся переподключить звонок...');
        setPhase('connecting');
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
  }, [localStream, minimized]);

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
  }, [remoteStream, minimized]);

  const closeResources = () => {
    clearDisconnectTimer();
    clearUnstableConnectionTimer();
    clearHealthCheckInterval();
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
      markConnectionHealthy();
      startHealthCheckLoop();
      ensureRemotePlayback();
    };

    peerConnection.onconnectionstatechange = () => {
      if (peerConnection.connectionState === 'connected') {
        markConnectionHealthy();
        startHealthCheckLoop();
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
        markConnectionHealthy();
        startHealthCheckLoop();
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

  const clampMinimizedPosition = (nextX: number, nextY: number) => {
    const width = minimizedCallRef.current?.offsetWidth || 220;
    const height = minimizedCallRef.current?.offsetHeight || 170;
    const maxX = Math.max(12, window.innerWidth - width - 12);
    const maxY = Math.max(12, window.innerHeight - height - 12);

    return {
      x: Math.min(Math.max(12, nextX), maxX),
      y: Math.min(Math.max(12, nextY), maxY),
    };
  };

  const handleMinimizedPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }

    const rect = minimizedCallRef.current?.getBoundingClientRect();
    const origin = minimizedPosition || {
      x: rect?.left || 12,
      y: rect?.top || Math.max(12, window.innerHeight - (rect?.height || 170) - 18),
    };

    minimizedDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: origin.x,
      originY: origin.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleMinimizedPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = minimizedDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    const nextPosition = clampMinimizedPosition(
      drag.originX + (event.clientX - drag.startX),
      drag.originY + (event.clientY - drag.startY),
    );
    setMinimizedPosition(nextPosition);
  };

  const handleMinimizedPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (minimizedDragRef.current?.pointerId === event.pointerId) {
      minimizedDragRef.current = null;
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  useEffect(() => {
    if (!minimized || !minimizedPosition) {
      return;
    }

    const handleResize = () => {
      setMinimizedPosition((prev) => (prev ? clampMinimizedPosition(prev.x, prev.y) : prev));
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [minimized, minimizedPosition]);

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

  if (minimized && phase !== 'incoming') {
    return (
      <div ref={minimizedCallRef} className={styles.minimizedCall} style={minimizedPosition ? { inset: `${minimizedPosition.y}px auto auto ${minimizedPosition.x}px`, right: 'auto', bottom: 'auto' } : undefined}>
        <div className={styles.minimizedDragHandle} onPointerDown={handleMinimizedPointerDown} onPointerMove={handleMinimizedPointerMove} onPointerUp={handleMinimizedPointerUp} onPointerCancel={handleMinimizedPointerUp}>
          <span className={styles.minimizedDragGrip} />
        </div>
        <div className={styles.minimizedSurface} role="button" tabIndex={0} onClick={() => onRestore?.()} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onRestore?.(); } }}>
          {call.mode === 'video' ? (
            <div className={styles.minimizedMediaFrame}>
              <video ref={remoteVideoRef} autoPlay playsInline className={styles.minimizedRemoteVideo} />
              <div className={styles.minimizedLocalPreview}>
                {localStream?.getVideoTracks().length ? (
                  <video ref={localVideoRef} autoPlay playsInline muted className={styles.minimizedLocalVideo} />
                ) : (
                  <div className={styles.audioStageMini}>{videoUnavailable ? 'Без камеры' : 'Вы'}</div>
                )}
              </div>
            </div>
          ) : (
            <div className={styles.minimizedAudioStage}>
              <div className={styles.audioPulse}>{call.peerName.slice(0, 1).toUpperCase()}</div>
            </div>
          )}
          <div className={styles.minimizedMeta}>
            <span className={styles.minimizedTitle}>{call.peerName}</span>
            <span className={styles.minimizedText}>{statusText}</span>
            {connectionNotice ? <span className={styles.minimizedNotice}>{connectionNotice}</span> : null}
          </div>
        </div>
        <div className={styles.minimizedActionsRow}>
          <button type="button" className={styles.minimizedAction} onClick={toggleAudio}>{audioEnabled ? 'Микрофон' : 'Без звука'}</button>
          <button type="button" className={styles.minimizedAction} onClick={() => onRestore?.()}>Развернуть</button>
          <button type="button" className={styles.minimizedDanger} onClick={endCall}>Завершить</button>
        </div>
        <audio ref={remoteAudioRef} autoPlay playsInline preload="auto" className={styles.remoteAudio} />
      </div>
    );
  }

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
            <button className={styles.controlBtn} onClick={toggleAudio} title={audioEnabled ? 'Микрофон вкл' : 'Микрофон выкл'}>
              {audioEnabled ? (
                <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
              ) : (
                <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2c0 .76-.13 1.49-.36 2.18"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
              )}
            </button>
            <button className={styles.dangerBtn} onClick={endCall} title="Завершить">
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.28a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2.03V19a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3.22a2 2 0 0 1 2.03 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.32 9.96a16 16 0 0 0 2.36 3.35z"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
            </button>
            {onMinimize ? (
              <button className={styles.controlBtn} onClick={onMinimize} title="Свернуть">
                <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
              </button>
            ) : null}
            {call.mode === 'video' ? (
              <>
                <button className={`${styles.controlBtn} ${!videoEnabled ? styles.controlBtnOff : ''}`} onClick={toggleVideo} title={videoEnabled ? 'Камера вкл' : 'Камера выкл'}>
                  {videoEnabled ? (
                    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
                  ) : (
                    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M21 7l-4 2.8"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
                  )}
                </button>
                <button className={styles.controlBtn} onClick={switchCamera} disabled={isSwitchingCamera || videoUnavailable} title="Сменить камеру">
                  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
                </button>
              </>
            ) : !onMinimize ? (
              <button className={styles.controlBtn} onClick={closeOverlay} title="Скрыть">
                <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18"/><path d="M6 6l12 12"/></svg>
              </button>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

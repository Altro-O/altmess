function createGroupCallStore() {
  const rooms = new Map();

  return {
    getRoom(groupId) {
      return rooms.get(String(groupId)) || null;
    },
    ensureRoom(groupId) {
      const key = String(groupId);
      if (!rooms.has(key)) {
        rooms.set(key, {
          groupId: key,
          mode: 'video',
          invitedAt: new Date().toISOString(),
          participants: new Map(),
          createdAt: new Date().toISOString(),
        });
      }

      return rooms.get(key);
    },
    startRoom(groupId, mode) {
      const room = this.ensureRoom(groupId);
      room.mode = mode === 'audio' ? 'audio' : 'video';
      room.invitedAt = new Date().toISOString();
      return room;
    },
    upsertParticipant(groupId, participant) {
      const room = this.ensureRoom(groupId);
      room.participants.set(String(participant.userId), {
        userId: String(participant.userId),
        socketId: String(participant.socketId),
        joinedAt: participant.joinedAt || new Date().toISOString(),
      });
      return room;
    },
    removeParticipant(groupId, userId) {
      const room = this.getRoom(groupId);
      if (!room) {
        return null;
      }

      room.participants.delete(String(userId));
      if (room.participants.size === 0) {
        this.removeRoom(groupId);
        return null;
      }

      return room;
    },
    listParticipants(groupId) {
      const room = this.getRoom(groupId);
      return room ? [...room.participants.values()] : [];
    },
    hasParticipant(groupId, userId) {
      const room = this.getRoom(groupId);
      return Boolean(room?.participants.has(String(userId)));
    },
    removeRoom(groupId) {
      rooms.delete(String(groupId));
    },
  };
}

module.exports = {
  createGroupCallStore,
};

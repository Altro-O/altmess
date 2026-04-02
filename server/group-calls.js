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
          participants: new Map(),
          createdAt: new Date().toISOString(),
        });
      }

      return rooms.get(key);
    },
    removeRoom(groupId) {
      rooms.delete(String(groupId));
    },
  };
}

module.exports = {
  createGroupCallStore,
};

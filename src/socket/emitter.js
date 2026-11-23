// Dipakai service/route untuk emit event tanpa import circular ke server socket.
let io = null;
export const setIO = (instance) => { io = instance; };
export const getIO = () => io;
export const emit = (room, event, payload) => { io?.to(room).emit(event, payload); };
export const joinUserToRoom = (userId, room) => { io?.in(`user:${userId}`).socketsJoin(room); };
export const leaveUserFromRoom = (userId, room) => { io?.in(`user:${userId}`).socketsLeave(room); };

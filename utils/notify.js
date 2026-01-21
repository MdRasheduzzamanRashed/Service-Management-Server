import { getIO } from "../socket.js";

export function emitToUser(username, notification) {
  const io = getIO();
  io.to(`user:${String(username).toLowerCase()}`).emit(
    "notification",
    notification,
  );
}

export function emitToRole(role, notification) {
  const io = getIO();
  io.to(`role:${String(role).toUpperCase()}`).emit(
    "notification",
    notification,
  );
}

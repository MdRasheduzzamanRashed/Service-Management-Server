// socket.js
import { Server } from "socket.io";

let io = null;

export function initSocket(server) {
  io = new Server(server, {
    cors: {
      origin: true, // server.js already controls cors; this is ok
      methods: ["GET", "POST"],
    },
  });

  io.on("connection", (socket) => {
    // client will send { username, role }
    socket.on("join", ({ username, role }) => {
      if (username) socket.join(`user:${String(username).toLowerCase()}`);
      if (role) socket.join(`role:${String(role).toUpperCase()}`);
    });
  });

  return io;
}

export function getIO() {
  return io;
}

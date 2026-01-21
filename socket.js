import { Server } from "socket.io";

let ioInstance = null;

export function initSocket(server) {
  ioInstance = new Server(server, {
    cors: {
      origin: ["http://localhost:3000", process.env.CLIENT_URL].filter(Boolean),
      methods: ["GET", "POST"],
      credentials: false, // ✅ MUST match Express CORS
    },
  });

  ioInstance.on("connection", (socket) => {
    console.log("🔌 Socket connected:", socket.id);

    socket.on("register", ({ role, username }) => {
      if (role) {
        const r = String(role).toUpperCase();
        socket.join(`role:${r}`);
        console.log(`➡️ ${socket.id} joined role:${r}`);
      }

      if (username) {
        const u = String(username).toLowerCase();
        socket.join(`user:${u}`);
        console.log(`➡️ ${socket.id} joined user:${u}`);
      }
    });

    socket.on("disconnect", () => {
      console.log("❌ Socket disconnected:", socket.id);
    });
  });

  return ioInstance;
}

export function getIO() {
  if (!ioInstance) {
    throw new Error("Socket.io not initialized");
  }
  return ioInstance;
}

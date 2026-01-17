import { Server } from "socket.io";

let ioInstance = null;

export function initSocket(server) {
  ioInstance = new Server(server, {
    cors: {
      origin: "http://localhost:3000",
      methods: ["GET", "POST"],
      credentials: true
    }
  });

  ioInstance.on("connection", (socket) => {
    console.log("Socket connected:", socket.id);

    socket.on("register", ({ role, email }) => {
      if (role) {
        socket.join(`role:${role}`);
        console.log(`Socket ${socket.id} joined room role:${role}`);
      }
      if (email) {
        socket.join(`user:${email}`);
        console.log(`Socket ${socket.id} joined room user:${email}`);
      }
    });

    socket.on("disconnect", () => {
      console.log("Socket disconnected:", socket.id);
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
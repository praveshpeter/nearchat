const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
const MATCH_RADIUS_KM = 10;

// Serve frontend files
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// In-memory store — no database needed
const waiting = new Map();   // socketId -> { id, name, lat, lng, socket }
const partners = new Map();  // socketId -> socketId
let chatCount = 0;

// Haversine distance formula
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
    Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function broadcastStats() {
  io.emit('stats', {
    online: io.engine.clientsCount,
    chats: chatCount
  });
}

function tryMatch(newUser) {
  for (const [wid, wUser] of waiting.entries()) {
    if (wid === newUser.id) continue;
    const dist = haversine(newUser.lat, newUser.lng, wUser.lat, wUser.lng);
    if (dist <= MATCH_RADIUS_KM) {
      waiting.delete(wid);
      waiting.delete(newUser.id);
      partners.set(newUser.id, wid);
      partners.set(wid, newUser.id);
      const d = dist.toFixed(1);
      newUser.socket.emit('matched', { partnerId: wid, partnerName: wUser.name, distance: d });
      wUser.socket.emit('matched', { partnerId: newUser.id, partnerName: newUser.name, distance: d });
      console.log(`Matched: ${newUser.name} <-> ${wUser.name} (${d}km)`);
      return true;
    }
  }
  return false;
}

io.on('connection', (socket) => {
  console.log('+ Connected:', socket.id);
  broadcastStats();

  socket.on('search', ({ name, lat, lng }) => {
    waiting.delete(socket.id);
    const user = { id: socket.id, name, lat, lng, socket };
    waiting.set(socket.id, user);
    const matched = tryMatch(user);
    if (!matched) socket.emit('searching');
    broadcastStats();
  });

  socket.on('cancel-search', () => {
    waiting.delete(socket.id);
    broadcastStats();
  });

  socket.on('accept-match', ({ partnerId }) => {
    const partnerSocket = io.sockets.sockets.get(partnerId);
    if (partnerSocket) {
      socket.emit('chat-started');
      partnerSocket.emit('chat-started');
      chatCount++;
      broadcastStats();
    }
  });

  socket.on('skip-match', ({ partnerId }) => {
    partners.delete(socket.id);
    partners.delete(partnerId);
    const partnerSocket = io.sockets.sockets.get(partnerId);
    if (partnerSocket) partnerSocket.emit('partner-left');
  });

  socket.on('message', ({ text, time }) => {
    const pid = partners.get(socket.id);
    if (!pid) return;
    const partnerSocket = io.sockets.sockets.get(pid);
    if (partnerSocket) partnerSocket.emit('message', { text, time });
  });

  socket.on('typing', () => {
    const pid = partners.get(socket.id);
    const ps = io.sockets.sockets.get(pid);
    if (ps) ps.emit('typing');
  });

  socket.on('stop-typing', () => {
    const pid = partners.get(socket.id);
    const ps = io.sockets.sockets.get(pid);
    if (ps) ps.emit('stop-typing');
  });

  socket.on('end-chat', () => {
    const pid = partners.get(socket.id);
    if (pid) {
      const ps = io.sockets.sockets.get(pid);
      if (ps) ps.emit('partner-left');
      partners.delete(socket.id);
      partners.delete(pid);
    }
  });

  socket.on('disconnect', () => {
    console.log('- Disconnected:', socket.id);
    waiting.delete(socket.id);
    const pid = partners.get(socket.id);
    if (pid) {
      const ps = io.sockets.sockets.get(pid);
      if (ps) ps.emit('partner-left');
      partners.delete(socket.id);
      partners.delete(pid);
    }
    broadcastStats();
  });
});

server.listen(PORT, () => {
  console.log(`NearChat running on port ${PORT}`);
});

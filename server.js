const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  pingInterval: 3000,
  pingTimeout: 5000
});

app.use(express.static(path.join(__dirname, 'public')));

// ========== 상태 저장 ==========
const rooms = {}; // { PIN: { host, players[], bombHolder, timer, timerTotal, timerStart, gameStarted, interval } }

// ========== 유틸리티 ==========
function generatePIN() {
  let pin;
  do {
    pin = String(Math.floor(100000 + Math.random() * 900000));
  } while (rooms[pin]);
  return pin;
}

function getRandomTime() {
  return Math.floor(Math.random() * 21000) + 10000; // 10초 ~ 30초 (ms)
}

function getRandomPlayer(room, excludeId) {
  const others = room.players.filter(p => p.id !== excludeId && p.connected);
  if (others.length === 0) return null;
  return others[Math.floor(Math.random() * others.length)];
}

function getElapsedRatio(room) {
  if (!room.timerStart || !room.timerTotal) return 0;
  const elapsed = Date.now() - room.timerStart;
  return Math.min(elapsed / room.timerTotal, 1);
}

function cleanupRoom(pin) {
  const room = rooms[pin];
  if (room) {
    if (room.interval) clearInterval(room.interval);
    if (room.bombTimeout) clearTimeout(room.bombTimeout);
    delete rooms[pin];
  }
}

// ========== QR 코드 생성 ==========
app.get('/api/qr/:pin', async (req, res) => {
  try {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const url = `${baseUrl}/player.html?pin=${req.params.pin}`;
    const qr = await QRCode.toDataURL(url, { width: 300, margin: 2 });
    res.json({ qr, url });
  } catch (e) {
    res.status(500).json({ error: 'QR 생성 실패' });
  }
});

// ========== 소켓 통신 ==========
io.on('connection', (socket) => {
  console.log(`[연결] ${socket.id}`);

  // ----- 방 만들기 (호스트) -----
  socket.on('create-room', (callback) => {
    const pin = generatePIN();
    rooms[pin] = {
      host: socket.id,
      players: [],
      bombHolder: null,
      timer: null,
      timerTotal: null,
      timerStart: null,
      gameStarted: false,
      interval: null,
      bombTimeout: null
    };
    socket.join(pin);
    socket.pin = pin;
    socket.role = 'host';
    console.log(`[방 생성] PIN: ${pin}, Host: ${socket.id}`);
    callback({ success: true, pin });
  });

  // ----- 방 참가 (플레이어) -----
  socket.on('join-room', ({ pin, nickname }, callback) => {
    const room = rooms[pin];
    if (!room) {
      return callback({ success: false, message: '존재하지 않는 방입니다.' });
    }
    if (room.gameStarted) {
      return callback({ success: false, message: '이미 게임이 진행 중입니다.' });
    }
    if (room.players.length >= 20) {
      return callback({ success: false, message: '방이 가득 찼습니다. (최대 20명)' });
    }

    const player = {
      id: socket.id,
      nickname: nickname.trim().substring(0, 10) || '익명',
      connected: true
    };

    room.players.push(player);
    socket.join(pin);
    socket.pin = pin;
    socket.role = 'player';
    socket.nickname = player.nickname;

    console.log(`[참가] ${player.nickname} → 방 ${pin}`);

    // 호스트에게 참가자 목록 업데이트
    io.to(room.host).emit('player-list', room.players.map(p => ({
      id: p.id, nickname: p.nickname, connected: p.connected
    })));

    callback({ success: true, nickname: player.nickname });
  });

  // ----- 게임 시작 (호스트) -----
  socket.on('start-game', (callback) => {
    const pin = socket.pin;
    const room = rooms[pin];
    if (!room || room.host !== socket.id) {
      return callback({ success: false, message: '권한이 없습니다.' });
    }

    const connectedPlayers = room.players.filter(p => p.connected);
    if (connectedPlayers.length < 2) {
      return callback({ success: false, message: '최소 2명 이상의 참가자가 필요합니다.' });
    }

    room.gameStarted = true;
    room.timerTotal = getRandomTime();
    room.timerStart = Date.now();

    // 랜덤으로 첫 폭탄 보유자 선정
    const firstHolder = connectedPlayers[Math.floor(Math.random() * connectedPlayers.length)];
    room.bombHolder = firstHolder.id;

    console.log(`[게임시작] 방 ${pin} | 타이머: ${room.timerTotal}ms | 첫 폭탄: ${firstHolder.nickname}`);

    // 모든 참가자에게 게임 시작 알림
    io.to(pin).emit('game-started', {
      bombHolder: firstHolder.id,
      bombHolderName: firstHolder.nickname
    });

    // 긴장감 증가 인터벌 (500ms마다 ratio 전송)
    room.interval = setInterval(() => {
      const ratio = getElapsedRatio(room);
      io.to(pin).emit('tension-update', { ratio });

      if (ratio >= 1) {
        explodeBomb(pin);
      }
    }, 500);

    // 안전장치: 타이머 종료 시 폭발
    room.bombTimeout = setTimeout(() => {
      if (room.gameStarted) {
        explodeBomb(pin);
      }
    }, room.timerTotal + 500);

    callback({ success: true });
  });

  // ----- 폭탄 패스 -----
  socket.on('pass-bomb', (callback) => {
    const pin = socket.pin;
    const room = rooms[pin];
    if (!room || !room.gameStarted) {
      return callback({ success: false });
    }
    if (room.bombHolder !== socket.id) {
      return callback({ success: false, message: '폭탄을 가지고 있지 않습니다.' });
    }

    const nextPlayer = getRandomPlayer(room, socket.id);
    if (!nextPlayer) {
      // 혼자 남은 경우 즉시 폭발
      explodeBomb(pin);
      return callback({ success: true });
    }

    room.bombHolder = nextPlayer.id;
    console.log(`[패스] ${socket.nickname} → ${nextPlayer.nickname} (방 ${pin})`);

    io.to(pin).emit('bomb-passed', {
      from: socket.nickname,
      bombHolder: nextPlayer.id,
      bombHolderName: nextPlayer.nickname
    });

    callback({ success: true });
  });

  // ----- 폭발 처리 -----
  function explodeBomb(pin) {
    const room = rooms[pin];
    if (!room || !room.gameStarted) return;

    room.gameStarted = false;
    if (room.interval) clearInterval(room.interval);
    if (room.bombTimeout) clearTimeout(room.bombTimeout);

    const loser = room.players.find(p => p.id === room.bombHolder);
    const loserName = loser ? loser.nickname : '???';

    console.log(`[폭발!] 방 ${pin} | 당첨자: ${loserName}`);

    io.to(pin).emit('bomb-exploded', {
      loserId: room.bombHolder,
      loserName: loserName
    });
  }

  // ----- 게임 리셋 (호스트) -----
  socket.on('reset-game', () => {
    const pin = socket.pin;
    const room = rooms[pin];
    if (!room || room.host !== socket.id) return;

    room.gameStarted = false;
    room.bombHolder = null;
    room.timerTotal = null;
    room.timerStart = null;
    if (room.interval) clearInterval(room.interval);
    if (room.bombTimeout) clearTimeout(room.bombTimeout);

    io.to(pin).emit('game-reset');
    io.to(room.host).emit('player-list', room.players.filter(p => p.connected).map(p => ({
      id: p.id, nickname: p.nickname, connected: p.connected
    })));
  });

  // ----- 연결 해제 -----
  socket.on('disconnect', () => {
    console.log(`[연결해제] ${socket.id} (${socket.nickname || 'host'})`);
    const pin = socket.pin;
    if (!pin || !rooms[pin]) return;
    const room = rooms[pin];

    // 호스트가 나간 경우 → 방 폭파
    if (room.host === socket.id) {
      io.to(pin).emit('room-closed', { message: '호스트가 퇴장하여 방이 종료되었습니다.' });
      cleanupRoom(pin);
      return;
    }

    // 플레이어가 나간 경우
    const player = room.players.find(p => p.id === socket.id);
    if (player) {
      player.connected = false;

      // 폭탄 가진 사람이 나갔으면 → 즉시 다음 사람에게 넘기기
      if (room.gameStarted && room.bombHolder === socket.id) {
        const nextPlayer = getRandomPlayer(room, socket.id);
        if (nextPlayer) {
          room.bombHolder = nextPlayer.id;
          console.log(`[이탈패스] ${player.nickname} 이탈 → ${nextPlayer.nickname}에게 폭탄 이동`);
          io.to(pin).emit('bomb-passed', {
            from: player.nickname + ' (이탈)',
            bombHolder: nextPlayer.id,
            bombHolderName: nextPlayer.nickname
          });
        } else {
          explodeBomb(pin);
        }
      }

      // 호스트에게 목록 업데이트
      io.to(room.host).emit('player-list', room.players.map(p => ({
        id: p.id, nickname: p.nickname, connected: p.connected
      })));

      // 연결된 플레이어가 없으면 방 정리
      const connected = room.players.filter(p => p.connected);
      if (connected.length === 0 && room.gameStarted) {
        cleanupRoom(pin);
      }
    }
  });
});

// ========== 서버 시작 ==========
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🧨 폭탄 돌리기 서버 실행 중: http://localhost:${PORT}`);
});

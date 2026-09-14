const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const rooms = {};

// Configuratia culorilor in functie de numarul de jucatori
const PLAYER_SLOTS = {
  2: ['Blue', 'Yellow'],
  3: ['Blue', 'Red', 'Yellow'],
  4: ['Blue', 'Red', 'Yellow', 'Green']
};

const START_OFFSETS = {
  Blue: 0,
  Red: 10,
  Yellow: 20,
  Green: 30
};

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

io.on('connection', (socket) => {
  socket.on('create_room', ({ playerName, maxPlayers }) => {
    const roomCode = generateRoomCode();
    const count = parseInt(maxPlayers, 10);
    const availableColors = PLAYER_SLOTS[count] || PLAYER_SLOTS[4];

    rooms[roomCode] = {
      maxPlayers: count,
      availableColors: availableColors,
      players: [
        { id: socket.id, name: playerName, color: availableColors[0], isHost: true }
      ],
      gameStarted: false,
      turnIndex: 0,
      diceValue: null,
      diceRolled: false,
      pawns: {
        Blue: [-1, -1, -1, -1],
        Red: [-1, -1, -1, -1],
        Yellow: [-1, -1, -1, -1],
        Green: [-1, -1, -1, -1]
      }
    };

    socket.join(roomCode);
    socket.emit('room_created', { roomCode, room: rooms[roomCode] });
  });

  socket.on('join_room', ({ playerName, roomCode }) => {
    const code = roomCode.toUpperCase().trim();
    const room = rooms[code];

    if (!room) return socket.emit('error_message', 'Room not found.');
    if (room.gameStarted) return socket.emit('error_message', 'Game already started.');
    if (room.players.length >= room.maxPlayers) return socket.emit('error_message', 'Room is full.');

    const assignedColor = room.availableColors[room.players.length];
    room.players.push({ id: socket.id, name: playerName, color: assignedColor, isHost: false });
    
    socket.join(code);
    socket.emit('joined_successfully', { roomCode: code, room });
    io.to(code).emit('update_players', room.players);
  });

  socket.on('start_game', (roomCode) => {
    const room = rooms[roomCode];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || !player.isHost) return;

    room.gameStarted = true;
    io.to(roomCode).emit('game_started', {
      turnColor: room.players[room.turnIndex].color,
      pawns: room.pawns,
      players: room.players,
      maxPlayers: room.maxPlayers,
      activeColors: room.availableColors
    });
  });

  socket.on('roll_dice', (roomCode) => {
    const room = rooms[roomCode];
    if (!room || !room.gameStarted || room.diceRolled) return;

    const currentPlayer = room.players[room.turnIndex];
    if (currentPlayer.id !== socket.id) return;

    const dice = Math.floor(Math.random() * 6) + 1;
    room.diceValue = dice;
    room.diceRolled = true;

    const color = currentPlayer.color;
    const playerPawns = room.pawns[color];

    // Reguli de mutare
    const canMoveAny = playerPawns.some((pos) => {
      if (pos === -1) return dice === 6; // Doar la 6 iese din baza
      if (pos >= 0 && pos + dice <= 44) return true;
      return false;
    });

    io.to(roomCode).emit('dice_rolled', { dice, turnColor: color, canMoveAny });

    // Daca nu exista mutari posibile
    if (!canMoveAny) {
      setTimeout(() => {
        if (dice === 6) {
          // A dat 6, dar n-are mutari (ex: blocaj) -> mai da o data
          room.diceRolled = false;
          io.to(roomCode).emit('state_update', {
            pawns: room.pawns,
            turnColor: color,
            message: `${currentPlayer.name} rolled a 6! Roll again.`
          });
        } else {
          nextTurn(roomCode);
        }
      }, 1500);
    }
  });

  socket.on('move_pawn', ({ roomCode, pawnIndex }) => {
    const room = rooms[roomCode];
    if (!room || !room.diceRolled) return;

    const currentPlayer = room.players[room.turnIndex];
    if (currentPlayer.id !== socket.id) return;

    const color = currentPlayer.color;
    const dice = room.diceValue;
    let pos = room.pawns[color][pawnIndex];
    let moved = false;

    if (pos === -1 && dice === 6) {
      // Scoate piesa la start
      room.pawns[color][pawnIndex] = 0;
      moved = true;
    } else if (pos >= 0 && pos + dice <= 44) {
      // Inainteaza piesa
      pos += dice;
      room.pawns[color][pawnIndex] = pos;
      moved = true;

      // Capturare pion advers pe traseul comun
      if (pos < 40) {
        const globalTarget = (pos + START_OFFSETS[color]) % 40;
        room.players.forEach(p => {
          if (p.color !== color) {
            room.pawns[p.color].forEach((otherPos, oIdx) => {
              if (otherPos >= 0 && otherPos < 40) {
                const otherGlobal = (otherPos + START_OFFSETS[p.color]) % 40;
                if (otherGlobal === globalTarget) {
                  room.pawns[p.color][oIdx] = -1; // trimis inapoi in baza
                }
              }
            });
          }
        });
      }
    }

    if (moved) {
      if (dice === 6) {
        // La 6 primeste inca o aruncare
        room.diceRolled = false;
        io.to(roomCode).emit('state_update', {
          pawns: room.pawns,
          turnColor: color,
          message: `${currentPlayer.name} rolled a 6 and gets another roll!`
        });
      } else {
        // Trecem la urmatorul jucator
        nextTurn(roomCode);
      }
    }
  });

  function nextTurn(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    room.diceRolled = false;
    room.diceValue = null;
    room.turnIndex = (room.turnIndex + 1) % room.players.length;

    io.to(roomCode).emit('state_update', {
      pawns: room.pawns,
      turnColor: room.players[room.turnIndex].color,
      message: `It is now ${room.players[room.turnIndex].name}'s turn.`
    });
  }

  socket.on('disconnect', () => {
    for (const code in rooms) {
      const room = rooms[code];
      const index = room.players.findIndex(p => p.id === socket.id);
      if (index !== -1) {
        room.players.splice(index, 1);
        if (room.players.length === 0) {
          delete rooms[code];
        } else {
          io.to(code).emit('update_players', room.players);
        }
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'super-senha-secreta-damas-2026';

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// BANCO DE DADOS (SQLite)
// ==========================================
const db = new sqlite3.Database('./database.sqlite', (err) => {
    if (err) console.error('Erro ao conectar ao SQLite:', err.message);
    else console.log('Conectado ao banco de dados SQLite.');
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        elo INTEGER DEFAULT 1000,
        wins INTEGER DEFAULT 0,
        losses INTEGER DEFAULT 0,
        draws INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

// ==========================================
// ROTAS DE AUTENTICAÇÃO E PERFIL (REST API)
// ==========================================
app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password || username.length < 3 || password.length < 6) {
        return res.status(400).json({ error: 'Dados inválidos. Username > 2 e Senha > 5.' });
    }
    try {
        const hash = await bcrypt.hash(password, 10);
        db.run(`INSERT INTO users (username, password) VALUES (?, ?)`, [username, hash], function(err) {
            if (err) return res.status(400).json({ error: 'Username já existe.' });
            const token = jwt.sign({ id: this.lastID, username }, JWT_SECRET);
            res.json({ token, username, elo: 1000 });
        });
    } catch (e) { res.status(500).json({ error: 'Erro no servidor' }); }
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    db.get(`SELECT * FROM users WHERE username = ?`, [username], async (err, user) => {
        if (err || !user) return res.status(400).json({ error: 'Usuário não encontrado.' });
        const valid = await bcrypt.compare(password, user.password);
        if (!valid) return res.status(400).json({ error: 'Senha incorreta.' });
        const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET);
        res.json({ token, username: user.username, elo: user.elo, wins: user.wins, losses: user.losses });
    });
});

app.get('/api/leaderboard', (req, res) => {
    db.all(`SELECT username, elo, wins, losses FROM users ORDER BY elo DESC LIMIT 10`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: 'Erro ao buscar ranking' });
        res.json(rows);
    });
});

// ==========================================
// LÓGICA DO JOGO DE DAMAS (Anti-Cheat)
// ==========================================
const EMPTY = 0, WHITE = 1, BLACK = 2, WHITE_KING = 3, BLACK_KING = 4;

function createInitialBoard() {
    let board = Array(8).fill().map(() => Array(8).fill(EMPTY));
    for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
            if ((r + c) % 2 !== 0) {
                if (r < 3) board[r][c] = BLACK;
                else if (r > 4) board[r][c] = WHITE;
            }
        }
    }
    return board;
}

function getValidMoves(board, playerTurn, mustMovePiece = null) {
    let moves = [];
    let hasJumps = false;
    let playerPieces = playerTurn === 'white' ? [WHITE, WHITE_KING] : [BLACK, BLACK_KING];
    
    for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
            if (playerPieces.includes(board[r][c])) {
                if (mustMovePiece && (mustMovePiece.r !== r || mustMovePiece.c !== c)) continue;
                
                let pieceJumps = getPieceJumps(board, r, c, board[r][c]);
                if (pieceJumps.length > 0) {
                    if (!hasJumps) { moves = []; hasJumps = true; } // Se achou pulo, descarta movimentos simples
                    moves.push(...pieceJumps);
                } else if (!hasJumps) {
                    moves.push(...getPieceRegularMoves(board, r, c, board[r][c]));
                }
            }
        }
    }
    return { moves, hasJumps };
}

function getPieceRegularMoves(board, r, c, piece) {
    let moves = [];
    let dirs = [];
    if (piece === WHITE || piece === WHITE_KING || piece === BLACK_KING) dirs.push([-1, -1], [-1, 1]); // Cima
    if (piece === BLACK || piece === WHITE_KING || piece === BLACK_KING) dirs.push([1, -1], [1, 1]);  // Baixo

    for (let [dr, dc] of dirs) {
        let nr = r + dr, nc = c + dc;
        if (nr >= 0 && nr < 8 && nc >= 0 && nc < 8 && board[nr][nc] === EMPTY) {
            moves.push({ from: {r, c}, to: {r: nr, c: nc}, isJump: false });
        }
    }
    return moves;
}

function getPieceJumps(board, r, c, piece) {
    let jumps = [];
    let dirs = [[-1, -1], [-1, 1], [1, -1], [1, 1]]; // Pulo é permitido para trás para todas no BR, mas focaremos no simples
    // Regra padrão: Peças normais pulam só pra frente. Reis pulam pra qualquer lado.
    if (piece === WHITE) dirs = [[-1, -1], [-1, 1]];
    if (piece === BLACK) dirs = [[1, -1], [1, 1]];

    let enemyPieces = piece === WHITE || piece === WHITE_KING ? [BLACK, BLACK_KING] : [WHITE, WHITE_KING];

    for (let [dr, dc] of dirs) {
        let nr = r + dr, nc = c + dc; // Casa inimiga
        let jr = r + 2*dr, jc = c + 2*dc; // Casa de destino
        if (jr >= 0 && jr < 8 && jc >= 0 && jc < 8) {
            if (enemyPieces.includes(board[nr][nc]) && board[jr][jc] === EMPTY) {
                jumps.push({ from: {r, c}, to: {r: jr, c: jc}, isJump: true, captured: {r: nr, c: nc} });
            }
        }
    }
    return jumps;
}

// ==========================================
// ESTADO DO MULTIPLAYER (Salas e Filas)
// ==========================================
const rooms = {}; // roomId -> roomData
const matchmakingQueue = [];
const connectedUsers = {}; // socketId -> { userId, username, elo, currentRoom }

function updateElo(winnerElo, loserElo) {
    const k = 32;
    const expectedWinner = 1 / (1 + Math.pow(10, (loserElo - winnerElo) / 400));
    const expectedLoser = 1 / (1 + Math.pow(10, (winnerElo - loserElo) / 400));
    return {
        newWinnerElo: Math.round(winnerElo + k * (1 - expectedWinner)),
        newLoserElo: Math.round(loserElo + k * (0 - expectedLoser))
    };
}

async function handleGameEnd(roomId, winnerColor) {
    const room = rooms[roomId];
    if (!room) return;
    
    let winnerId = winnerColor === 'white' ? room.players.white.id : room.players.black.id;
    let loserId = winnerColor === 'white' ? room.players.black.id : room.players.white.id;

    // Buscar no DB e atualizar
    db.get(`SELECT id, elo, wins, losses FROM users WHERE id IN (?, ?)`, [winnerId, loserId], (err, rows) => {
        // Lógica simplificada: Atualizar DB real na produção.
        // Simulando a atualização rápida para enviar para o frontend
        io.to(roomId).emit('game_over', { winner: winnerColor, message: 'Partida finalizada!' });
        delete rooms[roomId];
    });
}

// ==========================================
// SOCKET.IO (Tempo Real)
// ==========================================
io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error("Não autorizado"));
    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) return next(new Error("Token inválido"));
        socket.user = decoded;
        next();
    });
});

io.on('connection', (socket) => {
    console.log(`Usuário conectado: ${socket.user.username}`);
    
    db.get(`SELECT elo FROM users WHERE id = ?`, [socket.user.id], (err, row) => {
        connectedUsers[socket.id] = { id: socket.user.id, username: socket.user.username, elo: row?.elo || 1000, socketId: socket.id };
    });

    // SISTEMA DE MATCHMAKING (RANKED)
    socket.on('find_match', () => {
        let user = connectedUsers[socket.id];
        if (!user) return;
        if (matchmakingQueue.find(u => u.id === user.id)) return; // Já na fila

        matchmakingQueue.push(user);
        socket.emit('queue_update', { message: 'Buscando partida...', inQueue: true });

        if (matchmakingQueue.length >= 2) {
            let p1 = matchmakingQueue.shift();
            let p2 = matchmakingQueue.shift();
            
            const roomId = `room_${Date.now()}`;
            rooms[roomId] = {
                id: roomId,
                board: createInitialBoard(),
                turn: 'white',
                players: {
                    white: p1,
                    black: p2
                },
                mustMovePiece: null,
                timer: { white: 600, black: 600, lastTick: Date.now() } // 10 min
            };

            connectedUsers[p1.socketId].currentRoom = roomId;
            connectedUsers[p2.socketId].currentRoom = roomId;

            io.sockets.sockets.get(p1.socketId).join(roomId);
            io.sockets.sockets.get(p2.socketId).join(roomId);

            io.to(roomId).emit('game_start', { 
                roomId, 
                white: { username: p1.username, elo: p1.elo }, 
                black: { username: p2.username, elo: p2.elo },
                board: rooms[roomId].board,
                turn: 'white'
            });
        }
    });

    // SISTEMA DE JOGO (MOVIMENTOS)
    socket.on('make_move', (data) => {
        let user = connectedUsers[socket.id];
        if (!user || !user.currentRoom) return;
        
        let room = rooms[user.currentRoom];
        let color = room.players.white.id === user.id ? 'white' : (room.players.black.id === user.id ? 'black' : null);
        if (!color || room.turn !== color) return; // Não é a vez do jogador

        let { moves } = getValidMoves(room.board, room.turn, room.mustMovePiece);
        
        // Verifica se o movimento requisitado está na lista de permitidos
        let validMove = moves.find(m => m.from.r === data.from.r && m.from.c === data.from.c && m.to.r === data.to.r && m.to.c === data.to.c);
        
        if (validMove) {
            // Executar movimento
            let piece = room.board[validMove.from.r][validMove.from.c];
            room.board[validMove.from.r][validMove.from.c] = EMPTY;
            room.board[validMove.to.r][validMove.to.c] = piece;

            if (validMove.isJump) {
                room.board[validMove.captured.r][validMove.captured.c] = EMPTY; // Remove peça capturada
                
                // Verifica promoção no meio do pulo
                if (color === 'white' && validMove.to.r === 0) room.board[validMove.to.r][validMove.to.c] = WHITE_KING;
                if (color === 'black' && validMove.to.r === 7) room.board[validMove.to.r][validMove.to.c] = BLACK_KING;

                // Verifica se pode pular de novo (Multi-jump)
                let extraJumps = getPieceJumps(room.board, validMove.to.r, validMove.to.c, room.board[validMove.to.r][validMove.to.c]);
                if (extraJumps.length > 0) {
                    room.mustMovePiece = { r: validMove.to.r, c: validMove.to.c };
                    io.to(room.id).emit('update_board', { board: room.board, turn: room.turn, mustMovePiece: room.mustMovePiece });
                    return; // Continua o turno
                }
            }

            // Promoção normal caso chegue ao fim
            if (color === 'white' && validMove.to.r === 0) room.board[validMove.to.r][validMove.to.c] = WHITE_KING;
            if (color === 'black' && validMove.to.r === 7) room.board[validMove.to.r][validMove.to.c] = BLACK_KING;

            // Passa o turno
            room.turn = room.turn === 'white' ? 'black' : 'white';
            room.mustMovePiece = null;

            // Verifica se o próximo jogador tem movimentos
            let nextMoves = getValidMoves(room.board, room.turn);
            if (nextMoves.moves.length === 0) {
                handleGameEnd(room.id, color); // Próximo jogador sem movimentos = Vitória do atual
            } else {
                io.to(room.id).emit('update_board', { board: room.board, turn: room.turn });
            }
        } else {
            // Movimento inválido (Anti-cheat ou erro de sync)
            socket.emit('invalid_move', { board: room.board }); 
        }
    });

    // CHAT E DESCONEXÃO
    socket.on('send_chat', (msg) => {
        let user = connectedUsers[socket.id];
        if (user && user.currentRoom) {
            io.to(user.currentRoom).emit('chat_message', { sender: user.username, text: msg });
        }
    });

    socket.on('disconnect', () => {
        let user = connectedUsers[socket.id];
        if (user) {
            // Remover da fila de matchmaking
            const qIndex = matchmakingQueue.findIndex(u => u.id === user.id);
            if (qIndex !== -1) matchmakingQueue.splice(qIndex, 1);
            
            // Abandono de sala (Vitória pro oponente)
            if (user.currentRoom && rooms[user.currentRoom]) {
                let room = rooms[user.currentRoom];
                let winner = room.players.white.id === user.id ? 'black' : 'white';
                handleGameEnd(user.currentRoom, winner);
            }
            delete connectedUsers[socket.id];
        }
    });
});

// App Entry Point
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

server.listen(PORT, () => {
    console.log(`Servidor de Damas Pro rodando na porta ${PORT}`);
});

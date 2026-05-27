/**
 * IPL Trump Card Arena — Multiplayer Backend
 * ============================================
 * Express + Socket.io server for real-time lobby & game sync.
 * Port: 3000
 *
 * Room lifecycle:
 *   create-lobby → join-lobby → start-game → [choose-stat / toss] × N rounds → game-over
 */

const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const cors     = require('cors');
const crypto   = require('crypto');
const path     = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});

app.use(cors());
app.use(express.json());

// ── Serve the game HTML so phone/devices can join via browser ─────────────────
app.use(express.static(path.join(__dirname, '..')));

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/status', (req, res) => {
    res.json({
        status : 'running',
        rooms  : Object.keys(rooms).length,
        players: Object.values(rooms).reduce((a, r) => a + r.players.length, 0)
    });
});

// ── In-memory room store ──────────────────────────────────────────────────────
/**
 * Room shape:
 * {
 *   code       : '4F8K2J',
 *   hostId     : socketId,
 *   state      : 'lobby' | 'playing' | 'ended',
 *   level      : 1 | 2 | 3,
 *   players    : [{ id, name, isBot, connected }],
 *   game       : {
 *     decks         : { [playerId]: card[] },
 *     activeCards   : { [playerId]: card | null },
 *     pot           : card[],
 *     round         : number,
 *     turnOwnerIdx  : number,
 *     chosenStat    : string | null,
 *     evaluated     : boolean,
 *     timer         : NodeJS.Timeout | null,
 *     tossOwner     : string | null      // socketId who needs to toss
 *   }
 * }
 */
const rooms = {};

// ── Helpers ───────────────────────────────────────────────────────────────────
function generateCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code;
    do {
        code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    } while (rooms[code]);
    return code;
}

function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

function getRoom(code) { return rooms[code] || null; }

function roomPublicState(room) {
    return {
        code    : room.code,
        state   : room.state,
        level   : room.level,
        hostId  : room.hostId,
        players : room.players.map(p => ({
            id        : p.id,
            name      : p.name,
            isBot     : p.isBot,
            connected : p.connected,
            cardCount : room.game ? (room.game.decks[p.id]?.length ?? 0) : 0
        }))
    };
}

// ── Stat comparison (mirrors client STATEDEFINITIONS) ─────────────────────────
const BETTER = {
    runs         : 'high',
    strikeRateBat: 'high',
    averageBat   : 'high',
    highestScore : 'high',
    sixes        : 'high',
    fours        : 'high',
    wickets      : 'high',
    economy      : 'low',
    averageBowl  : 'low',
    strikeRateBowl: 'low',
    rank         : 'low'
};

function getStatVal(card, statKey) {
    if (!card) return statKey === 'rank' ? 9999 : 0;
    const paths = {
        runs          : card.batting?.Runs,
        strikeRateBat : card.batting?.StrikeRate,
        averageBat    : card.batting?.BattingAvg,
        highestScore  : card.batting?.HighestScore,
        sixes         : card.batting?.Sixes,
        fours         : card.batting?.Fours,
        wickets       : card.bowling?.Wickets,
        economy       : card.bowling?.Econ,
        averageBowl   : card.bowling?.Average,
        strikeRateBowl: card.bowling?.StrikeRate,
        rank          : card.category_rank || card.rank
    };
    const v = parseFloat(paths[statKey]);
    if (isNaN(v)) return BETTER[statKey] === 'low' ? 9999 : 0;
    return v;
}

function evaluateRound(room) {
    const { game, players } = room;
    const statKey = game.chosenStat;

    const alivePlayers = players.filter(p => game.decks[p.id]?.length > 0 || game.activeCards[p.id]);
    const better       = BETTER[statKey] ?? 'high';

    let bestVal = better === 'high' ? -Infinity : Infinity;
    alivePlayers.forEach(p => {
        const v = getStatVal(game.activeCards[p.id], statKey);
        if (better === 'high' ? v > bestVal : v < bestVal) bestVal = v;
    });

    const winners = alivePlayers.filter(p => getStatVal(game.activeCards[p.id], statKey) === bestVal).map(p => p.id);

    // Build value map for display
    const valueMap = {};
    alivePlayers.forEach(p => { valueMap[p.id] = getStatVal(game.activeCards[p.id], statKey); });

    return { winners, bestVal, valueMap };
}

function distributeCards(room) {
    const { game, players } = room;
    const { winners } = evaluateRound(room);

    // Collect all active cards into pot
    const potCards = [];
    players.forEach(p => {
        if (game.activeCards[p.id]) {
            potCards.push(game.activeCards[p.id]);
            game.activeCards[p.id] = null;
        }
    });

    if (winners.length === 1) {
        // Single winner gets all cards + pot
        game.decks[winners[0]] = [...(game.decks[winners[0]] || []), ...game.pot, ...potCards];
        game.pot = [];
        // Turn passes to winner
        const idx = players.findIndex(p => p.id === winners[0]);
        game.turnOwnerIdx = idx >= 0 ? idx : 0;
    } else {
        // Tie — cards go to pot, same turn owner
        game.pot = [...game.pot, ...potCards];
    }
}

function advanceToNextRound(room) {
    const { game, players } = room;
    game.round++;
    game.chosenStat  = null;
    game.evaluated   = false;

    // Remove players with no cards
    players.forEach(p => {
        if (!game.decks[p.id] || game.decks[p.id].length === 0) {
            game.activeCards[p.id] = null;
        } else {
            game.activeCards[p.id] = game.decks[p.id][0];
        }
    });

    // Ensure turn owner is still alive
    const aliveIds = players.filter(p => game.decks[p.id]?.length > 0).map(p => p.id);
    if (aliveIds.length <= 1) return null; // game over

    const turnOwner = players[game.turnOwnerIdx];
    if (!aliveIds.includes(turnOwner?.id)) {
        const firstAliveIdx = players.findIndex(p => aliveIds.includes(p.id));
        game.turnOwnerIdx = firstAliveIdx >= 0 ? firstAliveIdx : 0;
    }
    return aliveIds;
}

function buildRoundState(room) {
    const { game, players } = room;
    const turnOwner = players[game.turnOwnerIdx];
    return {
        round       : game.round,
        potCount    : game.pot.length,
        turnOwnerId : turnOwner?.id,
        turnOwnerName: turnOwner?.name,
        activeCards : Object.fromEntries(
            players.map(p => [p.id, game.activeCards[p.id]])
        ),
        deckCounts  : Object.fromEntries(
            players.map(p => [p.id, game.decks[p.id]?.length ?? 0])
        )
    };
}

function checkGameOver(room) {
    const { game, players } = room;
    const alive = players.filter(p => game.decks[p.id]?.length > 0);
    return alive.length <= 1 ? (alive[0] || null) : null;
}

function clearRoomTimer(room) {
    if (room.game?.timer) {
        clearTimeout(room.game.timer);
        room.game.timer = null;
    }
}

// ── Socket.io events ──────────────────────────────────────────────────────────
io.on('connection', socket => {
    console.log(`[+] Connected: ${socket.id}`);

    // ── Create Lobby ──────────────────────────────────────────────────────────
    socket.on('create-lobby', ({ playerName, level }) => {
        if (!playerName?.trim()) return socket.emit('error', 'Player name required.');
        const code = generateCode();
        rooms[code] = {
            code,
            hostId : socket.id,
            state  : 'lobby',
            level  : level || 1,
            players: [{ id: socket.id, name: playerName.trim(), isBot: false, connected: true }],
            game   : null
        };
        socket.join(code);
        socket.roomCode = code;
        socket.playerName = playerName.trim();

        socket.emit('lobby-created', { code, room: roomPublicState(rooms[code]) });
        console.log(`[LOBBY] Created: ${code} by ${playerName}`);
    });

    // ── Join Lobby ────────────────────────────────────────────────────────────
    socket.on('join-lobby', ({ roomCode, playerName }) => {
        const code = roomCode?.toUpperCase().trim();
        const room = getRoom(code);
        if (!room) return socket.emit('error', `Room "${code}" not found.`);
        if (room.state !== 'lobby') return socket.emit('error', 'Game already started.');
        if (room.players.length >= 6) return socket.emit('error', 'Room is full (max 6 players).');
        if (!playerName?.trim()) return socket.emit('error', 'Player name required.');

        const player = { id: socket.id, name: playerName.trim(), isBot: false, connected: true };
        room.players.push(player);
        socket.join(code);
        socket.roomCode = code;
        socket.playerName = playerName.trim();

        socket.emit('lobby-joined', { room: roomPublicState(room) });
        io.to(code).emit('player-joined', { player, room: roomPublicState(room) });
        console.log(`[LOBBY] ${playerName} joined ${code}`);
    });

    // ── Update Level (host only) ──────────────────────────────────────────────
    socket.on('set-level', ({ level }) => {
        const room = getRoom(socket.roomCode);
        if (!room || room.hostId !== socket.id) return;
        room.level = parseInt(level) || 1;
        io.to(room.code).emit('level-changed', { level: room.level, room: roomPublicState(room) });
    });

    // ── Start Game ────────────────────────────────────────────────────────────
    socket.on('start-game', ({ cardData }) => {
        const room = getRoom(socket.roomCode);
        if (!room) return socket.emit('error', 'Room not found.');
        if (room.hostId !== socket.id) return socket.emit('error', 'Only host can start the game.');
        if (room.players.length < 2) return socket.emit('error', 'Need at least 2 players to start.');
        if (!Array.isArray(cardData) || cardData.length < room.players.length) {
            return socket.emit('error', 'Not enough cards for all players.');
        }

        room.state = 'playing';
        const shuffled = shuffle(cardData);
        const decks    = {};
        const activeCards = {};

        room.players.forEach(p => {
            decks[p.id]       = [];
            activeCards[p.id] = null;
        });

        // Deal round-robin
        shuffled.forEach((card, i) => {
            const pid = room.players[i % room.players.length].id;
            decks[pid].push(card);
        });

        room.game = {
            decks,
            activeCards,
            pot          : [],
            round        : 1,
            turnOwnerIdx : 0,
            chosenStat   : null,
            evaluated    : false,
            timer        : null,
            tossOwner    : null
        };

        // Set active cards
        room.players.forEach(p => {
            room.game.activeCards[p.id] = room.game.decks[p.id][0] || null;
        });

        // Remove top card from deck (it's now "active")
        room.players.forEach(p => {
            if (room.game.decks[p.id].length > 0) room.game.decks[p.id].shift();
        });

        // Send each player their own private deck
        room.players.forEach(p => {
            io.to(p.id).emit('game-started', {
                yourId      : p.id,
                yourDeck    : room.game.decks[p.id],
                activeCard  : room.game.activeCards[p.id],
                roundState  : buildRoundState(room)
            });
        });

        io.to(room.code).emit('round-started', buildRoundState(room));
        console.log(`[GAME] Started room ${room.code} | ${room.players.length} players | ${shuffled.length} cards`);

        // Start 90s timer for turn owner
        startTurnTimer(room);
    });

    // ── Choose Stat ───────────────────────────────────────────────────────────
    socket.on('choose-stat', ({ statKey }) => {
        const room = getRoom(socket.roomCode);
        if (!room || room.state !== 'playing') return;
        if (room.game.evaluated) return;

        const turnOwner = room.players[room.game.turnOwnerIdx];
        if (turnOwner.id !== socket.id) return socket.emit('error', 'Not your turn.');
        if (!BETTER[statKey]) return socket.emit('error', 'Invalid stat.');

        clearRoomTimer(room);
        room.game.chosenStat = statKey;

        io.to(room.code).emit('stat-chosen', { statKey, turnOwnerId: socket.id });

        // Evaluate after short delay
        setTimeout(() => resolveRound(room), 1500);
    });

    // ── Timeout Toss ─────────────────────────────────────────────────────────
    socket.on('toss-choice', ({ choice }) => {
        const room = getRoom(socket.roomCode);
        if (!room || room.state !== 'playing') return;
        if (room.game.tossOwner !== socket.id) return;
        if (!['Heads', 'Tails'].includes(choice)) return;

        clearRoomTimer(room);
        const result     = Math.random() < 0.5 ? 'Heads' : 'Tails';
        const playerWon  = (choice === result);
        const alivePlayers = room.players.filter(p => room.game.decks[p.id]?.length > 0 || room.game.activeCards[p.id]);

        let newTurnOwnerIdx;
        if (playerWon) {
            newTurnOwnerIdx = room.players.findIndex(p => p.id === socket.id);
        } else {
            const others = alivePlayers.filter(p => p.id !== socket.id);
            const winner = others[Math.floor(Math.random() * others.length)];
            newTurnOwnerIdx = room.players.findIndex(p => p.id === winner?.id);
        }
        room.game.turnOwnerIdx = newTurnOwnerIdx >= 0 ? newTurnOwnerIdx : 0;
        room.game.tossOwner    = null;

        const newTurnOwner = room.players[room.game.turnOwnerIdx];
        io.to(room.code).emit('toss-result', {
            choice, result, playerWon,
            newTurnOwnerId  : newTurnOwner.id,
            newTurnOwnerName: newTurnOwner.name
        });

        // Give new turn owner 90s
        setTimeout(() => startTurnTimer(room), 2000);
    });

    // ── Disconnect ────────────────────────────────────────────────────────────
    socket.on('disconnect', () => {
        const code = socket.roomCode;
        const room = getRoom(code);
        if (!room) return;

        const player = room.players.find(p => p.id === socket.id);
        if (player) player.connected = false;

        io.to(code).emit('player-disconnected', {
            playerId: socket.id,
            name    : player?.name,
            room    : roomPublicState(room)
        });
        console.log(`[-] Disconnected: ${socket.id} from ${code}`);

        // Cleanup empty rooms after 2 minutes
        const allLeft = room.players.every(p => !p.connected);
        if (allLeft) {
            setTimeout(() => {
                if (rooms[code] && rooms[code].players.every(p => !p.connected)) {
                    clearRoomTimer(rooms[code]);
                    delete rooms[code];
                    console.log(`[ROOM] Cleaned up empty room ${code}`);
                }
            }, 120_000);
        }

        // If host left during lobby, transfer host
        if (room.state === 'lobby' && room.hostId === socket.id) {
            const nextHost = room.players.find(p => p.connected && p.id !== socket.id);
            if (nextHost) {
                room.hostId = nextHost.id;
                io.to(code).emit('host-changed', { newHostId: nextHost.id, newHostName: nextHost.name });
            }
        }
    });

    // ── Reconnect to room ─────────────────────────────────────────────────────
    socket.on('reconnect-room', ({ roomCode, playerName }) => {
        const code = roomCode?.toUpperCase().trim();
        const room = getRoom(code);
        if (!room) return socket.emit('error', 'Room not found.');

        const existing = room.players.find(p => p.name === playerName.trim());
        if (!existing) return socket.emit('error', 'Player not in room.');

        // Update socket ID
        const oldId = existing.id;
        existing.id        = socket.id;
        existing.connected = true;
        socket.join(code);
        socket.roomCode   = code;

        // Update game decks/activeCards keys
        if (room.game) {
            if (room.game.decks[oldId])       { room.game.decks[socket.id]       = room.game.decks[oldId];       delete room.game.decks[oldId]; }
            if (room.game.activeCards[oldId] !== undefined) { room.game.activeCards[socket.id] = room.game.activeCards[oldId]; delete room.game.activeCards[oldId]; }
            if (room.game.tossOwner === oldId) room.game.tossOwner = socket.id;
            // Update turnOwner index
            const idx = room.players.findIndex(p => p.id === socket.id);
            if (room.game.turnOwnerIdx === room.players.indexOf(existing)) room.game.turnOwnerIdx = idx;
        }

        socket.emit('reconnect-success', {
            yourId     : socket.id,
            room       : roomPublicState(room),
            roundState : room.game ? buildRoundState(room) : null,
            yourDeck   : room.game?.decks[socket.id] || [],
            activeCard : room.game?.activeCards[socket.id] || null
        });
        io.to(code).emit('player-rejoined', { playerId: socket.id, name: existing.name, room: roomPublicState(room) });
        console.log(`[RECONNECT] ${existing.name} reconnected to ${code}`);
    });
});

// ── Internal: resolve a round ─────────────────────────────────────────────────
function resolveRound(room) {
    if (!room.game || room.game.evaluated) return;
    room.game.evaluated = true;

    const { winners, bestVal, valueMap } = evaluateRound(room);

    io.to(room.code).emit('round-result', {
        statKey  : room.game.chosenStat,
        winners,
        bestVal,
        valueMap,
        roundState: buildRoundState(room)
    });

    // Distribute cards
    distributeCards(room);

    // Check game over
    const gameWinner = checkGameOver(room);
    if (gameWinner) {
        room.state = 'ended';
        clearRoomTimer(room);
        io.to(room.code).emit('game-over', {
            winnerId  : gameWinner.id,
            winnerName: gameWinner.name
        });
        console.log(`[GAME] Over in ${room.code} — Winner: ${gameWinner.name}`);
        setTimeout(() => { delete rooms[room.code]; }, 300_000);
        return;
    }

    // Next round after delay
    setTimeout(() => {
        const alive = advanceToNextRound(room);
        if (!alive) return;

        room.players.forEach(p => {
            io.to(p.id).emit('next-round', {
                yourDeck   : room.game.decks[p.id],
                activeCard : room.game.activeCards[p.id],
                roundState : buildRoundState(room)
            });
        });
        io.to(room.code).emit('round-started', buildRoundState(room));
        startTurnTimer(room);
    }, 3000);
}

// ── Internal: 90s turn timer ──────────────────────────────────────────────────
function startTurnTimer(room) {
    clearRoomTimer(room);
    if (!room.game) return;

    const turnOwner = room.players[room.game.turnOwnerIdx];
    if (!turnOwner) return;

    io.to(room.code).emit('timer-started', { seconds: 90, turnOwnerId: turnOwner.id });

    room.game.timer = setTimeout(() => {
        if (!room.game || room.game.evaluated) return;
        // Timeout — trigger toss for current turn owner
        room.game.tossOwner = turnOwner.id;
        io.to(room.code).emit('turn-timeout', { tossOwnerId: turnOwner.id });
        console.log(`[TIMER] Timeout for ${turnOwner.name} in ${room.code}`);

        // Give 30s for toss response, else auto-pick
        room.game.timer = setTimeout(() => {
            if (room.game?.tossOwner === turnOwner.id) {
                const auto = Math.random() < 0.5 ? 'Heads' : 'Tails';
                io.to(turnOwner.id).emit('auto-toss', { choice: auto });
            }
        }, 30_000);
    }, 90_000);
}

// ── Start server ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('╔══════════════════════════════════════════════╗');
    console.log('║   🏏  IPL Trump Card Arena — Backend         ║');
    console.log(`║   🟢  Running on http://localhost:${PORT}       ║`);
    console.log('║   📡  Socket.io ready for connections        ║');
    console.log('║   🌐  Other devices: use your LAN IP:3000    ║');
    console.log('╚══════════════════════════════════════════════╝');
    console.log('');
    console.log('  Players on same WiFi can open:');
    console.log('  → http://<YOUR_IP>:3000/gemini-code-game.html');
    console.log('');
});

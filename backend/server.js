/**
 * IPL Trump Card Arena — Multiplayer Backend v2
 * ===============================================
 * ARCHITECTURE:
 *   - Server loads card JSONs itself (no cardData from host)
 *   - Server is 100% authoritative: deals cards, evaluates stats, picks winner
 *   - Each client only receives their OWN deck + all players' active cards
 *   - Frontend renders; GIF/audio handled client-side
 */

const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const cors     = require('cors');
const path     = require('path');
const fs       = require('fs');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    pingTimeout: 60000,
    pingInterval: 25000
});

app.use(cors());
app.use(express.json());

// Serve the game HTML so phone/devices can join via browser
app.use(express.static(path.join(__dirname, '..')));

// ── Load card data from JSON files ────────────────────────────────────────────
const GAME_DIR = path.join(__dirname, '..');

function loadJson(filename) {
    try {
        const raw = fs.readFileSync(path.join(GAME_DIR, filename), 'utf8');
        const data = JSON.parse(raw);
        // Support arrays or {players:[]} wrapper
        const arr = Array.isArray(data) ? data : (data.players || data.records || Object.values(data)[0]);
        if (!Array.isArray(arr)) throw new Error('Not an array');
        return arr;
    } catch(e) {
        console.error(`[CARDS] Failed to load ${filename}:`, e.message);
        return [];
    }
}

// Level mapping: level 1 = allrounders, 2 = bowlers, 3 = batters
const CARD_DATA = {
    1: loadJson('allrounders.json'),
    2: loadJson('bowlers.json'),
    3: loadJson('batters.json')
};

// Normalise a raw JSON card record into the shape the frontend expects
function normaliseCard(raw, idx) {
    return {
        id           : raw.id ?? idx,
        name         : raw.batting?.PlayerName || raw.bowling?.PlayerName || raw.playerSlug?.replace(/-/g,' ').toUpperCase() || `Player ${idx+1}`,
        team         : raw.team || raw.batting?.TeamName || raw.bowling?.TeamName || 'Neutral',
        rank         : parseInt(raw.rank) || 999,
        category_rank: parseInt(raw.category_rank) || (idx + 1),
        category     : raw.category || '',
        image_name   : raw.image_name || '',
        batting      : raw.batting  || {},
        bowling      : raw.bowling  || {}
    };
}

Object.keys(CARD_DATA).forEach(lvl => {
    CARD_DATA[lvl] = CARD_DATA[lvl].map(normaliseCard);
    console.log(`[CARDS] Level ${lvl}: ${CARD_DATA[lvl].length} cards loaded`);
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/status', (_req, res) => {
    res.json({
        status : 'running',
        rooms  : Object.keys(rooms).length,
        players: Object.values(rooms).reduce((a, r) => a + r.players.length, 0),
        cards  : { 1: CARD_DATA[1].length, 2: CARD_DATA[2].length, 3: CARD_DATA[3].length }
    });
});

// ── In-memory room store ──────────────────────────────────────────────────────
const rooms = {};

function generateCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code;
    do { code = Array.from({length:6}, () => chars[Math.floor(Math.random()*chars.length)]).join(''); }
    while (rooms[code]);
    return code;
}

function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length-1; i>0; i--) {
        const j = Math.floor(Math.random()*(i+1));
        [a[i],a[j]] = [a[j],a[i]];
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
            id       : p.id,
            name     : p.name,
            connected: p.connected,
            cardCount: room.game ? (room.game.decks[p.id]?.length ?? 0) : 0
        }))
    };
}

// ── Stat evaluation (mirrors client STATEDEFINITIONS) ─────────────────────────
const STAT_DIR = {
    runs          : 'high',
    strikeRateBat : 'high',
    averageBat    : 'high',
    highestScore  : 'high',
    sixes         : 'high',
    fours         : 'high',
    wickets       : 'high',
    economy       : 'low',
    averageBowl   : 'low',
    strikeRateBowl: 'low',
    rank          : 'low'
};

function getStatVal(card, key) {
    if (!card) return STAT_DIR[key]==='low' ? 9999 : 0;
    const map = {
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
    const v = parseFloat(map[key]);
    return isNaN(v) ? (STAT_DIR[key]==='low' ? 9999 : 0) : v;
}

function evaluateRound(room) {
    const { game, players } = room;
    const stat = game.chosenStat;
    const dir  = STAT_DIR[stat] ?? 'high';
    const alive = players.filter(p => game.activeCards[p.id]);

    let best = dir==='high' ? -Infinity : Infinity;
    alive.forEach(p => {
        const v = getStatVal(game.activeCards[p.id], stat);
        if (dir==='high' ? v>best : v<best) best = v;
    });

    const winners  = alive.filter(p => getStatVal(game.activeCards[p.id],stat) === best).map(p=>p.id);
    const valueMap = {};
    alive.forEach(p => { valueMap[p.id] = getStatVal(game.activeCards[p.id], stat); });
    return { winners, bestVal: best, valueMap };
}

function buildRoundState(room) {
    const { game, players } = room;
    const owner = players[game.turnOwnerIdx];
    return {
        round        : game.round,
        potCount     : game.pot.length,
        turnOwnerId  : owner?.id,
        turnOwnerName: owner?.name,
        // Send all active cards so every client can render the arena
        activeCards  : Object.fromEntries(players.map(p => [p.id, game.activeCards[p.id] || null])),
        deckCounts   : Object.fromEntries(players.map(p => [p.id, game.decks[p.id]?.length ?? 0]))
    };
}

function checkGameOver(room) {
    const alive = room.players.filter(p => (room.game.decks[p.id]?.length ?? 0) > 0);
    return alive.length <= 1 ? (alive[0] || null) : null;
}

function clearTimer(room) {
    if (room.game?.timer) { clearTimeout(room.game.timer); room.game.timer = null; }
}

// ── Socket events ─────────────────────────────────────────────────────────────
io.on('connection', socket => {
    console.log(`[+] ${socket.id}`);

    // ── Create Lobby ──────────────────────────────────────────────────────────
    socket.on('create-lobby', ({ playerName, level }) => {
        if (!playerName?.trim()) return socket.emit('error', 'Player name required.');
        const code = generateCode();
        rooms[code] = {
            code, hostId: socket.id, state: 'lobby',
            level: parseInt(level) || 1,
            players: [{ id: socket.id, name: playerName.trim(), connected: true }],
            game: null
        };
        socket.join(code);
        socket.roomCode = code;
        socket.emit('lobby-created', { code, room: roomPublicState(rooms[code]) });
        console.log(`[LOBBY] Created: ${code} by ${playerName}`);
    });

    // ── Join Lobby ────────────────────────────────────────────────────────────
    socket.on('join-lobby', ({ roomCode, playerName }) => {
        const code = roomCode?.toUpperCase().trim();
        const room = getRoom(code);
        if (!room) return socket.emit('error', `Room "${code}" not found.`);
        if (room.state !== 'lobby') return socket.emit('error', 'Game already started.');
        if (room.players.length >= 6) return socket.emit('error', 'Room is full (max 6).');
        if (!playerName?.trim()) return socket.emit('error', 'Player name required.');

        room.players.push({ id: socket.id, name: playerName.trim(), connected: true });
        socket.join(code);
        socket.roomCode = code;

        socket.emit('lobby-joined', { room: roomPublicState(room) });
        io.to(code).emit('player-joined', { room: roomPublicState(room) });
        console.log(`[LOBBY] ${playerName} joined ${code}`);
    });

    // ── Set Level (host only) ─────────────────────────────────────────────────
    socket.on('set-level', ({ level }) => {
        const room = getRoom(socket.roomCode);
        if (!room || room.hostId !== socket.id) return;
        room.level = parseInt(level) || 1;
        io.to(room.code).emit('level-changed', { level: room.level, room: roomPublicState(room) });
    });

    // ── Start Game (host only) ────────────────────────────────────────────────
    // Server uses its own JSON card data; falls back to client-provided cardData
    // if server JSONs are empty (e.g. Codespaces without JSON files pushed)
    socket.on('start-game', ({ cardData } = {}) => {
        const room = getRoom(socket.roomCode);
        if (!room) return socket.emit('error', 'Room not found.');
        if (room.hostId !== socket.id) return socket.emit('error', 'Only host can start.');
        if (room.players.length < 2) return socket.emit('error', 'Need at least 2 players.');

        // Try server's own JSON first; fall back to client-provided cardData
        let cards = CARD_DATA[room.level]?.length > 0 ? CARD_DATA[room.level] : (CARD_DATA[1]?.length > 0 ? CARD_DATA[1] : []);

        if (cards.length < room.players.length && Array.isArray(cardData) && cardData.length >= room.players.length) {
            // Use client-provided cards (normalise them to our internal format)
            cards = cardData.map(normaliseCard);
            console.log(`[GAME] Using client-provided cards (${cards.length}) for room ${room.code}`);
        }

        if (cards.length < room.players.length) {
            return socket.emit('error', `Not enough cards (${cards.length}) for ${room.players.length} players. Push JSON files to server.`);
        }

        room.state = 'playing';
        const shuffled = shuffle(cards);
        const decks = {}, activeCards = {};
        room.players.forEach(p => { decks[p.id] = []; activeCards[p.id] = null; });

        // Deal round-robin
        shuffled.forEach((card, i) => {
            decks[room.players[i % room.players.length].id].push(card);
        });

        // Set first active card for each player (top of deck)
        room.players.forEach(p => {
            activeCards[p.id] = decks[p.id].shift() || null;
        });

        room.game = {
            decks, activeCards,
            pot: [], round: 1, turnOwnerIdx: 0,
            chosenStat: null, evaluated: false, timer: null, tossOwner: null
        };

        const roundState = buildRoundState(room);

        // Send each player their private deck + their active card + full roundState
        room.players.forEach(p => {
            io.to(p.id).emit('game-started', {
                yourId    : p.id,
                yourDeck  : room.game.decks[p.id],        // remaining deck (active already removed)
                activeCard: room.game.activeCards[p.id],  // current card to play
                roundState                                 // has ALL players' active cards + deckCounts
            });
        });

        console.log(`[GAME] Started ${room.code} | Level ${room.level} | ${room.players.length}p | ${shuffled.length} cards`);
        startTurnTimer(room);
    });

    // ── Choose Stat ───────────────────────────────────────────────────────────
    socket.on('choose-stat', ({ statKey }) => {
        const room = getRoom(socket.roomCode);
        if (!room || room.state !== 'playing' || room.game.evaluated) return;
        const owner = room.players[room.game.turnOwnerIdx];
        if (owner.id !== socket.id) return socket.emit('error', 'Not your turn.');
        if (!STAT_DIR[statKey]) return socket.emit('error', 'Invalid stat.');

        clearTimer(room);
        room.game.chosenStat = statKey;
        io.to(room.code).emit('stat-chosen', { statKey, turnOwnerId: socket.id });
        setTimeout(() => resolveRound(room), 1500);
    });

    // ── Toss Choice ───────────────────────────────────────────────────────────
    socket.on('toss-choice', ({ choice }) => {
        const room = getRoom(socket.roomCode);
        if (!room || room.state !== 'playing') return;
        if (room.game.tossOwner !== socket.id) return;
        if (!['Heads','Tails'].includes(choice)) return;

        clearTimer(room);
        const result    = Math.random() < 0.5 ? 'Heads' : 'Tails';
        const playerWon = choice === result;
        const alive = room.players.filter(p => room.game.decks[p.id]?.length > 0 || room.game.activeCards[p.id]);

        if (playerWon) {
            room.game.turnOwnerIdx = room.players.findIndex(p => p.id === socket.id);
        } else {
            const others = alive.filter(p => p.id !== socket.id);
            const pick   = others[Math.floor(Math.random()*others.length)];
            room.game.turnOwnerIdx = room.players.findIndex(p => p.id === pick?.id);
        }
        room.game.turnOwnerIdx  = Math.max(0, room.game.turnOwnerIdx);
        room.game.tossOwner     = null;
        const newOwner = room.players[room.game.turnOwnerIdx];
        io.to(room.code).emit('toss-result', { choice, result, playerWon, newTurnOwnerId: newOwner.id, newTurnOwnerName: newOwner.name });
        setTimeout(() => startTurnTimer(room), 2000);
    });

    // ── Disconnect ────────────────────────────────────────────────────────────
    socket.on('disconnect', () => {
        const room = getRoom(socket.roomCode);
        if (!room) return;
        const p = room.players.find(q => q.id === socket.id);
        if (p) p.connected = false;
        io.to(room.code).emit('player-disconnected', { playerId: socket.id, name: p?.name, room: roomPublicState(room) });
        console.log(`[-] ${socket.id} left ${room.code}`);

        // Transfer host if needed
        if (room.state === 'lobby' && room.hostId === socket.id) {
            const next = room.players.find(q => q.connected && q.id !== socket.id);
            if (next) { room.hostId = next.id; io.to(room.code).emit('host-changed', { newHostId: next.id, newHostName: next.name }); }
        }
        // Clean up if all gone
        if (room.players.every(q => !q.connected)) {
            setTimeout(() => {
                if (rooms[room.code]?.players.every(q => !q.connected)) {
                    clearTimer(rooms[room.code]);
                    delete rooms[room.code];
                }
            }, 120_000);
        }
    });

    // ── Reconnect ─────────────────────────────────────────────────────────────
    socket.on('reconnect-room', ({ roomCode, playerName }) => {
        const code = roomCode?.toUpperCase().trim();
        const room = getRoom(code);
        if (!room) return socket.emit('error', 'Room not found.');
        const existing = room.players.find(p => p.name === playerName?.trim());
        if (!existing) return socket.emit('error', 'Player not in room.');

        const oldId = existing.id;
        existing.id = socket.id; existing.connected = true;
        socket.join(code); socket.roomCode = code;

        if (room.game) {
            if (room.game.decks[oldId])          { room.game.decks[socket.id] = room.game.decks[oldId]; delete room.game.decks[oldId]; }
            if (room.game.activeCards[oldId]!==undefined) { room.game.activeCards[socket.id] = room.game.activeCards[oldId]; delete room.game.activeCards[oldId]; }
            if (room.game.tossOwner === oldId)    room.game.tossOwner = socket.id;
        }

        socket.emit('reconnect-success', {
            yourId: socket.id, room: roomPublicState(room),
            yourDeck  : room.game?.decks[socket.id] || [],
            activeCard: room.game?.activeCards[socket.id] || null,
            roundState: room.game ? buildRoundState(room) : null
        });
        io.to(code).emit('player-rejoined', { name: existing.name, room: roomPublicState(room) });
    });
});

// ── Resolve round ─────────────────────────────────────────────────────────────
function resolveRound(room) {
    if (!room.game || room.game.evaluated) return;
    room.game.evaluated = true;

    const { winners, bestVal, valueMap } = evaluateRound(room);

    io.to(room.code).emit('round-result', {
        statKey: room.game.chosenStat,
        winners,    // array of socket IDs
        bestVal,
        valueMap,   // { playerId: statValue }
        roundState: buildRoundState(room)
    });

    // Distribute active cards to winner(s)
    const potCards = [];
    room.players.forEach(p => {
        if (room.game.activeCards[p.id]) { potCards.push(room.game.activeCards[p.id]); room.game.activeCards[p.id] = null; }
    });

    if (winners.length === 1) {
        room.game.decks[winners[0]] = [...(room.game.decks[winners[0]] || []), ...room.game.pot, ...potCards];
        room.game.pot = [];
        room.game.turnOwnerIdx = room.players.findIndex(p => p.id === winners[0]);
        if (room.game.turnOwnerIdx < 0) room.game.turnOwnerIdx = 0;
    } else {
        room.game.pot = [...room.game.pot, ...potCards]; // tie → pot
    }

    // Check game over
    const winner = checkGameOver(room);
    if (winner) {
        room.state = 'ended'; clearTimer(room);
        io.to(room.code).emit('game-over', { winnerId: winner.id, winnerName: winner.name });
        setTimeout(() => { delete rooms[room.code]; }, 300_000);
        return;
    }

    // Advance to next round after 3s
    setTimeout(() => {
        room.game.round++;
        room.game.chosenStat = null;
        room.game.evaluated  = false;

        // Draw next active card for each player
        room.players.forEach(p => {
            if (room.game.decks[p.id]?.length > 0) {
                room.game.activeCards[p.id] = room.game.decks[p.id].shift();
            } else {
                room.game.activeCards[p.id] = null;
            }
        });

        // Ensure turn owner is still alive
        const alive = room.players.filter(p => room.game.activeCards[p.id]);
        if (alive.length <= 1) {
            const w = alive[0] || null;
            if (w) {
                room.state = 'ended';
                io.to(room.code).emit('game-over', { winnerId: w.id, winnerName: w.name });
            }
            return;
        }
        const owner = room.players[room.game.turnOwnerIdx];
        if (!alive.find(p => p.id === owner?.id)) {
            room.game.turnOwnerIdx = room.players.findIndex(p => alive.find(a => a.id===p.id));
            if (room.game.turnOwnerIdx < 0) room.game.turnOwnerIdx = 0;
        }

        const roundState = buildRoundState(room);
        // Send each player their updated deck + new active card
        room.players.forEach(p => {
            io.to(p.id).emit('next-round', {
                yourDeck  : room.game.decks[p.id] || [],
                activeCard: room.game.activeCards[p.id] || null,
                roundState
            });
        });

        io.to(room.code).emit('round-started', roundState);
        startTurnTimer(room);
    }, 3000);
}

// ── 90s turn timer ────────────────────────────────────────────────────────────
function startTurnTimer(room) {
    clearTimer(room);
    if (!room.game) return;
    const owner = room.players[room.game.turnOwnerIdx];
    if (!owner) return;
    io.to(room.code).emit('timer-started', { seconds: 90, turnOwnerId: owner.id });
    room.game.timer = setTimeout(() => {
        if (!room.game || room.game.evaluated) return;
        room.game.tossOwner = owner.id;
        io.to(room.code).emit('turn-timeout', { tossOwnerId: owner.id });
        room.game.timer = setTimeout(() => {
            if (room.game?.tossOwner === owner.id) {
                io.to(owner.id).emit('auto-toss', { choice: Math.random()<0.5?'Heads':'Tails' });
            }
        }, 30_000);
    }, 90_000);
}

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('╔══════════════════════════════════════════════╗');
    console.log('║   🏏  IPL Trump Card Arena — Backend v2      ║');
    console.log(`║   🟢  Running on http://localhost:${PORT}       ║`);
    console.log('║   📡  Cards loaded from JSON — authoritative ║');
    console.log('╚══════════════════════════════════════════════╝');
    console.log('');
});

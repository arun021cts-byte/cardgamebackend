# 🏏 IPL Trump Card Arena — Multiplayer Backend

Real-time multiplayer lobby server using **Node.js + Express + Socket.io**.

---

## 🚀 How to Start

**Double-click** `start-server.bat` — OR run in terminal:

```bash
cd backend
node server.js
```

Server starts on **http://localhost:3000**

---

## 👥 Multiplayer Flow

### For the Host
1. Open `gemini-code-game.html` in a browser
2. Click **"👥 Multiplayer Lobby"** tab
3. Enter your name, choose a level → **Create Room**
4. Share the **6-character room code** with friends
5. Wait for players to join → Click **▶ Start Game**

### For Joining Players
1. Open `gemini-code-game.html` (or `http://[HOST_IP]:3000/gemini-code-game.html` on same WiFi)
2. Click **"👥 Multiplayer Lobby"** tab
3. Enter your name + the room code → **Join Room**
4. Wait for host to start

---

## 🌐 Playing Across Devices (Same WiFi)

Find your PC's local IP address:
```
ipconfig   ← look for IPv4 Address (e.g. 192.168.1.5)
```

Other players on the same WiFi open:
```
http://192.168.1.5:3000/gemini-code-game.html
```

---

## ⚙️ Features

| Feature | Detail |
|---|---|
| Room codes | 6-char alphanumeric (e.g. `4F8K2J`) |
| Max players per room | 6 |
| Turn timer | 90 seconds per turn |
| Timeout handling | Coin toss to decide next player |
| Disconnect handling | Player marked offline, game continues |
| Reconnect | Rejoin with same name + room code |
| Host transfer | If host leaves during lobby, next player becomes host |
| Card data | Sent by host — no server-side JSON needed |

---

## 📡 Socket Events

### Client → Server
| Event | Payload |
|---|---|
| `create-lobby` | `{ playerName, level }` |
| `join-lobby` | `{ roomCode, playerName }` |
| `set-level` | `{ level }` (host only) |
| `start-game` | `{ cardData }` (host only) |
| `choose-stat` | `{ statKey }` |
| `toss-choice` | `{ choice: 'Heads' \| 'Tails' }` |
| `reconnect-room` | `{ roomCode, playerName }` |

### Server → Client
| Event | Payload |
|---|---|
| `lobby-created` | `{ code, room }` |
| `lobby-joined` | `{ room }` |
| `player-joined` | `{ player, room }` |
| `player-disconnected` | `{ playerId, name, room }` |
| `game-started` | `{ yourId, yourDeck, activeCard, roundState }` |
| `round-started` | `roundState` |
| `stat-chosen` | `{ statKey, turnOwnerId }` |
| `round-result` | `{ statKey, winners, bestVal, valueMap }` |
| `next-round` | `{ yourDeck, activeCard, roundState }` |
| `turn-timeout` | `{ tossOwnerId }` |
| `toss-result` | `{ choice, result, playerWon, newTurnOwner... }` |
| `game-over` | `{ winnerId, winnerName }` |
| `error` | `string` |

---

## 🗂 Files

```
backend/
├── server.js          ← Main server (Express + Socket.io)
├── package.json       ← Dependencies
├── start-server.bat   ← Windows quick-start
└── README.md          ← This file
```

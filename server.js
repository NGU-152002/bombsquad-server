const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(cors());
app.use(express.static(path.join(__dirname)));

// Game state and room management
const gameRooms = new Map();
const playerSockets = new Map();

class GameRoom {
    constructor(roomId, maxPlayers = 4) {
        this.roomId = roomId;
        this.maxPlayers = maxPlayers;
        this.players = new Map();
        this.gameState = 'waiting'; // waiting, playing, finished
        this.gameStartTime = null;
        this.bombs = new Map();
        this.powerUps = new Map();
        this.destructibleBlocks = [];
        this.roundTimer = 120;
        
        // Initialize destructible blocks (same as client)
        this.initializeDestructibleBlocks();
    }
    
    initializeDestructibleBlocks() {
        const width = 1024;
        const height = 768;
        
        // Create destructible blocks grid (same logic as client)
        for (let x = 100; x < width - 100; x += 64) {
            for (let y = 100; y < height - 100; y += 64) {
                // Skip player spawn areas
                const corners = [
                    { x: 64, y: 64 }, { x: width - 64, y: 64 },
                    { x: 64, y: height - 64 }, { x: width - 64, y: height - 64 }
                ];
                
                let tooClose = false;
                corners.forEach(corner => {
                    if (Math.abs(x - corner.x) < 100 && Math.abs(y - corner.y) < 100) {
                        tooClose = true;
                    }
                });
                
                // Skip indestructible block positions
                const indestructible = [
                    { x: 200, y: 200 }, { x: 200, y: 400 }, { x: 200, y: 600 },
                    { x: 400, y: 200 }, { x: 400, y: 600 },
                    { x: 600, y: 200 }, { x: 600, y: 600 },
                    { x: 800, y: 200 }, { x: 800, y: 400 }, { x: 800, y: 600 }
                ];
                
                indestructible.forEach(pos => {
                    if (Math.abs(x - pos.x) < 50 && Math.abs(y - pos.y) < 50) {
                        tooClose = true;
                    }
                });
                
                if (!tooClose && Math.random() < 0.6) {
                    this.destructibleBlocks.push({ x, y, id: `block_${x}_${y}` });
                }
            }
        }
    }
    
    addPlayer(socket, playerData) {
        if (this.players.size >= this.maxPlayers) {
            return false;
        }
        
        const playerId = this.players.size + 1;
        const spawnPositions = [
            { x: 64, y: 64 },
            { x: 1024 - 64, y: 64 },
            { x: 64, y: 768 - 64 },
            { x: 1024 - 64, y: 768 - 64 }
        ];
        
        const player = {
            id: playerId,
            socket: socket.id,
            name: playerData.name || `Player ${playerId}`,
            x: spawnPositions[playerId - 1].x,
            y: spawnPositions[playerId - 1].y,
            health: 100,
            isAlive: true,
            bombCapacity: 1,
            bombCount: 0,
            bombPower: 3,
            powerUps: { speed: 1, bombs: 0, power: 0 }
        };
        
        this.players.set(playerId, player);
        return player;
    }
    
    removePlayer(socketId) {
        for (let [playerId, player] of this.players) {
            if (player.socket === socketId) {
                this.players.delete(playerId);
                return playerId;
            }
        }
        return null;
    }
    
    canStartGame() {
        return this.players.size >= 2 && this.gameState === 'waiting';
    }
    
    startGame() {
        this.gameState = 'playing';
        this.gameStartTime = Date.now();
        this.roundTimer = 120;
        
        // Start periodic game state synchronization (reduced frequency to prevent noise)
        this.syncInterval = setInterval(() => {
            if (this.gameState === 'playing') {
                this.broadcastToRoom('gameStateUpdate', this.getGameState());
            } else {
                clearInterval(this.syncInterval);
            }
        }, 10000); // Sync every 10 seconds (was 5 seconds)
    }
    
    updatePlayer(playerId, updateData) {
        const player = this.players.get(playerId);
        if (player && player.isAlive) {
            // Validate and update player position
            player.x = Math.max(32, Math.min(1024 - 32, updateData.x || player.x));
            player.y = Math.max(32, Math.min(768 - 32, updateData.y || player.y));
            
            return true;
        }
        return false;
    }
    
    placeBomb(playerId, x, y) {
        const player = this.players.get(playerId);
        if (!player || !player.isAlive || player.bombCount >= player.bombCapacity) {
            return null;
        }
        
        // Snap to grid
        const gridSize = 64;
        const bombX = Math.round(x / gridSize) * gridSize;
        const bombY = Math.round(y / gridSize) * gridSize;
        
        // Check if bomb already exists at position
        for (let bomb of this.bombs.values()) {
            if (Math.abs(bomb.x - bombX) < 32 && Math.abs(bomb.y - bombY) < 32) {
                return null;
            }
        }
        
        const bombId = `bomb_${Date.now()}_${playerId}`;
        const bomb = {
            id: bombId,
            x: bombX,
            y: bombY,
            owner: playerId,
            power: player.bombPower,
            fuseTime: 3000,
            placedAt: Date.now()
        };
        
        this.bombs.set(bombId, bomb);
        player.bombCount++;
        
        // Schedule explosion
        setTimeout(() => {
            this.explodeBomb(bombId);
        }, 3000);
        
        return bomb;
    }
    
    explodeBomb(bombId) {
        const bomb = this.bombs.get(bombId);
        if (!bomb) return;
        
        this.bombs.delete(bombId);
        
        // Decrease owner bomb count
        const owner = this.players.get(bomb.owner);
        if (owner) {
            owner.bombCount--;
        }
        
        // Calculate explosion areas
        const explosionAreas = this.calculateExplosion(bomb.x, bomb.y, bomb.power);
        
        // Damage players
        for (let player of this.players.values()) {
            if (!player.isAlive) continue;
            
            for (let area of explosionAreas) {
                const distance = Math.sqrt(
                    Math.pow(player.x - area.x, 2) + Math.pow(player.y - area.y, 2)
                );
                
                if (distance < 40) {
                    player.health -= 25;
                    if (player.health <= 0) {
                        player.isAlive = false;
                    }
                    break;
                }
            }
        }
        
        // Chain reactions
        for (let otherBomb of this.bombs.values()) {
            if (otherBomb.id === bombId) continue;
            
            for (let area of explosionAreas) {
                const distance = Math.sqrt(
                    Math.pow(otherBomb.x - area.x, 2) + Math.pow(otherBomb.y - area.y, 2)
                );
                
                if (distance < 40) {
                    setTimeout(() => {
                        this.explodeBomb(otherBomb.id);
                    }, 50);
                    break;
                }
            }
        }
        
        // Destroy blocks and create power-ups
        const destroyedBlocks = [];
        this.destructibleBlocks = this.destructibleBlocks.filter(block => {
            for (let area of explosionAreas) {
                if (Math.abs(block.x - area.x) < 32 && Math.abs(block.y - area.y) < 32) {
                    destroyedBlocks.push(block);
                    
                    // Chance to spawn power-up
                    if (Math.random() < 0.3) {
                        const powerUpTypes = ['speed', 'bombs', 'power', 'health'];
                        const powerUpType = powerUpTypes[Math.floor(Math.random() * powerUpTypes.length)];
                        const powerUpId = `powerup_${Date.now()}_${Math.random()}`;
                        
                        this.powerUps.set(powerUpId, {
                            id: powerUpId,
                            type: powerUpType,
                            x: block.x,
                            y: block.y,
                            spawnedAt: Date.now()
                        });
                    }
                    
                    return false;
                }
            }
            return true;
        });
        
        // Broadcast explosion
        this.broadcastToRoom('bombExploded', {
            bombId,
            explosionAreas,
            destroyedBlocks,
            players: Array.from(this.players.values()),
            powerUps: Array.from(this.powerUps.values())
        });
        
        // Check win condition
        this.checkWinCondition();
    }
    
    calculateExplosion(x, y, power) {
        const gridSize = 64;
        const directions = [
            { x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }
        ];
        
        const explosionAreas = [{ x, y }];
        
        directions.forEach(dir => {
            for (let i = 1; i <= power; i++) {
                const checkX = x + (dir.x * gridSize * i);
                const checkY = y + (dir.y * gridSize * i);
                
                // Check bounds
                if (checkX < 50 || checkX > 1024 - 50 || checkY < 50 || checkY > 768 - 50) {
                    break;
                }
                
                // Check for destructible blocks
                let blocked = false;
                for (let block of this.destructibleBlocks) {
                    if (Math.abs(block.x - checkX) < 32 && Math.abs(block.y - checkY) < 32) {
                        blocked = true;
                        break;
                    }
                }
                
                explosionAreas.push({ x: checkX, y: checkY });
                
                if (blocked) break;
            }
        });
        
        return explosionAreas;
    }
    
    collectPowerUp(playerId, powerUpId) {
        const powerUp = this.powerUps.get(powerUpId);
        const player = this.players.get(playerId);
        
        if (!powerUp || !player || !player.isAlive) return false;
        
        // Apply power-up effect
        switch (powerUp.type) {
            case 'speed':
                player.powerUps.speed = Math.min(player.powerUps.speed + 0.3, 2);
                break;
            case 'bombs':
                player.bombCapacity++;
                player.powerUps.bombs++;
                break;
            case 'power':
                player.bombPower++;
                player.powerUps.power++;
                break;
            case 'health':
                player.health = Math.min(player.health + 30, 100);
                break;
        }
        
        this.powerUps.delete(powerUpId);
        return true;
    }
    
    checkWinCondition() {
        const alivePlayers = Array.from(this.players.values()).filter(p => p.isAlive);
        
        if (alivePlayers.length <= 1) {
            this.gameState = 'finished';
            const winner = alivePlayers.length === 1 ? alivePlayers[0] : null;
            
            this.broadcastToRoom('gameOver', {
                winner: winner ? winner.id : null,
                players: Array.from(this.players.values())
            });
        }
    }
    
    broadcastToRoom(event, data) {
        for (let player of this.players.values()) {
            const socket = io.sockets.sockets.get(player.socket);
            if (socket) {
                socket.emit(event, data);
            }
        }
    }
    
    getGameState() {
        return {
            roomId: this.roomId,
            gameState: this.gameState,
            players: Array.from(this.players.values()),
            bombs: Array.from(this.bombs.values()),
            powerUps: Array.from(this.powerUps.values()),
            destructibleBlocks: this.destructibleBlocks,
            roundTimer: this.roundTimer
        };
    }
}

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log(`Player connected: ${socket.id}`);
    
    socket.on('createRoom', (data) => {
        const roomId = `room_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const room = new GameRoom(roomId, data.maxPlayers || 4);
        gameRooms.set(roomId, room);
        
        const player = room.addPlayer(socket, data);
        if (player) {
            socket.join(roomId);
            playerSockets.set(socket.id, { roomId, playerId: player.id });
            
            socket.emit('roomCreated', {
                roomId: roomId,
                playerId: player.id,
                gameState: room.getGameState()
            });
            
            console.log(`Room created: ${roomId} by ${player.name}`);
        }
    });
    
    socket.on('joinRoom', (data) => {
        console.log(`[DEBUG] joinRoom called for socket ${socket.id}, roomId: ${data.roomId}`);
        
        // Check if socket is already in a room to prevent duplicates
        const existingPlayerInfo = playerSockets.get(socket.id);
        if (existingPlayerInfo) {
            console.log(`[DEBUG] Socket ${socket.id} already in room ${existingPlayerInfo.roomId}, ignoring duplicate joinRoom`);
            return;
        }
        
        const room = gameRooms.get(data.roomId);
        if (!room) {
            console.log(`[DEBUG] Room ${data.roomId} not found. Available rooms:`, Array.from(gameRooms.keys()));
            socket.emit('error', { message: 'Room not found' });
            return;
        }
        
        const player = room.addPlayer(socket, data);
        if (player) {
            socket.join(data.roomId);
            playerSockets.set(socket.id, { roomId: data.roomId, playerId: player.id });
            
            socket.emit('roomJoined', {
                playerId: player.id,
                gameState: room.getGameState()
            });
            
            // Notify other players
            room.broadcastToRoom('playerJoined', {
                player: player,
                gameState: room.getGameState()
            });
            
            console.log(`${player.name} joined room: ${data.roomId}`);
            
            // Auto-start game if enough players
            if (room.canStartGame()) {
                setTimeout(() => {
                    if (room.canStartGame()) {
                        room.startGame();
                        const gameState = room.getGameState();
                        
                        // Send game started event first
                        room.broadcastToRoom('gameStarted', gameState);
                        
                        // Send game state update after a short delay to prevent race condition
                        setTimeout(() => {
                            room.broadcastToRoom('gameStateUpdate', gameState);
                        }, 500);
                        
                        console.log(`[DEBUG] Game started in room: ${data.roomId}. Players: ${room.players.size}`);
                    }
                }, 2000);
            }
        } else {
            socket.emit('error', { message: 'Room is full' });
        }
    });
    
    socket.on('playerMove', (data) => {
        const playerInfo = playerSockets.get(socket.id);
        if (!playerInfo) return;
        
        const room = gameRooms.get(playerInfo.roomId);
        if (!room || room.gameState !== 'playing') return;
        
        if (room.updatePlayer(playerInfo.playerId, data)) {
            // Broadcast to other players
            socket.to(playerInfo.roomId).emit('playerMoved', {
                playerId: playerInfo.playerId,
                x: data.x,
                y: data.y
            });
        }
    });
    
    socket.on('placeBomb', (data) => {
        const playerInfo = playerSockets.get(socket.id);
        if (!playerInfo) return;
        
        const room = gameRooms.get(playerInfo.roomId);
        if (!room || room.gameState !== 'playing') return;
        
        const bomb = room.placeBomb(playerInfo.playerId, data.x, data.y);
        if (bomb) {
            room.broadcastToRoom('bombPlaced', {
                bomb: bomb,
                playerId: playerInfo.playerId
            });
        }
    });
    
    socket.on('collectPowerUp', (data) => {
        const playerInfo = playerSockets.get(socket.id);
        if (!playerInfo) return;
        
        const room = gameRooms.get(playerInfo.roomId);
        if (!room || room.gameState !== 'playing') return;
        
        if (room.collectPowerUp(playerInfo.playerId, data.powerUpId)) {
            room.broadcastToRoom('powerUpCollected', {
                powerUpId: data.powerUpId,
                playerId: playerInfo.playerId,
                players: Array.from(room.players.values())
            });
        }
    });
    
    // Ping handler
    socket.on('ping', (data) => {
        socket.emit('pong', { timestamp: data.timestamp });
    });
    
    socket.on('disconnect', () => {
        console.log(`[DEBUG] Player disconnected: ${socket.id}`);
        
        const playerInfo = playerSockets.get(socket.id);
        if (playerInfo) {
            const room = gameRooms.get(playerInfo.roomId);
            if (room) {
                const removedPlayerId = room.removePlayer(socket.id);
                if (removedPlayerId) {
                    room.broadcastToRoom('playerLeft', {
                        playerId: removedPlayerId,
                        gameState: room.getGameState()
                    });
                    
                    // Clean up empty rooms (but not if game is starting)
                    if (room.players.size === 0 && room.gameState !== 'playing') {
                        gameRooms.delete(playerInfo.roomId);
                        console.log(`[DEBUG] Room deleted: ${playerInfo.roomId}`);
                    } else if (room.players.size === 0) {
                        console.log(`[DEBUG] Room ${playerInfo.roomId} empty but game is playing, keeping room`);
                    }
                }
            }
            
            playerSockets.delete(socket.id);
        }
    });
});

// Health check endpoint for deployment platforms
app.get('/health', (req, res) => {
    res.status(200).json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        activeRooms: gameRooms.size,
        activePlayers: playerSockets.size
    });
});

// Serve the main game files
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'lobby.html'));
});

app.get('/game', (req, res) => {
    res.sendFile(path.join(__dirname, 'multiplayer.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`BombSquad Multiplayer Server running on port ${PORT}`);
    console.log(`Open http://localhost:${PORT} to start playing!`);
});
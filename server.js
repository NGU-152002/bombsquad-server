const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        uptime: process.uptime(),
        rooms: gameRooms.size,
        players: playerSockets.size 
    });
});

// Game state and room management
const gameRooms = new Map();
const playerSockets = new Map();
const transitioningPlayers = new Map(); // Track players transitioning between pages

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
        this.lastUpdate = Date.now();
        
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
            bombPower: 5,
            powerUps: { speed: 1, bombs: 0, power: 0 },
            lastUpdate: Date.now()
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
        
        // Mark all players as transitioning to prevent room deletion
        for (let player of this.players.values()) {
            transitioningPlayers.set(player.socket, {
                roomId: this.roomId,
                playerId: player.id,
                playerName: player.name,
                transitionStart: Date.now()
            });
        }
        
        console.log(`Game started in room ${this.roomId} with ${this.players.size} players`);
    }
    
    // Try to rejoin a transitioning player
    rejoinTransitioningPlayer(socket, oldPlayerData) {
        // Find the original player slot
        for (let [playerId, player] of this.players) {
            if (player.name === oldPlayerData.playerName && playerId === oldPlayerData.playerId) {
                // Update socket reference
                player.socket = socket.id;
                console.log(`Player ${player.name} successfully rejoined room ${this.roomId}`);
                return player;
            }
        }
        return null;
    }
    
    updatePlayer(playerId, updateData) {
        const player = this.players.get(playerId);
        if (player && player.isAlive) {
            // Validate and update player position with bounds checking
            const margin = 32;
            player.x = Math.max(margin, Math.min(1024 - margin, updateData.x || player.x));
            player.y = Math.max(margin, Math.min(768 - margin, updateData.y || player.y));
            player.lastUpdate = Date.now();
            
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
        
        console.log(`Player ${playerId} placed bomb at (${bombX}, ${bombY})`);
        return bomb;
    }
    
    explodeBomb(bombId) {
        const bomb = this.bombs.get(bombId);
        if (!bomb) return;
        
        console.log(`Exploding bomb ${bombId} at (${bomb.x}, ${bomb.y})`);
        
        this.bombs.delete(bombId);
        
        // Decrease owner bomb count
        const owner = this.players.get(bomb.owner);
        if (owner) {
            owner.bombCount = Math.max(0, owner.bombCount - 1);
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
                        console.log(`Player ${player.id} eliminated`);
                    }
                    break;
                }
            }
        }
        
        // Chain reactions with delay to prevent infinite loops
        const chainBombs = [];
        for (let otherBomb of this.bombs.values()) {
            if (otherBomb.id === bombId) continue;
            
            for (let area of explosionAreas) {
                const distance = Math.sqrt(
                    Math.pow(otherBomb.x - area.x, 2) + Math.pow(otherBomb.y - area.y, 2)
                );
                
                if (distance < 40) {
                    chainBombs.push(otherBomb.id);
                    break;
                }
            }
        }
        
        // Trigger chain reactions with delay
        chainBombs.forEach(chainBombId => {
            setTimeout(() => {
                this.explodeBomb(chainBombId);
            }, 50);
        });
        
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
        console.log(`Player ${playerId} collected ${powerUp.type} power-up`);
        return true;
    }
    
    checkWinCondition() {
        const alivePlayers = Array.from(this.players.values()).filter(p => p.isAlive);
        
        if (alivePlayers.length <= 1) {
            this.gameState = 'finished';
            const winner = alivePlayers.length === 1 ? alivePlayers[0] : null;
            
            console.log(`Game finished in room ${this.roomId}. Winner: ${winner ? winner.name : 'Draw'}`);
            
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
    
    // Cleanup old power-ups (15 seconds)
    cleanupOldPowerUps() {
        const now = Date.now();
        for (let [id, powerUp] of this.powerUps) {
            if (now - powerUp.spawnedAt > 15000) {
                this.powerUps.delete(id);
            }
        }
    }
}

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log(`Player connected: ${socket.id}`);
    
    socket.on('createRoom', (data) => {
        try {
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
        } catch (error) {
            console.error('Error creating room:', error);
            socket.emit('error', { message: 'Failed to create room' });
        }
    });
    
    socket.on('joinRoom', (data) => {
        try {
            const room = gameRooms.get(data.roomId);
            if (!room) {
                socket.emit('error', { message: 'Room not found' });
                return;
            }
            
            // Check if this is a reconnecting player
            let player = null;
            let isReconnecting = false;
            
            // Look for transitioning player data (try name first, then player ID)
            const transitioningPlayer = Array.from(transitioningPlayers.entries())
                .find(([oldSocketId, transData]) => 
                    transData.roomId === data.roomId && 
                    (transData.playerName === data.name || transData.playerId === data.playerId)
                );
            
            if (transitioningPlayer) {
                // This is a reconnecting player
                const [oldSocketId, transData] = transitioningPlayer;
                player = room.rejoinTransitioningPlayer(socket, transData);
                
                if (player) {
                    isReconnecting = true;
                    transitioningPlayers.delete(oldSocketId);
                    console.log(`Player ${data.name} successfully reconnected to room ${data.roomId}`);
                }
            }
            
            // If not reconnecting, try to add as new player
            if (!player) {
                player = room.addPlayer(socket, data);
            }
            
            if (player) {
                socket.join(data.roomId);
                playerSockets.set(socket.id, { roomId: data.roomId, playerId: player.id });
                
                socket.emit('roomJoined', {
                    playerId: player.id,
                    gameState: room.getGameState(),
                    isReconnecting: isReconnecting
                });
                
                if (!isReconnecting) {
                    // Notify other players only for new joins
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
                                room.broadcastToRoom('gameStarted', room.getGameState());
                            }
                        }, 2000);
                    }
                } else {
                    // For reconnections, immediately send game started if game is already playing
                    if (room.gameState === 'playing') {
                        socket.emit('gameStarted', room.getGameState());
                    }
                }
                
                // Always ensure player is in the socket room
                socket.join(data.roomId);
                
                // If game is already playing, notify all players about current state
                if (room.gameState === 'playing') {
                    room.broadcastToRoom('gameStateUpdate', room.getGameState());
                }
            } else {
                socket.emit('error', { message: 'Room is full' });
            }
        } catch (error) {
            console.error('Error joining room:', error);
            socket.emit('error', { message: 'Failed to join room' });
        }
    });
    
    socket.on('playerMove', (data) => {
        try {
            const playerInfo = playerSockets.get(socket.id);
            if (!playerInfo) return;
            
            const room = gameRooms.get(playerInfo.roomId);
            if (!room || room.gameState !== 'playing') return;
            
            if (room.updatePlayer(playerInfo.playerId, data)) {
                // Broadcast to other players (excluding sender)
                socket.to(playerInfo.roomId).emit('playerMoved', {
                    playerId: playerInfo.playerId,
                    x: data.x,
                    y: data.y
                });
            }
        } catch (error) {
            console.error('Error handling player move:', error);
        }
    });
    
    socket.on('placeBomb', (data) => {
        try {
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
        } catch (error) {
            console.error('Error placing bomb:', error);
        }
    });
    
    socket.on('collectPowerUp', (data) => {
        try {
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
        } catch (error) {
            console.error('Error collecting power-up:', error);
        }
    });
    
    // Ping handler
    socket.on('ping', (data) => {
        socket.emit('pong', { timestamp: data.timestamp });
    });
    
    socket.on('disconnect', () => {
        console.log(`Player disconnected: ${socket.id}`);
        
        try {
            const playerInfo = playerSockets.get(socket.id);
            const transitionData = transitioningPlayers.get(socket.id);
            
            if (playerInfo) {
                const room = gameRooms.get(playerInfo.roomId);
                if (room) {
                    // If player is transitioning (game just started), delay room cleanup
                    if (transitionData) {
                        console.log(`Player ${transitionData.playerName} disconnected during transition, delaying cleanup`);
                        
                        // Schedule delayed cleanup (10 seconds to allow reconnection)
                        setTimeout(() => {
                            // Check if player has reconnected
                            if (transitioningPlayers.has(socket.id)) {
                                console.log(`Player ${transitionData.playerName} failed to reconnect, removing from room`);
                                transitioningPlayers.delete(socket.id);
                                
                                const currentRoom = gameRooms.get(playerInfo.roomId);
                                if (currentRoom) {
                                    const removedPlayerId = currentRoom.removePlayer(socket.id);
                                    if (removedPlayerId) {
                                        currentRoom.broadcastToRoom('playerLeft', {
                                            playerId: removedPlayerId,
                                            gameState: currentRoom.getGameState()
                                        });
                                        
                                        // Clean up empty rooms
                                        if (currentRoom.players.size === 0) {
                                            gameRooms.delete(playerInfo.roomId);
                                            console.log(`Room deleted after timeout: ${playerInfo.roomId}`);
                                        }
                                    }
                                }
                            }
                        }, 30000); // 30 second grace period
                        
                    } else {
                        // Normal disconnect - immediate cleanup
                        const removedPlayerId = room.removePlayer(socket.id);
                        if (removedPlayerId) {
                            room.broadcastToRoom('playerLeft', {
                                playerId: removedPlayerId,
                                gameState: room.getGameState()
                            });
                            
                            // Clean up empty rooms
                            if (room.players.size === 0) {
                                gameRooms.delete(playerInfo.roomId);
                                console.log(`Room deleted: ${playerInfo.roomId}`);
                            }
                        }
                    }
                }
                
                playerSockets.delete(socket.id);
            }
        } catch (error) {
            console.error('Error handling disconnect:', error);
        }
    });
});

// Periodic cleanup of old power-ups and stale transitions
setInterval(() => {
    for (let room of gameRooms.values()) {
        room.cleanupOldPowerUps();
    }
    
    // Clean up stale transition data (older than 2 minutes)
    const now = Date.now();
    for (let [socketId, transitionData] of transitioningPlayers.entries()) {
        if (now - transitionData.transitionStart > 120000) {
            console.log(`Cleaning up stale transition data for ${transitionData.playerName}`);
            transitioningPlayers.delete(socketId);
        }
    }
}, 30000); // Every 30 seconds

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 BombSquad Multiplayer Server running on port ${PORT}`);
    console.log(`🌐 Server URL: http://localhost:${PORT}`);
    console.log(`📊 Health check: http://localhost:${PORT}/health`);
    console.log('🎮 Ready for players!');
});
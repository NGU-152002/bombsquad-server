# BombSquad Multiplayer Server

## 🚀 Standalone Multiplayer Server

This is the dedicated server for BombSquad multiplayer games. Deploy this separately from your game client.

## 📁 Server Structure

```
bombsquad-server/
├── server.js          # Main server application
├── package.json       # Dependencies and scripts
└── README.md          # This file
```

## ⚡ Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Start Server
```bash
npm start
```

### 3. For Development
```bash
npm run dev  # Auto-restart on changes
```

## 🌐 Deployment Options

### Option 1: Heroku (Free Tier)
```bash
# Login to Heroku
heroku login

# Create app
heroku create your-bombsquad-server

# Deploy
git init
git add .
git commit -m "Initial server deployment"
git push heroku main

# Your server will be at: https://your-bombsquad-server.herokuapp.com
```

### Option 2: Railway
1. Go to [Railway.app](https://railway.app)
2. Connect GitHub repo or upload files
3. Set build command: `npm install`
4. Set start command: `npm start`
5. Deploy!

### Option 3: Render
1. Go to [Render.com](https://render.com)
2. Create new Web Service
3. Connect repo
4. Build command: `npm install`
5. Start command: `npm start`
6. Deploy!

### Option 4: DigitalOcean/AWS/Google Cloud
1. Create a VPS/Instance
2. Upload server files
3. Install Node.js and npm
4. Run `npm install && npm start`
5. Configure firewall for port 3000

### Option 5: Local Network
```bash
# Find your IP address
# Windows: ipconfig
# Mac/Linux: ifconfig

# Share with friends: http://YOUR_IP:3000
```

## 🔧 Configuration

### Environment Variables
```bash
PORT=3000                    # Server port
NODE_ENV=production         # Environment
MAX_PLAYERS_PER_ROOM=4      # Players per room
ROOM_TIMEOUT=300000         # Room timeout (5 minutes)
```

### Server Settings (in server.js)
```javascript
const maxPlayers = 4;           // Players per room
const fuseTime = 3000;          # Bomb timer (3 seconds)
const roundTimer = 120;         # Round duration (2 minutes)
const powerUpChance = 0.3;      # Power-up spawn chance (30%)
```

## 📊 Monitoring

### Health Check Endpoint
```
GET /health
```

Returns:
```json
{
  "status": "OK",
  "uptime": 3600,
  "rooms": 5,
  "players": 12
}
```

### Console Logs
- Player connections/disconnections
- Room creation/deletion
- Game events (bomb explosions, wins)
- Error handling

## 🛡️ Security Features

- CORS enabled for all origins
- Input validation for all events
- Rate limiting (implicit via Socket.IO)
- Error handling and graceful recovery
- Automatic cleanup of empty rooms
- Protection against infinite bomb chains

## 🎮 Client Configuration

Update your game client to connect to your deployed server:

**In networkManager.js:**
```javascript
this.serverUrl = 'https://your-server-domain.com';
```

**Or dynamically:**
```javascript
const serverUrl = 'https://your-bombsquad-server.herokuapp.com';
await networkManager.connect(serverUrl);
```

## 📈 Scaling

### For High Traffic:
1. **Redis Adapter**: Scale across multiple server instances
2. **Load Balancer**: Distribute connections
3. **Database**: Store persistent game data
4. **CDN**: Serve static assets faster

### Redis Scaling Example:
```javascript
const redisAdapter = require('@socket.io/redis-adapter');
const redis = require('redis');

const pubClient = redis.createClient({ url: 'redis://localhost:6379' });
const subClient = pubClient.duplicate();

io.adapter(redisAdapter(pubClient, subClient));
```

## 🐛 Troubleshooting

### Server Won't Start
- Check Node.js version (>=14.0.0)
- Verify all dependencies installed: `npm install`
- Check port availability: `lsof -i :3000`

### Players Can't Connect
- Verify server URL is correct
- Check firewall settings
- Ensure server is publicly accessible
- Test health endpoint: `curl https://your-server.com/health`

### High Memory Usage
- Implement room timeouts
- Clean up disconnected players
- Monitor with: `node --inspect server.js`

### Performance Issues
- Enable Node.js clustering
- Use PM2 for production: `pm2 start server.js`
- Monitor with APM tools

## 🔄 Updates

### Deploying Updates
1. **Heroku**: `git push heroku main`
2. **Railway/Render**: Auto-deploy on git push
3. **Manual**: Upload new files and restart

### Zero-Downtime Updates
```bash
# Using PM2
pm2 reload server.js

# Using Docker
docker-compose up --no-deps -d server
```

## 📝 Logs

### Production Logging
```javascript
// Add to server.js
const winston = require('winston');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' })
  ]
});
```

### Log Monitoring
- **Heroku**: `heroku logs --tail`
- **Railway**: View in dashboard
- **PM2**: `pm2 logs`

## 🎯 Production Checklist

- [ ] Environment variables configured
- [ ] HTTPS enabled (for production)
- [ ] Error logging implemented
- [ ] Health checks working
- [ ] Monitoring/alerts set up
- [ ] Backup/recovery plan
- [ ] Load testing completed
- [ ] Security review done

## 🆘 Support

### Common Issues:
1. **CORS errors**: Server and client on different domains
2. **Connection timeout**: Check network/firewall
3. **Memory leaks**: Implement proper cleanup
4. **Socket disconnections**: Add reconnection logic

### Getting Help:
- Check server logs first
- Test with health endpoint
- Verify client configuration
- Monitor resource usage

## 🎉 Success!

Your BombSquad server is now ready for production! Players from around the world can connect and play together.

**🌟 Server URL**: `https://your-deployed-server.com`
**🎮 Share this URL with your game clients!**
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import cors from 'cors';
import { createServer } from 'http';
import { networkInterfaces } from 'os';
import { randomUUID } from 'crypto';

class TranslationRoom {
  constructor(id, name = null) {
    this.id = id;
    this.name = name || `Room ${id}`;
    this.presenter = null;
    this.listeners = new Map();
    this.audioBuffer = [];
    this.isActive = false;
    this.createdAt = new Date();
    this.lastActivity = new Date();
    this.settings = {
      maxBufferSize: 50,
      maxListeners: 100,
      audioQuality: 'high',
      autoCleanup: true,
      bufferTimeoutMs: 5000
    };
    this.stats = {
      totalMessages: 0,
      audioChunks: 0,
      reconnections: 0
    };
  }

  addPresenter(ws, clientId, metadata = {}) {
    if (this.presenter && this.presenter.ws.readyState === WebSocket.OPEN) {
      throw new Error('Room already has an active presenter');
    }
    
    this.presenter = { 
      ws, 
      clientId, 
      connectedAt: new Date(),
      metadata: {
        userAgent: metadata.userAgent || 'Unknown',
        ip: metadata.ip || 'Unknown',
        ...metadata
      }
    };
    this.isActive = true;
    this.updateActivity();
    
    this.sendToPresenter({
      type: 'room-joined',
      roomId: this.id,
      listeners: this.listeners.size,
      message: `Conectado a la sala ${this.name}`
    });
    
    console.log(`📢 Presenter ${clientId} joined room ${this.id} (${this.listeners.size} listeners)`);
  }

  addListener(ws, clientId, metadata = {}) {
    if (this.listeners.size >= this.settings.maxListeners) {
      throw new Error('Room is full');
    }
    
    const listener = {
      ws,
      clientId,
      connectedAt: new Date(),
      lastPing: new Date(),
      metadata: {
        userAgent: metadata.userAgent || 'Unknown',
        language: metadata.language || 'es',
        ip: metadata.ip || 'Unknown',
        ...metadata
      }
    };
    
    this.listeners.set(clientId, listener);
    this.updateActivity();
    
    this.sendToListener(clientId, {
      type: 'connected',
      roomId: this.id,
      message: `Conectado al stream de audio - Sala: ${this.name}`,
      listeners: this.listeners.size
    });
    
    this.sendBufferedAudio(listener);
    this.notifyPresenterListenerChange();
    
    console.log(`👂 Listener ${clientId} joined room ${this.id} (${this.listeners.size}/${this.settings.maxListeners})`);
  }

  removePresenter() {
    if (this.presenter) {
      console.log(`📢 Presenter ${this.presenter.clientId} left room ${this.id}`);
      this.presenter = null;
      this.isActive = false;
      this.broadcastToListeners({
        type: 'presenter-disconnected',
        message: 'El presentador se ha desconectado. Esperando reconexión...'
      });
    }
  }

  removeListener(clientId) {
    if (this.listeners.has(clientId)) {
      const listener = this.listeners.get(clientId);
      console.log(`👂 Listener ${clientId} left room ${this.id} (connected for ${Math.round((Date.now() - listener.connectedAt.getTime()) / 1000)}s)`);
      this.listeners.delete(clientId);
      this.notifyPresenterListenerChange();
      this.updateActivity();
    }
  }

  broadcastAudioChunk(audioData, timestamp) {
    const audioChunk = {
      type: 'audio-stream',
      audioData,
      timestamp: timestamp || Date.now(),
      roomId: this.id
    };

    this.audioBuffer.push(audioChunk);
    if (this.audioBuffer.length > this.settings.maxBufferSize) {
      this.audioBuffer.shift();
    }

    const cutoffTime = Date.now() - this.settings.bufferTimeoutMs;
    this.audioBuffer = this.audioBuffer.filter(chunk => chunk.timestamp > cutoffTime);

    let successCount = 0;
    let failureCount = 0;
    
    this.listeners.forEach((listener, clientId) => {
      if (listener.ws.readyState === WebSocket.OPEN) {
        try {
          listener.ws.send(JSON.stringify(audioChunk));
          successCount++;
        } catch (error) {
          console.error(`Error sending to listener ${clientId}:`, error.message);
          this.removeListener(clientId);
          failureCount++;
        }
      } else {
        this.removeListener(clientId);
        failureCount++;
      }
    });

    this.stats.audioChunks++;
    this.updateActivity();

    return { successCount, failureCount };
  }

  sendBufferedAudio(listener) {
    if (this.audioBuffer.length === 0) return;

    const recentChunks = this.audioBuffer.slice(-5);
    recentChunks.forEach(chunk => {
      if (listener.ws.readyState === WebSocket.OPEN) {
        try {
          listener.ws.send(JSON.stringify({
            ...chunk,
            type: 'audio-buffer'
          }));
        } catch (error) {
          console.error(`Error sending buffer to ${listener.clientId}:`, error.message);
        }
      }
    });
  }

  sendToPresenter(message) {
    if (this.presenter && this.presenter.ws.readyState === WebSocket.OPEN) {
      try {
        this.presenter.ws.send(JSON.stringify(message));
      } catch (error) {
        console.error(`Error sending to presenter:`, error.message);
        this.removePresenter();
      }
    }
  }

  sendToListener(clientId, message) {
    const listener = this.listeners.get(clientId);
    if (listener && listener.ws.readyState === WebSocket.OPEN) {
      try {
        listener.ws.send(JSON.stringify(message));
      } catch (error) {
        console.error(`Error sending to listener ${clientId}:`, error.message);
        this.removeListener(clientId);
      }
    }
  }

  broadcastToListeners(message) {
    this.listeners.forEach((listener, clientId) => {
      this.sendToListener(clientId, message);
    });
  }

  notifyPresenterListenerChange() {
    this.sendToPresenter({
      type: 'listeners-update',
      count: this.listeners.size,
      listeners: Array.from(this.listeners.values()).map(l => ({
        id: l.clientId,
        connectedAt: l.connectedAt,
        language: l.metadata.language
      }))
    });
  }

  updateActivity() {
    this.lastActivity = new Date();
  }

  ping() {
    const now = new Date();
    
    this.listeners.forEach((listener, clientId) => {
      if (listener.ws.readyState === WebSocket.OPEN) {
        try {
          listener.ws.ping();
          listener.lastPing = now;
        } catch (error) {
          console.error(`Error pinging listener ${clientId}:`, error.message);
          this.removeListener(clientId);
        }
      } else {
        this.removeListener(clientId);
      }
    });

    if (this.presenter && this.presenter.ws.readyState === WebSocket.OPEN) {
      try {
        this.presenter.ws.ping();
      } catch (error) {
        console.error(`Error pinging presenter:`, error.message);
        this.removePresenter();
      }
    }
  }

  getStats() {
    return {
      ...this.stats,
      id: this.id,
      name: this.name,
      isActive: this.isActive,
      listeners: this.listeners.size,
      hasPresenter: !!this.presenter,
      createdAt: this.createdAt,
      lastActivity: this.lastActivity,
      bufferSize: this.audioBuffer.length
    };
  }
}

class RobustTranslationServer {
  constructor() {
    this.app = express();
    this.server = createServer(this.app);
    this.wss = new WebSocketServer({ server: this.server });
    this.rooms = new Map();
    this.clients = new Map();
    this.defaultRoom = 'main';
    
    this.setupExpress();
    this.setupWebSocket();
    this.startHealthCheck();
    this.createDefaultRoom();
  }

  setupExpress() {
    this.app.use(cors());
    this.app.use(express.json({ limit: '10mb' }));

    this.app.get('/health', (req, res) => {
      const stats = this.getServerStats();
      res.json({
        status: 'ok',
        ...stats,
        timestamp: new Date().toISOString()
      });
    });

    this.app.get('/rooms', (req, res) => {
      const roomStats = Array.from(this.rooms.values()).map(room => room.getStats());
      res.json({
        rooms: roomStats,
        totalRooms: this.rooms.size
      });
    });

    this.app.post('/rooms', (req, res) => {
      const { name } = req.body;
      const roomId = this.createRoom(name);
      res.json({
        success: true,
        roomId,
        message: `Room ${roomId} created successfully`
      });
    });

    // ENDPOINT TTS
    this.app.post('/tts', async (req, res) => {
      try {
        const { text, language = 'en-US', voice } = req.body;
        
        if (!text) {
          return res.status(400).json({ 
            error: 'Text is required' 
          });
        }

        console.log(`🎤 TTS Request: "${text}" (${language})`);

        const voiceConfig = this.getVoiceConfig(language, voice);
        console.log(`🔊 Voice config:`, voiceConfig);

        const googleApiKey = process.env.GOOGLE_API_KEY;
        if (!googleApiKey) {
          return res.status(500).json({ 
            error: 'Google API Key not configured' 
          });
        }

        const ttsResponse = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${googleApiKey}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            input: { text: text },
            voice: voiceConfig,
            audioConfig: {
              audioEncoding: 'MP3',
              speakingRate: 0.9,
              pitch: 0.0,
              volumeGainDb: 2.0
            }
          })
        });

        if (!ttsResponse.ok) {
          const errorText = await ttsResponse.text();
          console.error('❌ Google TTS Error:', ttsResponse.status, errorText);
          return res.status(ttsResponse.status).json({ 
            error: `Google TTS API error: ${errorText}` 
          });
        }

        const ttsData = await ttsResponse.json();
        
        if (!ttsData.audioContent) {
          return res.status(500).json({ 
            error: 'No audio content received from Google TTS' 
          });
        }

        console.log(`✅ TTS Success: ${ttsData.audioContent.length} chars base64`);

        res.json({
          success: true,
          audioContent: ttsData.audioContent,
          mimeType: 'audio/mp3',
          language: language,
          voice: voiceConfig.name,
          textLength: text.length
        });

      } catch (error) {
        console.error('❌ TTS Endpoint Error:', error);
        res.status(500).json({ 
          error: 'Internal server error during TTS processing',
          details: error.message 
        });
      }
    });

    this.app.get('/info', (req, res) => {
      const localIP = this.getLocalIP();
      const stats = this.getServerStats();
      res.json({
        serverIP: localIP,
        port: process.env.PORT || 3001,
        ...stats,
        listenerUrl: `http://${localIP}:${process.env.PORT || 3001}/listen`,
        webSocketUrl: `ws://${localIP}:${process.env.PORT || 3001}`,
        ttsEndpoint: `http://${localIP}:${process.env.PORT || 3001}/tts`
      });
    });
  }

  getVoiceConfig(language, customVoice) {
    if (customVoice) {
      return customVoice;
    }

    const voiceMap = {
      'es-ES': { languageCode: 'es-ES', name: 'es-ES-Standard-A', ssmlGender: 'FEMALE' },
      'es': { languageCode: 'es-ES', name: 'es-ES-Standard-A', ssmlGender: 'FEMALE' },
      'en-US': { languageCode: 'en-US', name: 'en-US-Standard-D', ssmlGender: 'MALE' },
      'en': { languageCode: 'en-US', name: 'en-US-Standard-D', ssmlGender: 'MALE' },
    };

    return voiceMap[language] || voiceMap['en-US'];
  }

  setupWebSocket() {
    this.wss.on('connection', (ws, req) => {
      const clientId = randomUUID();
      const url = new URL(req.url, `http://${req.headers.host}`);
      const clientType = url.searchParams.get('type');
      const roomId = url.searchParams.get('room') || this.defaultRoom;
      const userAgent = req.headers['user-agent'];
      const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;

      console.log(`🔗 New connection: ${clientType} (${clientId}) -> Room: ${roomId}`);

      this.clients.set(clientId, {
        ws,
        type: clientType,
        roomId,
        connectedAt: new Date(),
        metadata: { userAgent, ip }
      });

      try {
        const room = this.getOrCreateRoom(roomId);

        if (clientType === 'broadcaster') {
          room.addPresenter(ws, clientId, { userAgent, ip });
        } else if (clientType === 'listener') {
          room.addListener(ws, clientId, { userAgent, ip });
        } else {
          throw new Error(`Unknown client type: ${clientType}`);
        }

        ws.on('message', (message) => {
          this.handleMessage(clientId, message);
        });

        ws.on('close', () => {
          this.handleDisconnection(clientId);
        });

        ws.on('error', (error) => {
          console.error(`WebSocket error for ${clientId}:`, error.message);
          this.handleDisconnection(clientId);
        });

        ws.on('pong', () => {
          const client = this.clients.get(clientId);
          if (client) {
            client.lastPong = new Date();
          }
        });

      } catch (error) {
        console.error(`Error setting up client ${clientId}:`, error.message);
        ws.send(JSON.stringify({
          type: 'error',
          message: error.message
        }));
        ws.close();
      }
    });
  }

  handleMessage(clientId, message) {
    try {
      const client = this.clients.get(clientId);
      if (!client) return;

      const data = JSON.parse(message);
      const room = this.rooms.get(client.roomId);
      if (!room) return;

      switch (data.type) {
        case 'audio-chunk':
          if (client.type === 'broadcaster') {
            const result = room.broadcastAudioChunk(data.audioData, data.timestamp);
            
            room.sendToPresenter({
              type: 'delivery-status',
              delivered: result.successCount,
              failed: result.failureCount,
              timestamp: data.timestamp
            });
          }
          break;

        case 'ping':
          client.ws.send(JSON.stringify({
            type: 'pong',
            timestamp: Date.now()
          }));
          break;

        case 'room-settings':
          if (client.type === 'broadcaster' && data.settings) {
            Object.assign(room.settings, data.settings);
            room.sendToPresenter({
              type: 'settings-updated',
              settings: room.settings
            });
          }
          break;

        default:
          console.warn(`Unknown message type: ${data.type} from ${clientId}`);
      }

      room.stats.totalMessages++;
    } catch (error) {
      console.error(`Error handling message from ${clientId}:`, error.message);
    }
  }

  handleDisconnection(clientId) {
    const client = this.clients.get(clientId);
    if (!client) return;

    const room = this.rooms.get(client.roomId);
    if (room) {
      if (client.type === 'broadcaster') {
        room.removePresenter();
      } else if (client.type === 'listener') {
        room.removeListener(clientId);
      }
    }

    this.clients.delete(clientId);
    console.log(`🔌 Client ${clientId} (${client.type}) disconnected from room ${client.roomId}`);
  }

  getOrCreateRoom(roomId) {
    if (!this.rooms.has(roomId)) {
      this.createRoom(null, roomId);
    }
    return this.rooms.get(roomId);
  }

  createRoom(name = null, roomId = null) {
    const id = roomId || randomUUID().slice(0, 8);
    const room = new TranslationRoom(id, name);
    this.rooms.set(id, room);
    console.log(`🏠 Created room: ${id} (${name || 'Unnamed'})`);
    return id;
  }

  createDefaultRoom() {
    if (!this.rooms.has(this.defaultRoom)) {
      const room = new TranslationRoom(this.defaultRoom, 'Sala Principal');
      this.rooms.set(this.defaultRoom, room);
      console.log(`🏠 Created default room: ${this.defaultRoom}`);
    }
  }

  startHealthCheck() {
    setInterval(() => {
      this.rooms.forEach(room => {
        room.ping();
      });
    }, 30000);

    setInterval(() => {
      this.cleanupInactiveRooms();
    }, 300000);

    setInterval(() => {
      const stats = this.getServerStats();
      console.log(`📊 Server Stats: ${stats.totalClients} clients, ${stats.activeRooms} rooms, ${stats.totalAudioChunks} audio chunks sent`);
    }, 60000);
  }

  cleanupInactiveRooms() {
    const cutoffTime = Date.now() - (30 * 60 * 1000);
    
    this.rooms.forEach((room, roomId) => {
      if (roomId === this.defaultRoom) return;
      
      if (!room.isActive && room.listeners.size === 0 && room.lastActivity.getTime() < cutoffTime) {
        console.log(`🗑️ Cleaning up inactive room: ${roomId}`);
        this.rooms.delete(roomId);
      }
    });
  }

  getServerStats() {
    const totalClients = this.clients.size;
    const activeRooms = Array.from(this.rooms.values()).filter(r => r.isActive).length;
    const totalListeners = Array.from(this.rooms.values()).reduce((sum, room) => sum + room.listeners.size, 0);
    const totalAudioChunks = Array.from(this.rooms.values()).reduce((sum, room) => sum + room.stats.audioChunks, 0);

    return {
      totalClients,
      totalListeners,
      totalRooms: this.rooms.size,
      activeRooms,
      totalAudioChunks,
      uptime: process.uptime(),
      memory: process.memoryUsage()
    };
  }

  getLocalIP() {
    const interfaces = networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const netInterface of interfaces[name]) {
        if (netInterface.family === 'IPv4' && !netInterface.internal) {
          return netInterface.address;
        }
      }
    }
    return 'localhost';
  }

  listen(port = 3001) {
    this.server.listen(port, '0.0.0.0', () => {
      const localIP = this.getLocalIP();
      console.log(`
🎵 Robust Audio Translation Server Started
📡 Server: http://${localIP}:${port}
👥 Listener URL: http://${localIP}:${port}/listen
🔗 WebSocket: ws://${localIP}:${port}
📊 Health Check: http://${localIP}:${port}/health
🏠 Rooms API: http://${localIP}:${port}/rooms
🎤 TTS API: http://${localIP}:${port}/tts
      `);
    });

    process.on('SIGTERM', () => this.shutdown());
    process.on('SIGINT', () => this.shutdown());
  }

  shutdown() {
    console.log('🔄 Shutting down server...');
    
    this.clients.forEach((client) => {
      try {
        client.ws.send(JSON.stringify({
          type: 'server-shutdown',
          message: 'El servidor se está cerrando. Por favor, recarga la página en unos momentos.'
        }));
      } catch (error) {
        // Ignore errors during shutdown
      }
    });

    this.wss.close(() => {
      console.log('🔌 WebSocket server closed');
      
      this.server.close(() => {
        console.log('🛑 Server shutdown complete');
        process.exit(0);
      });
    });

    setTimeout(() => {
      console.log('⚠️ Force shutdown');
      process.exit(1);
    }, 5000);
  }
}

const translationServer = new RobustTranslationServer();
const PORT = process.env.PORT || 3001;
translationServer.listen(PORT);
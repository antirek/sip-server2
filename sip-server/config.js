require('dotenv').config();

const config = {
    // SIP сервер
    sip: {
        port: process.env.SIP_PORT || 5060,
        host: process.env.SIP_HOST || '0.0.0.0',
        serverAddress: process.env.SERVER_ADDRESS || '192.168.0.42'
    },
    
    // API сервер
    api: {
        port: process.env.API_PORT || 3000,
        host: process.env.API_HOST || '0.0.0.0'
    },
    
    // RTP прокси
    rtp: {
        port: process.env.RTP_PORT || 10000,
        host: process.env.RTP_HOST || '0.0.0.0'
    },
    
    // Валидные номера
    extensions: {
        min: parseInt(process.env.EXT_MIN) || 100,
        max: parseInt(process.env.EXT_MAX) || 110
    },
    
    // Логирование
    logging: {
        level: process.env.LOG_LEVEL || 'info',
        file: process.env.LOG_FILE || './logs/sip-server.log',
        maxSize: process.env.LOG_MAX_SIZE || '10m',
        maxFiles: parseInt(process.env.LOG_MAX_FILES) || 5
    },
    
    // Безопасность
    security: {
        enableAuth: process.env.ENABLE_AUTH === 'true' || false,
        authSecret: process.env.AUTH_SECRET || 'your-secret-key',
        rateLimit: {
            windowMs: parseInt(process.env.RATE_LIMIT_WINDOW) || 15 * 60 * 1000, // 15 минут
            max: parseInt(process.env.RATE_LIMIT_MAX) || 100 // максимум 100 запросов
        }
    },
    
    // Таймауты
    timeouts: {
        callSetup: parseInt(process.env.CALL_SETUP_TIMEOUT) || 30000, // 30 секунд
        registration: parseInt(process.env.REGISTRATION_TIMEOUT) || 3600, // 1 час
        cleanup: parseInt(process.env.CLEANUP_INTERVAL) || 60000 // 1 минута
    }
};

// Генерируем список валидных номеров
config.validExtensions = new Set();
for (let i = config.extensions.min; i <= config.extensions.max; i++) {
    config.validExtensions.add(i.toString());
}

module.exports = config; 
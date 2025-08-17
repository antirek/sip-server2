const winston = require('winston');
const path = require('path');
const fs = require('fs');
const config = require('./config');

// Создаем директорию для логов если её нет
const logDir = path.dirname(config.logging.file);
if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
}

// Настройка форматирования логов
const logFormat = winston.format.combine(
    winston.format.timestamp({
        format: 'YYYY-MM-DD HH:mm:ss'
    }),
    winston.format.errors({ stack: true }),
    winston.format.json()
);

// Создаем логгер
const logger = winston.createLogger({
    level: config.logging.level,
    format: logFormat,
    defaultMeta: { service: 'sip-server' },
    transports: [
        // Логирование в файл
        new winston.transports.File({
            filename: config.logging.file,
            maxsize: config.logging.maxSize,
            maxFiles: config.logging.maxFiles,
            tailable: true
        }),
        // Логирование ошибок в отдельный файл
        new winston.transports.File({
            filename: path.join(logDir, 'error.log'),
            level: 'error',
            maxsize: config.logging.maxSize,
            maxFiles: config.logging.maxFiles
        })
    ]
});

// В режиме разработки добавляем вывод в консоль
if (process.env.NODE_ENV !== 'production') {
    logger.add(new winston.transports.Console({
        format: winston.format.combine(
            winston.format.colorize(),
            winston.format.simple()
        )
    }));
}

// Создаем специализированные логгеры
const sipLogger = {
    info: (message, meta = {}) => logger.info(message, { ...meta, component: 'sip' }),
    error: (message, meta = {}) => logger.error(message, { ...meta, component: 'sip' }),
    warn: (message, meta = {}) => logger.warn(message, { ...meta, component: 'sip' }),
    debug: (message, meta = {}) => logger.debug(message, { ...meta, component: 'sip' })
};

const rtpLogger = {
    info: (message, meta = {}) => logger.info(message, { ...meta, component: 'rtp' }),
    error: (message, meta = {}) => logger.error(message, { ...meta, component: 'rtp' }),
    warn: (message, meta = {}) => logger.warn(message, { ...meta, component: 'rtp' }),
    debug: (message, meta = {}) => logger.debug(message, { ...meta, component: 'rtp' })
};

const apiLogger = {
    info: (message, meta = {}) => logger.info(message, { ...meta, component: 'api' }),
    error: (message, meta = {}) => logger.error(message, { ...meta, component: 'api' }),
    warn: (message, meta = {}) => logger.warn(message, { ...meta, component: 'api' }),
    debug: (message, meta = {}) => logger.debug(message, { ...meta, component: 'api' })
};

module.exports = {
    logger,
    sipLogger,
    rtpLogger,
    apiLogger
}; 
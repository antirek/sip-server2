const dgram = require('dgram');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

// Импортируем наши модули
const config = require('./config');
const { sipLogger, apiLogger } = require('./logger');
const SipValidator = require('./utils/sip-validator');
const CallManager = require('./utils/call-manager');
const UserManager = require('./utils/user-manager');
const RtpProxy = require('./rtp-proxy');

// Создаем UDP сервер для SIP
const sipServer = dgram.createSocket('udp4');

// Создаем Express приложение для управления
const app = express();

// Настройка CORS
app.use(cors());

// Настройка rate limiting
const limiter = rateLimit({
    windowMs: config.security.rateLimit.windowMs,
    max: config.security.rateLimit.max,
    message: {
        error: 'Too many requests from this IP, please try again later.'
    },
    standardHeaders: true,
    legacyHeaders: false,
});

app.use(limiter);
app.use(express.json());

// Инициализируем менеджеры
const sipValidator = new SipValidator(config);
const callManager = new CallManager(config);
const userManager = new UserManager(config);

// Создаем RTP прокси
const rtpProxy = new RtpProxy(config);

// Парсинг SIP сообщений
function parseSipMessage(message) {
    const lines = message.toString().split('\r\n');
    const firstLine = lines[0];
    const headers = {};
    let body = '';
    let bodyStart = false;

    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (line === '') {
            bodyStart = true;
            continue;
        }
        if (bodyStart) {
            body += line + '\r\n';
        } else {
            const colonIndex = line.indexOf(':');
            if (colonIndex !== -1) {
                const key = line.substring(0, colonIndex).trim();
                const value = line.substring(colonIndex + 1).trim();
                headers[key] = value;
            }
        }
    }

    return {
        firstLine,
        headers,
        body: body.trim()
    };
}

// Создание SIP ответа
function createSipResponse(statusCode, statusText, headers, body = '') {
    let response = `SIP/2.0 ${statusCode} ${statusText}\r\n`;
    
    for (const [key, value] of Object.entries(headers)) {
        response += `${key}: ${value}\r\n`;
    }
    
    if (body) {
        response += `Content-Length: ${body.length}\r\n`;
    }
    
    response += '\r\n';
    if (body) {
        response += body;
    }
    
    return response;
}

// Извлечение номера из SIP URI
function extractNumber(uri) {
    console.log(`Извлекаем номер из URI: ${uri}`);
    // Поддерживаем разные форматы: sip:100@domain, sip:100@domain:port, sip:100@domain;user=phone
    const match = uri.match(/sip:(\d+)@/);
    const number = match ? match[1] : null;
    console.log(`Извлеченный номер: ${number}`);
    return number;
}

// Обработка REGISTER запросов
function handleRegister(message, rinfo) {
    try {
        const parsed = parseSipMessage(message);
        
        // Валидация REGISTER запроса
        const validation = sipValidator.validateRegisterRequest(parsed);
        if (!validation.valid) {
            sipValidator.logValidationError('REGISTER', validation.errors, message.toString());
            const response = createSipResponse(400, 'Bad Request', {
                'Via': parsed.headers['Via'],
                'From': parsed.headers['From'],
                'To': parsed.headers['To'],
                'Call-ID': parsed.headers['Call-ID'],
                'CSeq': parsed.headers['CSeq']
            });
            sipServer.send(response, rinfo.port, rinfo.address);
            return;
        }

        const toHeader = parsed.headers['To'];
        const fromHeader = parsed.headers['From'];
        const contactHeader = parsed.headers['Contact'];
        const expiresHeader = parsed.headers['Expires'] || '3600';

        const number = extractNumber(toHeader);
        const expires = parseInt(expiresHeader);
        
        // Регистрируем пользователя
        const contactUri = contactHeader.replace(/^<|>.*$/g, '');
        const userData = userManager.registerUser(number, contactUri, rinfo.address, rinfo.port, expires);

        sipLogger.info(`User registration successful`, {
            number,
            address: rinfo.address,
            port: rinfo.port,
            expires,
            contactUri
        });

        const response = createSipResponse(200, 'OK', {
            'Via': parsed.headers['Via'],
            'From': fromHeader,
            'To': toHeader,
            'Call-ID': parsed.headers['Call-ID'],
            'CSeq': parsed.headers['CSeq'],
            'Contact': contactHeader,
            'Expires': expiresHeader
        });

        sipServer.send(response, rinfo.port, rinfo.address);
        
    } catch (error) {
        sipLogger.error(`Error handling REGISTER request`, {
            error: error.message,
            stack: error.stack,
            address: rinfo.address,
            port: rinfo.port
        });
        
        // Отправляем ошибку клиенту
        const response = createSipResponse(500, 'Internal Server Error', {
            'Via': parsed?.headers?.['Via'],
            'From': parsed?.headers?.['From'],
            'To': parsed?.headers?.['To'],
            'Call-ID': parsed?.headers?.['Call-ID'],
            'CSeq': parsed?.headers?.['CSeq']
        });
        sipServer.send(response, rinfo.port, rinfo.address);
    }
}

// Обработка INVITE запросов
function handleInvite(message, rinfo) {
    try {
        const parsed = parseSipMessage(message);
        
        // Валидация INVITE запроса
        const validation = sipValidator.validateInviteRequest(parsed);
        if (!validation.valid) {
            sipValidator.logValidationError('INVITE', validation.errors, message.toString());
            const response = createSipResponse(400, 'Bad Request', {
                'Via': parsed.headers['Via'],
                'From': parsed.headers['From'],
                'To': parsed.headers['To'],
                'Call-ID': parsed.headers['Call-ID'],
                'CSeq': parsed.headers['CSeq']
            });
            sipServer.send(response, rinfo.port, rinfo.address);
            return;
        }

        const toHeader = parsed.headers['To'];
        const fromHeader = parsed.headers['From'];
        const callId = parsed.headers['Call-ID'];

        const fromNumber = extractNumber(fromHeader);
        const toNumber = extractNumber(toHeader);

        sipLogger.info(`Incoming call`, {
            fromNumber,
            toNumber,
            callId,
            address: rinfo.address,
            port: rinfo.port
        });

        // Проверяем регистрацию абонентов
        const targetUser = userManager.getUser(toNumber);
        const callingUser = userManager.getUser(fromNumber);

        if (!targetUser || !callingUser) {
            const missingUser = !targetUser ? toNumber : fromNumber;
            sipLogger.warn(`User not registered`, { missingUser, fromNumber, toNumber });
            
            const response = createSipResponse(404, 'Not Found', {
                'Via': parsed.headers['Via'],
                'From': fromHeader,
                'To': toHeader,
                'Call-ID': callId,
                'CSeq': parsed.headers['CSeq']
            });
            sipServer.send(response, rinfo.port, rinfo.address);
            return;
        }

        // Проверяем, не занят ли целевой абонент
        if (callManager.isNumberBusy(toNumber)) {
            sipLogger.warn(`Target user is busy`, { toNumber });
            const response = createSipResponse(486, 'Busy Here', {
                'Via': parsed.headers['Via'],
                'From': fromHeader,
                'To': toHeader,
                'Call-ID': callId,
                'CSeq': parsed.headers['CSeq']
            });
            sipServer.send(response, rinfo.port, rinfo.address);
            return;
        }

        // Создаем новый звонок
        const callData = callManager.createCall(
            callId, 
            fromNumber, 
            toNumber, 
            rinfo.address, 
            rinfo.port, 
            parsed.body
        );

        // Устанавливаем целевого абонента
        callManager.setTarget(callId, targetUser.address, targetUser.port);

        // Сохраняем оригинальные заголовки
        callManager.updateCallState(callId, 'RINGING', {
            originalVia: parsed.headers['Via'],
            originalFrom: parsed.headers['From'],
            originalTo: parsed.headers['To'],
            originalCSeq: parsed.headers['CSeq'],
            originalContact: parsed.headers['Contact']
        });

        // Отправляем 100 Trying
        const tryingResponse = createSipResponse(100, 'Trying', {
            'Via': parsed.headers['Via'],
            'From': fromHeader,
            'To': toHeader,
            'Call-ID': callId,
            'CSeq': parsed.headers['CSeq']
        });
        sipServer.send(tryingResponse, rinfo.port, rinfo.address);

        // Модифицируем SDP для направления RTP через сервер
        let modifiedSdp = parsed.body;
        if (parsed.body && parsed.headers['Content-Type']?.includes('application/sdp')) {
            modifiedSdp = rtpProxy.modifySdp(parsed.body, callId);
        }

        // Создаем INVITE к вызываемому абоненту
        const targetUri = `sip:${toNumber}@${targetUser.address}:${targetUser.port}`;
        const serverAddress = config.sip.serverAddress;
        
        let inviteToTarget = `INVITE ${targetUri} SIP/2.0\r\n` +
            `Via: SIP/2.0/UDP ${serverAddress}:${config.sip.port}\r\n` +
            `From: ${fromHeader}\r\n` +
            `To: ${toHeader}\r\n` +
            `Call-ID: ${callId}\r\n` +
            `CSeq: ${parsed.headers['CSeq']}\r\n` +
            `Contact: ${parsed.headers['Contact']}\r\n`;
        
        if (parsed.headers['Content-Type']) {
            inviteToTarget += `Content-Type: ${parsed.headers['Content-Type']}\r\n`;
        }
        
        if (modifiedSdp) {
            inviteToTarget += `Content-Length: ${modifiedSdp.length}\r\n`;
        }
        
        inviteToTarget += '\r\n';
        
        if (modifiedSdp) {
            inviteToTarget += modifiedSdp;
        }

        sipLogger.info(`Sending INVITE to target`, {
            callId,
            targetUri,
            targetAddress: targetUser.address,
            targetPort: targetUser.port
        });

        sipServer.send(inviteToTarget, targetUser.port, targetUser.address);

        // Извлекаем RTP порт из SDP
        if (parsed.body && parsed.headers['Content-Type']?.includes('application/sdp')) {
            const rtpPortMatch = parsed.body.match(/m=audio ([0-9]+)/);
            if (rtpPortMatch) {
                const fromRtpPort = parseInt(rtpPortMatch[1]);
                callManager.updateCallState(callId, 'RINGING', { fromRtpPort });
                sipLogger.info(`RTP port extracted`, {
                    callId,
                    fromNumber,
                    fromRtpPort
                });
            }
        }

    } catch (error) {
        sipLogger.error(`Error handling INVITE request`, {
            error: error.message,
            stack: error.stack,
            address: rinfo.address,
            port: rinfo.port
        });
        
        // Отправляем ошибку клиенту
        const response = createSipResponse(500, 'Internal Server Error', {
            'Via': parsed?.headers?.['Via'],
            'From': parsed?.headers?.['From'],
            'To': parsed?.headers?.['To'],
            'Call-ID': parsed?.headers?.['Call-ID'],
            'CSeq': parsed?.headers?.['CSeq']
        });
        sipServer.send(response, rinfo.port, rinfo.address);
    }
}

// Обработка BYE запросов
function handleBye(message, rinfo) {
    const parsed = parseSipMessage(message);
    const callId = parsed.headers['Call-ID'];
    
    const call = callManager.getCall(callId);
    if (call) {
        // Пересылаем BYE другому участнику
        const byeMessage = `BYE ${call.toAddress}:${call.toPort} SIP/2.0\r\n` +
            `Via: SIP/2.0/UDP ${rinfo.address}:${rinfo.port}\r\n` +
            `From: ${parsed.headers['From']}\r\n` +
            `To: ${parsed.headers['To']}\r\n` +
            `Call-ID: ${callId}\r\n` +
            `CSeq: ${parsed.headers['CSeq']}\r\n` +
            '\r\n';
        
        sipServer.send(byeMessage, call.toPort, call.toAddress);
        // Не удаляем звонок сразу, а помечаем как завершающийся
        console.log(`🎯 BYE ОБРАБОТКА: Устанавливаем terminating = true для звонка ${callId}`);
        call.terminating = true;
        rtpProxy.removeStream(callId);
        console.log(`🎯 BYE ОБРАБОТКА: Звонок ${callId} помечен как завершающийся`);
    }

    const response = createSipResponse(200, 'OK', {
        'Via': parsed.headers['Via'],
        'From': parsed.headers['From'],
        'To': parsed.headers['To'],
        'Call-ID': callId,
        'CSeq': parsed.headers['CSeq']
    });
    sipServer.send(response, rinfo.port, rinfo.address);
}

// Обработка ACK запросов
function handleAck(message, rinfo) {
    const parsed = parseSipMessage(message);
    const callId = parsed.headers['Call-ID'];
    
    console.log(`🎯 ACK ОБРАБОТКА: Получен ACK для звонка ${callId} от ${rinfo.address}:${rinfo.port}`);
    console.log(`🎯 ACK ОБРАБОТКА: Call-ID: ${callId}`);
    
    const call = callManager.getCall(callId);
    if (call) {
        console.log(`🎯 ACK ОБРАБОТКА: Найден активный звонок`);
        console.log(`🎯 ACK ОБРАБОТКА: Пересылаем ACK к ${call.toNumber} на ${call.toAddress}:${call.toPort}`);
        console.log(`🎯 ACK ОБРАБОТКА: call.toAddress = ${call.toAddress}, call.toPort = ${call.toPort}`);
        
        // Проверяем, не завершается ли звонок
        if (call.terminating) {
            console.log(`🎯 ACK ОБРАБОТКА: Звонок завершается, но все равно пересылаем ACK`);
        }
        
        // Пересылаем ACK другому участнику
        // Извлекаем branch из оригинального Via заголовка
        const originalVia = parsed.headers['Via'];
        const branchMatch = originalVia.match(/branch=([^;]+)/);
        const branch = branchMatch ? branchMatch[1] : 'z9hG4bK-' + Math.random().toString(36).substr(2, 9);
        
        let ackMessage = `ACK sip:${call.toNumber}@${call.toAddress}:${call.toPort} SIP/2.0\r\n` +
            `Via: SIP/2.0/UDP ${config.sip.serverAddress}:${config.sip.port};branch=${branch}\r\n` +
            `From: ${parsed.headers['From']}\r\n` +
            `To: ${parsed.headers['To']}\r\n` +
            `Call-ID: ${callId}\r\n` +
            `CSeq: ${parsed.headers['CSeq']}\r\n`;
        
        if (parsed.headers['Contact']) {
            ackMessage += `Contact: ${parsed.headers['Contact']}\r\n`;
        }
        
        ackMessage += '\r\n';
        
        if (parsed.body) {
            ackMessage += parsed.body;
        }
        
        console.log(`🎯 ACK ОБРАБОТКА: Отправляем ACK:\n${ackMessage}`);
        sipServer.send(ackMessage, call.toPort, call.toAddress);
        console.log(`🎯 ACK ОБРАБОТКА: ACK переслан к ${call.toNumber} на ${call.toAddress}:${call.toPort}`);
    } else {
        console.log(`🎯 ACK ОБРАБОТКА: Звонок ${callId} НЕ НАЙДЕН в активных звонках`);
        const activeCalls = callManager.getActiveCalls();
        console.log(`🎯 ACK ОБРАБОТКА: Все активные звонки: ${activeCalls.map(c => c.callId).join(', ')}`);
    }
}

// Обработка входящих SIP сообщений
sipServer.on('message', (message, rinfo) => {
    const messageStr = message.toString();
    const firstLine = messageStr.split('\r\n')[0];
    
    console.log(`\n=== SIP СООБЩЕНИЕ ===`);
    console.log(`Получено SIP сообщение от ${rinfo.address}:${rinfo.port}: ${firstLine}`);
    console.log(`Тип сообщения: ${firstLine.split(' ')[0]}`);
    console.log(`Полное сообщение:\n${messageStr}`);
    console.log(`=== КОНЕЦ SIP СООБЩЕНИЯ ===\n`);

    if (firstLine.startsWith('REGISTER')) {
        handleRegister(message, rinfo);
    } else if (firstLine.startsWith('INVITE')) {
        handleInvite(message, rinfo);
    } else if (firstLine.startsWith('BYE')) {
        handleBye(message, rinfo);
    } else if (firstLine.startsWith('ACK')) {
        console.log(`\n🔍 ОБРАБОТКА ACK 🔍`);
        handleAck(message, rinfo);
        console.log(`🔍 КОНЕЦ ОБРАБОТКИ ACK 🔍\n`);
    } else if (firstLine.startsWith('SIP/2.0')) {
        // Обработка ответов
        const parsed = parseSipMessage(message);
        const statusLine = parsed.firstLine;
        const callId = parsed.headers['Call-ID'];
        
        console.log(`Получен ответ: ${statusLine} от ${rinfo.address}:${rinfo.port}`);
        console.log(`Call-ID ответа: ${callId}`);
        
        const call = callManager.getCall(callId);
        console.log(`🎯 200 OK ОБРАБОТКА: Call-ID: ${callId}`);
        console.log(`🎯 200 OK ОБРАБОТКА: Звонок найден: ${!!call}`);
        console.log(`🎯 200 OK ОБРАБОТКА: Звонок завершается: ${call ? call.terminating : 'N/A'}`);
        if (call && call.terminating) {
            console.log(`🎯 200 OK ОБРАБОТКА: ВНИМАНИЕ! Звонок уже помечен как завершающийся!`);
        }
        if (call && statusLine.includes('200 OK') && call.terminating) {
            // Это ответ на BYE запрос
            console.log(`🎯 200 OK НА BYE: Получен 200 OK на BYE от ${call.toNumber}`);
            console.log(`🎯 200 OK НА BYE: Удаляем звонок ${callId} из активных звонков`);
            callManager.endCall(callId);
            console.log('🎯 200 OK НА BYE: Звонок полностью завершен');
        } else if (call && statusLine.includes('200 OK')) {
            console.log(`Пересылаем 200 OK к ${call.fromNumber} на ${call.fromAddress}:${call.fromPort}`);
            
            // Настраиваем RTP поток если есть SDP в ответе
            if (parsed.body && parsed.headers['Content-Type'] && parsed.headers['Content-Type'].includes('application/sdp')) {
                // Извлекаем RTP порты из SDP ответа
                const rtpPortMatch = parsed.body.match(/m=audio ([0-9]+)/);
                if (rtpPortMatch && call.fromRtpPort) {
                    const toRtpPort = parseInt(rtpPortMatch[1]);
                    console.log(`Настройка RTP потока: ${call.fromAddress}:${call.fromRtpPort} <-> ${rinfo.address}:${toRtpPort}`);
                    rtpProxy.addStream(callId, call.fromAddress, call.fromRtpPort, rinfo.address, toRtpPort);
                }
            }
            
            // Создаем правильные заголовки для 200 OK
            // Важно: используем оригинальные заголовки из INVITE, а не из ответа
            const responseHeaders = {
                'Via': call.originalVia || parsed.headers['Via'], // Оригинальный Via из INVITE
                'From': call.originalFrom || parsed.headers['From'], // Оригинальный From из INVITE
                'To': call.originalTo || parsed.headers['To'], // Оригинальный To из INVITE
                'Call-ID': callId,
                'CSeq': call.originalCSeq || parsed.headers['CSeq'] // Оригинальный CSeq из INVITE
            };
            
            // Изменяем Contact заголовок, чтобы ACK шел через сервер
            responseHeaders['Contact'] = `<sip:101@192.168.0.42:5060>`;
            
            if (parsed.headers['Content-Type']) {
                responseHeaders['Content-Type'] = parsed.headers['Content-Type'];
            }
            
            // Модифицируем SDP в ответе, чтобы ACK шел через сервер
            let responseBody = parsed.body || '';
            if (responseBody && parsed.headers['Content-Type'] && parsed.headers['Content-Type'].includes('application/sdp')) {
                responseBody = rtpProxy.modifySdp(responseBody, callId + '_response');
                console.log(`SDP в ответе модифицирован для направления ACK через сервер`);
            }
            
            // Пересылаем 200 OK вызывающему абоненту
            const okResponse = createSipResponse(200, 'OK', responseHeaders, responseBody);
            console.log(`Отправляем 200 OK к ${call.fromNumber}:\n${okResponse}`);
            sipServer.send(okResponse, call.fromPort, call.fromAddress);
            
            // Помечаем звонок как ожидающий ACK
            callManager.updateCallState(callId, 'ESTABLISHED', { waitingForAck: true });
            console.log(`Звонок ${callId} помечен как ожидающий ACK от ${call.fromNumber}`);
        } else if (call && (statusLine.includes('404') || statusLine.includes('486') || statusLine.includes('487'))) {
            console.log(`Пересылаем ${statusLine} к ${call.fromNumber}`);
            
            // Пересылаем ошибку вызывающему абоненту
            const errorResponse = createSipResponse(
                statusLine.split(' ')[1], 
                statusLine.split(' ').slice(2).join(' '), 
                {
                    'Via': parsed.headers['Via'],
                    'From': parsed.headers['From'],
                    'To': parsed.headers['To'],
                    'Call-ID': callId,
                    'CSeq': parsed.headers['CSeq']
                }
            );
            
            sipServer.send(errorResponse, call.fromPort, call.fromAddress);
        }
    }
});

// Express API для управления
app.get('/api/users', (req, res) => {
    try {
        const users = userManager.getAllUsers();
        apiLogger.info(`Users list requested`, { count: users.length });
        res.json(users);
    } catch (error) {
        apiLogger.error(`Error getting users`, { error: error.message });
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/extensions', (req, res) => {
    try {
        const extensions = Array.from(config.validExtensions);
        res.json(extensions);
    } catch (error) {
        apiLogger.error(`Error getting extensions`, { error: error.message });
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/calls', (req, res) => {
    try {
        const calls = callManager.getActiveCalls();
        apiLogger.info(`Active calls requested`, { count: calls.length });
        res.json(calls);
    } catch (error) {
        apiLogger.error(`Error getting calls`, { error: error.message });
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/calls/history', (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const offset = parseInt(req.query.offset) || 0;
        const history = callManager.getCallHistory(limit, offset);
        apiLogger.info(`Call history requested`, { limit, offset, count: history.length });
        res.json(history);
    } catch (error) {
        apiLogger.error(`Error getting call history`, { error: error.message });
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/statistics', (req, res) => {
    try {
        const callStats = callManager.getStatistics();
        const userStats = userManager.getUserStatistics();
        const rtpStats = rtpProxy.getStreams();
        
        const statistics = {
            calls: callStats,
            users: userStats,
            rtp: {
                activeStreams: rtpStats.length
            },
            server: {
                uptime: process.uptime(),
                memory: process.memoryUsage(),
                version: process.version
            }
        };
        
        apiLogger.info(`Statistics requested`);
        res.json(statistics);
    } catch (error) {
        apiLogger.error(`Error getting statistics`, { error: error.message });
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/rtp-streams', (req, res) => {
    try {
        const streams = rtpProxy.getStreams();
        res.json(streams);
    } catch (error) {
        apiLogger.error(`Error getting RTP streams`, { error: error.message });
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/api/users/:username', (req, res) => {
    try {
        const username = req.params.username;
        const success = userManager.unregisterUser(username);
        
        if (success) {
            apiLogger.info(`User unregistered via API`, { username });
            res.json({ message: `User ${username} unregistered` });
        } else {
            apiLogger.warn(`User not found for unregistration`, { username });
            res.status(404).json({ error: 'User not found' });
        }
    } catch (error) {
        apiLogger.error(`Error unregistering user`, { error: error.message, username: req.params.username });
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Новые эндпоинты
app.get('/api/users/:username/calls', (req, res) => {
    try {
        const username = req.params.username;
        const calls = callManager.getCallsByNumber(username);
        apiLogger.info(`User calls requested`, { username, count: calls.length });
        res.json(calls);
    } catch (error) {
        apiLogger.error(`Error getting user calls`, { error: error.message, username: req.params.username });
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/users/expiring', (req, res) => {
    try {
        const withinMinutes = parseInt(req.query.within) || 30;
        const expiringUsers = userManager.getExpiringUsers(withinMinutes);
        apiLogger.info(`Expiring users requested`, { withinMinutes, count: expiringUsers.length });
        res.json(expiringUsers);
    } catch (error) {
        apiLogger.error(`Error getting expiring users`, { error: error.message });
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Административные эндпоинты (только для разработки)
if (process.env.NODE_ENV !== 'production') {
    app.post('/api/admin/clear-calls', (req, res) => {
        try {
            callManager.clearAllCalls();
            apiLogger.warn(`All calls cleared via admin API`);
            res.json({ message: 'All calls cleared' });
        } catch (error) {
            apiLogger.error(`Error clearing calls`, { error: error.message });
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    app.post('/api/admin/clear-users', (req, res) => {
        try {
            userManager.clearAllUsers();
            apiLogger.warn(`All users cleared via admin API`);
            res.json({ message: 'All users cleared' });
        } catch (error) {
            apiLogger.error(`Error clearing users`, { error: error.message });
            res.status(500).json({ error: 'Internal server error' });
        }
    });
}

// Запуск серверов
sipServer.bind(config.sip.port, config.sip.host, () => {
    sipLogger.info(`SIP server started`, {
        port: config.sip.port,
        host: config.sip.host,
        serverAddress: config.sip.serverAddress
    });
    console.log(`SIP сервер запущен на порту ${config.sip.port}`);
    console.log(`Сервер слушает на всех интерфейсах (${config.sip.host}:${config.sip.port})`);
    console.log(`Поддерживаемые номера: ${Array.from(config.validExtensions).join(', ')}`);
});

// Обработка ошибок SIP сервера
sipServer.on('error', (error) => {
    sipLogger.error(`SIP server error`, { error: error.message });
});

// Запускаем RTP прокси
rtpProxy.start();

app.listen(config.api.port, config.api.host, () => {
    apiLogger.info(`API server started`, {
        port: config.api.port,
        host: config.api.host
    });
    console.log(`API сервер запущен на порту ${config.api.port}`);
    console.log('Доступные эндпоинты:');
    console.log(`  GET  http://localhost:${config.api.port}/api/users - список зарегистрированных пользователей`);
    console.log(`  GET  http://localhost:${config.api.port}/api/extensions - список валидных номеров`);
    console.log(`  GET  http://localhost:${config.api.port}/api/calls - активные звонки`);
    console.log(`  GET  http://localhost:${config.api.port}/api/calls/history - история звонков`);
    console.log(`  GET  http://localhost:${config.api.port}/api/statistics - статистика сервера`);
    console.log(`  GET  http://localhost:${config.api.port}/api/rtp-streams - активные RTP потоки`);
    console.log(`  DELETE http://localhost:${config.api.port}/api/users/:username - удалить регистрацию пользователя`);
    console.log(`  GET  http://localhost:${config.api.port}/api/users/:username/calls - звонки пользователя`);
    console.log(`  GET  http://localhost:${config.api.port}/api/users/expiring - пользователи с истекающей регистрацией`);
});

// Обработка завершения работы
process.on('SIGINT', () => {
    console.log('Завершение работы SIP сервера...');
    sipLogger.info(`Server shutdown initiated`);
    
    sipServer.close();
    rtpProxy.stop();
    
    console.log('Сервер остановлен');
    process.exit(0);
});

// Обработка необработанных ошибок
process.on('uncaughtException', (error) => {
    sipLogger.error(`Uncaught exception`, { 
        error: error.message, 
        stack: error.stack 
    });
    console.error('Необработанная ошибка:', error);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    sipLogger.error(`Unhandled rejection`, { 
        reason: reason?.message || reason,
        promise: promise 
    });
    console.error('Необработанное отклонение промиса:', reason);
}); 
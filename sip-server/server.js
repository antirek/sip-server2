const dgram = require('dgram');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');

// Создаем UDP сервер для SIP
const sipServer = dgram.createSocket('udp4');

// Создаем Express приложение для управления
const app = express();
app.use(cors());
app.use(express.json());

// Хранилище зарегистрированных абонентов
const registeredUsers = new Map();

// Валидные короткие номера (100-110)
const validExtensions = new Set();
for (let i = 100; i <= 110; i++) {
    validExtensions.add(i.toString());
}

// Активные звонки
const activeCalls = new Map();

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
    const parsed = parseSipMessage(message);
    const requestLine = parsed.firstLine;
    const toHeader = parsed.headers['To'];
    const fromHeader = parsed.headers['From'];
    const contactHeader = parsed.headers['Contact'];
    const expiresHeader = parsed.headers['Expires'] || '3600';

    const number = extractNumber(toHeader);
    
    if (!number || !validExtensions.has(number)) {
        const response = createSipResponse(403, 'Forbidden', {
            'Via': parsed.headers['Via'],
            'From': fromHeader,
            'To': toHeader,
            'Call-ID': parsed.headers['Call-ID'],
            'CSeq': parsed.headers['CSeq']
        });
        sipServer.send(response, rinfo.port, rinfo.address);
        return;
    }

    // Сохраняем информацию о пользователе
    const contactUri = contactHeader.replace(/^<|>.*$/g, '');
    registeredUsers.set(number, {
        uri: contactUri,
        address: rinfo.address,
        port: rinfo.port,
        expires: parseInt(expiresHeader),
        registeredAt: new Date()
    });

    console.log(`Пользователь ${number} зарегистрирован: ${contactUri}`);

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
}

// Обработка INVITE запросов
function handleInvite(message, rinfo) {
    const parsed = parseSipMessage(message);
    const requestLine = parsed.firstLine;
    const toHeader = parsed.headers['To'];
    const fromHeader = parsed.headers['From'];
    const callId = parsed.headers['Call-ID'];

    const fromNumber = extractNumber(fromHeader);
    const toNumber = extractNumber(toHeader);

    console.log(`Входящий звонок от ${fromNumber} к ${toNumber}`);

    // Проверяем валидность номеров
    if (!fromNumber || !toNumber || !validExtensions.has(fromNumber) || !validExtensions.has(toNumber)) {
        console.log(`Невалидные номера: ${fromNumber} -> ${toNumber}`);
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

    // Проверяем регистрацию абонентов
    const targetUser = registeredUsers.get(toNumber);
    const callingUser = registeredUsers.get(fromNumber);

    console.log(`Проверяем регистрацию: ${fromNumber} -> ${toNumber}`);
    console.log(`Зарегистрированные пользователи: ${Array.from(registeredUsers.keys()).join(', ')}`);
    console.log(`targetUser: ${targetUser ? 'найден' : 'не найден'}`);
    console.log(`callingUser: ${callingUser ? 'найден' : 'не найден'}`);

    if (!targetUser || !callingUser) {
        console.log(`Абонент не зарегистрирован: ${!targetUser ? toNumber : fromNumber}`);
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

    console.log(`Отправляем INVITE к ${toNumber} на ${targetUser.address}:${targetUser.port}`);

    // Отправляем 100 Trying
    const tryingResponse = createSipResponse(100, 'Trying', {
        'Via': parsed.headers['Via'],
        'From': fromHeader,
        'To': toHeader,
        'Call-ID': callId,
        'CSeq': parsed.headers['CSeq']
    });
    sipServer.send(tryingResponse, rinfo.port, rinfo.address);

    // Создаем INVITE к вызываемому абоненту
    // Используем правильный URI для целевого абонента
    const targetUri = `sip:${toNumber}@${targetUser.address}:${targetUser.port}`;
    
    // Используем адрес сервера в Via заголовке, чтобы абонент 101 знал, куда отправлять ответ
    const serverAddress = '192.168.0.42'; // IP адрес сервера
    
    let inviteToTarget = `INVITE ${targetUri} SIP/2.0\r\n` +
        `Via: SIP/2.0/UDP ${serverAddress}:${SIP_PORT}\r\n` +
        `From: ${fromHeader}\r\n` +
        `To: ${toHeader}\r\n` +
        `Call-ID: ${callId}\r\n` +
        `CSeq: ${parsed.headers['CSeq']}\r\n` +
        `Contact: ${parsed.headers['Contact']}\r\n`;
    
    if (parsed.headers['Content-Type']) {
        inviteToTarget += `Content-Type: ${parsed.headers['Content-Type']}\r\n`;
    }
    
    if (parsed.body) {
        inviteToTarget += `Content-Length: ${parsed.body.length}\r\n`;
    }
    
    inviteToTarget += '\r\n';
    
    if (parsed.body) {
        inviteToTarget += parsed.body;
    }

    console.log(`Отправляем INVITE:\n${inviteToTarget}`);
    sipServer.send(inviteToTarget, targetUser.port, targetUser.address);

    // Сохраняем информацию о звонке
    activeCalls.set(callId, {
        fromNumber,
        toNumber,
        fromAddress: rinfo.address,
        fromPort: rinfo.port,
        toAddress: targetUser.address,
        toPort: targetUser.port,
        sdp: parsed.body
    });

    console.log(`Звонок установлен: ${fromNumber} -> ${toNumber}`);
    console.log('RTP прокси будет настроен через SDP');
}

// Обработка BYE запросов
function handleBye(message, rinfo) {
    const parsed = parseSipMessage(message);
    const callId = parsed.headers['Call-ID'];
    
    const call = activeCalls.get(callId);
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
        activeCalls.delete(callId);
        console.log('Звонок завершен');
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
    
    console.log(`Получен ACK для звонка ${callId}`);
    
    const call = activeCalls.get(callId);
    if (call) {
        // Пересылаем ACK другому участнику
        const ackMessage = `ACK ${call.toAddress}:${call.toPort} SIP/2.0\r\n` +
            `Via: SIP/2.0/UDP ${rinfo.address}:${rinfo.port}\r\n` +
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
        
        sipServer.send(ackMessage, call.toPort, call.toAddress);
        console.log(`ACK переслан к ${call.toNumber}`);
    }
}

// Обработка входящих SIP сообщений
sipServer.on('message', (message, rinfo) => {
    const messageStr = message.toString();
    const firstLine = messageStr.split('\r\n')[0];
    
    console.log(`Получено SIP сообщение от ${rinfo.address}:${rinfo.port}: ${firstLine}`);

    if (firstLine.startsWith('REGISTER')) {
        handleRegister(message, rinfo);
    } else if (firstLine.startsWith('INVITE')) {
        handleInvite(message, rinfo);
    } else if (firstLine.startsWith('BYE')) {
        handleBye(message, rinfo);
    } else if (firstLine.startsWith('ACK')) {
        handleAck(message, rinfo);
    } else if (firstLine.startsWith('SIP/2.0')) {
        // Обработка ответов
        const parsed = parseSipMessage(message);
        const statusLine = parsed.firstLine;
        const callId = parsed.headers['Call-ID'];
        
        console.log(`Получен ответ: ${statusLine} от ${rinfo.address}:${rinfo.port}`);
        console.log(`Call-ID ответа: ${callId}`);
        console.log(`Активные звонки: ${Array.from(activeCalls.keys()).join(', ')}`);
        
        const call = activeCalls.get(callId);
        if (call && statusLine.includes('200 OK')) {
            console.log(`Пересылаем 200 OK к ${call.fromNumber} на ${call.fromAddress}:${call.fromPort}`);
            
            // Создаем заголовки для ответа
            const responseHeaders = {
                'Via': parsed.headers['Via'],
                'From': parsed.headers['From'],
                'To': parsed.headers['To'],
                'Call-ID': callId,
                'CSeq': parsed.headers['CSeq']
            };
            
            if (parsed.headers['Contact']) {
                responseHeaders['Contact'] = parsed.headers['Contact'];
            }
            
            if (parsed.headers['Content-Type']) {
                responseHeaders['Content-Type'] = parsed.headers['Content-Type'];
            }
            
            // Пересылаем 200 OK вызывающему абоненту
            const okResponse = createSipResponse(200, 'OK', responseHeaders, parsed.body || '');
            sipServer.send(okResponse, call.fromPort, call.fromAddress);
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
    const users = Array.from(registeredUsers.entries()).map(([username, data]) => ({
        username,
        uri: data.uri,
        address: data.address,
        port: data.port,
        expires: data.expires,
        registeredAt: data.registeredAt
    }));
    res.json(users);
});

app.get('/api/extensions', (req, res) => {
    res.json(Array.from(validExtensions));
});

app.get('/api/calls', (req, res) => {
    const calls = Array.from(activeCalls.entries()).map(([callId, data]) => ({
        callId,
        fromNumber: data.fromNumber,
        toNumber: data.toNumber,
        fromAddress: data.fromAddress,
        toAddress: data.toAddress
    }));
    res.json(calls);
});

app.delete('/api/users/:username', (req, res) => {
    const username = req.params.username;
    if (registeredUsers.has(username)) {
        registeredUsers.delete(username);
        res.json({message: `User ${username} unregistered`});
    } else {
        res.status(404).json({error: 'User not found'});
    }
});

// Запуск серверов
const SIP_PORT = process.env.SIP_PORT || 5060;
const API_PORT = process.env.API_PORT || 3000;

sipServer.bind(SIP_PORT, '0.0.0.0', () => {
    console.log(`SIP сервер запущен на порту ${SIP_PORT}`);
    console.log(`Сервер слушает на всех интерфейсах (0.0.0.0:${SIP_PORT})`);
    console.log(`Поддерживаемые номера: ${Array.from(validExtensions).join(', ')}`);
});

app.listen(API_PORT, () => {
    console.log(`API сервер запущен на порту ${API_PORT}`);
    console.log('Доступные эндпоинты:');
    console.log(`  GET  http://localhost:${API_PORT}/api/users - список зарегистрированных пользователей`);
    console.log(`  GET  http://localhost:${API_PORT}/api/extensions - список валидных номеров`);
    console.log(`  GET  http://localhost:${API_PORT}/api/calls - активные звонки`);
    console.log(`  DELETE http://localhost:${API_PORT}/api/users/:username - удалить регистрацию пользователя`);
});

// Обработка завершения работы
process.on('SIGINT', () => {
    console.log('Завершение работы SIP сервера...');
    sipServer.close();
    process.exit(0);
}); 
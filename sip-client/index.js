const dgram = require('dgram');
const crypto = require('crypto');

class SipClient {
    constructor(config) {
        this.config = config;
        this.socket = dgram.createSocket('udp4');
        this.callId = this.generateCallId();
        this.cseq = 1;
        this.registered = false;
        this.activeCall = null;
        
        this.setupSocket();
    }

    setupSocket() {
        this.socket.on('message', (message, rinfo) => {
            this.handleSipMessage(message, rinfo);
        });

        this.socket.on('error', (error) => {
            console.error('SIP Client error:', error);
        });
    }

    generateCallId() {
        return crypto.randomBytes(16).toString('hex') + '@' + this.config.clientAddress;
    }

    generateTag() {
        return crypto.randomBytes(8).toString('hex');
    }

    // Регистрация на сервере
    register() {
        const message = this.createRegisterMessage();
        this.sendMessage(message);
        console.log(`Регистрация отправлена для номера ${this.config.extension}`);
    }

    // Создание REGISTER сообщения
    createRegisterMessage() {
        const expires = this.config.expires || 3600;
        
        return `REGISTER sip:${this.config.extension}@${this.config.serverAddress}:${this.config.serverPort} SIP/2.0\r\n` +
               `Via: SIP/2.0/UDP ${this.config.clientAddress}:${this.config.clientPort}\r\n` +
               `From: <sip:${this.config.extension}@${this.config.serverAddress}>\r\n` +
               `To: <sip:${this.config.extension}@${this.config.serverAddress}>\r\n` +
               `Call-ID: ${this.callId}\r\n` +
               `CSeq: ${this.cseq++} REGISTER\r\n` +
               `Contact: <sip:${this.config.extension}@${this.config.clientAddress}:${this.config.clientPort}>\r\n` +
               `Expires: ${expires}\r\n` +
               `Content-Length: 0\r\n` +
               `\r\n`;
    }

    // Звонок на другой номер
    call(targetNumber) {
        if (!this.registered) {
            console.error('Клиент не зарегистрирован');
            return;
        }

        const callId = this.generateCallId();
        const sdp = this.createSdp();
        
        const message = this.createInviteMessage(targetNumber, callId, sdp);
        this.sendMessage(message);
        
        this.activeCall = {
            callId,
            targetNumber,
            state: 'INITIATED'
        };
        
        console.log(`Звонок инициирован на номер ${targetNumber}`);
    }

    // Создание INVITE сообщения
    createInviteMessage(targetNumber, callId, sdp) {
        return `INVITE sip:${targetNumber}@${this.config.serverAddress}:${this.config.serverPort} SIP/2.0\r\n` +
               `Via: SIP/2.0/UDP ${this.config.clientAddress}:${this.config.clientPort}\r\n` +
               `From: <sip:${this.config.extension}@${this.config.serverAddress}>\r\n` +
               `To: <sip:${targetNumber}@${this.config.serverAddress}>\r\n` +
               `Call-ID: ${callId}\r\n` +
               `CSeq: ${this.cseq++} INVITE\r\n` +
               `Contact: <sip:${this.config.extension}@${this.config.clientAddress}:${this.config.clientPort}>\r\n` +
               `Content-Type: application/sdp\r\n` +
               `Content-Length: ${sdp.length}\r\n` +
               `\r\n` +
               `${sdp}`;
    }

    // Создание SDP
    createSdp() {
        const sessionId = Math.floor(Math.random() * 1000000);
        const rtpPort = this.config.rtpPort || 10002;
        
        return `v=0\r\n` +
               `o=${this.config.extension} ${sessionId} ${sessionId} IN IP4 ${this.config.clientAddress}\r\n` +
               `s=SIP Call\r\n` +
               `c=IN IP4 ${this.config.clientAddress}\r\n` +
               `t=0 0\r\n` +
               `m=audio ${rtpPort} RTP/AVP 0 8 101\r\n` +
               `a=rtpmap:0 PCMU/8000\r\n` +
               `a=rtpmap:8 PCMA/8000\r\n` +
               `a=rtpmap:101 telephone-event/8000\r\n`;
    }

    // Завершение звонка
    hangup() {
        if (!this.activeCall) {
            console.error('Нет активного звонка');
            return;
        }

        const message = this.createByeMessage();
        this.sendMessage(message);
        
        console.log(`Звонок завершен`);
        this.activeCall = null;
    }

    // Создание BYE сообщения
    createByeMessage() {
        return `BYE sip:${this.activeCall.targetNumber}@${this.config.serverAddress}:${this.config.serverPort} SIP/2.0\r\n` +
               `Via: SIP/2.0/UDP ${this.config.clientAddress}:${this.config.clientPort}\r\n` +
               `From: <sip:${this.config.extension}@${this.config.serverAddress}>\r\n` +
               `To: <sip:${this.activeCall.targetNumber}@${this.config.serverAddress}>\r\n` +
               `Call-ID: ${this.activeCall.callId}\r\n` +
               `CSeq: ${this.cseq++} BYE\r\n` +
               `Content-Length: 0\r\n` +
               `\r\n`;
    }

    // Отправка сообщения
    sendMessage(message) {
        this.socket.send(message, this.config.serverPort, this.config.serverAddress, (error) => {
            if (error) {
                console.error('Ошибка отправки сообщения:', error);
            }
        });
    }

    // Обработка входящих SIP сообщений
    handleSipMessage(message, rinfo) {
        const messageStr = message.toString();
        const lines = messageStr.split('\r\n');
        const firstLine = lines[0];
        
        console.log(`\n=== Получено SIP сообщение ===`);
        console.log(`От: ${rinfo.address}:${rinfo.port}`);
        console.log(`Сообщение: ${firstLine}`);
        console.log(`=== Конец сообщения ===\n`);

        if (firstLine.startsWith('SIP/2.0')) {
            // Это ответ
            const statusCode = parseInt(firstLine.split(' ')[1]);
            
            if (statusCode === 200) {
                if (this.activeCall && this.activeCall.state === 'INITIATED') {
                    // Отправляем ACK
                    this.sendAck();
                    this.activeCall.state = 'ESTABLISHED';
                    console.log('Звонок установлен!');
                } else if (!this.activeCall) {
                    // Регистрация успешна
                    this.registered = true;
                    console.log('Регистрация успешна!');
                }
            } else if (statusCode === 100) {
                console.log('Получен 100 Trying');
            } else if (statusCode === 404) {
                console.log('Ошибка: абонент не найден');
            } else if (statusCode === 486) {
                console.log('Ошибка: абонент занят');
            }
        } else if (firstLine.startsWith('INVITE')) {
            // Входящий звонок
            this.handleIncomingCall(messageStr);
        } else if (firstLine.startsWith('BYE')) {
            // Завершение звонка
            this.handleIncomingBye(messageStr);
        }
    }

    // Обработка входящего звонка
    handleIncomingCall(message) {
        console.log('Входящий звонок!');
        
        // Автоматически отвечаем 200 OK
        const response = this.createOkResponse(message);
        this.sendMessage(response);
        
        // Отправляем ACK
        setTimeout(() => {
            this.sendAck();
        }, 100);
    }

    // Обработка входящего BYE
    handleIncomingBye(message) {
        console.log('Звонок завершен другой стороной');
        
        const response = this.createOkResponse(message);
        this.sendMessage(response);
        
        this.activeCall = null;
    }

    // Создание 200 OK ответа
    createOkResponse(originalMessage) {
        const lines = originalMessage.split('\r\n');
        const requestLine = lines[0];
        const method = requestLine.split(' ')[0];
        
        let response = `SIP/2.0 200 OK\r\n`;
        
        // Копируем заголовки
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i];
            if (line === '') break;
            
            if (line.startsWith('Via:') || line.startsWith('From:') || 
                line.startsWith('To:') || line.startsWith('Call-ID:') || 
                line.startsWith('CSeq:')) {
                response += line + '\r\n';
            }
        }
        
        if (method === 'INVITE') {
            // Добавляем SDP для INVITE
            const sdp = this.createSdp();
            response += `Content-Type: application/sdp\r\n`;
            response += `Content-Length: ${sdp.length}\r\n`;
            response += `\r\n`;
            response += sdp;
        } else {
            response += `Content-Length: 0\r\n`;
            response += `\r\n`;
        }
        
        return response;
    }

    // Отправка ACK
    sendAck() {
        if (!this.activeCall) return;
        
        const message = `ACK sip:${this.activeCall.targetNumber}@${this.config.serverAddress}:${this.config.serverPort} SIP/2.0\r\n` +
                       `Via: SIP/2.0/UDP ${this.config.clientAddress}:${this.config.clientPort}\r\n` +
                       `From: <sip:${this.config.extension}@${this.config.serverAddress}>\r\n` +
                       `To: <sip:${this.activeCall.targetNumber}@${this.config.serverAddress}>\r\n` +
                       `Call-ID: ${this.activeCall.callId}\r\n` +
                       `CSeq: ${this.cseq++} ACK\r\n` +
                       `Content-Length: 0\r\n` +
                       `\r\n`;
        
        this.sendMessage(message);
    }

    // Запуск клиента
    start() {
        this.socket.bind(this.config.clientPort, this.config.clientAddress, () => {
            console.log(`SIP клиент запущен на ${this.config.clientAddress}:${this.config.clientPort}`);
            console.log(`Номер: ${this.config.extension}`);
            console.log(`Сервер: ${this.config.serverAddress}:${this.config.serverPort}`);
            
            // Автоматически регистрируемся
            this.register();
        });
    }

    // Остановка клиента
    stop() {
        this.socket.close();
        console.log('SIP клиент остановлен');
    }
}

module.exports = SipClient; 
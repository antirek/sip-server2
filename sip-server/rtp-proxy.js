const dgram = require('dgram');
const { rtpLogger } = require('./logger');

class RtpProxy {
    constructor(config) {
        this.config = config;
        this.rtpServer = dgram.createSocket('udp4');
        this.activeStreams = new Map(); // Call-ID -> { fromPort, toPort, fromAddress, toAddress }
        this.serverPort = config.rtp.port;
        this.serverAddress = config.sip.serverAddress;
    }

    // Запуск RTP сервера
    start() {
        this.rtpServer.bind(this.serverPort, this.config.rtp.host, () => {
            rtpLogger.info(`RTP proxy started`, {
                port: this.serverPort,
                host: this.config.rtp.host
            });
        });

        this.rtpServer.on('message', (message, rinfo) => {
            this.handleRtpPacket(message, rinfo);
        });

        this.rtpServer.on('error', (error) => {
            rtpLogger.error(`RTP server error`, { error: error.message });
        });
    }

    // Обработка RTP пакетов
    handleRtpPacket(message, rinfo) {
        // Ищем активный поток для этого адреса/порта
        for (const [callId, stream] of this.activeStreams) {
            if (rinfo.address === stream.fromAddress && rinfo.port === stream.fromPort) {
                // Пересылаем RTP пакет к целевому абоненту
                this.rtpServer.send(message, stream.toPort, stream.toAddress);
                rtpLogger.debug(`RTP packet forwarded`, {
                    from: `${rinfo.address}:${rinfo.port}`,
                    to: `${stream.toAddress}:${stream.toPort}`,
                    callId
                });
                return;
            } else if (rinfo.address === stream.toAddress && rinfo.port === stream.toPort) {
                // Пересылаем RTP пакет к вызывающему абоненту
                this.rtpServer.send(message, stream.fromPort, stream.fromAddress);
                rtpLogger.debug(`RTP packet forwarded`, {
                    from: `${rinfo.address}:${rinfo.port}`,
                    to: `${stream.fromAddress}:${stream.fromPort}`,
                    callId
                });
                return;
            }
        }

        // Если поток не найден, логируем как предупреждение
        rtpLogger.warn(`RTP packet received for unknown stream`, {
            address: rinfo.address,
            port: rinfo.port,
            packetSize: message.length
        });
    }

    // Добавление активного потока
    addStream(callId, fromAddress, fromPort, toAddress, toPort) {
        this.activeStreams.set(callId, {
            fromAddress,
            fromPort,
            toAddress,
            toPort
        });
        rtpLogger.info(`RTP stream added`, {
            callId,
            fromAddress,
            fromPort,
            toAddress,
            toPort
        });
        
        // Добавляем обратный поток для двусторонней связи
        this.activeStreams.set(callId + '_reverse', {
            fromAddress: toAddress,
            fromPort: toPort,
            toAddress: fromAddress,
            toPort: fromPort
        });
        rtpLogger.info(`Reverse RTP stream added`, {
            callId: callId + '_reverse',
            fromAddress: toAddress,
            fromPort: toPort,
            toAddress: fromAddress,
            toPort: fromPort
        });
    }

    // Удаление активного потока
    removeStream(callId) {
        if (this.activeStreams.has(callId)) {
            this.activeStreams.delete(callId);
            rtpLogger.info(`RTP stream removed`, { callId });
        }
        if (this.activeStreams.has(callId + '_reverse')) {
            this.activeStreams.delete(callId + '_reverse');
            rtpLogger.info(`Reverse RTP stream removed`, { callId: callId + '_reverse' });
        }
    }

    // Модификация SDP для направления RTP через сервер
    modifySdp(sdp, callId) {
        const serverAddress = this.serverAddress;
        const serverPort = this.serverPort;
        
        rtpLogger.debug(`SDP modification started`, {
            callId,
            originalSdpLength: sdp.length
        });
        
        // Заменяем IP адрес и порт в SDP
        // Важно: заменяем ВСЕ вхождения IP адреса в SDP
        let modifiedSdp = sdp.replace(/c=IN IP4 [^\r\n]+/g, `c=IN IP4 ${serverAddress}`);
        modifiedSdp = modifiedSdp.replace(/o=[^\s]+ [^\s]+ [^\s]+ IN IP4 [^\r\n]+/g, (match) => {
            return match.replace(/IN IP4 [^\r\n]+/, `IN IP4 ${serverAddress}`);
        });
        modifiedSdp = modifiedSdp.replace(/m=audio [0-9]+/g, `m=audio ${serverPort}`);
        
        rtpLogger.info(`SDP modified`, {
            callId,
            serverAddress,
            serverPort,
            originalLength: sdp.length,
            modifiedLength: modifiedSdp.length
        });
        
        return modifiedSdp;
    }

    // Получение информации о потоках
    getStreams() {
        return Array.from(this.activeStreams.entries()).map(([callId, stream]) => ({
            callId,
            fromAddress: stream.fromAddress,
            fromPort: stream.fromPort,
            toAddress: stream.toAddress,
            toPort: stream.toPort
        }));
    }

    // Остановка RTP сервера
    stop() {
        this.rtpServer.close();
        rtpLogger.info(`RTP proxy stopped`);
    }
}

module.exports = RtpProxy; 
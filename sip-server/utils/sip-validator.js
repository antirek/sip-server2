const { sipLogger } = require('../logger');

class SipValidator {
    constructor(config) {
        this.config = config;
    }

    // Извлечение URI из заголовка (убирает отображаемое имя)
    extractUri(header) {
        if (!header || typeof header !== 'string') {
            return null;
        }
        
        // Ищем URI в угловых скобках <sip:...>
        const bracketMatch = header.match(/<([^>]+)>/);
        if (bracketMatch) {
            return bracketMatch[1];
        }
        
        // Если нет скобок, считаем что весь заголовок - это URI
        return header.trim();
    }

    // Валидация SIP URI
    validateSipUri(uri) {
        if (!uri || typeof uri !== 'string') {
            return { valid: false, error: 'URI is required and must be a string' };
        }

        // Проверяем формат sip:number@domain с возможными параметрами
        const sipUriPattern = /^sip:(\d+)@([^:]+)(?::(\d+))?(?:;[^;]*)*$/;
        const match = uri.match(sipUriPattern);
        
        if (!match) {
            return { valid: false, error: 'Invalid SIP URI format' };
        }

        const number = match[1];
        const domain = match[2];
        const port = match[3];

        // Проверяем номер
        if (!this.config.validExtensions.has(number)) {
            return { 
                valid: false, 
                error: `Invalid extension number: ${number}. Valid range: ${this.config.extensions.min}-${this.config.extensions.max}` 
            };
        }

        return { 
            valid: true, 
            number, 
            domain, 
            port: port || '5060' 
        };
    }

    // Валидация SIP заголовков
    validateHeaders(headers, requiredHeaders = []) {
        const errors = [];
        const missingHeaders = [];

        // Проверяем обязательные заголовки
        for (const header of requiredHeaders) {
            if (!headers[header]) {
                missingHeaders.push(header);
            }
        }

        if (missingHeaders.length > 0) {
            errors.push(`Missing required headers: ${missingHeaders.join(', ')}`);
        }

        // Валидация Call-ID
        if (headers['Call-ID']) {
            const callIdPattern = /^[a-zA-Z0-9._-]+(?:@[a-zA-Z0-9._-]+)?(?:-[a-zA-Z0-9._-]+)?$/;
            if (!callIdPattern.test(headers['Call-ID'])) {
                errors.push('Invalid Call-ID format');
            }
        }

        // Валидация CSeq
        if (headers['CSeq']) {
            const cseqPattern = /^\d+\s+[A-Z]+$/;
            if (!cseqPattern.test(headers['CSeq'])) {
                errors.push('Invalid CSeq format');
            }
        }

        // Валидация Via
        if (headers['Via']) {
            const viaPattern = /^SIP\/2\.0\/UDP\s+[^:]+:\d+(?:;[^;]*)*$/;
            if (!viaPattern.test(headers['Via'])) {
                errors.push('Invalid Via header format');
            }
        }

        return {
            valid: errors.length === 0,
            errors
        };
    }

    // Валидация SDP
    validateSdp(sdp) {
        if (!sdp || typeof sdp !== 'string') {
            return { valid: false, error: 'SDP is required and must be a string' };
        }

        const errors = [];
        const lines = sdp.split('\r\n');

        // Проверяем обязательные секции SDP
        const requiredSections = ['v=', 'o=', 's=', 'c=', 't=', 'm='];
        const foundSections = new Set();

        for (const line of lines) {
            if (line.startsWith('v=')) foundSections.add('v=');
            if (line.startsWith('o=')) foundSections.add('o=');
            if (line.startsWith('s=')) foundSections.add('s=');
            if (line.startsWith('c=')) foundSections.add('c=');
            if (line.startsWith('t=')) foundSections.add('t=');
            if (line.startsWith('m=')) foundSections.add('m=');
        }

        for (const section of requiredSections) {
            if (!foundSections.has(section)) {
                errors.push(`Missing required SDP section: ${section}`);
            }
        }

        // Проверяем медиа секцию
        const mediaLine = lines.find(line => line.startsWith('m='));
        if (mediaLine) {
            const mediaParts = mediaLine.split(' ');
            if (mediaParts.length < 4) {
                errors.push('Invalid media line format');
            } else {
                const mediaType = mediaParts[0].substring(2);
                const port = parseInt(mediaParts[1]);
                
                if (mediaType !== 'audio') {
                    errors.push('Only audio media type is supported');
                }
                
                if (isNaN(port) || port < 1024 || port > 65535) {
                    errors.push('Invalid RTP port number');
                }
            }
        }

        return {
            valid: errors.length === 0,
            errors
        };
    }

    // Валидация REGISTER запроса
    validateRegisterRequest(parsedMessage) {
        const requiredHeaders = ['To', 'From', 'Call-ID', 'CSeq', 'Contact'];
        const headerValidation = this.validateHeaders(parsedMessage.headers, requiredHeaders);
        
        if (!headerValidation.valid) {
            return headerValidation;
        }

        // Валидация To заголовка
        const toUri = this.extractUri(parsedMessage.headers['To']);
        if (!toUri) {
            return { valid: false, error: 'Invalid To header format' };
        }
        const toValidation = this.validateSipUri(toUri);
        if (!toValidation.valid) {
            return toValidation;
        }

        // Валидация From заголовка
        const fromUri = this.extractUri(parsedMessage.headers['From']);
        if (!fromUri) {
            return { valid: false, error: 'Invalid From header format' };
        }
        const fromValidation = this.validateSipUri(fromUri);
        if (!fromValidation.valid) {
            return fromValidation;
        }

        // Проверяем, что To и From номера совпадают
        if (toValidation.number !== fromValidation.number) {
            return { 
                valid: false, 
                error: 'To and From numbers must match in REGISTER request' 
            };
        }

        // Валидация Expires заголовка
        const expires = parsedMessage.headers['Expires'];
        if (expires) {
            const expiresNum = parseInt(expires);
            if (isNaN(expiresNum) || expiresNum < 0 || expiresNum > 86400) {
                return { 
                    valid: false, 
                    error: 'Expires must be a number between 0 and 86400' 
                };
            }
        }

        return { valid: true };
    }

    // Валидация INVITE запроса
    validateInviteRequest(parsedMessage) {
        const requiredHeaders = ['To', 'From', 'Call-ID', 'CSeq', 'Contact'];
        const headerValidation = this.validateHeaders(parsedMessage.headers, requiredHeaders);
        
        if (!headerValidation.valid) {
            return headerValidation;
        }

        // Валидация To заголовка
        const toUri = this.extractUri(parsedMessage.headers['To']);
        if (!toUri) {
            return { valid: false, error: 'Invalid To header format' };
        }
        const toValidation = this.validateSipUri(toUri);
        if (!toValidation.valid) {
            return toValidation;
        }

        // Валидация From заголовка
        const fromUri = this.extractUri(parsedMessage.headers['From']);
        if (!fromUri) {
            return { valid: false, error: 'Invalid From header format' };
        }
        const fromValidation = this.validateSipUri(fromUri);
        if (!fromValidation.valid) {
            return fromValidation;
        }

        // Проверяем, что To и From номера разные
        if (toValidation.number === fromValidation.number) {
            return { 
                valid: false, 
                error: 'Cannot call yourself' 
            };
        }

        // Валидация SDP если присутствует
        if (parsedMessage.body && parsedMessage.headers['Content-Type']?.includes('application/sdp')) {
            const sdpValidation = this.validateSdp(parsedMessage.body);
            if (!sdpValidation.valid) {
                return sdpValidation;
            }
        }

        return { valid: true };
    }

    // Валидация BYE запроса
    validateByeRequest(parsedMessage) {
        const requiredHeaders = ['To', 'From', 'Call-ID', 'CSeq'];
        const headerValidation = this.validateHeaders(parsedMessage.headers, requiredHeaders);
        
        if (!headerValidation.valid) {
            return headerValidation;
        }

        // Валидация To заголовка
        const toValidation = this.validateSipUri(parsedMessage.headers['To']);
        if (!toValidation.valid) {
            return toValidation;
        }

        // Валидация From заголовка
        const fromValidation = this.validateSipUri(parsedMessage.headers['From']);
        if (!fromValidation.valid) {
            return fromValidation;
        }

        return { valid: true };
    }

    // Логирование ошибок валидации
    logValidationError(operation, errors, message) {
        sipLogger.error(`SIP validation failed for ${operation}`, {
            errors,
            message: message?.substring(0, 200) + (message?.length > 200 ? '...' : ''),
            timestamp: new Date().toISOString()
        });
    }
}

module.exports = SipValidator; 
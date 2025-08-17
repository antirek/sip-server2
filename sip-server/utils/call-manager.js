const { sipLogger } = require('../logger');

class CallManager {
    constructor(config) {
        this.config = config;
        this.activeCalls = new Map();
        this.callHistory = [];
        this.maxHistorySize = 1000;
        
        // Запускаем периодическую очистку
        this.startCleanupTimer();
    }

    // Создание нового звонка
    createCall(callId, fromNumber, toNumber, fromAddress, fromPort, sdp = null) {
        const callData = {
            callId,
            fromNumber,
            toNumber,
            fromAddress,
            fromPort,
            toAddress: null,
            toPort: null,
            fromRtpPort: null,
            toRtpPort: null,
            sdp,
            state: 'INITIATED',
            inviteTime: new Date(),
            answerTime: null,
            endTime: null,
            duration: 0,
            terminating: false,
            originalVia: null,
            originalFrom: null,
            originalTo: null,
            originalCSeq: null,
            retryCount: 0,
            maxRetries: 3
        };

        this.activeCalls.set(callId, callData);
        sipLogger.info(`Call created`, {
            callId,
            fromNumber,
            toNumber,
            state: callData.state
        });

        return callData;
    }

    // Получение звонка по ID
    getCall(callId) {
        return this.activeCalls.get(callId);
    }

    // Обновление состояния звонка
    updateCallState(callId, state, additionalData = {}) {
        const call = this.activeCalls.get(callId);
        if (!call) {
            sipLogger.warn(`Attempted to update non-existent call`, { callId, state });
            return false;
        }

        const oldState = call.state;
        call.state = state;
        Object.assign(call, additionalData);

        sipLogger.info(`Call state updated`, {
            callId,
            fromNumber: call.fromNumber,
            toNumber: call.toNumber,
            oldState,
            newState: state,
            additionalData
        });

        return true;
    }

    // Установка целевого абонента
    setTarget(callId, toAddress, toPort) {
        const call = this.activeCalls.get(callId);
        if (!call) {
            return false;
        }

        call.toAddress = toAddress;
        call.toPort = toPort;
        call.state = 'RINGING';

        sipLogger.info(`Call target set`, {
            callId,
            toAddress,
            toPort,
            state: call.state
        });

        return true;
    }

    // Установка RTP портов
    setRtpPorts(callId, fromRtpPort, toRtpPort) {
        const call = this.activeCalls.get(callId);
        if (!call) {
            return false;
        }

        call.fromRtpPort = fromRtpPort;
        call.toRtpPort = toRtpPort;

        sipLogger.info(`RTP ports set`, {
            callId,
            fromRtpPort,
            toRtpPort
        });

        return true;
    }

    // Ответ на звонок
    answerCall(callId) {
        const call = this.activeCalls.get(callId);
        if (!call) {
            return false;
        }

        call.state = 'ESTABLISHED';
        call.answerTime = new Date();

        sipLogger.info(`Call answered`, {
            callId,
            fromNumber: call.fromNumber,
            toNumber: call.toNumber,
            answerTime: call.answerTime
        });

        return true;
    }

    // Завершение звонка
    endCall(callId, reason = 'NORMAL') {
        const call = this.activeCalls.get(callId);
        if (!call) {
            return false;
        }

        call.state = 'TERMINATED';
        call.endTime = new Date();
        call.terminating = true;
        call.terminationReason = reason;

        if (call.answerTime) {
            call.duration = Math.floor((call.endTime - call.answerTime) / 1000);
        }

        // Добавляем в историю
        this.addToHistory(call);

        // Удаляем из активных звонков
        this.activeCalls.delete(callId);

        sipLogger.info(`Call ended`, {
            callId,
            fromNumber: call.fromNumber,
            toNumber: call.toNumber,
            duration: call.duration,
            reason
        });

        return call;
    }

    // Добавление в историю звонков
    addToHistory(call) {
        this.callHistory.push({
            ...call,
            id: Date.now() + Math.random()
        });

        // Ограничиваем размер истории
        if (this.callHistory.length > this.maxHistorySize) {
            this.callHistory = this.callHistory.slice(-this.maxHistorySize);
        }
    }

    // Получение всех активных звонков
    getActiveCalls() {
        return Array.from(this.activeCalls.entries()).map(([callId, call]) => ({
            callId,
            fromNumber: call.fromNumber,
            toNumber: call.toNumber,
            state: call.state,
            inviteTime: call.inviteTime,
            answerTime: call.answerTime,
            duration: call.duration,
            fromAddress: call.fromAddress,
            toAddress: call.toAddress
        }));
    }

    // Получение истории звонков
    getCallHistory(limit = 50, offset = 0) {
        return this.callHistory
            .slice(offset, offset + limit)
            .map(call => ({
                callId: call.callId,
                fromNumber: call.fromNumber,
                toNumber: call.toNumber,
                state: call.state,
                inviteTime: call.inviteTime,
                answerTime: call.answerTime,
                endTime: call.endTime,
                duration: call.duration,
                terminationReason: call.terminationReason
            }));
    }

    // Получение статистики
    getStatistics() {
        const now = new Date();
        const activeCalls = this.activeCalls.size;
        const totalCalls = this.callHistory.length + activeCalls;
        
        // Статистика по состояниям
        const stateStats = {};
        for (const call of this.activeCalls.values()) {
            stateStats[call.state] = (stateStats[call.state] || 0) + 1;
        }

        // Статистика по длительности
        const completedCalls = this.callHistory.filter(call => call.duration > 0);
        const avgDuration = completedCalls.length > 0 
            ? completedCalls.reduce((sum, call) => sum + call.duration, 0) / completedCalls.length 
            : 0;

        return {
            activeCalls,
            totalCalls,
            stateStats,
            averageDuration: Math.round(avgDuration),
            completedCalls: completedCalls.length,
            serverUptime: process.uptime()
        };
    }

    // Очистка устаревших звонков
    cleanup() {
        const now = new Date();
        const timeout = this.config.timeouts.callSetup;
        const callsToRemove = [];

        for (const [callId, call] of this.activeCalls.entries()) {
            const timeSinceInvite = now - call.inviteTime;
            
            // Удаляем звонки, которые не установились в течение таймаута
            if (timeSinceInvite > timeout && call.state === 'INITIATED') {
                callsToRemove.push(callId);
                sipLogger.warn(`Call timeout - removing stale call`, {
                    callId,
                    fromNumber: call.fromNumber,
                    toNumber: call.toNumber,
                    timeSinceInvite: Math.floor(timeSinceInvite / 1000)
                });
            }
        }

        for (const callId of callsToRemove) {
            this.endCall(callId, 'TIMEOUT');
        }

        if (callsToRemove.length > 0) {
            sipLogger.info(`Cleaned up ${callsToRemove.length} stale calls`);
        }
    }

    // Запуск таймера очистки
    startCleanupTimer() {
        setInterval(() => {
            this.cleanup();
        }, this.config.timeouts.cleanup);
    }

    // Получение звонков по номеру
    getCallsByNumber(number) {
        const calls = [];
        
        for (const [callId, call] of this.activeCalls.entries()) {
            if (call.fromNumber === number || call.toNumber === number) {
                calls.push({
                    callId,
                    fromNumber: call.fromNumber,
                    toNumber: call.toNumber,
                    state: call.state,
                    inviteTime: call.inviteTime,
                    answerTime: call.answerTime,
                    duration: call.duration
                });
            }
        }

        return calls;
    }

    // Проверка, занят ли номер
    isNumberBusy(number) {
        for (const call of this.activeCalls.values()) {
            if ((call.fromNumber === number || call.toNumber === number) && 
                (call.state === 'RINGING' || call.state === 'ESTABLISHED')) {
                return true;
            }
        }
        return false;
    }

    // Удаление всех звонков (для тестирования)
    clearAllCalls() {
        const count = this.activeCalls.size;
        this.activeCalls.clear();
        this.callHistory = [];
        sipLogger.info(`All calls cleared`, { count });
    }
}

module.exports = CallManager; 
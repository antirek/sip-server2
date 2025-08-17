const { sipLogger } = require('../logger');

class UserManager {
    constructor(config) {
        this.config = config;
        this.registeredUsers = new Map();
        this.registrationHistory = [];
        this.maxHistorySize = 1000;
        
        // Запускаем периодическую очистку
        this.startCleanupTimer();
    }

    // Регистрация пользователя
    registerUser(number, uri, address, port, expires = 3600) {
        const now = new Date();
        const expiresAt = new Date(now.getTime() + expires * 1000);

        const userData = {
            number,
            uri,
            address,
            port,
            expires,
            expiresAt,
            registeredAt: now,
            lastSeen: now,
            status: 'REGISTERED',
            registrationCount: 1
        };

        // Проверяем, был ли пользователь уже зарегистрирован
        const existingUser = this.registeredUsers.get(number);
        if (existingUser) {
            userData.registrationCount = existingUser.registrationCount + 1;
            userData.registeredAt = existingUser.registeredAt; // Сохраняем первоначальную дату регистрации
        }

        this.registeredUsers.set(number, userData);

        // Добавляем в историю
        this.addToHistory({
            action: 'REGISTER',
            number,
            address,
            port,
            expires,
            timestamp: now
        });

        sipLogger.info(`User registered`, {
            number,
            address,
            port,
            expires,
            expiresAt,
            registrationCount: userData.registrationCount
        });

        return userData;
    }

    // Отмена регистрации пользователя
    unregisterUser(number) {
        const user = this.registeredUsers.get(number);
        if (!user) {
            sipLogger.warn(`Attempted to unregister non-existent user`, { number });
            return false;
        }

        this.registeredUsers.delete(number);

        // Добавляем в историю
        this.addToHistory({
            action: 'UNREGISTER',
            number,
            address: user.address,
            port: user.port,
            timestamp: new Date()
        });

        sipLogger.info(`User unregistered`, {
            number,
            address: user.address,
            port: user.port
        });

        return true;
    }

    // Получение пользователя по номеру
    getUser(number) {
        return this.registeredUsers.get(number);
    }

    // Проверка, зарегистрирован ли пользователь
    isUserRegistered(number) {
        const user = this.registeredUsers.get(number);
        if (!user) {
            return false;
        }

        // Проверяем, не истекла ли регистрация
        if (new Date() > user.expiresAt) {
            sipLogger.warn(`User registration expired`, {
                number,
                expiresAt: user.expiresAt
            });
            this.registeredUsers.delete(number);
            return false;
        }

        return true;
    }

    // Обновление времени последней активности
    updateLastSeen(number) {
        const user = this.registeredUsers.get(number);
        if (user) {
            user.lastSeen = new Date();
        }
    }

    // Получение всех зарегистрированных пользователей
    getAllUsers() {
        const users = [];
        const now = new Date();

        for (const [number, user] of this.registeredUsers.entries()) {
            // Проверяем, не истекла ли регистрация
            if (now > user.expiresAt) {
                this.registeredUsers.delete(number);
                continue;
            }

            users.push({
                number,
                uri: user.uri,
                address: user.address,
                port: user.port,
                expires: user.expires,
                expiresAt: user.expiresAt,
                registeredAt: user.registeredAt,
                lastSeen: user.lastSeen,
                status: user.status,
                registrationCount: user.registrationCount
            });
        }

        return users;
    }

    // Получение статистики пользователей
    getUserStatistics() {
        const now = new Date();
        const totalUsers = this.registeredUsers.size;
        const activeUsers = Array.from(this.registeredUsers.values())
            .filter(user => now <= user.expiresAt).length;

        // Статистика по адресам
        const addressStats = {};
        for (const user of this.registeredUsers.values()) {
            addressStats[user.address] = (addressStats[user.address] || 0) + 1;
        }

        // Статистика по времени регистрации
        const recentRegistrations = Array.from(this.registeredUsers.values())
            .filter(user => {
                const timeSinceRegistration = now - user.registeredAt;
                return timeSinceRegistration < 24 * 60 * 60 * 1000; // Последние 24 часа
            }).length;

        return {
            totalUsers,
            activeUsers,
            addressStats,
            recentRegistrations,
            registrationHistory: this.registrationHistory.length
        };
    }

    // Очистка истекших регистраций
    cleanup() {
        const now = new Date();
        const expiredUsers = [];

        for (const [number, user] of this.registeredUsers.entries()) {
            if (now > user.expiresAt) {
                expiredUsers.push(number);
                sipLogger.warn(`User registration expired during cleanup`, {
                    number,
                    address: user.address,
                    expiresAt: user.expiresAt
                });
            }
        }

        for (const number of expiredUsers) {
            this.registeredUsers.delete(number);
        }

        if (expiredUsers.length > 0) {
            sipLogger.info(`Cleaned up ${expiredUsers.length} expired registrations`);
        }
    }

    // Запуск таймера очистки
    startCleanupTimer() {
        setInterval(() => {
            this.cleanup();
        }, this.config.timeouts.cleanup);
    }

    // Добавление в историю регистраций
    addToHistory(entry) {
        this.registrationHistory.push(entry);

        // Ограничиваем размер истории
        if (this.registrationHistory.length > this.maxHistorySize) {
            this.registrationHistory = this.registrationHistory.slice(-this.maxHistorySize);
        }
    }

    // Получение истории регистраций
    getRegistrationHistory(limit = 50, offset = 0) {
        return this.registrationHistory
            .slice(offset, offset + limit)
            .map(entry => ({
                action: entry.action,
                number: entry.number,
                address: entry.address,
                port: entry.port,
                expires: entry.expires,
                timestamp: entry.timestamp
            }));
    }

    // Поиск пользователей по адресу
    getUsersByAddress(address) {
        const users = [];
        
        for (const [number, user] of this.registeredUsers.entries()) {
            if (user.address === address) {
                users.push({
                    number,
                    uri: user.uri,
                    port: user.port,
                    expiresAt: user.expiresAt,
                    lastSeen: user.lastSeen
                });
            }
        }

        return users;
    }

    // Получение пользователей, которые скоро истекают
    getExpiringUsers(withinMinutes = 30) {
        const now = new Date();
        const threshold = new Date(now.getTime() + withinMinutes * 60 * 1000);
        const expiringUsers = [];

        for (const [number, user] of this.registeredUsers.entries()) {
            if (user.expiresAt <= threshold && user.expiresAt > now) {
                expiringUsers.push({
                    number,
                    address: user.address,
                    expiresAt: user.expiresAt,
                    minutesUntilExpiry: Math.floor((user.expiresAt - now) / (60 * 1000))
                });
            }
        }

        return expiringUsers;
    }

    // Принудительное удаление всех пользователей (для тестирования)
    clearAllUsers() {
        const count = this.registeredUsers.size;
        this.registeredUsers.clear();
        this.registrationHistory = [];
        sipLogger.info(`All users cleared`, { count });
    }

    // Получение пользователей по диапазону номеров
    getUsersByNumberRange(start, end) {
        const users = [];
        
        for (const [number, user] of this.registeredUsers.entries()) {
            const num = parseInt(number);
            if (num >= start && num <= end) {
                users.push({
                    number,
                    uri: user.uri,
                    address: user.address,
                    port: user.port,
                    expiresAt: user.expiresAt,
                    lastSeen: user.lastSeen
                });
            }
        }

        return users;
    }
}

module.exports = UserManager; 
const SipClient = require('./index');

// Конфигурация для тестирования
const config = {
    extension: '100',                    // Номер абонента
    serverAddress: '192.168.0.42',       // IP адрес SIP сервера
    serverPort: 5060,                    // Порт SIP сервера
    clientAddress: '192.168.0.100',      // IP адрес клиента
    clientPort: 5061,                    // Порт клиента
    rtpPort: 10002,                      // RTP порт клиента
    expires: 3600                        // Время жизни регистрации
};

// Создаем клиент
const client = new SipClient(config);

// Запускаем клиент
client.start();

// Функция для тестирования звонков
function testCall(targetNumber) {
    setTimeout(() => {
        console.log(`\n=== Тестирование звонка на ${targetNumber} ===`);
        client.call(targetNumber);
    }, 2000);
}

// Функция для завершения звонка
function testHangup() {
    setTimeout(() => {
        console.log(`\n=== Завершение звонка ===`);
        client.hangup();
    }, 10000);
}

// Примеры использования
console.log('SIP Client Test Script');
console.log('=====================');
console.log('Доступные команды:');
console.log('- client.call("101") - позвонить на номер 101');
console.log('- client.hangup() - завершить звонок');
console.log('- client.stop() - остановить клиент');

// Автоматический тест (раскомментируйте для автоматического тестирования)
/*
setTimeout(() => {
    testCall('101');
    testHangup();
}, 5000);
*/

// Обработка завершения работы
process.on('SIGINT', () => {
    console.log('\nЗавершение работы клиента...');
    client.stop();
    process.exit(0);
});

// Экспортируем клиент для интерактивного использования
global.client = client; 
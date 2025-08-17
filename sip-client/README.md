# SIP Client

Простой SIP клиент для тестирования SIP сервера.

## Возможности

- ✅ Регистрация на SIP сервере
- ✅ Исходящие звонки
- ✅ Входящие звонки (автоответ)
- ✅ Завершение звонков
- ✅ Поддержка SDP
- ✅ Автоматическая обработка SIP сообщений

## Установка

```bash
npm install
```

## Конфигурация

Отредактируйте конфигурацию в файле `test-client.js`:

```javascript
const config = {
    extension: '100',                    // Номер абонента
    serverAddress: '192.168.0.42',       // IP адрес SIP сервера
    serverPort: 5060,                    // Порт SIP сервера
    clientAddress: '192.168.0.100',      // IP адрес клиента
    clientPort: 5061,                    // Порт клиента
    rtpPort: 10002,                      // RTP порт клиента
    expires: 3600                        // Время жизни регистрации
};
```

## Запуск

```bash
npm start
```

## Использование

После запуска клиент автоматически зарегистрируется на сервере. Доступные команды:

```javascript
// Позвонить на номер 101
client.call("101");

// Завершить активный звонок
client.hangup();

// Остановить клиент
client.stop();
```

## Тестирование

Для тестирования между двумя клиентами:

1. Запустите SIP сервер
2. Запустите первый клиент с номером 100
3. Запустите второй клиент с номером 101 (измените конфигурацию)
4. Выполните звонок между клиентами

### Пример конфигурации для второго клиента:

```javascript
const config = {
    extension: '101',
    serverAddress: '192.168.0.42',
    serverPort: 5060,
    clientAddress: '192.168.0.101',  // Другой IP
    clientPort: 5062,                // Другой порт
    rtpPort: 10004,                  // Другой RTP порт
    expires: 3600
};
```

## Логирование

Клиент выводит подробные логи в консоль:
- Регистрация на сервере
- Исходящие и входящие звонки
- SIP сообщения
- Ошибки и предупреждения

## Структура проекта

```
sip-client/
├── index.js          # Основной класс SIP клиента
├── test-client.js    # Тестовый скрипт
├── package.json      # Зависимости и скрипты
└── README.md         # Документация
```

## API

### SipClient

#### Конструктор
```javascript
const client = new SipClient(config);
```

#### Методы
- `start()` - запуск клиента
- `stop()` - остановка клиента
- `register()` - регистрация на сервере
- `call(targetNumber)` - звонок на номер
- `hangup()` - завершение звонка

## Примеры

### Базовое использование
```javascript
const SipClient = require('./index');

const config = {
    extension: '100',
    serverAddress: '192.168.0.42',
    serverPort: 5060,
    clientAddress: '192.168.0.100',
    clientPort: 5061,
    rtpPort: 10002
};

const client = new SipClient(config);
client.start();

// Позвонить через 5 секунд
setTimeout(() => {
    client.call('101');
}, 5000);
```

### Программное управление
```javascript
// Создание клиента
const client = new SipClient(config);

// Обработка событий
client.socket.on('message', (message, rinfo) => {
    console.log('Получено сообщение:', message.toString());
});

// Запуск
client.start();

// Звонок
client.call('101');

// Завершение через 10 секунд
setTimeout(() => {
    client.hangup();
    client.stop();
}, 10000);
``` 
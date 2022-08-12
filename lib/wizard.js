var readline = require("readline");
var botgram = require("botgram");
var fs = require("fs");
var util = require("util");
var utils = require("./utils");

// Wizard functions

function stepAuthToken(rl, config) {
    return question(rl, "Для начала, введите API токен вашего бота: ")
    .then(function (token) {
        token = token.trim();
        //if (!/^\d{5,}:[a-zA-Z0-9_+/-]{20,}$/.test(token))
        //    throw new Error();
        config.authToken = token;
        return createBot(token);
    }).catch(function (err) {
        console.error("Введен неверный токен. Повторите попытку.\n%s\n", err);
        return stepAuthToken(rl, config);
    });
}

function stepOwner(rl, config, getNextMessage) {
    console.log("Ожидание сообщения...");
    return getNextMessage().then(function (msg) {
        var prompt = util.format("Должен ли %s "%s" (%s) быть владельцем бота? [y/n]: ", msg.chat.type, msg.chat.name, msg.chat.id);
        return question(rl, prompt)
        .then(function (answer) {
            console.log();
            answer = answer.trim().toLowerCase();
            if (answer === "y" || answer === "yes" || answer === "да" || answer === "д")
                config.owner = msg.chat.id;
            else
                return stepOwner(rl, config, getNextMessage);
        });
    });
}

function configWizard(options) {
    var rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    var config = {};
    var bot = null;

    return Promise.resolve()
    .then(function () {
        return stepAuthToken(rl, config);
    })
    .then(function (bot_) {
        bot = bot_;
        console.log("\nТеперь поговорите со мной, чтобы я мог найти ваш аккаунт Telegram:\n%s\n", bot.link());
    })
    .then(function () {
        var getNextMessage = getPromiseFactory(bot);
        return stepOwner(rl, config, getNextMessage);
    })
    .then(function () {
        console.log("Все готово, записываю конфигурацию...");
        var contents = JSON.stringify(config, null, 4) + "\n";
        return writeFile(options.configFile, contents);
    })

    .catch(function (err) {
        console.error("Ошибка, мастер завершил работу со сбоем:\n%s", err.stack);
        process.exit(1);
    })
    .then(function () {
        rl.close();
        if (bot) bot.stop();
        process.exit(0);
    });
}

// Promise utilities

function question(interface, query) {
    return new Promise(function (resolve, reject) {
        interface.question(query, resolve);
    });
}

function writeFile(file, contents) {
    return new Promise(function (resolve, reject) {
        fs.writeFile(file, contents, "utf-8", function (err) {
            if (err) reject(err);
            else resolve();
        });
    });
}

function createBot(token) {
    return new Promise(function (resolve, reject) {
        var bot = botgram(token, { agent: utils.createAgent() });
        bot.on("error", function (err) {
            bot.stop();
            reject(err);
        });
        bot.on("ready", resolve.bind(this, bot));
    });
}

function getPromiseFactory(bot) {
    var resolveCbs = [];
    bot.message(function (msg, reply, next) {
        if (!msg.queued) {
            resolveCbs.forEach(function (resolve) {
                resolve(msg);
            });
            resolveCbs = [];
        }
        next();
    });
    return function () {
        return new Promise(function (resolve, reject) {
            resolveCbs.push(resolve);
        });
    };
}



exports.configWizard = configWizard;

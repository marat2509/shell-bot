#!/usr/bin/env node
// Starts the bot, handles permissions and chat context,
// interprets commands and delegates the actual command
// running to a Command instance. When started, an owner
// ID should be given.

var path = require("path");
var fs = require("fs");
var botgram = require("botgram");
var escapeHtml = require("escape-html");
var utils = require("./lib/utils");
var Command = require("./lib/command").Command;

var CONFIG_FILE = path.join(__dirname, "config.json");
try {
    var config = require(CONFIG_FILE);
} catch (e) {
    console.error("Failed to load configuration file. Starting setup wizard...\n");
    require("./lib/wizard").configWizard({ configFile: CONFIG_FILE });
    return;
}

var bot = botgram(config.authToken, { agent: utils.createAgent() });
var owner = config.owner;
var tokens = {};
var granted = {};
var contexts = {};
var defaultCwd = process.env.HOME || process.cwd();

var fileUploads = {};

bot.on("updateError", function (err) {
  console.error("Error while updating: ", err);
});

bot.on("synced", function () {
  console.log("Bot runned.");
});


function rootHook(msg, reply, next) {
  if (msg.queued) return;

  var id = msg.chat.id;
  var allowed = id === owner || granted[id];

  // If this message contains a token, check it
  if (!allowed && msg.command === "start" && Object.hasOwnProperty.call(tokens, msg.args())) {
    var token = tokens[msg.args()];
    delete tokens[msg.args()];
    granted[id] = true;
    allowed = true;

    // Notify owner
    // FIXME: reply to token message
    var contents = (msg.user ? "Пользователь" : "Чат") + " <em>" + escapeHtml(msg.chat.name) + "</em>";
    if (msg.chat.username) contents += " (@" + escapeHtml(msg.chat.username) + ")";
    contents += " теперь может использовать бота. что-бы запретить, используйте:";
    reply.to(owner).html(contents).command("revoke", id);
  }

  // If chat is not allowed, but user is, use its context
  if (!allowed && (msg.from.id === owner || granted[msg.from.id])) {
    id = msg.from.id;
    allowed = true;
  }

  // Check that the chat is allowed
  if (!allowed) {
    if (msg.command === "start") reply.html("Нет доступа.");
    return;
  }

  if (!contexts[id]) contexts[id] = {
    id: id,
    shell: utils.shells[0],
    env: utils.getSanitizedEnv(),
    cwd: defaultCwd,
    size: {columns: 40, rows: 20},
    silent: true,
    interactive: false,
    linkPreviews: false,
  };

  msg.context = contexts[id];
  next();
}
bot.all(rootHook);
bot.edited.all(rootHook);


// Replies
bot.message(function (msg, reply, next) {
  if (msg.reply === undefined || msg.reply.from.id !== this.get("id")) return next();
  if (msg.file)
    return handleDownload(msg, reply);
  if (msg.context.editor)
    return msg.context.editor.handleReply(msg);
  if (!msg.context.command)
    return reply.html("Нет запущенных команд.");
  msg.context.command.handleReply(msg);
});

// Edits
bot.edited.message(function (msg, reply, next) {
  if (msg.context.editor)
    return msg.context.editor.handleEdit(msg);
  next();
});

// Convenience command -- behaves as /run or /enter
// depending on whether a command is already running
bot.command("r", function (msg, reply, next) {
  // A little hackish, but it does show the power of
  // Botgram's fallthrough system!
  msg.command = msg.context.command ? "enter" : "run";
  next();
});

// Signal sending
bot.command("cancel", "kill", function (msg, reply, next) {
  var arg = msg.args(1)[0];
  if (!msg.context.command)
    return reply.html("Команды не запущены");

  var group = msg.command === "cancel";
  var signal = group ? "SIGINT" : "SIGTERM";
  if (arg) signal = arg.trim().toUpperCase();
  if (signal.substring(0,3) !== "SIG") signal = "SIG" + signal;
  try {
    msg.context.command.sendSignal(signal, group);
  } catch (err) {
    reply.reply(msg).html("Не удается отправить команду");
  }
});

// Input sending
bot.command("enter", "type", function (msg, reply, next) {
  var args = msg.args();
  if (!msg.context.command)
    return reply.html("Нет запущенных команд.");
  if (msg.command === "type" && !args) args = " ";
  msg.context.command.sendInput(args, msg.command === "type");
});
bot.command("ctrl", function (msg, reply, next) {
  var arg = msg.args(1)[0];
  if (!msg.context.command)
    return reply.html("Нет запущенных команд.");
  if (!arg || !/^[a-zA-Z]$/i.test(arg))
    return reply.html("Используйте /ctrl &lt;буква&gt; для отправки Ctrl+буква в процесс.");
  var code = arg.toUpperCase().charCodeAt(0) - 0x40;
  msg.context.command.sendInput(String.fromCharCode(code), true);
});
bot.command("alt", function (msg, reply, next) {
  var arg = msg.args(1)[0];
  if (!msg.context.command)
    return reply.html("Нет запущенных команд.");
  if (!arg)
    return msg.context.command.toggleMeta();
  msg.context.command.toggleMeta(true);
  msg.context.command.sendInput(arg, true);
});
bot.command("end", function (msg, reply, next) {
  if (!msg.context.command)
    return reply.html("Нет запущенных команд.");
  msg.context.command.sendEof();
});

// Redraw
bot.command("redraw", function (msg, reply, next) {
  if (!msg.context.command)
    return reply.html("Нет запущенных команд.");
  msg.context.command.redraw();
});

// Command start
bot.command("run", function (msg, reply, next) {
  var args = msg.args();
  if (!args)
    return reply.html("Используйте /run &lt;команда&gt; для выполнения чего-либо.");

  if (msg.context.command) {
    var command = msg.context.command;
    return reply.text("Команда уже запущена.");
  }

  if (msg.editor) msg.editor.detach();
  msg.editor = null;

  console.log('Chat/user "%s": runned command "%s"', msg.chat.name, args);
  msg.context.command = new Command(reply, msg.context, args);
  msg.context.command.on("exit", function() {
    msg.context.command = null;
  });
});

// Keypad
bot.command("keypad", function (msg, reply, next) {
  if (!msg.context.command)
    return reply.html("Нет запущенных команд.");
  try {
    msg.context.command.toggleKeypad();
  } catch (e) {
    reply.html("Не удается вызвать клавиатуру.");
  }
});

// File upload / download
bot.command("upload", function (msg, reply, next) {
  var args = msg.args();
  if (!args)
    return reply.html("Используйте /upload &lt;файл&gt; и бот отправит вам файл");

  var file = path.resolve(msg.context.cwd, args);
  try {
    var stream = fs.createReadStream(file);
  } catch (e) {
    return reply.html("Не удается открыть файл: %s", e.message);
  }

  // Catch errors but do nothing, they'll be propagated to the handler below
  stream.on("error", function (e) {});

  reply.action("upload_document").document(stream).then(function (e, msg) {
    if (e)
      return reply.html("Не удается отправить файл: %s", e.message);
    fileUploads[msg.id] = file;
  });
});
function handleDownload(msg, reply) {
  if (Object.hasOwnProperty.call(fileUploads, msg.reply.id))
    var file = fileUploads[msg.reply.id];
  else if (msg.context.lastDirMessageId == msg.reply.id)
    var file = path.join(msg.context.cwd, msg.filename || utils.constructFilename(msg));
  else
    return;

  try {
    var stream = fs.createWriteStream(file);
  } catch (e) {
    return reply.html("Не удается записать файл: %s", e.message);
  }
  bot.fileStream(msg.file, function (err, ostream) {
    if (err) throw err;
    reply.action("typing");
    ostream.pipe(stream);
    ostream.on("end", function () {
      reply.html("Файл записан: %s", file);
    });
  });
}

// Status
bot.command("status", function (msg, reply, next) {
  var content = "", context = msg.context;

  // Running command
  if (context.editor) content += "Редактирование файла: " + escapeHtml(context.editor.file) + "\n\n";
  else if (!context.command) content += "Нет запущенных команд.\n\n";
  else content += "Команда запущена, PID "+context.command.pty.pid+".\n\n";

  // Chat settings
  content += "Терминал: " + escapeHtml(context.shell) + "\n";
  content += "Размер: " + context.size.columns + "x" + context.size.rows + "\n";
  content += "Расположение: " + escapeHtml(context.cwd) + "\n";
  content += "Скрыто: " + (context.silent ? "да" : "нет") + "\n";
  content += "Интерактивная оболочка: " + (context.interactive ? "да" : "нет") + "\n";
  content += "Предпросмотры ссылок: " + (context.linkPreviews ? "да" : "нет") + "\n";
  var uid = process.getuid(), gid = process.getgid();
  if (uid !== gid) uid = uid + "/" + gid;
  content += "UID/GID: " + uid + "\n";

  // Granted chats (msg.chat.id is intentional)
  if (msg.chat.id === owner) {
    var grantedIds = Object.keys(granted);
    if (grantedIds.length) {
      content += "\nРазрешенные чаты:\n";
      content += grantedIds.map(function (id) { return id.toString(); }).join("\n");
    } else {
      content += "\nНет разрешенных чатов/пользователей. Используйте /grant или /token для разрешения другим чатам/пользователям использовать бота.";
    }
  }

  if (context.command) reply.reply(context.command.initialMessage.id);
  reply.html(content);
});

// Settings: Shell
bot.command("shell", function (msg, reply, next) {
  var arg = msg.args(1)[0];
  if (arg) {
    if (msg.context.command) {
      var command = msg.context.command;
      return reply.reply(command.initialMessage.id || msg).html("Can't change the shell while a command is running.");
    }
    try {
      var shell = utils.resolveShell(arg);
      msg.context.shell = shell;
      reply.html("Терминал изменён.");
    } catch (err) {
      reply.html("Не удается изменить терминал.");
    }
  } else {
    var shell = msg.context.shell;
    var otherShells = utils.shells.slice(0);
    var idx = otherShells.indexOf(shell);
    if (idx !== -1) otherShells.splice(idx, 1);

    var content = "Текущий терминал: " + escapeHtml(shell);
    if (otherShells.length)
      content += "\n\nДругие терминалы:\n" + otherShells.map(escapeHtml).join("\n");
    reply.html(content);
  }
});

// Settings: Working dir
bot.command("cd", function (msg, reply, next) {
  var arg = msg.args(1)[0];
  if (arg) {
    if (msg.context.command) {
      var command = msg.context.command;
      return reply.reply(command.initialMessage.id || msg).html("Не удается сменить директорию, пока команда запущена.");
    }
    var newdir = path.resolve(msg.context.cwd, arg);
    try {
      fs.readdirSync(newdir);
      msg.context.cwd = newdir;
    } catch (err) {
      return reply.html("%s", err);
    }
  }

  reply.html("Сейчас в: %s", msg.context.cwd).then().then(function (m) {
    msg.context.lastDirMessageId = m.id;
  });
});

// Settings: Environment
bot.command("env", function (msg, reply, next) {
  var env = msg.context.env, key = msg.args();
  if (!key)
    return reply.reply(msg).html("Используйте %s для просмотра значения переменной, или %s для ее изменения", "/env <имя>", "/env <имя>=<значение>");

  var idx = key.indexOf("=");
  if (idx === -1) idx = key.indexOf(" ");

  if (idx !== -1) {
    if (msg.context.command) {
      var command = msg.context.command;
      return reply.reply(command.initialMessage.id || msg).html("Не удается изменить переменную, пока запущена команда");
    }

    var value = key.substring(idx + 1);
    key = key.substring(0, idx).trim().replace(/\s+/g, " ");
    if (value.length) env[key] = value;
    else delete env[key];
  }

  reply.reply(msg).text(printKey(key));

  function printKey(k) {
    if (Object.hasOwnProperty.call(env, k))
      return k + "=" + JSON.stringify(env[k]);
    return k + " unset";
  }
});

// Settings: Size
bot.command("resize", function (msg, reply, next) {
  var arg = msg.args(1)[0] || "";
  var match = /(\d+)\s*((\sby\s)|x|\s|,|;)\s*(\d+)/i.exec(arg.trim());
  if (match) var columns = parseInt(match[1]), rows = parseInt(match[4]);
  if (!columns || !rows)
    return reply.text("Используйте /resize <столбцы> <ряды> для изменения размера терминала.");

  msg.context.size = { columns: columns, rows: rows };
  if (msg.context.command) msg.context.command.resize(msg.context.size);
  reply.reply(msg).html("Размер терминала изменён.");
});

// Settings: Silent
bot.command("setsilent", function (msg, reply, next) {
  var arg = utils.resolveBoolean(msg.args());
  if (arg === null)
    return reply.html("Используйте /setsilent [yes|no] чтобы контролировать, будет ли новый вывод команды отправляться без вывода сообщений.");

  msg.context.silent = arg;
  if (msg.context.command) msg.context.command.setSilent(arg);
  reply.html("Вывод команд " + (arg ? "" : "не ") + "будет выводиться.");
});

// Settings: Interactive
bot.command("setinteractive", function (msg, reply, next) {
  var arg = utils.resolveBoolean(msg.args());
  if (arg === null)
    return reply.html("Используйте /setinteractive [yes|no] чтобы контролировать, является ли оболочка интерактивной. Включение этого параметра приведет к тому, что ваши алиасы, например, .bashrc, будут учтены, но может вызвать ошибки в некоторых оболочках, таких как fish.");

  if (msg.context.command) {
    var command = msg.context.command;
    return reply.reply(command.initialMessage.id || msg).html("Не удается изменить настройку интерактивной оболочки.");
  }
  msg.context.interactive = arg;
  reply.html("Команды " + (arg ? "" : "не ") + "будут запускаться с учетом интерактивной строки.");
});

// Settings: Link previews
bot.command("setlinkpreviews", function (msg, reply, next) {
  var arg = utils.resolveBoolean(msg.args());
  if (arg === null)
    return reply.html("Используйте /setlinkpreviews [yes|no] чтобы контролировать, будут ли ссылки иметь предпросмотр в выводе.");

  msg.context.linkPreviews = arg;
  if (msg.context.command) msg.context.command.setLinkPreviews(arg);
  reply.html("Ссылки в выводе " + (arg ? "" : "не ") + "будут иметь предпросмотр.");
});

// Settings: Other chat access
bot.command("grant", "revoke", function (msg, reply, next) {
  if (msg.context.id !== owner) return;
  var arg = msg.args(1)[0], id = parseInt(arg);
  if (!arg || isNaN(id))
    return reply.html("Используйте %s или %s чтобы контролировать, может ли чат с этим ID использовать этого бота.", "/grant <ID>", "/revoke <ID>");
  reply.reply(msg);
  if (msg.command === "grant") {
    granted[id] = true;
    reply.html("Чат/пользователь %s теперь может использовать бота. Используйте /revoke для отмены.", id);
  } else {
    if (contexts[id] && contexts[id].command)
      return reply.html("Не удалось отозвать указанный чат/пользователя, потому что команда выполняется.");
    delete granted[id];
    delete contexts[id];
    reply.html("Чат/пользователь %s был успешно отозван.", id);
  }
});
bot.command("token", function (msg, reply, next) {
  if (msg.context.id !== owner) return;
  var token = utils.generateToken();
  tokens[token] = true;
  reply.disablePreview().html("Одноразовый токен доступа сгенерирован. По следующей ссылке можно получить доступ к боту:\n%s\nИли отправив кому-либо это:", bot.link(token));
  reply.command(true, "start", token);
});

// Welcome message, help
bot.command("start", function (msg, reply, next) {
  if (msg.args() && msg.context.id === owner && Object.hasOwnProperty.call(tokens, msg.args())) {
    reply.html("Вы уже прошли аутентификацию; токен отозван.");
  } else {
    reply.html("Добро пожаловать! Используйте /run для выполнения команд и отвечайте на мои сообщения для отправки ввода. /help для получения дополнительной информации.");
  }
});

bot.command("help", function (msg, reply, next) {
  reply.html(
    "Используйте /run &lt;команда&gt; и я выполню введенную команду. Пока она запущена, вы можете:\n" +
    "\n" +
    "‣ Ответить на одно из моих сообщений для ввода текста в команду, либо использовать /enter.\n" +
    "‣ Использовать /end для отправки EOF (Ctrl+D) в команду.\n" +
    "‣ Использовать /cancel для отправки SIGINT (Ctrl+C) в группу процессов либо сигнал, который вы выберете.\n" +
    "‣ Использовать /kill для отправки SIGTERM к корневому процессу или выбранному вами сигналу.\n" + 
    "‣ Для графических приложений используйте /redraw для принудительного обновления вывода.\n" +
    "‣ Используйте /type или /ctrl для ввода клавиш, /alt для отправки клавиши с зажатым Alt, или /keypad для показа клавиатуры со специальными клавишами.\n" + 
    "\n" +
    "Вы можете увидеть текущий статус и настройки этого чата с помощью /status. Используйте /env для " +
    "управления пересенными, /cd для смены текущей директории, /shell что-бы увидеть или " +
    "изменить терминал, используемый для запуска команд и /resize для изменения размера терминала.\n" +
    "\n" +
    "По умолчанию вывод команд отправляется без звука, а ссылки не имеют предпросмотра " +
    "Это можно изменить с помощью /setsilent и /setlinkpreviews. Примечание: ссылки " +
    "никогда не имеют предпросмотра в статусе.\n" +
    "\n" +
    "<em>Дополнительные функции</em>\n" +
    "\n" +
    "Используйте /upload &lt;файл&gt; и я пришлю вам этот файл. Если вы ответите на это " +
    "сообщение, загрузив мне файл, я заменю его вашим.\n"
  );
});

// FIXME: add inline bot capabilities!
// FIXME: possible feature: restrict chats to UIDs
// FIXME: persistence
// FIXME: shape messages so we don't hit limits, and react correctly when we do


bot.command(function (msg, reply, next) {
  reply.reply(msg).text("Неверная команда.");
});

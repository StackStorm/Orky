// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license.
import * as restify from "restify";
import * as SocketIO from "socket.io";
import {UniversalBot, ChatConnector, IMiddlewareMap, IEvent, Session} from "botbuilder";
import { ConsoleLogger, ILogger, ApplicationInsightsLogger, CompoundLogger, NoLogger } from "./Logging";
import {Config, IConfig, StorageType} from "./Config";
import {BotRepository, IDataStorage, FileStorage, MemoryStorage} from "./Repositories";
import {BotConnectionManager, BotService, BotMessageFormatter} from "./Services"
import {Dialogs} from "./Dialogs";
import {ArgumentNullException} from "./Errors";

export class Orky {
  private _config: IConfig;
  private _logger: ILogger;
  private _server: restify.Server;

  constructor(config: IConfig) {
    if (!config) {
      throw new ArgumentNullException("config");
    }

    this._config = config;

    const loggers = [];
    loggers.push(new ConsoleLogger(config.LogLevel));

    if (config.ApplicationInsightsKey) {
      loggers.push(new ApplicationInsightsLogger(config.LogLevel, config.ApplicationInsightsKey));
    }

    if (loggers.length === 1) {
      this._logger = loggers[0];
    }
    else if (loggers.length > 1) {
      this._logger = new CompoundLogger(config.LogLevel, loggers);
    }
    else {
      this._logger = new NoLogger();
    }

    this._logger.info('Created new instance of Orky.');
    this._logger.debug(`Config: ${JSON.stringify(this._config)}`);
  }

  run(): void {
    const chatConnector = new ChatConnector({
      appId: this._config.MicrosoftAppId,
      appPassword: this._config.MicrosoftAppPassword
    });

    let botStorage: IDataStorage;
    if (this._config.BotDataStorageType === StorageType.File) {
      botStorage = new FileStorage(this._logger, this._config.BotDataFilePath);
    }
    else {
      botStorage = new MemoryStorage(this._logger);
    }

    const botRepository = new BotRepository(botStorage, this._logger);
    const botConnectionManager = new BotConnectionManager(botRepository, this._config.BotResponseTimeout, this._logger);
    const botService = new BotService(botRepository, botConnectionManager, this._logger, this._config.BotKeepDuration);
    const botMessageFormatter = new BotMessageFormatter();
    const universalBot = Dialogs.register(chatConnector, botService, botMessageFormatter, this._logger, this._config);

    this._server = restify.createServer({
      name: this._config.Name,
      version: this._config.Version,
      socketio: true
    });

    this._server.get("/", (req, res) => {
      res.send(200);
      res.end();
    });

    this._server.post(this._config.MessagesEndpoint, chatConnector.listen());

    const io = SocketIO(this._server, {
      path: this._config.BotConnectionEndpoint
    });

    io.use((socket, next) => {
      botService.authorizeConnection(socket)
        .then(() => next())
        .catch((error) => {
          this._logger.logException(error);
          next(error)
        });
    });

    io.on('connection', (socket) => {
      botService.establishConnection(socket)
        .catch((error) => {
          this._logger.logException(error);
        });
    });

    this._server.listen(this._config.ServerPort, () => {
      this._logger.info(`${this._server.name} listening to ${this._server.url}`); 
    });

    this._logger.info("Orky is running");
  }

  stop(): void {
    this._logger.info("Orky is shutting down");
    this._server.close();
  }
}

export function run(): void {
  const config = new Config();
  const orky = new Orky(config);
  orky.run();
}

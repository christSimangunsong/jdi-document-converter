const fs = require('fs-extra');
const path = require('path');
const { createLogger, format, transports } = require('winston');
const config = require('../config');

fs.ensureDirSync(config.logDir);

const logger = createLogger({
  level: 'info',
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.printf(({ timestamp, level, message }) => {
      return `[${timestamp}] [${level.toUpperCase()}] ${message}`;
    })
  ),
  transports: [
    new transports.Console({
      format: format.combine(
        format.colorize(),
        format.timestamp({ format: 'HH:mm:ss' }),
        format.printf(({ timestamp, level, message }) => {
          return `[${timestamp}] [${level}] ${message}`;
        })
      ),
    }),
    new transports.File({
      filename: path.join(config.logDir, 'app.log'),
      maxsize: 5242880,
      maxFiles: 5,
    }),
    new transports.File({
      level: 'error',
      filename: path.join(config.logDir, 'error.log'),
      maxsize: 5242880,
      maxFiles: 5,
    }),
  ],
});

module.exports = logger;

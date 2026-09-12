import pino from 'pino';

const isProd = process.env.NODE_ENV === 'production';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (isProd ? 'info' : 'debug'),
  transport: isProd
    ? undefined
    : { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } },
  // Never let a credential reach a log sink. `req.headers.*` covers Fastify's
  // default request serializer; the `*.foo` wildcards cover anything logged
  // as a plain object field (e.g. { widgetApiKey } in an error context)
  // regardless of which object it's nested under.
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-widget-api-key"]',
      '*.token',
      '*.widgetApiKey',
      '*.passwordHash',
      '*.password',
    ],
    censor: '[redacted]',
  },
});

export default logger;

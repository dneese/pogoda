// Мінімалістичний структурний логер: рівні + таймстампи, без залежностей.
// LOG_LEVEL=debug|info|warn|error (дефолт info).

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const current = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] || LEVELS.info;

function fmt(level, msg, args) {
  const ts = new Date().toISOString();
  const rest = args.length ? ' ' + args.map(a => {
    if (a instanceof Error) return a.stack || a.message;
    return typeof a === 'string' ? a : JSON.stringify(a);
  }).join(' ') : '';
  return `${ts} [${level.toUpperCase()}] ${typeof msg === 'string' ? msg : JSON.stringify(msg)}${rest}`;
}

function log(level, msg, ...args) {
  if ((LEVELS[level] || LEVELS.info) < current) return;
  const line = fmt(level, msg, args);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

module.exports = {
  debug: (msg, ...args) => log('debug', msg, ...args),
  info: (msg, ...args) => log('info', msg, ...args),
  warn: (msg, ...args) => log('warn', msg, ...args),
  error: (msg, ...args) => log('error', msg, ...args),
  level: current
};

/**
 * node-pty の代わりに SessionManager へ注入するフェイク。
 *
 * 実プロセスを起動せずに write / resize / kill / データ受信を検証できる。
 */

function createFakePty(options) {
  const dataHandlers = [];
  const exitHandlers = [];

  const pty = {
    options,
    written: [],
    resized: [],
    killed: false,

    write(data) {
      pty.written.push(data);
    },
    resize(cols, rows) {
      pty.resized.push({ cols, rows });
    },
    kill() {
      pty.killed = true;
    },
    onData(cb) {
      dataHandlers.push(cb);
    },
    onExit(cb) {
      exitHandlers.push(cb);
    },

    // --- テストから呼ぶ操作 ---
    emitData(data) {
      dataHandlers.forEach((cb) => cb(data));
    },
    emitExit(exitCode = 0) {
      exitHandlers.forEach((cb) => cb({ exitCode }));
    },
  };

  return pty;
}

/**
 * 生成された pty を記録するファクトリを返す。
 */
function createFakePtyFactory() {
  const created = [];
  const factory = (options) => {
    const pty = createFakePty(options);
    created.push(pty);
    return pty;
  };
  factory.created = created;
  factory.last = () => created[created.length - 1];
  return factory;
}

/**
 * テストから進められる時計。
 */
function createFakeClock(start = 1000) {
  let current = start;
  const now = () => current;
  now.advance = (ms) => {
    current += ms;
  };
  return now;
}

module.exports = { createFakePty, createFakePtyFactory, createFakeClock };

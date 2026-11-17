// DSH SDK 最小客户端：JSON-RPC over stdio，用于把 Web 连到常驻 DSH 会话
// 方法：initialize → session/prompt；接收 user-question/ask、approval/request、session.event
const { spawn } = require('child_process');
const readline = require('readline');
const os = require('os');
const path = require('path');

class DshSdkClient {
  constructor({ cwd, provider = 'deepseek-official', model = 'deepseek-chat', apiKey } = {}) {
    this.cwd = cwd || process.cwd();
    this.provider = provider;
    this.model = model;
    this.apiKey = apiKey;
    this.nextId = 1;
    this.pending = new Map(); // id -> { resolve, reject }
    this.handlers = {
      onUserQuestion: null,
      onApproval: null,
      onEvent: null,
      onStatus: null,
    };
  }

  start() {
    return new Promise((resolve, reject) => {
      const env = { ...process.env, DEEPSEEK_API_KEY: this.apiKey || process.env.DEEPSEEK_API_KEY };
      this.proc = spawn('dsh', ['--profile', 'sdk'], { cwd: this.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
      this.proc.stderr.on('data', (d) => this._log('stderr', d.toString().trim()));
      this.proc.on('exit', (code) => this._log('exit', code));

      this.rl = readline.createInterface({ input: this.proc.stdout });
      this.rl.on('line', (line) => this._onLine(line));

      // 等 stderr 出现启动提示或直接初始化
      const timeout = setTimeout(() => reject(new Error('SDK 启动超时')), 30000);
      this._call('initialize', {
        cwd: this.cwd,
        provider: this.provider,
        model: this.model,
        approvalRequests: true,
        capabilities: { userQuestions: true },
      }).then((r) => { clearTimeout(timeout); resolve(r); }).catch((e) => { clearTimeout(timeout); reject(e); });
    });
  }

  _log(kind, msg) {
    if (msg) console.error(`[sdk:${kind}] ${msg}`);
  }

  _onLine(line) {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id !== undefined && msg.method) {
      // server→client 请求：user-question/ask 或 approval/request
      this._onServerRequest(msg);
    } else if (msg.id !== undefined) {
      // 响应
      const p = this.pending.get(msg.id);
      if (p) { this.pending.delete(msg.id); msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result); }
    } else if (msg.method) {
      // 通知
      this._onNotification(msg);
    }
  }

  _onServerRequest(msg) {
    if (msg.method === 'user-question/ask' && this.handlers.onUserQuestion) {
      this.handlers.onUserQuestion(msg.params, (result) => {
        this._send({ jsonrpc: '2.0', id: msg.id, result });
      });
    } else if (msg.method === 'approval/request' && this.handlers.onApproval) {
      this.handlers.onApproval(msg.params, (outcome) => {
        this._send({ jsonrpc: '2.0', id: msg.id, result: { outcome } });
      });
    } else {
      // 无处理器：默认允许审批 / 取消提问
      if (msg.method === 'approval/request') this._send({ jsonrpc: '2.0', id: msg.id, result: { outcome: 'allowed-once' } });
      if (msg.method === 'user-question/ask') this._send({ jsonrpc: '2.0', id: msg.id, result: { cancelled: true } });
    }
  }

  _onNotification(msg) {
    const p = msg.params || {};
    if (msg.method === 'session.event' && this.handlers.onEvent) this.handlers.onEvent(p);
    if (msg.method === 'session.status' && this.handlers.onStatus) this.handlers.onStatus(p);
  }

  _send(obj) {
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  _call(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this._send({ jsonrpc: '2.0', id, method, params });
    });
  }

  async prompt(sessionId, text) {
    const contentBlocks = [{ type: 'text', text }];
    const r = await this._call('session/prompt', { sessionId, contentBlocks });
    return r; // { messageId }
  }

  close() {
    try { this._call('shutdown', {}); } catch {}
    setTimeout(() => { try { this.proc.kill(); } catch {} }, 500);
    if (this.rl) this.rl.close();
  }
}

module.exports = { DshSdkClient };

// 单测：node sdk.js "提示词"
if (require.main === module) {
  const apiKey = (() => {
    try {
      const c = require('fs').readFileSync(path.join(os.homedir(), '.dsh', '.credentials.yaml'), 'utf8');
      const m = c.match(/DEEPSEEK_API_KEY:\s*(\S+)/);
      return m ? m[1] : '';
    } catch { return ''; }
  })();
  const prompt = process.argv[2] || '只回复两个字：就绪';
  const client = new DshSdkClient({ cwd: process.cwd(), apiKey });
  (async () => {
    const info = await client.start();
    console.log('INITIALIZED:', JSON.stringify(info));
    let done = false;
    client.handlers.onStatus = (p) => { if (p.status === 'idle' && !done) { done = true; console.log('AGENT IDLE'); client.close(); process.exit(0); } };
    client.handlers.onUserQuestion = (p, reply) => { console.log('QUESTION:', JSON.stringify(p.questions)); reply({ cancelled: true }); };
    client.handlers.onEvent = (p) => {
      const ev = p.event || {};
      if (ev.type === 'assistant/message' && ev.data && ev.data.message) {
        const txt = (ev.data.message.content || []).map((b) => b.text || '').join('');
        if (txt) console.log('ASSISTANT:', txt);
      }
    };
    await client.prompt('demo-' + Date.now(), prompt);
    console.log('PROMPT SENT, waiting…');
    setTimeout(() => { console.log('TIMEOUT'); client.close(); process.exit(1); }, 180000);
  })().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
}

#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { DshClient, hostError, redact } from '../src/dsh-client.js';
import { discoverLanes, makeConfiguration, saveConfiguration, defaultConfigFile, publicPoolLanes, PUBLIC_POOL_NOTICE, ACCOUNT_SETUP_GUIDE } from '../src/configuration.js';
import { runOneTurn } from '../src/runner.js';

const help = `白饭鱼 OFM 接入（Node.js 22.19+）
  doctor                         检查 DSH 协议和当前 OFM 候选，不调用模型
  setup                         默认配置当前目录的免费公开池
  setup --lanes provider/model   显式配置自己的账号渠道，多个候选用逗号分隔
  smoke --allow-model-call       新建隔离会话，发送固定短提示词，验证真实回答
  run --prompt-file FILE --allow-model-call  运行一个纯文本回合
  status                         查看本地回合元数据，不连接 DSH

连接：--base-url http://127.0.0.1:3080
授权：DSH_AUTH_COOKIE / DSH_LAUNCH_TOKEN 环境变量；或经授权传 --use-local-session
      --dsh-home PATH 仅在显式 --use-local-session 时读取本机会话签名密钥
配置：--config PATH（默认 DSH_HOME/baifanyu-ofm/config.local.json）；--state PATH（默认配置旁 state/）
其他：--cn-until ISO_DATE（只用于已核实的 CN 权益）；--timeout 90000；--agent-preset NAME
输出均为 JSON。只有 smoke/run 会提交模型提示词，可能消耗用户渠道额度。
本入口不安装 OFM、不登录渠道、不导入凭据；原生插件安装方法见 README。`;
const output = value => process.stdout.write(JSON.stringify(value, null, 2) + '\n');
try {
  const { values: v, positionals } = parseArgs({ allowPositionals: true, options: {
    'base-url': { type: 'string' }, 'dsh-home': { type: 'string' }, config: { type: 'string' },
    state: { type: 'string' }, lanes: { type: 'string' }, 'cn-until': { type: 'string' },
    timeout: { type: 'string' }, 'prompt-file': { type: 'string' }, 'agent-preset': { type: 'string' },
    'use-local-session': { type: 'boolean' }, 'allow-model-call': { type: 'boolean' }, help: { type: 'boolean' }
  } });
  const action = positionals[0];
  if (!action || v.help) { process.stdout.write(help + '\n'); }
  else {
    if (positionals.length !== 1 || !['doctor', 'setup', 'smoke', 'run', 'status'].includes(action)) throw hostError('未知命令；使用 --help', 'INVALID_COMMAND');
    const configFile = path.resolve(v.config ?? defaultConfigFile(v['dsh-home']));
    const stateDir = path.resolve(v.state ?? path.join(path.dirname(configFile), 'state'));
    if (action === 'status') {
      const runs = fs.existsSync(stateDir) ? fs.readdirSync(stateDir).filter(name => /^[0-9a-f-]{36}\.json$/.test(name)).map(name => {
        const run = JSON.parse(fs.readFileSync(path.join(stateDir, name), 'utf8'));
        return { ...run, status: run.status === 'pending' ? 'unknown' : run.status };
      }) : [];
      output({ scope: 'local-submission-metadata', runs });
    } else {
      const client = new DshClient({ baseUrl: v['base-url'], dshHome: v['dsh-home'], useLocalSession: v['use-local-session'] === true });
      if (action === 'doctor') {
        const catalog = await client.catalog();
        const candidates = discoverLanes(catalog);
        output({ ok: candidates.length > 0, protocol: 'slash-rpc', eventStream: 'not-probed', baseUrl: client.baseUrl, publicPool: publicPoolLanes(catalog), candidates,
          next: publicPoolLanes(catalog).length ? '运行 setup 默认配置免费公开池；账号渠道需要自行添加后显式选择' : '在 OFM 启用公开池并刷新目录，或添加自己的账号后运行 setup --lanes',
          note: '目录可见不等于模型可调用，也不能证明免费。doctor 没有调用模型。', limitations: PUBLIC_POOL_NOTICE, accountSetup: ACCOUNT_SETUP_GUIDE });
        if (!candidates.length) process.exitCode = 2;
      } else if (action === 'setup') {
        const config = makeConfiguration(await client.catalog(), (v.lanes ?? '').split(',').map(x => x.trim()).filter(Boolean), { qoderCnFreeUntil: v['cn-until'] });
        output({ ok: true, ...saveConfiguration(configFile, config), lanes: config.dsh.allowedLanes,
          limitations: PUBLIC_POOL_NOTICE, accountSetup: ACCOUNT_SETUP_GUIDE, next: '授权一次短模型请求后运行 smoke --allow-model-call' });
      } else {
        if (!v['allow-model-call']) throw hostError('真实调用需要 --allow-model-call，并确认已获得用户授权', 'MODEL_CALL_NOT_AUTHORIZED');
        if (!fs.existsSync(configFile)) throw hostError('缺少配置；先运行 doctor 和 setup --lanes', 'CONFIG_REQUIRED');
        if (action === 'run' && !v['prompt-file']) throw hostError('run 需要 --prompt-file；正文不放入命令行或本地审计', 'PROMPT_REQUIRED');
        const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
        const prompt = action === 'smoke' ? '这是一条独立供模验证。不要调用任何工具。只回复 BFY_OK' : fs.readFileSync(v['prompt-file'], 'utf8');
        const stop = new AbortController();
        const interrupt = () => stop.abort();
        process.once('SIGINT', interrupt);
        process.once('SIGTERM', interrupt);
        try {
          const result = await runOneTurn({ client, config, stateDir, prompt, timeoutMs: Number(v.timeout ?? 90000), agentPreset: v['agent-preset'], signal: stop.signal });
          const matched = action !== 'smoke' || result.text === 'BFY_OK';
          output({ ...result, ok: matched, ...(action === 'smoke' ? { smokeMatched: matched, scope: 'one-live-text-turn' } : {}) });
          if (!matched) process.exitCode = 3;
        } finally {
          process.removeListener('SIGINT', interrupt);
          process.removeListener('SIGTERM', interrupt);
        }
      }
    }
  }
} catch (error) {
  output({ ok: false, code: error.code ?? 'SETUP_FAILED', message: redact(error.message), ...(error.runId ? { runId: error.runId } : {}) });
  process.exitCode = 1;
}

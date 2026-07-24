#!/usr/bin/env node
/**
 * Local GPT-Image-2 studio. No external Node packages required.
 *
 * Run with: node image-studio/server.mjs
 * Then open: http://127.0.0.1:3016
 */

import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(APP_DIR, '..');
const LIBRARY_DIR = path.join(ROOT_DIR, '素材', '01_GPT-Image-2_图片素材库');
const API_BASE = 'https://api.lk888.ai';
const GENERATE_URL = `${API_BASE}/v1/media/generate`;
const STATUS_URL = `${API_BASE}/v1/media/status`;
const POLL_INTERVAL = 3000;
const MAX_POLL_TIME = 300_000;
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT) || 3016;
const TASK_STORE_PATH = path.join(APP_DIR, 'data', 'generation-tasks.json');
const TYPE_ORDER = ['场景', '角色', '道具'];
const TYPE_ICONS = { 场景: '◐', 角色: '◎', 道具: '◇' };
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const MIME_TYPES = { '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp' };
const generationTasks = new Map();
let taskStoreWrite = Promise.resolve();

const exists = async (target) => fs.access(target).then(() => true).catch(() => false);
const toPosix = (target) => target.split(path.sep).join('/');
const readTextIfPresent = async (target) => (await exists(target) ? fs.readFile(target, 'utf8') : '');
const nowDate = () => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};
const nowTime = () => {
  const date = new Date();
  return `${String(date.getHours()).padStart(2, '0')}${String(date.getMinutes()).padStart(2, '0')}${String(date.getSeconds()).padStart(2, '0')}`;
};
const safeFileName = (value) => value.replace(/[^\p{L}\p{N}_-]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'image';

function json(res, data, status = 200) {
  const body = Buffer.from(JSON.stringify(data));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
  res.end(body);
}

function persistedTask(task) {
  const { assetDirectory, ...record } = task;
  return record;
}

function persistTaskStore() {
  const content = JSON.stringify({ version: 1, tasks: [...generationTasks.values()].map(persistedTask) }, null, 2);
  taskStoreWrite = taskStoreWrite
    .catch(() => {})
    .then(async () => {
      await fs.mkdir(path.dirname(TASK_STORE_PATH), { recursive: true });
      await fs.writeFile(TASK_STORE_PATH, `${content}\n`, 'utf8');
    });
  taskStoreWrite.catch((error) => console.error(`[tasks] 无法保存本地任务记录: ${errorMessage(error)}`));
  return taskStoreWrite;
}

async function loadTaskStore() {
  if (!(await exists(TASK_STORE_PATH))) return;
  try {
    const saved = JSON.parse(await fs.readFile(TASK_STORE_PATH, 'utf8'));
    for (const task of saved.tasks ?? []) {
      if (!task?.taskId || !task?.assetPath) continue;
      generationTasks.set(String(task.taskId), { ...task, taskId: String(task.taskId), files: Array.isArray(task.files) ? task.files : null });
    }
    console.log(`[tasks] 已恢复 ${generationTasks.size} 条本地任务记录`);
  } catch (error) {
    console.error(`[tasks] 无法读取本地任务记录: ${errorMessage(error)}`);
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : '发生未知错误';
}

function pathInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

async function filesRecursively(directory) {
  if (!(await exists(directory))) return [];
  const results = [];
  const visit = async (current) => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(candidate);
      else if (IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) results.push(candidate);
    }
  };
  await visit(directory);
  return results;
}

async function assetFromDirectory(type, directory) {
  const folder = path.basename(directory);
  const divider = folder.indexOf('_');
  const id = divider === -1 ? folder : folder.slice(0, divider);
  const name = divider === -1 ? folder : folder.slice(divider + 1);
  const generated = await filesRecursively(path.join(directory, '03_生成记录'));
  const timestamps = await Promise.all(generated.map(async (file) => ({ file, mtime: (await fs.stat(file)).mtimeMs })));
  timestamps.sort((a, b) => b.mtime - a.mtime);
  return {
    id,
    name,
    type,
    icon: TYPE_ICONS[type] ?? '·',
    relative_path: toPosix(path.relative(ROOT_DIR, directory)),
    definition: await readTextIfPresent(path.join(directory, '00_资产定义.md')),
    prompt: await readTextIfPresent(path.join(directory, '02_GPT-Image-2_提示词', '文生图提示词.md')),
    brief: await readTextIfPresent(path.join(directory, '01_图片准备', '图片清单.md')),
    generated_count: generated.length,
    latest_image: timestamps[0] ? `/files/${toPosix(path.relative(ROOT_DIR, timestamps[0].file))}` : null,
  };
}

async function loadAssets() {
  const assets = [];
  for (const type of TYPE_ORDER) {
    const typeDirectory = path.join(LIBRARY_DIR, type);
    if (!(await exists(typeDirectory))) continue;
    const entries = await fs.readdir(typeDirectory, { withFileTypes: true });
    for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))) {
      assets.push(await assetFromDirectory(type, path.join(typeDirectory, entry.name)));
    }
  }
  return assets;
}

async function validatedAssetDirectory(relativePath) {
  if (typeof relativePath !== 'string') throw new Error('资产路径无效');
  const candidate = path.resolve(ROOT_DIR, relativePath);
  if (!pathInside(path.resolve(LIBRARY_DIR), candidate) || !(await exists(candidate)) || !(await fs.stat(candidate)).isDirectory()) {
    throw new Error('找不到所选资产目录，或目录不在素材库中');
  }
  return candidate;
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 200_000) throw new Error('请求内容大小无效');
    chunks.push(chunk);
  }
  if (!size) throw new Error('请求内容不能为空');
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('请求 JSON 格式无效'); }
}

// API key supplied for this local studio.
const API_KEY = 'sk-9d6e40a6184a5d3619bc0c145d14343f196e8b9b06ed8e83';

function apiHeaders() {
  return { Authorization: `Bearer ${API_KEY}` };
}

function taskIdFrom(result) {
  const candidates = [result?.task_id, result?.data?.task_id, result?.data?.id];
  return candidates.find((value) => typeof value === 'string' || typeof value === 'number');
}

function imageItemsFrom(result) {
  if (!result || typeof result !== 'object') return [];
  if (typeof result.result_url === 'string' && result.result_url) return [{ url: result.result_url }];
  if (typeof result.output === 'string' && result.output) return [{ url: result.output }];
  if (Array.isArray(result.output)) return result.output;
  if (result.output && typeof result.output === 'object') return [result.output];
  if (Array.isArray(result.data)) return result.data;
  if (Array.isArray(result.images)) return result.images;
  return [];
}

async function submitGenerateTask(requestData) {
  console.log(`\n[submit] POST ${GENERATE_URL}`);
  console.log(`[submit] body: ${JSON.stringify(requestData)}`);
  let response;
  try {
    response = await fetch(GENERATE_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', ...apiHeaders() }, body: JSON.stringify(requestData), signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    console.error(`[submit] 连接失败: ${errorMessage(error)}`);
    throw new Error(`无法连接图片接口: ${errorMessage(error)}`);
  }
  const raw = await response.text();
  console.log(`[submit] 响应 ${response.status}: ${raw.slice(0, 500)}`);
  if (!response.ok) throw new Error(`接口返回 ${response.status}: ${raw.slice(0, 1000)}`);
  let result;
  try { result = JSON.parse(raw); }
  catch { throw new Error('图片接口返回了无法解析的数据'); }
  const taskId = taskIdFrom(result);
  if (taskId !== undefined) {
    console.log(`[submit] task_id: ${taskId}`);
    return { taskId, result: null };
  }
  // Some OpenAI-compatible gateways return the completed image directly.  This
  // is not the asynchronous path, but accepting it avoids discarding a valid
  // result when a gateway chooses that response format.
  if (imageItemsFrom(result).length) return { taskId: null, result };
  throw new Error(`接口未返回 task_id 或图片结果: ${raw.slice(0, 600)}`);
}

async function pollTaskStatus(taskId, onUpdate = () => {}) {
  console.log(`[poll] 开始轮询 task_id: ${taskId}`);
  const deadline = Date.now() + MAX_POLL_TIME;
  let lastStatus = '';
  let polls = 0;
  while (Date.now() < deadline) {
    polls++;
    let response;
    try {
      response = await fetch(`${STATUS_URL}?task_id=${encodeURIComponent(taskId)}`, { headers: apiHeaders(), signal: AbortSignal.timeout(10_000) });
    } catch (error) {
      console.error(`[poll] #${polls} 连接失败: ${errorMessage(error)}`);
      throw new Error(`轮询任务状态失败: ${errorMessage(error)}`);
    }
    const raw = await response.text();
    console.log(`[poll] #${polls} 响应 ${response.status}: ${raw.slice(0, 300)}`);
    if (!response.ok) throw new Error(`轮询接口返回 ${response.status}: ${raw.slice(0, 1000)}`);
    let result;
    try { result = JSON.parse(raw); }
    catch { throw new Error('轮询接口返回了无法解析的数据'); }
    onUpdate(result);
    const state = String(result.state ?? '').toLowerCase();
    if (state !== lastStatus) {
      lastStatus = state;
      console.log(`[poll] task ${taskId} 状态变更: ${state || 'unknown'}，进度: ${result.progress ?? '未知'}`);
    }
    // The API document explicitly defines is_final as the terminal-state flag.
    // status/status_group are display-only Chinese strings and must not drive
    // program logic.
    if (result.is_final === true) {
      if (state === 'success') {
        console.log(`[poll] 生成完成，result_url: ${String(result.result_url ?? '').slice(0, 300)}`);
        return result;
      }
      const detail = result.error || `任务以 ${state || 'unknown'} 状态结束`;
      console.error(`[poll] 生成失败: ${JSON.stringify(result).slice(0, 500)}`);
      throw new Error(`图片生成失败: ${detail}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
  throw new Error(`图片生成超时（已等待 ${MAX_POLL_TIME / 1000} 秒）`);
}

function extensionFromUrl(value) {
  try {
    const extension = path.extname(new URL(value).pathname).toLowerCase();
    return IMAGE_EXTENSIONS.has(extension) ? extension : null;
  } catch { return null; }
}

function extensionFromContentType(value) {
  const mime = String(value ?? '').split(';', 1)[0].toLowerCase();
  return { 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' }[mime] ?? null;
}

async function imageFile(item) {
  if (typeof item === 'string') item = { url: item };
  const encoded = item?.b64_json ?? item?.base64;
  if (encoded) {
    const source = String(encoded);
    const extension = extensionFromContentType(source.match(/^data:([^;]+);base64,/)?.[1]) ?? '.png';
    return { buffer: Buffer.from(source.replace(/^data:image\/\w+;base64,/, ''), 'base64'), extension };
  }
  const url = item?.url ?? item?.image_url;
  if (!url) throw new Error('接口响应中没有可保存的图片数据（预期 b64_json 或 url）。');
  console.log(`[download] 下载图片: ${url.slice(0, 120)}`);
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`无法下载图片：${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  console.log(`[download] 完成，大小: ${(buffer.length / 1024).toFixed(1)} KB`);
  return { buffer, extension: extensionFromContentType(response.headers.get('content-type')) ?? extensionFromUrl(url) ?? '.png' };
}

async function saveGeneratedImages(assetDirectory, assetId, prompt, requestData, taskResult) {
  const items = imageItemsFrom(taskResult);
  if (!Array.isArray(items) || !items.length) throw new Error(`接口未返回图片: ${JSON.stringify(taskResult).slice(0, 600)}`);
  const saveDirectory = path.join(assetDirectory, '03_生成记录', nowDate());
  await fs.mkdir(saveDirectory, { recursive: true });
  const base = `${safeFileName(assetId)}_${safeFileName(prompt.slice(0, 24))}_${nowTime()}`;
  const files = [];
  for (const [index, item] of items.entries()) {
    const image = await imageFile(item);
    const target = path.join(saveDirectory, `${base}_${String(index + 1).padStart(2, '0')}${image.extension}`);
    await fs.writeFile(target, image.buffer);
    files.push(toPosix(path.relative(ROOT_DIR, target)));
  }
  const { output: _output, data, images, ...responseSummary } = taskResult;
  await fs.writeFile(path.join(saveDirectory, `${base}_参数记录.json`), JSON.stringify({ created_at: new Date().toISOString(), asset_id: assetId, asset_directory: toPosix(path.relative(ROOT_DIR, assetDirectory)), request: requestData, prompt, response_summary: responseSummary, files }, null, 2), 'utf8');
  return files;
}

function taskResponse(task) {
  return {
    ok: true,
    task_id: task.taskId,
    state: task.state,
    status: task.status,
    progress: task.progress,
    is_final: task.is_final,
    error: task.error,
    files: task.files,
    directory: task.directory,
  };
}

function updateTask(task, changes) {
  Object.assign(task, changes, { updated_at: new Date().toISOString() });
  void persistTaskStore();
}

function runGenerationTask(task) {
  pollTaskStatus(task.taskId, (remote) => {
    updateTask(task, {
      state: String(remote.state ?? 'running').toLowerCase(),
      status: String(remote.status ?? '处理中'),
      progress: String(remote.progress ?? ''),
      is_final: remote.is_final === true,
    });
  }).then(async (taskResult) => {
    const files = await saveGeneratedImages(task.assetDirectory, task.assetId, task.prompt, task.requestData, taskResult);
    updateTask(task, { state: 'success', status: '已完成', progress: '100%', is_final: true, files: files.map((file) => `/files/${file}`) });
    console.log(`[generate] task ${task.taskId} 完成，保存 ${files.length} 个文件`);
  }).catch((error) => {
    updateTask(task, { state: 'failed', status: '失败', is_final: true, error: errorMessage(error) });
    console.error(`[generate] task ${task.taskId} 失败: ${task.error}`);
  });
}

async function resumeIncompleteTasks() {
  for (const task of generationTasks.values()) {
    if (task.is_final) continue;
    try {
      task.assetDirectory = await validatedAssetDirectory(task.assetPath);
      runGenerationTask(task);
      console.log(`[tasks] 恢复轮询任务 ${task.taskId}`);
    } catch (error) {
      updateTask(task, { state: 'failed', status: '本地资产路径无效', is_final: true, error: errorMessage(error) });
    }
  }
}

async function serveFile(res, target) {
  try {
    const info = await fs.stat(target);
    if (!info.isFile()) throw new Error('not-file');
    const content = await fs.readFile(target);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[path.extname(target).toLowerCase()] ?? 'application/octet-stream', 'Content-Length': content.length, 'Cache-Control': 'no-store' });
    res.end(content);
  } catch { json(res, { error: 'File not found' }, 404); }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? HOST}`);
  try {
    if (req.method === 'GET' && url.pathname === '/api/assets') {
      return json(res, { assets: await loadAssets(), library: toPosix(path.relative(ROOT_DIR, LIBRARY_DIR)) });
    }
    if (req.method === 'GET' && url.pathname === '/api/generate/status') {
      const taskId = url.searchParams.get('task_id');
      const task = taskId ? generationTasks.get(taskId) : null;
      return task ? json(res, taskResponse(task)) : json(res, { ok: false, error: '找不到本地生成任务；服务重启后请重新提交。' }, 404);
    }
    if (req.method === 'GET' && url.pathname === '/api/generate/tasks') {
      const assetPath = url.searchParams.get('asset_path');
      const tasks = [...generationTasks.values()]
        .filter((task) => !assetPath || task.assetPath === assetPath)
        .sort((a, b) => String(b.updated_at ?? b.created_at ?? '').localeCompare(String(a.updated_at ?? a.created_at ?? '')))
        .map(taskResponse);
      return json(res, { ok: true, tasks });
    }
    if (req.method === 'POST' && url.pathname === '/api/generate') {
      try {
        const body = await readJsonBody(req);
        console.log(`\n${'='.repeat(50)}`);
        console.log(`[generate] 收到生成请求`);
        console.log(`[generate] 资产: ${body.asset_id} (${body.asset_path})`);
        console.log(`[generate] 尺寸: ${body.size ?? '1024x1024'}`);
        const assetDirectory = await validatedAssetDirectory(body.asset_path);
        const prompt = String(body.prompt ?? '').trim();
        if (!prompt) throw new Error('提示词不能为空');
        console.log(`[generate] 提示词: ${prompt.slice(0, 80)}${prompt.length > 80 ? '...' : ''}`);
        const count = Math.max(1, Math.min(Number.parseInt(body.n, 10) || 1, 4));
        const requestData = {
          model: 'gpt-image-2',
          prompt,
          params: { size: body.size ?? '1024x1024', quality: body.quality ?? 'auto', n: count },
        };
        const submission = await submitGenerateTask(requestData);
        if (submission.taskId === null) {
          const files = await saveGeneratedImages(assetDirectory, String(body.asset_id ?? 'image'), prompt, requestData, submission.result);
          const task = {
            taskId: `local_${Date.now()}`, assetPath: body.asset_path, assetDirectory, assetId: String(body.asset_id ?? 'image'), prompt, requestData,
            state: 'success', status: '已完成', progress: '100%', is_final: true, error: '', files: files.map((file) => `/files/${file}`),
            directory: toPosix(path.relative(ROOT_DIR, path.join(assetDirectory, '03_生成记录'))), created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
          };
          generationTasks.set(task.taskId, task);
          await persistTaskStore();
          return json(res, taskResponse(task));
        }
        const task = {
          taskId: String(submission.taskId), assetPath: body.asset_path, assetDirectory, assetId: String(body.asset_id ?? 'image'), prompt, requestData,
          state: 'pending', status: '已提交', progress: '0%', is_final: false, error: '', files: null,
          directory: toPosix(path.relative(ROOT_DIR, path.join(assetDirectory, '03_生成记录'))), created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        };
        generationTasks.set(task.taskId, task);
        await persistTaskStore();
        runGenerationTask(task);
        console.log(`${'='.repeat(50)}\n`);
        return json(res, taskResponse(task));
      } catch (error) { return json(res, { ok: false, error: errorMessage(error) }, 400); }
    }
    if (req.method === 'GET' && url.pathname.startsWith('/files/')) {
      const target = path.resolve(ROOT_DIR, decodeURIComponent(url.pathname.slice('/files/'.length)));
      if (!pathInside(path.resolve(LIBRARY_DIR), target)) return json(res, { error: 'Not allowed' }, 403);
      return serveFile(res, target);
    }
    if (req.method === 'GET') {
      const requested = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
      const target = path.resolve(APP_DIR, requested);
      if (!pathInside(path.resolve(APP_DIR), target) && target !== path.resolve(APP_DIR, 'index.html')) return json(res, { error: 'Not allowed' }, 403);
      return serveFile(res, target);
    }
    return json(res, { error: 'Not found' }, 404);
  } catch (error) {
    console.error('Unexpected error:', error);
    return json(res, { ok: false, error: '本地服务出现错误，请查看终端输出。' }, 500);
  }
});

async function start() {
  await loadTaskStore();
  await resumeIncompleteTasks();
  server.listen(PORT, HOST, () => {
    console.log(`Image studio running at http://${HOST}:${PORT}`);
    console.log("Images will be saved in each asset's 03_生成记录/YYYY-MM-DD directory.");
  });
}

start().catch((error) => {
  console.error(`无法启动 Image studio: ${errorMessage(error)}`);
  process.exitCode = 1;
});

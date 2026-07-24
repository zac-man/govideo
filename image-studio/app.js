const state = { assets: [], selected: null, filter: '全部' };
const $ = (selector) => document.querySelector(selector);
const assetList = $('#asset-list');
const prompt = $('#prompt');

function plainMarkdown(text) {
  return (text || '暂无说明。')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function filteredAssets() {
  const query = $('#asset-search').value.trim().toLowerCase();
  return state.assets.filter((asset) => (state.filter === '全部' || asset.type === state.filter) && `${asset.id} ${asset.name}`.toLowerCase().includes(query));
}

function renderAssets() {
  const template = $('#asset-template');
  assetList.replaceChildren();
  const assets = filteredAssets();
  if (!assets.length) { assetList.innerHTML = '<p class="markdown-copy empty">没有匹配的资产</p>'; return; }
  assets.forEach((asset) => {
    const card = template.content.firstElementChild.cloneNode(true);
    card.classList.toggle('selected', state.selected?.relative_path === asset.relative_path);
    card.querySelector('.asset-symbol').textContent = asset.icon;
    card.querySelector('.asset-name').textContent = asset.name;
    card.querySelector('.asset-id').textContent = asset.id;
    card.querySelector('.asset-made').textContent = asset.generated_count ? `${asset.generated_count} 张` : '未生成';
    card.addEventListener('click', () => selectAsset(asset));
    assetList.append(card);
  });
}

function selectAsset(asset) {
  state.selected = asset;
  $('#selected-type').textContent = `${asset.type} / ${asset.id}`;
  $('#selected-name').textContent = asset.name;
  $('#definition').textContent = plainMarkdown(asset.definition);
  $('#brief').textContent = plainMarkdown(asset.brief);
  $('#output-folder').textContent = `目标目录 · ${asset.relative_path}/03_生成记录/当天`;
  prompt.value = plainMarkdown(asset.prompt);
  $('#notice').textContent = '已加载资产模板。补充本次画面的主体、视角或动作后生成。';
  $('#notice').className = 'notice';
  renderAssets();
  void restoreLatestTask(asset);
}

function showImages(files, directory) {
  const stage = $('#result-stage');
  const grid = document.createElement('div');
  grid.className = `result-grid${files.length > 1 ? ' multi' : ''}`;
  files.forEach((file, index) => {
    const image = new Image();
    image.src = `${file}?v=${Date.now()}-${index}`;
    image.alt = `已生成图片 ${index + 1}`;
    grid.append(image);
  });
  stage.replaceChildren(grid);
  $('#save-note').textContent = `已归档 · ${directory}`;
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function showTask(task) {
  const id = task.task_id ?? '即时结果';
  const progress = task.progress ? ` · ${task.progress}` : '';
  $('#task-info').textContent = `任务号 · ${id} · ${task.state ?? 'pending'}${progress}`;
}

async function refreshAssets() {
  const selectedPath = state.selected?.relative_path;
  const refreshed = await fetch('/api/assets').then((response) => response.json());
  state.assets = refreshed.assets;
  state.selected = state.assets.find((asset) => asset.relative_path === selectedPath) || state.selected;
  renderAssets();
}

async function restoreLatestTask(asset) {
  try {
    const response = await fetch(`/api/generate/tasks?asset_path=${encodeURIComponent(asset.relative_path)}`);
    const data = await response.json();
    if (!response.ok || !data.ok || !data.tasks.length || state.selected?.relative_path !== asset.relative_path) return;
    const task = data.tasks[0];
    showTask(task);
    if (task.state === 'success' && task.files?.length) {
      showImages(task.files, task.directory);
      setNotice(`已从本地任务记录恢复任务 ${task.task_id} 的图片。`, 'success');
    } else if (!task.is_final) {
      setNotice(`已恢复任务 ${task.task_id}：${task.status || task.state}。`);
    }
  } catch (_) {
    // Asset browsing remains available even if the optional task-history file is unavailable.
  }
}

async function waitForTask(taskId) {
  while (true) {
    const response = await fetch(`/api/generate/status?task_id=${encodeURIComponent(taskId)}`);
    const task = await response.json();
    if (!response.ok || !task.ok) throw new Error(task.error || '无法读取生成任务状态');
    showTask(task);
    setNotice(`任务 ${task.task_id}：${task.status || task.state}${task.progress ? `（${task.progress}）` : ''}`);
    if (task.is_final) {
      if (task.state !== 'success') throw new Error(task.error || '图片生成失败');
      showImages(task.files, task.directory);
      setNotice(`任务 ${task.task_id} 已完成，保存 ${task.files.length} 张图片。`, 'success');
      await refreshAssets();
      return;
    }
    await wait(2000);
  }
}

async function generate() {
  if (!state.selected) { setNotice('请先选择一个资产目录。', 'error'); return; }
  if (!prompt.value.trim()) { setNotice('提示词不能为空。', 'error'); return; }
  const button = $('#generate');
  button.disabled = true; button.innerHTML = '<span>◌</span> 生成中…'; setNotice('正在请求 GPT-Image-2，图片完成后会自动写入资产目录。');
  try {
    const response = await fetch('/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      asset_id: state.selected.id, asset_path: state.selected.relative_path, prompt: prompt.value.trim(),
      size: $('#size').value, quality: $('#quality').value, n: Number($('#image-count').value)
    }) });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || '生成失败');
    showTask(data);
    if (data.task_id) {
      setNotice(`任务 ${data.task_id} 已提交，开始轮询状态。`);
      await waitForTask(data.task_id);
    } else {
      showImages(data.files, data.directory);
      setNotice(`已完成 ${data.files.length} 张图片，并保存参数记录。`, 'success');
      await refreshAssets();
    }
  } catch (error) { setNotice(error.message, 'error'); }
  finally { button.disabled = false; button.innerHTML = '<span>✦</span> 生成画面'; }
}

function setNotice(message, type = '') { const notice = $('#notice'); notice.textContent = message; notice.className = `notice ${type}`; }

async function boot() {
  try {
    const response = await fetch('/api/assets');
    const data = await response.json();
    state.assets = data.assets;
    $('#asset-total').textContent = state.assets.length;
    $('#asset-count').textContent = `${state.assets.length} 项资产`;
    renderAssets();
    if (state.assets.length) selectAsset(state.assets[0]);
  } catch (_) { setNotice('无法读取本地素材库。请确认通过 node server.mjs 启动。', 'error'); }
}

document.querySelectorAll('.filter').forEach((button) => button.addEventListener('click', () => { state.filter = button.dataset.type; document.querySelectorAll('.filter').forEach((item) => item.classList.toggle('active', item === button)); renderAssets(); }));
$('#asset-search').addEventListener('input', renderAssets);
$('#restore-prompt').addEventListener('click', () => state.selected && (prompt.value = plainMarkdown(state.selected.prompt)));
$('#generate').addEventListener('click', generate);
boot();

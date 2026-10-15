/**
 * 弹出面板逻辑：状态展示、任务控制、结果导出。
 *
 * 任务状态以 chrome.storage.local 为准，面板打开时先读一次，
 * 之后靠后台广播和定时轮询刷新。这样即使面板被关掉再打开，
 * 也能看到正在进行的任务。
 */

const $ = (id) => document.getElementById(id);

const PAGE_TYPE_TEXT = {
  search: '京东搜索结果页',
  product: '京东商品详情页',
  comments: '京东评论页',
  other: '京东页面（不支持采集）',
  none: '非京东页面'
};

let pollTimer = null;

// ══════════════════════════════════════════════════════════
// 与后台通信
// ══════════════════════════════════════════════════════════

function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(response || { ok: false, error: '没有收到后台响应' });
      }
    });
  });
}

// ══════════════════════════════════════════════════════════
// 状态展示
// ══════════════════════════════════════════════════════════

async function refreshLogin() {
  const el = $('login-state');
  el.className = 'value pending';
  el.textContent = '检测中…';

  const res = await send({ type: 'check-login' });
  if (!res.ok) {
    el.className = 'value bad';
    el.textContent = '检测失败';
    $('status-detail').textContent = res.error || '';
    return;
  }

  const { state, detail } = res.data;
  if (state === 'logged_in') {
    el.className = 'value ok';
    el.textContent = '已登录';
  } else if (state === 'need_login') {
    el.className = 'value bad';
    el.textContent = '未登录 / 会话已失效';
  } else {
    el.className = 'value warn';
    el.textContent = '无法确认';
  }
  $('status-detail').textContent = detail || '';
}

async function refreshPage() {
  const el = $('page-state');
  el.className = 'value pending';
  el.textContent = '检测中…';

  // 走后台而不是直接给标签页发消息：后台会在内容脚本缺失时自动补注入，
  // 这样扩展重载后不需要手动刷新页面。
  const res = await send({ type: 'ping-tab' });

  if (!res.ok) {
    // 不覆盖登录状态那行的说明文字，页面错误只体现在这一行
    el.className = 'value bad';
    el.textContent = '无法识别';
    el.title = res.error || '';
    return { pageType: 'unknown', sku: '' };
  }

  const type = res.data.pageType;
  el.textContent = PAGE_TYPE_TEXT[type] || type;
  el.className = type === 'search' || type === 'product' ? 'value ok' : 'value warn';
  return { pageType: type, sku: res.data.sku };
}

/** 根据任务状态刷新面板。 */
function renderTask(task) {
  const running = task && task.status === 'running';

  $('btn-start').disabled = running;
  $('btn-stop').disabled = !running;

  const progressCard = $('progress-card');
  const resultCard = $('result-card');

  if (!task) {
    progressCard.classList.add('hidden');
    resultCard.classList.add('hidden');
    return;
  }

  // 进度
  const total = task.queue.length || 0;
  const done = task.results.length || 0;
  progressCard.classList.remove('hidden');
  $('progress-text').textContent = `${done} / ${total}`;
  $('bar-fill').style.width = total ? `${Math.round((done / total) * 100)}%` : '0%';

  const current = task.queue[task.index];
  const phaseText = task.phase === 'comments' ? '补采评论' : '读取详情';
  $('progress-detail').textContent = running && current
    ? `正在处理：${truncate(current.商品名称)}（${phaseText}）`
    : statusText(task.status);

  $('log').innerHTML = (task.log || [])
    .slice(-12)
    .map((entry) => `<div>${escapeHtml(entry.text)}</div>`)
    .join('');

  // 结果
  if (done > 0) {
    resultCard.classList.remove('hidden');
    const commentTotal = task.results.reduce((sum, r) => sum + (r.commentCount || 0), 0);
    $('result-text').textContent = `${done} 个商品，${commentTotal} 条评论`;
  } else {
    resultCard.classList.add('hidden');
  }

  // 错误提示
  if (task.status === 'error' && task.error) {
    showError(task.error);
  } else {
    hideError();
  }
}

function statusText(status) {
  return {
    running: '进行中',
    done: '已完成',
    stopped: '已停止',
    error: '出错了'
  }[status] || '';
}

function truncate(text) {
  const s = String(text || '');
  return s.length > 22 ? s.slice(0, 22) + '…' : s;
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function showError(message) {
  const el = $('error');
  el.textContent = message;
  el.classList.remove('hidden');
}

function hideError() {
  $('error').classList.add('hidden');
}

// ══════════════════════════════════════════════════════════
// 轮询：面板打开期间定时刷新任务状态
// ══════════════════════════════════════════════════════════

async function pollTask() {
  const res = await send({ type: 'get-task' });
  if (res.ok) renderTask(res.data);
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(pollTask, 1000);
}

// ══════════════════════════════════════════════════════════
// 导出
// ══════════════════════════════════════════════════════════

/** 生成带 BOM 的 CSV，保证 Excel 打开中文不乱码。 */
function toCsv(rows) {
  const body = rows
    .map((row) =>
      row
        .map((cell) => {
          const s = String(cell == null ? '' : cell);
          return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        })
        .join(',')
    )
    .join('\r\n');
  return '﻿' + body;
}

function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
}

/**
 * 导出合并 CSV：商品详情和评论放在同一个文件里，用分段标题隔开。
 *
 * 分成两段而不是合成一张宽表，是因为两者的粒度不同：商品是一行，
 * 评论是若干行。硬拼成一张表要么重复商品字段，要么让评论对不齐字段。
 * 分开两段既能直接看，也能按段解析。
 */
async function exportCsv() {
  const res = await send({ type: 'get-task' });
  if (!res.ok || !res.data) return showError('没有可导出的数据。');

  const task = res.data;
  const rows = [];

  rows.push(['京东商品采集结果']);
  rows.push(['采集时间', new Date(task.finishedAt || Date.now()).toLocaleString('zh-CN')]);
  rows.push([]);

  for (const r of task.results) {
    // ── 第一段：商品详情 ──
    rows.push(['【商品详情】']);
    rows.push(['字段', '值']);
    rows.push(['商品名称', r.商品名称 || '']);
    rows.push(['价格', r.价格 || '']);
    rows.push(['店铺名称', r.店铺名称 || '']);
    rows.push(['销量原文', r.销量 || '']);
    rows.push(['销量数值', r.销量解析 || 0]);
    rows.push(['好评率(%)', r.好评率 || 0]);
    rows.push(['详情链接', r.详情链接 || '']);
    rows.push(['采集时间', r.采集时间 || '']);
    rows.push([]);

    // ── 第二段：评论 ──
    const comments = r.comments || [];
    rows.push([`【评论】共 ${comments.length} 条`]);
    rows.push(['序号', '评论内容', '字数']);
    if (comments.length) {
      comments.forEach((c, i) => {
        rows.push([i + 1, c, String(c).length]);
      });
    } else {
      rows.push(['-', '（本次没有采集到评论）', '0']);
    }
    rows.push([]);
  }

  download(`jd_采集结果_${timestamp()}.csv`, toCsv(rows), 'text/csv;charset=utf-8');
}

async function exportJson() {
  const res = await send({ type: 'get-task' });
  if (!res.ok || !res.data) return showError('没有可导出的数据。');
  const payload = {
    导出时间: new Date().toISOString(),
    采集目标: res.data.target,
    商品数: res.data.results.length,
    商品: res.data.results
  };
  download(
    `jd_采集结果_${timestamp()}.json`,
    JSON.stringify(payload, null, 2),
    'application/json;charset=utf-8'
  );
}

// ══════════════════════════════════════════════════════════
// 事件绑定
// ══════════════════════════════════════════════════════════

$('btn-refresh').addEventListener('click', () => {
  refreshLogin();
  refreshPage();
});

$('btn-start').addEventListener('click', async () => {
  hideError();
  $('btn-start').disabled = true;

  const options = {
    comments: parseInt($('input-comments').value, 10) || 10
  };

  const res = await send({ type: 'start-crawl', options });
  if (!res.ok) {
    showError(res.error || '启动失败');
    $('btn-start').disabled = false;
    return;
  }
  startPolling();
  pollTask();
});

$('btn-stop').addEventListener('click', async () => {
  await send({ type: 'stop-crawl' });
  pollTask();
});

/**
 * 页面诊断。京东改版或取不到数据时，用这个确认实际结构。
 *
 * @param {string} messageType 'diagnose-tab' 或 'diagnose-expanded'
 * @param {string} busyText     运行中的提示文字
 */
async function runDiagnose(messageType, busyText) {
  const out = $('diag-output');
  out.classList.remove('hidden');
  out.textContent = busyText;

  // 走后台，内容脚本缺失时后台会补注入
  const res = await send({ type: messageType });

  if (!res.ok) {
    out.textContent =
      `诊断失败：${res.error || '未知错误'}\n\n` +
      '常见原因：当前页面不是京东页面，或者京东页面结构已经变化。';
    return;
  }

  out.textContent = JSON.stringify(res.data, null, 2);
}

$('btn-diagnose').addEventListener('click', () =>
  runDiagnose('diagnose-tab', '正在检查…')
);

$('btn-diagnose-expanded').addEventListener('click', () =>
  runDiagnose('diagnose-expanded', '正在点开评论区并检查，需要几秒…')
);

$('btn-csv').addEventListener('click', exportCsv);
$('btn-json').addEventListener('click', exportJson);

$('btn-clear').addEventListener('click', async () => {
  await send({ type: 'clear-task' });
  renderTask(null);
});

// 后台广播任务更新时立即刷新，比轮询更及时
chrome.runtime.onMessage.addListener((message) => {
  if (message && message.type === 'task-update') {
    renderTask(message.task);
  }
});

/**
 * 评论数量的风控提醒。
 *
 * 采集评论要反复滚动评论区，每滚一轮就触发一次请求。数量越大请求越多，
 * 全部记在用户自己的登录账号上。超过阈值时把提醒加重，避免用户
 * 顺手把数字调大却没意识到代价。
 *
 * 「约 N 次请求」按实测比例估：每轮滚动大约加载 3 条评论。
 */
const COMMENT_WARN_THRESHOLD = 20;
const COMMENTS_PER_SCROLL = 3;

function updateCommentWarning() {
  const el = $('comment-warn');
  const value = parseInt($('input-comments').value, 10) || 0;

  if (value > COMMENT_WARN_THRESHOLD) {
    const rounds = Math.ceil(value / COMMENTS_PER_SCROLL);
    el.classList.add('warn-strong');
    el.textContent =
      `⚠ 当前 ${value} 条，需要滚动评论区约 ${rounds} 次、发出同等数量的请求，` +
      `比较容易触发京东风控。建议改回 ${COMMENT_WARN_THRESHOLD} 条以内。`;
  } else {
    el.classList.remove('warn-strong');
    el.textContent =
      '⚠ 评论数量越大，要滚动的次数和向京东发出的请求就越多，越容易触发风控。' +
      `建议保持在 ${COMMENT_WARN_THRESHOLD} 条以内。`;
  }
}

$('input-comments').addEventListener('input', updateCommentWarning);

// 面板打开时初始化
(async function init() {
  updateCommentWarning();
  await refreshLogin();
  await refreshPage();
  await pollTask();
  startPolling();
})();

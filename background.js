/**
 * 后台 Service Worker：登录状态检测、任务队列编排、页面导航调度。
 *
 * 设计要点
 * ─────────
 * 1. 登录态检测分两步：先读 cookie 作为快速信号，再发一次真实请求确认会话有效。
 *    cookie 存在不等于有效，只读 cookie 会误判。
 *
 * 2. 任务状态全部放在 chrome.storage.local，不放内存。MV3 的 Service Worker
 *    空闲 30 秒会被回收，把进度写在内存里会直接丢失。
 *
 * 3. 导航之后不靠 sleep 等待，而是监听 chrome.tabs.onUpdated。这样即使
 *    Service Worker 中途被回收，页面加载完成事件也会把它唤醒并继续。
 *
 * 4. 所有对京东的访问都是「导航」和「页面自己发请求」，后台不构造任何接口调用。
 */

// ══════════════════════════════════════════════════════════
// 常量
// ══════════════════════════════════════════════════════════

const STORAGE_KEY = 'jdTask';
const WATCHDOG_ALARM = 'jd-crawl-watchdog';
const SESSION_CHECK_URL = 'https://order.jd.com/center/list.action';

/** 单次发消息给内容脚本的超时和重试，页面刚导航完时内容脚本可能还没就绪。 */
const SEND_TIMEOUT_MS = 90000;
const SEND_RETRIES = 5;
const SEND_RETRY_DELAY_MS = 800;

/**
 * 内容脚本文件列表，顺序必须和 manifest 里一致。
 * 扩展重载后，重载前就已经打开的页面不会自动获得新脚本，
 * 需要时用 chrome.scripting.executeScript 补注入一次。
 */
const CONTENT_SCRIPTS = [
  'lib/selectors.js',
  'lib/utils.js',
  'lib/crawler.js',
  'content.js'
];

/** 判断错误是否为「内容脚本不存在」。 */
function isMissingReceiver(error) {
  const msg = String((error && error.message) || error || '');
  return /Receiving end does not exist|Could not establish connection/i.test(msg);
}

/** 判定任务卡死的阈值，超过则尝试恢复。 */
const STALL_THRESHOLD_MS = 120000;

/**
 * 商品之间的随机等待区间，与源项目 jd_config.py 保持一致。
 * 数值调大只会让采集更慢，调小会让访问节奏更密集，不建议改小。
 */
const CRAWL_DELAY_MIN_MS = 3000;
const CRAWL_DELAY_MAX_MS = 8000;

// ══════════════════════════════════════════════════════════
// 任务状态存取
// ══════════════════════════════════════════════════════════

async function getTask() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return stored[STORAGE_KEY] || null;
}

async function setTask(task) {
  await chrome.storage.local.set({ [STORAGE_KEY]: task });
  broadcast({ type: 'task-update', task });
}

/** 向弹出面板广播，popup 未打开时忽略错误。 */
function broadcast(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

/** 更新任务日志，同时刷新进度时间戳。 */
function logLine(task, text) {
  task.log.push({ at: Date.now(), text });
  if (task.log.length > 200) task.log = task.log.slice(-200);
  task.lastProgressAt = Date.now();
}

/** 更新工具栏角标，显示已完成数 / 总数。 */
async function updateBadge(task) {
  if (!task) {
    await chrome.action.setBadgeText({ text: '' });
    return;
  }
  if (task.status === 'running') {
    const text = `${task.results.length}/${task.queue.length}`;
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color: '#e74c3c' });
  } else if (task.status === 'done') {
    await chrome.action.setBadgeText({ text: '完' });
    await chrome.action.setBadgeBackgroundColor({ color: '#52c41a' });
  } else if (task.status === 'error') {
    await chrome.action.setBadgeText({ text: '错' });
    await chrome.action.setBadgeBackgroundColor({ color: '#fa8c16' });
  } else {
    await chrome.action.setBadgeText({ text: '' });
  }
}

// ══════════════════════════════════════════════════════════
// 登录状态检测
// ══════════════════════════════════════════════════════════

/**
 * 检测京东登录状态。
 *
 * 返回 { state, hasPtKey, detail }
 *   state: 'logged_in' | 'need_login' | 'unknown'
 *
 * 两步走的原因：pt_key 这类 cookie 还在，不代表服务端还认这个会话。
 * 只读 cookie 会把过期会话误判成已登录，所以要发一次真实请求确认。
 */
async function checkLogin() {
  let hasPtKey = false;
  try {
    const cookies = await chrome.cookies.getAll({ domain: '.jd.com' });
    hasPtKey = cookies.some((c) => c.name === 'pt_key' && c.value);
  } catch (e) {
    // cookie 读取失败不影响后续的真实请求验证
  }

  try {
    // credentials: 'include' 让浏览器自动带上用户真实 cookie，
    // host_permissions 已授予 jd.com，因此不受跨域限制。
    const res = await fetch(SESSION_CHECK_URL, {
      credentials: 'include',
      redirect: 'follow',
      cache: 'no-store'
    });

    const finalUrl = res.url || '';
    const bouncedToLogin = /login|passport/i.test(finalUrl);

    if (bouncedToLogin) {
      return {
        state: 'need_login',
        hasPtKey,
        detail: '请求被重定向到登录页，当前会话已失效'
      };
    }
    return {
      state: 'logged_in',
      hasPtKey,
      detail: hasPtKey ? '已登录，会话有效' : '已登录（未检出 pt_key，但访问订单页正常）'
    };
  } catch (e) {
    // 网络失败不等于未登录，这一点必须和「确认掉到登录页」区分开
    return {
      state: 'unknown',
      hasPtKey,
      detail: `无法确认登录态：${String(e.message || e)}`
    };
  }
}

// ══════════════════════════════════════════════════════════
// 与内容脚本通信
// ══════════════════════════════════════════════════════════

/**
 * 带超时和重试的 sendMessage，页面刚加载完时内容脚本可能尚未就绪。
 *
 * opts.timeout / opts.retries 用于「点击可能触发跳转」这类预期会失联的调用：
 * 页面一旦开始跳转，content script 就被销毁，消息永远收不到，
 * 与其等满 90 秒不如快速失败，由调用方对比 URL 判断实际发生了什么。
 */
async function sendToTab(tabId, action, payload = {}, opts = {}) {
  const timeout = opts.timeout || SEND_TIMEOUT_MS;
  const maxAttempts = opts.retries || SEND_RETRIES;

  let lastError = null;
  let triedInject = false;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await withTimeout(
        chrome.tabs.sendMessage(tabId, { action, payload }),
        timeout
      );
      if (result && result.ok) return result.data;
      throw new Error((result && result.error) || '内容脚本返回失败');
    } catch (e) {
      lastError = e;

      // 没注入过就补注入一次再重试，避免用户手动刷新页面。
      // 扩展重载后，重载前打开的标签页不会自动带上新脚本。
      if (!triedInject && isMissingReceiver(e)) {
        triedInject = true;
        try {
          await chrome.scripting.executeScript({
            target: { tabId },
            files: CONTENT_SCRIPTS
          });
          continue;
        } catch (injectError) {
          lastError = injectError;
        }
      }

      if (attempt < maxAttempts) {
        await sleep(SEND_RETRY_DELAY_MS * attempt);
      }
    }
  }
  throw new Error(`与页面通信失败：${String((lastError && lastError.message) || lastError)}`);
}

/** 读取标签页当前 URL，标签页不存在时返回空串。 */
async function getTabUrl(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab.url || '';
  } catch (e) {
    return '';
  }
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('等待页面响应超时')), ms))
  ]);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 获取当前活动标签页。 */
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

// ══════════════════════════════════════════════════════════
// 采集流程
// ══════════════════════════════════════════════════════════

/** 页面类型的中文说明，用于报错提示。 */
const PAGE_LABEL = {
  search: '搜索结果页',
  product: '商品详情页',
  comments: '评论页',
  other: '其他京东页面',
  none: '非京东页面'
};

/**
 * 准备采集目标。
 *
 * 只采集当前打开的商品详情页，不遍历搜索结果。这样访问量最小，
 * 也符合「用户正看着哪个商品就采哪个」的使用方式。
 *
 * 返回 { products, tabId }，tabId 就是用户当前正在看的标签页。
 * 采集全程复用它，不另开后台标签页，这样用户能看到页面实际在做什么。
 */
async function prepareQueue(task) {
  const tab = await getActiveTab();
  if (!tab || !tab.id) throw new Error('找不到当前标签页。');

  const ping = await sendToTab(tab.id, 'ping');

  if (ping.pageType !== 'product') {
    const label = PAGE_LABEL[ping.pageType] || ping.pageType;
    throw new Error(`当前页面是「${label}」，本扩展只采集商品详情页。请先打开一个商品页面。`);
  }

  const sku = ping.sku || '';
  return {
    tabId: tab.id,
    products: [
      {
        商品名称: (ping.title || '').split('-')[0].trim(),
        价格: '',
        活动: '',
        店铺名称: '',
        销量: '',
        详情链接: sku ? `https://item.jd.com/${sku}.html` : tab.url
      }
    ]
  };
}

/** 启动一次采集任务。 */
async function startCrawl(options) {
  const existing = await getTask();
  if (existing && existing.status === 'running') {
    throw new Error('已有采集任务在运行，请先等待完成或停止。');
  }

  const task = {
    id: `jd-${Date.now()}`,
    status: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    target: {
      // 只采集当前商品，所以这里只有评论目标条数
      comments: Math.max(1, Math.min(50, options.comments || 10))
    },
    queue: [],
    index: 0,
    phase: 'detail',
    results: [],
    log: [],
    error: null,
    crawlTabId: null,
    lastProgressAt: Date.now()
  };

  await setTask(task);

  try {
    const prepared = await prepareQueue(task);
    task.queue = prepared.products;
    // 复用用户当前的标签页，不另开后台标签页，方便观察运行过程
    task.crawlTabId = prepared.tabId;
    logLine(task, `目标：当前商品，最多采集 ${task.target.comments} 条评论`);
  } catch (e) {
    task.status = 'error';
    task.error = String(e.message || e);
    task.finishedAt = Date.now();
    logLine(task, `准备失败：${task.error}`);
    await setTask(task);
    await updateBadge(task);
    await clearWatchdog();
    throw e;
  }

  await setTask(task);
  await updateBadge(task);
  await startWatchdog();

  await navigateToCurrent(task);
  return task;
}

/** 导航到队列中当前商品的详情页。 */
async function navigateToCurrent(task) {
  const product = task.queue[task.index];
  if (!product) return finishTask(task);

  const url = product.详情链接;
  if (!url) {
    logLine(task, `第 ${task.index + 1} 个商品没有详情链接，跳过`);
    return advance(task);
  }

  task.phase = 'detail';
  await setTask(task);

  try {
    // active: true 让页面保持可见，用户能直接看到正在采集哪个商品
    await chrome.tabs.update(task.crawlTabId, { url, active: true });
  } catch (e) {
    // 标签页被用户关掉了，属于全局故障，直接结束
    task.status = 'error';
    task.error = '采集标签页已被关闭，任务中止。';
    task.finishedAt = Date.now();
    logLine(task, task.error);
    await setTask(task);
    await updateBadge(task);
    await clearWatchdog();
  }
}

/**
 * 页面加载完成后的处理。
 * 由 chrome.tabs.onUpdated 触发，是流程推进的唯一入口。
 */
/**
 * 正在处理的标签页集合。
 *
 * chrome.tabs.onUpdated 对同一个页面可能触发多次 complete
 * （点击「全部评价」引起的二次加载就是这种情况）。没有这道保护时，
 * 两次 handlePageLoaded 会并发跑，各自采集一轮，后完成的那次覆盖先完成的，
 * 表现为「先显示 10 条评论，过一会儿变成 3 条」。
 */
const processingTabs = new Set();

async function handlePageLoaded(tabId) {
  if (processingTabs.has(tabId)) return;
  processingTabs.add(tabId);
  try {
    await handlePageLoadedInner(tabId);
  } finally {
    processingTabs.delete(tabId);
  }
}

async function handlePageLoadedInner(tabId) {
  const task = await getTask();
  if (!task || task.status !== 'running') return;
  if (task.crawlTabId !== tabId) return;

  // 只处理 jd.com 页面。用当前标签页采集时，用户可能中途导航到别处，
  // 或者标签页正处于加载中的空白状态，这些都不该触发提取。
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!/^https:\/\/[^/]*\.jd\.com\//.test(tab.url || '')) return;
  } catch (e) {
    return; // 标签页已经不存在
  }

  const product = task.queue[task.index];
  if (!product) return finishTask(task);

  task.lastProgressAt = Date.now();

  try {
    if (task.phase === 'detail') {
      const data = await sendToTab(tabId, 'extract-product');
      const merged = mergeProduct(product, data.detail);
      const record = {
        ...merged,
        comments: [],
        commentCount: 0,
        commentSource: ''
      };
      const paramCount = Object.keys(merged.商品参数 || {}).length;
      logLine(
        task,
        `「${shortName(merged.商品名称)}」详情已提取，${paramCount} 项规格参数`
      );

      // 评论一律先进入评论区，不看已经渲染出多少条。
      // 评论区是固定高度的预览，不点开「全部评价」就永远只有最初那几条，
      // 滚动也没用。
      task.pendingResult = record;
      task.phase = 'comments';
      await setTask(task);

      const outcome = await openCommentSection(task, tabId);

      // 页面已经跳转到评论区，后续由 onUpdated 触发的评论分支处理
      if (outcome === 'navigated') return;

      // 原地展开或没有入口：等渲染后在当前页采集
      await sleep(2500);
      await collectInto(task, tabId, record);

      task.results.push(record);
      task.pendingResult = null;
      await setTask(task);
      await updateBadge(task);
      return advance(task);
    }

    if (task.phase === 'comments') {
      const record = task.pendingResult || mergeProduct(product, {});

      // 刚进入评论区，先给页面一点渲染时间，再开始滚动采集
      await sleep(1800);
      await collectInto(task, tabId, record);

      task.results.push(record);
      task.pendingResult = null;
      await setTask(task);
      await updateBadge(task);
      return advance(task);
    }
  } catch (e) {
    logLine(task, `处理「${shortName(product.商品名称)}」失败：${String(e.message || e)}`);
    task.results.push({
      ...mergeProduct(product, {}),
      comments: [],
      commentCount: 0,
      commentSource: 'failed',
      error: String(e.message || e)
    });
    await updateBadge(task);
    return advance(task);
  }
}

/**
 * 点「全部评价」进入完整评论区。
 *
 * 返回 'navigated'（页面已跳转到评论区）或 'inline'（原地展开或没有入口）。
 *
 * 点击可能触发跳转，content script 会被销毁导致消息永远收不到，
 * 所以用短超时、不重试，靠对比点击前后的 URL 判断实际发生了什么。
 */
async function openCommentSection(task, tabId) {
  // 第一步：滚到评论区。评论区和「全部评价」按钮都是懒渲染的，
  // 页面刚打开时 DOM 里没有它们，必须先滚过去。这一步耗时长，给足超时。
  try {
    const prep = await sendToTab(tabId, 'prepare-comments', {}, { timeout: 30000, retries: 1 });
    if (!prep.buttonFound) {
      logLine(task, '滚到评论区后仍未找到「全部评价」入口');
    }
  } catch (e) {
    logLine(task, `定位评论区失败：${String((e && e.message) || e)}`);
  }

  // 第二步：点击。用短超时，因为跳转场景下消息必然收不到，
  // 与其干等不如快速失败，靠对比 URL 判断实际结果。
  const urlBefore = await getTabUrl(tabId);

  let result = null;
  try {
    result = await sendToTab(tabId, 'expand-comments', {}, { timeout: 6000, retries: 1 });
  } catch (e) {
    // 点击触发跳转时消息收不到，属于预期情况
    result = null;
  }

  const urlAfter = await getTabUrl(tabId);

  // 情况一：点击触发了跳转
  if (urlBefore && urlAfter && urlAfter !== urlBefore) {
    logLine(task, '已进入评论区，等待加载');
    return 'navigated';
  }

  // 情况二：入口是链接但没自动跳，主动导航过去
  if (result && result.href) {
    logLine(task, `已进入评论区：${result.href}`);
    try {
      await chrome.tabs.update(tabId, { url: result.href, active: true });
      return 'navigated';
    } catch (e) {
      // 导航失败就退回原地采集
    }
  }

  if (!result || !result.found) {
    logLine(task, '未找到「全部评价」入口，直接在当前页面采集评论');
  } else {
    logLine(task, '评论区已就地展开');
  }
  return 'inline';
}

/** 在当前页面滚动采集评论，结果写回 record。 */
async function collectInto(task, tabId, record) {
  let fresh = null;
  let stats = null;

  try {
    const data = await sendToTab(tabId, 'collect-comments', {
      comments: task.target.comments
    });
    fresh = data.comments || [];
    stats = data.stats || null;

    // 滚动遥测：评论条数不对时，看这行就知道是没滚动、还是滚了不加载
    if (stats) {
      const counts = (stats.counts || []).join(',');
      logLine(
        task,
        `评论采集 模式=${stats.mode} 选择器=${stats.selector} ` +
          `轮次=${stats.rounds} 各轮条数=[${counts}]`
      );
      if (stats.scrollTarget) {
        logLine(
          task,
          `滚动 ${stats.scrollTarget} 位置 ${stats.scrollTopStart}→${stats.scrollTopEnd} ` +
            `内容${stats.scrollHeight}/可视${stats.clientHeight}`
        );
      } else {
        logLine(task, '没有可滚动的评论容器，滚的是页面');
      }
    }
  } catch (e) {
    logLine(task, `评论采集失败：${String((e && e.message) || e)}`);
    record.commentError = String((e && e.message) || e);
    record.comments = record.comments || [];
    record.commentCount = record.comments.length;
    return;
  }

  const previous = record.comments || [];

  // 只在结果不更差时覆盖。页面上二次加载会让评论列表短暂回落到初始状态，
  // 这时采到的条数反而更少，直接覆盖会把已经拿到的结果丢掉。
  if (fresh.length >= previous.length) {
    record.comments = fresh;
    record.commentSource = 'comment-section';
  } else {
    logLine(
      task,
      `本次只拿到 ${fresh.length} 条，少于已有的 ${previous.length} 条，保留较多的一次`
    );
  }

  record.commentCount = record.comments.length;
  logLine(task, `「${shortName(record.商品名称)}」共 ${record.commentCount} 条评论`);
}

/** 前进到下一个商品，或在队列结束时收尾。 */
async function advance(task) {
  if (task.status !== 'running') return;

  task.index += 1;

  if (task.index >= task.queue.length) {
    return finishTask(task);
  }

  await setTask(task);

  // 商品之间的随机等待，和源项目的 CRAWL_DELAY 保持一致
  const waitMs = Math.round(
    CRAWL_DELAY_MIN_MS + Math.random() * (CRAWL_DELAY_MAX_MS - CRAWL_DELAY_MIN_MS)
  );
  logLine(task, `等待 ${(waitMs / 1000).toFixed(1)} 秒后处理下一个商品`);
  await sleep(waitMs);

  const fresh = await getTask();
  if (!fresh || fresh.status !== 'running') return;
  await navigateToCurrent(fresh);
}

/**
 * 收尾：标记完成、清理定时器。
 * 采集用的是用户自己的标签页，所以不关闭它，只是停止驱动导航。
 */
async function finishTask(task) {
  task.status = 'done';
  task.finishedAt = Date.now();
  task.crawlTabId = null;
  logLine(task, `采集完成，共 ${task.results.length} 个商品`);
  await setTask(task);
  await updateBadge(task);
  await clearWatchdog();
}

/** 手动停止任务。同样保留标签页，停在当前页面。 */
async function stopCrawl() {
  const task = await getTask();
  if (!task || task.status !== 'running') return;

  task.status = 'stopped';
  task.finishedAt = Date.now();
  task.crawlTabId = null;
  logLine(task, '用户手动停止');
  await setTask(task);
  await updateBadge(task);
  await clearWatchdog();
}

// ══════════════════════════════════════════════════════════
// 小工具
// ══════════════════════════════════════════════════════════

function shortName(name) {
  const s = String(name || '未知商品');
  return s.length > 24 ? s.slice(0, 24) + '…' : s;
}

/** 合并搜索结果页的卡片数据和详情页数据，卡片数据优先保留非空字段。 */
function mergeProduct(card, detail) {
  const d = detail || {};
  const params =
    d.商品参数 && typeof d.商品参数 === 'object' ? d.商品参数 : {};
  // 好评率优先从销量文案推导（旧版「好评率98%」常和销量放同一栏），
  // 新版分成独立元素，推导不出时用详情页本身解析的值
  const rateFromSales = JD_parseRate(card.销量 || d.销量 || '');
  const rate = rateFromSales || (d.好评率 || 0);

  return {
    商品名称: card.商品名称 || d.商品名称 || '',
    价格: card.价格 || d.价格 || '',
    活动: card.活动 || d.活动 || '',
    店铺名称: card.店铺名称 || d.店铺名称 || '',
    销量: card.销量 || d.销量 || '',
    详情链接: card.详情链接 || d.详情链接 || '',
    销量解析: JD_parseSales(card.销量 || d.销量 || ''),
    好评率: rate,
    商品参数: params,
    款式: d.款式 || [],
    采集时间: new Date().toISOString()
  };
}

// 后台是 module，无法直接引用内容脚本里的 JD 命名空间，这里复刻两个解析函数。
// 逻辑与 lib/utils.js 完全一致，改动时两边要同步。
function JD_parseSales(text) {
  const s = String(text || '');
  let m = s.match(/已售(\d+(?:\.\d+)?)万\+?/);
  if (m) return Math.trunc(parseFloat(m[1]) * 10000);
  m = s.match(/已售(\d+)\+?/);
  if (m) return parseInt(m[1], 10);
  m = s.match(/(\d+(?:\.\d+)?)万\+?/);
  if (m) return Math.trunc(parseFloat(m[1]) * 10000);
  m = s.match(/(\d+)\+/);
  if (m) return parseInt(m[1], 10);
  return 0;
}

function JD_parseRate(text) {
  const s = String(text || '');
  for (const p of [
    /好评率[：:\s]*(\d+(?:\.\d+)?)\s*%/,
    /(\d+(?:\.\d+)?)\s*%[^\d]{0,4}好评/,
    /好评[：:\s]*(\d+(?:\.\d+)?)\s*%/
  ]) {
    const m = s.match(p);
    if (m) return Math.trunc(parseFloat(m[1]));
  }
  return 0;
}

// ══════════════════════════════════════════════════════════
// 看门狗：Service Worker 被回收后的恢复
// ══════════════════════════════════════════════════════════

async function startWatchdog() {
  await chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 0.5 });
}

async function clearWatchdog() {
  await chrome.alarms.clear(WATCHDOG_ALARM);
}

/**
 * 如果任务长时间没有进展，尝试重新驱动一次。
 * 这是 Service Worker 被系统回收后的兜底，正常流程不会走到这里。
 */
async function watchdogTick() {
  const task = await getTask();
  if (!task || task.status !== 'running') {
    await clearWatchdog();
    return;
  }

  const stalled = Date.now() - (task.lastProgressAt || 0);
  if (stalled < STALL_THRESHOLD_MS) return;

  logLine(task, '检测到任务长时间无进展，尝试恢复');
  await setTask(task);

  try {
    const tab = await chrome.tabs.get(task.crawlTabId);
    if (tab && tab.status === 'complete' && tab.url && !tab.url.startsWith('about:')) {
      await handlePageLoaded(task.crawlTabId);
    } else if (tab) {
      await chrome.tabs.update(task.crawlTabId, { url: task.queue[task.index]?.详情链接 });
    }
  } catch (e) {
    task.status = 'error';
    task.error = '采集标签页已丢失，任务中止。';
    task.finishedAt = Date.now();
    logLine(task, task.error);
    await setTask(task);
    await updateBadge(task);
    await clearWatchdog();
  }
}

// ══════════════════════════════════════════════════════════
// 事件监听：全部在顶层同步注册，保证 Service Worker 被唤醒后仍能收到
// ══════════════════════════════════════════════════════════

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const type = message && message.type;

  if (type === 'check-login') {
    checkLogin()
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }

  if (type === 'start-crawl') {
    startCrawl(message.options || {})
      .then((task) => sendResponse({ ok: true, data: { id: task.id } }))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }

  if (type === 'stop-crawl') {
    stopCrawl()
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }

  if (type === 'get-task') {
    getTask()
      .then((task) => sendResponse({ ok: true, data: task }))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }

  // 面板的页面探测走后台，这样内容脚本缺失时能自动补注入
  if (type === 'ping-tab') {
    (async () => {
      const tab = await getActiveTab();
      if (!tab || !tab.id) throw new Error('找不到当前标签页。');
      const data = await sendToTab(tab.id, 'ping');
      return data;
    })()
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }

  if (type === 'diagnose-tab') {
    (async () => {
      const tab = await getActiveTab();
      if (!tab || !tab.id) throw new Error('找不到当前标签页。');
      const data = await sendToTab(tab.id, 'diagnose');
      return data;
    })()
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }

  /**
   * 先点开「全部评价」，再诊断。
   * 展开前后 DOM 结构差别很大，只看展开前的状态定位不到浮层里的滚动容器。
   */
  if (type === 'diagnose-expanded') {
    (async () => {
      const tab = await getActiveTab();
      if (!tab || !tab.id) throw new Error('找不到当前标签页。');

      await sendToTab(tab.id, 'prepare-comments', {}, { timeout: 30000, retries: 1 });

      const urlBefore = await getTabUrl(tab.id);
      try {
        await sendToTab(tab.id, 'expand-comments', {}, { timeout: 6000, retries: 1 });
      } catch (e) {
        // 点击触发跳转时消息收不到，属预期
      }

      const urlAfter = await getTabUrl(tab.id);
      const navigated = urlBefore && urlAfter && urlAfter !== urlBefore;
      await sleep(navigated ? 2500 : 3000);

      return await sendToTab(tab.id, 'diagnose', { deep: true });
    })()
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }

  if (type === 'clear-task') {
    chrome.storage.local
      .remove(STORAGE_KEY)
      .then(() => updateBadge(null))
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }

  return false;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return;
  handlePageLoaded(tabId).catch(() => {
    // handlePageLoaded 内部已经记录失败，这里避免未捕获的 rejection
  });
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const task = await getTask();
  if (!task || task.status !== 'running' || task.crawlTabId !== tabId) return;

  task.status = 'error';
  task.error = '采集标签页被关闭，任务中止。';
  task.finishedAt = Date.now();
  logLine(task, task.error);
  await setTask(task);
  await updateBadge(task);
  await clearWatchdog();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === WATCHDOG_ALARM) {
    watchdogTick().catch(() => {});
  }
});

/**
 * 通用工具函数。
 *
 * 移植自源项目的 crawler/jd_utils.py，保持相同的解析规则和返回值约定，
 * 这样扩展采到的数据可以直接和源项目的 Excel / MySQL 结果对比。
 */

// 用 var 而不是 const：多个内容脚本文件共享同一个全局作用域，
// 重复声明 const 会抛 "Identifier 'JD' has already been declared"。
var JD = (globalThis.JD = globalThis.JD || {});

/** 随机整数，含两端。对应 Python 的 random.randint。 */
JD.randInt = function (min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
};

/** 随机浮点，含左不含右。对应 Python 的 random.uniform。 */
JD.randFloat = function (min, max) {
  return Math.random() * (max - min) + min;
};

JD.sleep = function (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

/**
 * 尽量从元素中提取可见文字。
 * 对应 jd_utils.extract_text：依次尝试 innerText、textContent、title、aria-label。
 */
JD.extractText = function (el) {
  if (!el) return '';
  const candidates = [
    el.innerText,
    el.textContent,
    el.getAttribute && el.getAttribute('title'),
    el.getAttribute && el.getAttribute('aria-label')
  ];
  for (const raw of candidates) {
    const text = (raw || '').trim();
    if (text) return text;
  }
  return '';
};

/**
 * 只保留京东商品详情页链接，避免误打开客服页、店铺页。
 * 对应 jd_utils.normalize_url。
 */
JD.normalizeUrl = function (link) {
  let url = (link || '').trim();
  if (!url) return '';
  if (url.startsWith('//')) {
    url = 'https:' + url;
  } else if (url.startsWith('/')) {
    url = 'https://item.jd.com' + url;
  }
  const match = url.match(/https?:\/\/item\.jd\.com\/(\d+)\.html/);
  return match ? `https://item.jd.com/${match[1]}.html` : '';
};

/** 从商品详情链接提取 SKU。对应 jd_utils.get_sku_from_link。 */
JD.getSkuFromLink = function (link) {
  const match = (link || '').match(/item\.jd\.com\/(\d+)\.html/);
  return match ? match[1] : '';
};

/**
 * 从销量文案解析销量数值，解析不出返回 0。
 * 对应 jd_utils.parse_sales_num，四条正则顺序完全一致。
 */
JD.parseSalesNum = function (text) {
  const s = String(text == null ? '' : text);

  let m = s.match(/已售(\d+(?:\.\d+)?)万\+?/);
  if (m) return Math.trunc(parseFloat(m[1]) * 10000);

  m = s.match(/已售(\d+)\+?/);
  if (m) return parseInt(m[1], 10);

  m = s.match(/(\d+(?:\.\d+)?)万\+?/);
  if (m) return Math.trunc(parseFloat(m[1]) * 10000);

  m = s.match(/(\d+)\+/);
  if (m) return parseInt(m[1], 10);

  return 0;
};

/**
 * 从销量/好评文案解析好评率（%），解析不出返回 0。
 * 对应 jd_utils.parse_good_rate，三种语序逐个尝试，小数按截断处理。
 */
JD.parseGoodRate = function (text) {
  const s = String(text == null ? '' : text);
  const patterns = [
    /好评率[：:\s]*(\d+(?:\.\d+)?)\s*%/,   // 好评率98% / 好评率：98%
    /(\d+(?:\.\d+)?)\s*%[^\d]{0,4}好评/,   // 98%好评
    /好评[：:\s]*(\d+(?:\.\d+)?)\s*%/,     // 好评98%
    /超?(\d+(?:\.\d+)?)\s*%\s*(买家|用户|赞不绝口|好评)/  // 超99%买家赞不绝口
  ];
  for (const p of patterns) {
    const m = s.match(p);
    if (m) return Math.trunc(parseFloat(m[1]));
  }
  return 0;
};

/** 在元素内按顺序尝试选择器，返回第一个匹配的元素。 */
JD.pick = function (root, selectors) {
  for (const selector of selectors) {
    try {
      const el = root.querySelector(selector);
      if (el) return el;
    } catch (e) {
      // 忽略非法选择器，继续尝试下一个
    }
  }
  return null;
};

/** 在元素内按顺序尝试选择器，返回第一段非空文本。对应 jd_product_extractor.first_text。 */
JD.pickText = function (root, selectors) {
  for (const selector of selectors) {
    try {
      const el = root.querySelector(selector);
      if (!el) continue;
      const text = JD.extractText(el).replace(/\n/g, '/').trim();
      if (text) return text;
    } catch (e) {
      // 忽略
    }
  }
  return '';
};

/**
 * 按可见文本查找元素，对应源项目里的 text: 选择器语法。
 *
 * 用 XPath 的 contains(., ...) 而不是遍历元素读 innerText：
 * 京东商品页有上万个节点，逐个读 innerText 会强制重排，
 * 慢到可能直接超时。XPath 由浏览器原生执行，快得多。
 *
 * contains(.) 会同时命中祖先节点，所以取文字最短的那个，
 * 也就是真正承载这段文字的元素本身（比如按钮），而不是包住它的整块容器。
 */
JD.findByText = function (selectors, root = document) {
  for (const raw of selectors) {
    if (!raw.startsWith('text:')) continue;
    const target = raw.slice(5).trim();
    if (!target) continue;

    let snapshot;
    try {
      const xp = `//*[contains(., "${target.replace(/"/g, '')}")]`;
      snapshot = root.evaluate(xp, root, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    } catch (e) {
      continue;
    }

    let best = null;
    let bestLen = Infinity;
    for (let i = 0; i < snapshot.snapshotLength; i++) {
      const el = snapshot.snapshotItem(i);
      const text = (el.textContent || '').trim();
      // 文字过长说明是大容器，不是我们要的按钮
      if (!text || text.length > 40) continue;
      if (text.length < bestLen) {
        bestLen = text.length;
        best = el;
      }
    }
    if (best) return best;
  }
  return null;
};

/**
 * 混合选择器匹配：CSS 选择器走 querySelector，text: 前缀走文本查找。
 * 用于「全部评价」按钮这类可能是文本定位的元素。
 */
JD.pickMixed = function (root, selectors) {
  const cssSelectors = selectors.filter((s) => !s.startsWith('text:'));
  const textSelectors = selectors.filter((s) => s.startsWith('text:'));
  return JD.pick(root, cssSelectors) || JD.findByText(textSelectors, root);
};

/** 过滤无效评论，移植自 jd_comment_crawler.clean_comments。 */
JD.cleanComments = function (comments) {
  const cleaned = [];
  for (const raw of comments) {
    const text = String(raw || '').trim();
    if (!text) continue;
    if (text === JD.INVALID_COMMENT) continue;
    if (text.length < JD.MIN_COMMENT_LENGTH) continue;
    cleaned.push(text);
  }
  return cleaned;
};

/**
 * 找到「包含指定文字的最小元素」。
 *
 * 用 XPath 而不是遍历所有元素，因为京东详情页有上万个节点，
 * 逐个读 innerText 会强制重排，慢到不可接受。XPath 的 contains 由浏览器
 * 原生执行，快得多。
 */
JD.findSmallestByText = function (text, root = document) {
  const safe = String(text).replace(/"/g, '');
  let snapshot;
  try {
    const xp = `//*[contains(text(), "${safe}")]`;
    snapshot = root.evaluate(xp, root, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
  } catch (e) {
    return null;
  }

  let best = null;
  let bestLen = Infinity;
  for (let i = 0; i < snapshot.snapshotLength; i++) {
    const el = snapshot.snapshotItem(i);
    if (!el || !el.textContent) continue;
    const len = el.textContent.length;
    if (len > 0 && len < bestLen) {
      bestLen = len;
      best = el;
    }
  }
  return best;
};

/**
 * 找到标签后，向上走若干层读它所在容器的文字。
 * 例如找到「累计评价」后，往上两级就能拿到「累计评价 1万+」。
 */
JD.textNearLabel = function (labels, maxUp = 3) {
  for (const label of labels) {
    const el = JD.findSmallestByText(label);
    if (!el) continue;

    let node = el;
    for (let up = 0; up <= maxUp && node; up++) {
      const text = (node.innerText || node.textContent || '').trim();
      // 返回纯数据，不含 DOM 节点，方便通过消息传递
      if (text && text.length <= 60) return { label, text };
      node = node.parentElement;
    }
  }
  return null;
};

/** 在文档中按选择器列表统计匹配数量，用于诊断。 */
JD.countMatches = function (selectors) {
  const out = [];
  for (const selector of selectors) {
    let count = 0;
    try {
      count = document.querySelectorAll(selector).length;
    } catch (e) {
      count = -1; // 非法选择器
    }
    out.push({ selector, count });
  }
  return out;
};

/**
 * 元素当前是否真的可见。
 *
 * 点击「全部评价」之后，DOM 里可能同时存在预览区和浮层两份评论，
 * 必须靠可见性区分，否则会去滚那个已经隐藏的节点，看起来「滚了没反应」。
 */
JD.isVisible = function (el) {
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  try {
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    if (style.opacity === '0') return false;
  } catch (e) {
    // 取不到样式就当可见，避免误杀
  }
  return true;
};

/** 当前页面类型判定，用于弹出面板显示和采集模式选择。 */
JD.detectPageType = function (url = location.href) {
  if (/search\.jd\.com\//.test(url)) return 'search';
  if (/item\.jd\.com\/\d+\.html/.test(url)) return 'product';
  if (/club\.jd\.com\/comment\//.test(url)) return 'comments';
  if (/(^|\.)jd\.com\//.test(url)) return 'other';
  return 'none';
};
